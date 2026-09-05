import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  assemblePages,
  compareVersionTuples,
  CompressionError,
  getGhostscriptVersion,
  getQpdfVersion,
  GHOSTSCRIPT_SECURITY_FLOOR,
  parseVersionTuple,
  QPDF_SECURITY_FLOOR,
  type CompressionProfileName
} from "@pdf-compressor/core";
import { parsePageManifest } from "@pdf-compressor/core/page-manifest";
import { LIMITS, type JobManager } from "../jobs.js";
import { assertManifestDepth, MultipartError, streamExportMultipart } from "../multipart.js";
import type { SessionStore } from "../session.js";

export function writeJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(payload));
}

export interface EditRouteContext {
  sessions: SessionStore;
  jobs: JobManager;
  sessionId: string;
}

export interface CapabilityStatus {
  available: boolean;
  version: string | null;
}

export interface Capabilities {
  qpdf: CapabilityStatus;
  ghostscript: CapabilityStatus;
}

/** qpdf and Ghostscript capabilities are probed independently. */
export async function getCapabilities(deps: CapabilityDeps = {}): Promise<Capabilities> {
  const [qpdf, ghostscript] = await Promise.all([
    probe("qpdf", deps.getQpdfVersion),
    probe("gs", deps.getGhostscriptVersion)
  ]);
  return { qpdf, ghostscript };
}

export interface CapabilityDeps {
  getQpdfVersion?: () => Promise<string>;
  getGhostscriptVersion?: () => Promise<string>;
}

/** A readable version below the shared core floor reports unavailable. */
export function meetsNativeFloor(version: string, floor: string): boolean {
  const found = parseVersionTuple(version);
  const required = parseVersionTuple(floor);
  if (!found || !required) return false;
  return compareVersionTuples(found, required) >= 0;
}

async function probe(
  command: "qpdf" | "gs",
  getVersion?: () => Promise<string>
): Promise<CapabilityStatus> {
  try {
    const version =
      getVersion !== undefined
        ? await getVersion()
        : command === "qpdf"
          ? await getQpdfVersion()
          : await getGhostscriptVersion();
    const floor = command === "qpdf" ? QPDF_SECURITY_FLOOR : GHOSTSCRIPT_SECURITY_FLOOR;
    return { available: meetsNativeFloor(version, floor), version };
  } catch {
    return { available: false, version: null };
  }
}

function sanitizeExportError(error: unknown): { status: number; code: string } {
  if (error instanceof MultipartError) return { status: error.status, code: error.code };
  if (error instanceof CompressionError) {
    switch (error.code) {
      case "MANIFEST_INVALID":
      case "MANIFEST_DUPLICATE_SOURCE":
      case "MANIFEST_UNKNOWN_SOURCE":
      case "MANIFEST_INVALID_PAGE":
      case "MANIFEST_PAGE_OUT_OF_RANGE":
      case "MANIFEST_INVALID_ROTATION":
      case "MANIFEST_EMPTY":
      case "OUTPUT_PAGE_LIMIT_EXCEEDED":
        return { status: 400, code: error.code };
      case "OUTPUT_EXISTS":
      case "OUTPUT_WOULD_OVERWRITE_INPUT":
        return { status: 409, code: error.code };
      case "INPUT_NOT_FOUND":
      case "INPUT_NOT_PDF":
      case "INPUT_ENCRYPTED":
      case "INPUT_SIGNED":
      case "INPUT_HAS_ACTIVE_CONTENT":
      case "INSPECTION_INCOMPLETE":
      case "OUTPUT_INVALID":
        return { status: 422, code: error.code };
      case "NATIVE_VERSION_UNSUPPORTED":
      case "ENGINE_UNAVAILABLE":
        return { status: 503, code: error.code };
      case "JOB_CANCELLED":
        return { status: 499, code: error.code };
      case "JOB_TIMEOUT":
        return { status: 504, code: error.code };
      default:
        return { status: 500, code: "EXPORT_FAILED" };
    }
  }
  if (error instanceof Error && error.message === "OUTPUT_TOO_LARGE") {
    return { status: 422, code: "OUTPUT_TOO_LARGE" };
  }
  return { status: 500, code: "EXPORT_FAILED" };
}

function compressionFromUrl(url: URL): CompressionProfileName | null {
  const value = url.searchParams.get("compression");
  if (value === null || value === "none") return null;
  if (value === "conservative" || value === "balanced" || value === "aggressive") return value;
  throw new MultipartError("MANIFEST_INVALID", "Unknown compression profile.", 400);
}

/**
 * Bounded multipart page export. The caller holds the global native slot
 * and releases it after this handler settles. All non-final artifacts are
 * removed on every terminal state; only the validated output is retained.
 * This handler never releases the native slot itself: dispatch is the
 * single owner and releases exactly once per acquisition.
 */
export async function handlePageExport(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: EditRouteContext
): Promise<void> {
  const { jobs } = ctx;
  const claimed = Number(req.headers["content-length"]);
  const expectedIntake = Number.isInteger(claimed) && claimed > 0 ? claimed : LIMITS.maxTotalBytes;
  if (expectedIntake > LIMITS.maxTotalBytes) {
    writeJson(res, 413, { ok: false, code: "TOTAL_TOO_LARGE", message: "Upload exceeds its total byte cap." });
    return;
  }

  const { id: _jobTag, dir: jobDir } = await jobs.newJobDir("pages-");
  void _jobTag;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), jobs.jobTimeoutMs);
  timeout.unref?.();
  // A response that closes before headers are written means the client went
  // away; a completed request stream alone must not cancel native work.
  const onResClose = (): void => {
    if (!res.writableEnded) controller.abort();
  };
  res.on("close", onResClose);

  try {
    const outcome = await runExportWork(req, url, ctx, jobDir, controller);
    // Terminal cleanup completes before the response is written, so every
    // terminal state observably leaves no non-final artifacts behind.
    if (outcome.retainedDir === null) {
      await sweepNonRetained(jobDir);
    }
    writeJson(res, outcome.status, outcome.payload);
  } finally {
    clearTimeout(timeout);
    res.off("close", onResClose);
  }
}

interface ExportOutcome {
  status: number;
  payload: unknown;
  retainedDir: string | null;
}

async function runExportWork(
  req: IncomingMessage,
  url: URL,
  ctx: EditRouteContext,
  jobDir: string,
  controller: AbortController
): Promise<ExportOutcome> {
  const { jobs } = ctx;
  const fail = (status: number, code: string, message: string): ExportOutcome => ({
    status,
    payload: { ok: false, code, message },
    retainedDir: null
  });
  try {
    const intake = await jobs.checkCapacity(
      Number.isInteger(Number(req.headers["content-length"])) && Number(req.headers["content-length"]) > 0
        ? Number(req.headers["content-length"])
        : LIMITS.maxTotalBytes
    );
    if (!intake.ok) {
      return fail(507, intake.code, "Insufficient temporary capacity.");
    }

    const upload = await streamExportMultipart(req, jobDir, controller.signal);

    let parsed: unknown;
    try {
      parsed = JSON.parse(upload.manifestRaw);
    } catch {
      return fail(400, "MANIFEST_INVALID", "Manifest is not valid JSON.");
    }
    try {
      assertManifestDepth(parsed);
    } catch (error) {
      const mapped = sanitizeExportError(error);
      return fail(mapped.status, mapped.code, "Manifest exceeds its shape cap.");
    }
    let manifest;
    try {
      manifest = parsePageManifest(parsed);
    } catch {
      return fail(400, "MANIFEST_INVALID", "Manifest violates its closed schema.");
    }

    let compression: CompressionProfileName | null;
    try {
      compression = compressionFromUrl(url);
    } catch (error) {
      const mapped = sanitizeExportError(error);
      return fail(mapped.status, mapped.code, "Unknown compression profile.");
    }

    // Positional binding: source parts arrive in manifest source order.
    const distinctSources: string[] = [];
    for (const entry of manifest.pages) {
      if (!distinctSources.includes(entry.sourceId)) distinctSources.push(entry.sourceId);
    }
    if (distinctSources.length === 0 || manifest.pages.length === 0) {
      return fail(400, "MANIFEST_EMPTY", "The manifest describes no output pages.");
    }
    if (distinctSources.length > LIMITS.maxSources || manifest.pages.length > LIMITS.maxOutputPages) {
      return fail(400, "OUTPUT_PAGE_LIMIT_EXCEEDED", "Manifest exceeds its size cap.");
    }
    if (upload.sourcePaths.length !== distinctSources.length) {
      return fail(400, "MANIFEST_INVALID", "Source parts do not match the manifest sources.");
    }

    const capabilities = await getCapabilities();
    if (!capabilities.qpdf.available) {
      return fail(503, "EXPORT_UNAVAILABLE", "Page export is unavailable.");
    }
    if (compression !== null && !capabilities.ghostscript.available) {
      return fail(503, "COMPRESSION_UNAVAILABLE", "Compression is unavailable.");
    }

    const outputCapacity = await jobs.checkCapacity(upload.totalBytes + LIMITS.maxOutputBytes);
    if (!outputCapacity.ok) {
      return fail(507, outputCapacity.code, "Insufficient temporary capacity.");
    }

    const bindings = distinctSources.map((id, index) => ({ id, path: upload.sourcePaths[index] }));
    const destinationPath = join(jobDir, "output.pdf");
    const growthGuard = watchOutputGrowth(destinationPath, controller);
    try {
      const summary = await assemblePages({
        sources: bindings,
        manifest,
        destinationPath,
        compression,
        signal: controller.signal,
        timeoutMs: jobs.jobTimeoutMs
      });
      const outputStat = await stat(destinationPath);
      if (outputStat.size > LIMITS.maxOutputBytes) {
        throw new Error("OUTPUT_TOO_LARGE");
      }
      // Keep only the chosen validated output; remove uploads immediately.
      await Promise.all(upload.sourcePaths.map((path) => rm(path, { force: true })));
      const retained = await jobs.retainOutput({
        sessionId: ctx.sessionId,
        jobDir,
        outputPath: destinationPath,
        pageCount: summary.pageCount
      });
      return {
        status: 200,
        payload: {
          ok: true,
          handle: retained.handle,
          downloadUrl: `/api/outputs/${retained.handle}/download`,
          status: summary.status,
          pageCount: summary.pageCount,
          outputBytes: summary.outputBytes,
          engine: summary.engine,
          warnings: summary.warnings,
          compatWarnings: summary.compatWarnings
        },
        retainedDir: jobDir
      };
    } finally {
      growthGuard.stop();
    }
  } catch (error) {
    const mapped = sanitizeExportError(error);
    const message =
      mapped.status === 499
        ? "Export was cancelled."
        : mapped.status === 504
          ? "Export exceeded its runtime budget."
          : mapped.status >= 500
            ? "Export failed."
            : "Export was rejected.";
    return fail(mapped.status, mapped.code, message);
  }
}

/** Abort the job when a candidate grows past the output cap. */
function watchOutputGrowth(candidatePath: string, controller: AbortController): { stop(): void } {
  const timer = setInterval(() => {
    void stat(candidatePath)
      .then((fileStat) => {
        if (fileStat.size > LIMITS.maxOutputBytes) controller.abort();
      })
      .catch(() => undefined);
  }, 250);
  timer.unref?.();
  return {
    stop() {
      clearInterval(timer);
    }
  };
}

async function sweepNonRetained(jobDir: string): Promise<void> {
  // Retained outputs keep their whole job directory; anything else is removed.
  try {
    await rm(jobDir, { recursive: true, force: true });
  } catch {
    // Best effort: startup sweeps reclaim anything left behind.
  }
}
