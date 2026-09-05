import { randomBytes } from "node:crypto";
import { Dirent } from "node:fs";
import { lstat, mkdir, readdir, rm, stat } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { statfs } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** Initial Safety Limits shared by compression and page export. */
export const LIMITS = {
  /** Source PDFs per export. */
  maxSources: 10,
  /** Bytes per uploaded source. */
  maxSourceBytes: 100 * 1024 * 1024,
  /** Total multipart bytes per export. */
  maxTotalBytes: 100 * 1024 * 1024,
  /** Manifest field bytes. */
  maxManifestBytes: 256 * 1024,
  /** Multipart parts: exactly 1 manifest plus up to 10 sources. */
  maxParts: 11,
  /** Multipart header pairs. */
  maxHeaderPairs: 50,
  /** Source-id characters. */
  maxSourceIdLength: 64,
  /** Manifest JSON depth. */
  maxJsonDepth: 4,
  /** Output pages per export. */
  maxOutputPages: 500,
  /** Candidate or final output bytes. */
  maxOutputBytes: 150 * 1024 * 1024,
  /** Native export runtime budget. */
  jobTimeoutMs: 120_000,
  /** Global in-flight native operations across compression and export. */
  maxNativeOperations: 1,
  /** Retained downloadable jobs. */
  maxRetainedOutputs: 2,
  /** Aggregate app temp storage. */
  maxTempBytes: 600 * 1024 * 1024,
  /** Free-disk reserve after allocation. */
  minFreeBytes: 1024 * 1024 * 1024,
  /** Download artifact TTL. */
  outputTtlMs: 10 * 60 * 1000
} as const;

export interface CapacityCheck {
  ok: true;
}

export type CapacityFailureCode = "TEMP_QUOTA_EXCEEDED" | "DISK_RESERVE_EXHAUSTED";

export interface RetainedOutput {
  handle: string;
  sessionId: string;
  jobDir: string;
  outputPath: string;
  bytes: number;
  pageCount: number;
  createdAt: number;
  expiresAt: number;
  leased: boolean;
}

export type LeaseOutcome = "leased" | "not_found" | "forbidden" | "expired" | "busy";

export interface JobManagerOptions {
  /** Owned app temp root; defaults to a current-user private dir. */
  tempRoot?: string;
  outputTtlMs?: number;
  jobTimeoutMs?: number;
  now?: () => number;
}

function randomHandle(): string {
  return randomBytes(16).toString("hex");
}

/**
 * Startup-sweep ownership predicate. On platforms exposing
 * `process.getuid`, a temp-root child is only eligible for recursive
 * deletion when its owner matches the current user; foreign-owned
 * directories are ignored. Where ownership is unavailable (or the uid is
 * not a number), every canonical candidate stays eligible so behavior on
 * those platforms is unchanged.
 */
export function isOwnedByCurrentUser(statUid: number | undefined): boolean {
  const getuid = (process as unknown as { getuid?: () => number }).getuid;
  if (typeof getuid !== "function") return true;
  if (typeof statUid !== "number") return false;
  try {
    return statUid === getuid();
  } catch {
    return false;
  }
}

/**
 * Owns the app temp root, the single global native-operation slot, retained
 * downloadable outputs, and lifecycle cleanup. Only canonical child
 * directories created by this manager are ever swept; symlinks and foreign
 * entries are ignored. Never logs tokens, handles, paths, or filenames.
 */
export class JobManager {
  readonly tempRoot: string;
  private readonly outputTtlMs: number;
  readonly jobTimeoutMs: number;
  private readonly now: () => number;
  private nativeInFlight = false;
  private nativeEpoch = 0;
  private readonly retained = new Map<string, RetainedOutput>();
  private sweeper: NodeJS.Timeout | undefined;
  private closed = false;

  private constructor(tempRoot: string, options: JobManagerOptions) {
    this.tempRoot = tempRoot;
    this.outputTtlMs = options.outputTtlMs ?? LIMITS.outputTtlMs;
    this.jobTimeoutMs = options.jobTimeoutMs ?? LIMITS.jobTimeoutMs;
    this.now = options.now ?? Date.now;
  }

  static async create(options: JobManagerOptions = {}): Promise<JobManager> {
    const tempRoot = options.tempRoot ?? join(tmpdir(), "pdf-compressor-app");
    await mkdir(tempRoot, { recursive: true, mode: 0o700 });
    const manager = new JobManager(tempRoot, options);
    await manager.sweepStartupOrphans();
    manager.startSweeper();
    return manager;
  }

  /** Synchronous construction for embedding in a sync server factory. */
  static createSync(options: JobManagerOptions = {}): JobManager {
    const tempRoot = options.tempRoot ?? join(tmpdir(), "pdf-compressor-app");
    mkdirSync(tempRoot, { recursive: true, mode: 0o700 });
    const manager = new JobManager(tempRoot, options);
    void manager.sweepStartupOrphans().catch(() => undefined);
    manager.startSweeper();
    return manager;
  }

  private startSweeper(): void {
    this.sweeper = setInterval(() => {
      void this.sweepExpired().catch(() => undefined);
    }, 30_000);
    this.sweeper.unref?.();
  }

  /** Single global native-operation slot; no queue. */
  tryAcquireNative(): boolean {
    if (this.nativeInFlight) return false;
    this.nativeInFlight = true;
    this.nativeEpoch += 1;
    return true;
  }

  /**
   * Single-owner acquisition for request dispatch. The returned guard
   * releases exactly once and only while its own acquisition is still the
   * active holder: a stale guard from a completed request can never clear
   * a slot acquired later by another request. Dispatch owns the guard;
   * route handlers must never release the slot themselves.
   */
  acquireNativeSlot(): { release(): void } | null {
    if (!this.tryAcquireNative()) return null;
    const epoch = this.nativeEpoch;
    let released = false;
    return {
      release: (): void => {
        if (released) return;
        released = true;
        if (this.nativeEpoch === epoch) this.nativeInFlight = false;
      }
    };
  }

  releaseNative(): void {
    this.nativeInFlight = false;
  }

  isNativeBusy(): boolean {
    return this.nativeInFlight;
  }

  /** Create a private per-job directory owned by the current user. */
  async newJobDir(prefix: string): Promise<{ id: string; dir: string }> {
    const id = randomBytes(16).toString("hex");
    const dir = join(this.tempRoot, `${prefix}${id}`);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return { id, dir };
  }

  async removeDir(dir: string): Promise<void> {
    await rm(dir, { recursive: true, force: true });
  }

  /** Sum of bytes in owned canonical child directories (symlinks ignored). */
  async tempUsageBytes(): Promise<number> {
    let total = 0;
    let entries: Dirent[];
    try {
      entries = await readdir(this.tempRoot, { withFileTypes: true });
    } catch {
      return 0;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      total += await dirSize(join(this.tempRoot, entry.name));
    }
    return total;
  }

  async freeBytes(): Promise<number | null> {
    try {
      const info = await statfs(this.tempRoot);
      return info.bavail * info.bsize;
    } catch {
      return null;
    }
  }

  /**
   * Reserve quota before accepting bytes. Fails closed when the free-disk
   * reserve cannot be verified.
   */
  async checkCapacity(expectedBytes: number): Promise<CapacityCheck | { ok: false; code: CapacityFailureCode }> {
    const usage = await this.tempUsageBytes();
    if (usage + expectedBytes > LIMITS.maxTempBytes) {
      return { ok: false, code: "TEMP_QUOTA_EXCEEDED" };
    }
    const free = await this.freeBytes();
    if (free === null || free - expectedBytes < LIMITS.minFreeBytes) {
      return { ok: false, code: "DISK_RESERVE_EXHAUSTED" };
    }
    return { ok: true };
  }

  /**
   * Publish a validated output for session-bound download. Evicts the oldest
   * retained output beyond the two-output cap.
   */
  async retainOutput(options: {
    sessionId: string;
    jobDir: string;
    outputPath: string;
    pageCount: number;
  }): Promise<RetainedOutput> {
    const fileStat = await stat(options.outputPath);
    if (fileStat.size > LIMITS.maxOutputBytes) {
      throw new Error("OUTPUT_TOO_LARGE");
    }
    const at = this.now();
    const record: RetainedOutput = {
      handle: randomHandle(),
      sessionId: options.sessionId,
      jobDir: options.jobDir,
      outputPath: options.outputPath,
      bytes: fileStat.size,
      pageCount: options.pageCount,
      createdAt: at,
      expiresAt: at + this.outputTtlMs,
      leased: false
    };
    this.retained.set(record.handle, record);
    // Evict oldest beyond the retained-output cap.
    const ordered = [...this.retained.values()].sort((left, right) => left.createdAt - right.createdAt);
    while (ordered.length > LIMITS.maxRetainedOutputs) {
      const oldest = ordered.shift();
      if (oldest) await this.deleteRetained(oldest.handle);
    }
    return record;
  }

  retainedCount(): number {
    return this.retained.size;
  }

  peekRetained(handle: string): RetainedOutput | undefined {
    return this.retained.get(handle);
  }

  /** Atomically lease one transfer for the owning session. */
  lease(handle: string, sessionId: string): { outcome: LeaseOutcome; record?: RetainedOutput } {
    const record = this.retained.get(handle);
    if (!record) return { outcome: "not_found" };
    if (record.sessionId !== sessionId) return { outcome: "forbidden" };
    if (record.expiresAt <= this.now()) {
      void this.deleteRetained(handle);
      return { outcome: "expired" };
    }
    if (record.leased) return { outcome: "busy" };
    record.leased = true;
    return { outcome: "leased", record };
  }

  /** Release a lease after a failed transfer so one retry stays possible. */
  release(handle: string, sessionId: string): boolean {
    const record = this.retained.get(handle);
    if (!record || record.sessionId !== sessionId) return false;
    record.leased = false;
    return true;
  }

  /** Consume an output after a completed response. */
  async consume(handle: string, sessionId: string): Promise<boolean> {
    const record = this.retained.get(handle);
    if (!record || record.sessionId !== sessionId) return false;
    await this.deleteRetained(handle);
    return true;
  }

  /**
   * Synchronously consume an output at the `finish` transfer boundary.
   * The record leaves the map before asynchronous directory cleanup, so a
   * trailing `close` can never release the lease back for a replay. Returns
   * false when the handle is unknown or owned by another session.
   */
  consumeSync(handle: string, sessionId: string): boolean {
    const record = this.retained.get(handle);
    if (!record || record.sessionId !== sessionId) return false;
    this.retained.delete(handle);
    const dir = record.jobDir;
    void rm(dir, { recursive: true, force: true }).catch(() => undefined);
    return true;
  }

  /** Explicit discard of a session-bound output. */
  async discard(handle: string, sessionId: string): Promise<boolean> {
    const record = this.retained.get(handle);
    if (!record || record.sessionId !== sessionId) return false;
    await this.deleteRetained(handle);
    return true;
  }

  async sweepExpired(): Promise<void> {
    const at = this.now();
    for (const [handle, record] of this.retained) {
      if (record.expiresAt <= at) await this.deleteRetained(handle);
    }
  }

  /** Remove only owned canonical child directories; ignore the rest. */
  async sweepStartupOrphans(): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(this.tempRoot, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!/^(job-|pages-|compress-)[0-9a-f]{32}$/.test(entry.name)) continue;
      const full = join(this.tempRoot, entry.name);
      try {
        const fileStat = await lstat(full);
        if (!fileStat.isDirectory() || fileStat.isSymbolicLink()) continue;
        if (!isOwnedByCurrentUser(fileStat.uid)) continue;
      } catch {
        continue;
      }
      const owned = [...this.retained.values()].some((record) => record.jobDir === full);
      if (!owned) await rm(full, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.sweeper !== undefined) clearInterval(this.sweeper);
    for (const handle of [...this.retained.keys()]) {
      await this.deleteRetained(handle);
    }
  }

  private async deleteRetained(handle: string): Promise<void> {
    const record = this.retained.get(handle);
    if (!record) return;
    this.retained.delete(handle);
    await rm(record.jobDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    try {
      const entryStat = await lstat(full);
      if (entryStat.isSymbolicLink()) continue;
      if (entryStat.isDirectory()) {
        total += await dirSize(full);
      } else if (entryStat.isFile()) {
        total += entryStat.size;
      }
    } catch {
      continue;
    }
  }
  return total;
}
