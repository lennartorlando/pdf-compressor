import { lstat, mkdtemp, mkdir, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeTestPdf } from "../../../packages/core/test/pdf-fixtures.js";
import { JobManager, LIMITS } from "../src/jobs.js";
import { createLocalServer } from "../src/server.js";
import { SessionStore } from "../src/session.js";

interface HttpResult {
  status: number;
  body: Buffer;
}

describe("job lifecycle", () => {
  let scratch = "";
  let jobs: JobManager;
  let server: Server;
  let port = 0;
  let sessions: SessionStore;

  function call(
    path: string,
    options: { method?: string; headers?: Record<string, string>; body?: Buffer } = {}
  ): Promise<HttpResult> {
    return new Promise<HttpResult>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          path,
          method: options.method ?? "GET",
          setHost: false,
          agent: false,
          headers: { host: `127.0.0.1:${port}`, ...options.headers }
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
        }
      );
      req.on("error", reject);
      if (options.body) req.write(options.body);
      req.end();
    });
  }

  async function launchOnce(): Promise<{ origin: string; cookie: string; token: string }> {
    const origin = `http://127.0.0.1:${port}`;
    const { headers, body, status } = await new Promise<{ headers: Record<string, string | string[] | undefined>; body: Buffer; status: number }>(
      (resolve, reject) => {
        const req = request(
          { host: "127.0.0.1", port, path: "/api/session/launch", method: "POST", setHost: false, agent: false, headers: { host: `127.0.0.1:${port}`, origin } },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.on("end", () =>
              resolve({ headers: res.headers as Record<string, string | string[] | undefined>, body: Buffer.concat(chunks), status: res.statusCode ?? 0 })
            );
          }
        );
        req.on("error", reject);
        req.end();
      }
    );
    expect(status).toBe(200);
    const payload = JSON.parse(body.toString("utf8")) as { token: string };
    const rawCookie = headers["set-cookie"];
    const cookie = (Array.isArray(rawCookie) ? rawCookie.join("; ") : (rawCookie ?? "")).split(";")[0];
    return { origin, cookie, token: payload.token };
  }

  function boundary(): string {
    return `----u4life${Date.now().toString(36)}`;
  }

  async function exportOnce(auth: { origin: string; cookie: string; token: string }, pdf: Buffer): Promise<{ handle: string; downloadUrl: string }> {
    const edge = boundary();
    const manifest = JSON.stringify({ version: 1, pages: [{ sourceId: "a", page: 1 }] });
    const head =
      `--${edge}\r\nContent-Disposition: form-data; name="manifest"\r\nContent-Type: application/json\r\n\r\n${manifest}\r\n` +
      `--${edge}\r\nContent-Disposition: form-data; name="source"; filename="in.pdf"\r\nContent-Type: application/pdf\r\n\r\n`;
    const tail = `\r\n--${edge}--\r\n`;
    const body = Buffer.concat([Buffer.from(head, "utf8"), pdf, Buffer.from(tail, "utf8")]);
    const result = await call("/api/pages/export", {
      method: "POST",
      headers: {
        origin: auth.origin,
        cookie: auth.cookie,
        "x-launch-token": auth.token,
        "content-type": `multipart/form-data; boundary=${edge}`,
        "content-length": String(body.length)
      },
      body
    });
    expect(result.status).toBe(200);
    return JSON.parse(result.body.toString("utf8")) as { handle: string; downloadUrl: string };
  }

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), "u4-life-test-"));
    sessions = new SessionStore();
    jobs = await JobManager.create({ tempRoot: join(scratch, "app") });
    const handle = createLocalServer({ sessions, jobs });
    server = handle.server;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    port = (server.address() as AddressInfo).port;
    await writeTestPdf(scratch, "life.pdf", [{ width: 210 }]);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await jobs.shutdown();
    await rm(scratch, { recursive: true, force: true });
  });

  it("leases one transfer, releases on failure semantics, and consumes after completion", async () => {
    const { readFile } = await import("node:fs/promises");
    const pdf = await readFile(join(scratch, "life.pdf"));
    const auth = await launchOnce();
    const { handle, downloadUrl } = await exportOnce(auth, pdf);

    // Wrong session cannot lease.
    const other = await launchOnce();
    const forbidden = await call(downloadUrl, {
      headers: { origin: other.origin, cookie: other.cookie, "x-launch-token": other.token }
    });
    expect(forbidden.status).toBe(403);
    expect(JSON.parse(forbidden.body.toString("utf8"))).toMatchObject({ ok: false, code: "HANDLE_FORBIDDEN" });

    // Owning session downloads, then the artifact is consumed.
    const first = await call(downloadUrl, {
      headers: { origin: auth.origin, cookie: auth.cookie, "x-launch-token": auth.token }
    });
    expect(first.status).toBe(200);
    const replay = await call(downloadUrl, {
      headers: { origin: auth.origin, cookie: auth.cookie, "x-launch-token": auth.token }
    });
    expect(replay.status).toBe(404);
    void handle;
  });

  it("drives the lease state machine deterministically", async () => {
    const manager = await JobManager.create({ tempRoot: join(scratch, "leases") });
    try {
      const { dir } = await manager.newJobDir("job-");
      const outputPath = join(dir, "output.pdf");
      await writeFile(outputPath, Buffer.from("%PDF-1.4\n%EOF\n", "latin1"));
      const retained = await manager.retainOutput({ sessionId: "s1", jobDir: dir, outputPath, pageCount: 1 });

      expect(manager.lease(retained.handle, "s2").outcome).toBe("forbidden");
      expect(manager.lease(retained.handle, "s1").outcome).toBe("leased");
      expect(manager.lease(retained.handle, "s1").outcome).toBe("busy");
      expect(manager.release(retained.handle, "s1")).toBe(true);
      expect(manager.lease(retained.handle, "s1").outcome).toBe("leased");
      expect(await manager.consume(retained.handle, "s1")).toBe(true);
      expect(manager.lease(retained.handle, "s1").outcome).toBe("not_found");
    } finally {
      await manager.shutdown();
    }
  });

  it("supports explicit discard", async () => {
    const { readFile } = await import("node:fs/promises");
    const pdf = await readFile(join(scratch, "life.pdf"));
    const auth = await launchOnce();
    const { downloadUrl } = await exportOnce(auth, pdf);
    const handle = downloadUrl.split("/")[3];
    const discarded = await call(`/api/outputs/${handle}`, {
      method: "DELETE",
      headers: { origin: auth.origin, cookie: auth.cookie, "x-launch-token": auth.token }
    });
    expect(discarded.status).toBe(200);
    const after = await call(downloadUrl, {
      headers: { origin: auth.origin, cookie: auth.cookie, "x-launch-token": auth.token }
    });
    expect(after.status).toBe(404);
  });

  it("expires retained outputs after TTL and removes their directories", async () => {
    const manager = await JobManager.create({ tempRoot: join(scratch, "ttl"), outputTtlMs: 40 });
    try {
      const { dir } = await manager.newJobDir("job-");
      const outputPath = join(dir, "output.pdf");
      await writeFile(outputPath, Buffer.from("%PDF-1.4\n%EOF\n", "latin1"));
      const retained = await manager.retainOutput({ sessionId: "s1", jobDir: dir, outputPath, pageCount: 1 });
      await new Promise((resolve) => setTimeout(resolve, 80));
      await manager.sweepExpired();
      expect(manager.peekRetained(retained.handle)).toBeUndefined();
      await expect(stat(dir)).rejects.toThrow();
    } finally {
      await manager.shutdown();
    }
  });

  it("evicts the oldest output beyond the retained cap", async () => {
    const { readFile } = await import("node:fs/promises");
    const pdf = await readFile(join(scratch, "life.pdf"));
    const auth = await launchOnce();
    const first = await exportOnce(auth, pdf);
    const second = await exportOnce(auth, pdf);
    const third = await exportOnce(auth, pdf);
    expect(jobs.retainedCount()).toBeLessThanOrEqual(LIMITS.maxRetainedOutputs);
    const evicted = await call(first.downloadUrl, {
      headers: { origin: auth.origin, cookie: auth.cookie, "x-launch-token": auth.token }
    });
    expect(evicted.status).toBe(404);
    const live = await call(third.downloadUrl, {
      headers: { origin: auth.origin, cookie: auth.cookie, "x-launch-token": auth.token }
    });
    expect(live.status).toBe(200);
    // Drain the second retained output so later tests start clean.
    const drain = await call(second.downloadUrl, {
      headers: { origin: auth.origin, cookie: auth.cookie, "x-launch-token": auth.token }
    });
    expect([200, 404]).toContain(drain.status);
  });

  it("enforces temp-quota and free-disk boundaries before allocation", async () => {
    const manager = await JobManager.create({ tempRoot: join(scratch, "capacity") });
    try {
      expect(await manager.checkCapacity(LIMITS.maxTempBytes + 1)).toMatchObject({
        ok: false,
        code: "TEMP_QUOTA_EXCEEDED"
      });
      // The 1 GiB free-disk reserve only rejects when the disk is actually
      // low; here the disk is plentiful, so small intakes pass both checks.
      const free = await manager.freeBytes();
      expect(typeof free).toBe("number");
      expect(free as number).toBeGreaterThan(LIMITS.minFreeBytes);
      expect(await manager.checkCapacity(1024)).toMatchObject({ ok: true });
    } finally {
      await manager.shutdown();
    }
  });

  it("rejects outputs past the output byte cap", async () => {
    const { truncate } = await import("node:fs/promises");
    const manager = await JobManager.create({ tempRoot: join(scratch, "oversize") });
    try {
      const { dir } = await manager.newJobDir("job-");
      const outputPath = join(dir, "output.pdf");
      await writeFile(outputPath, Buffer.from("%PDF-1.4\n%EOF\n", "latin1"));
      await truncate(outputPath, LIMITS.maxOutputBytes + 1);
      await expect(manager.retainOutput({ sessionId: "s1", jobDir: dir, outputPath, pageCount: 1 })).rejects.toThrow(
        "OUTPUT_TOO_LARGE"
      );
      await rm(dir, { recursive: true, force: true });
    } finally {
      await manager.shutdown();
    }
  });

  it("fails a job past its runtime budget without leaking its workspace", async () => {
    const { readFile } = await import("node:fs/promises");
    const pdf = await readFile(join(scratch, "life.pdf"));
    const tightJobs = await JobManager.create({ tempRoot: join(scratch, "timeout"), jobTimeoutMs: 1 });
    const tightHandle = createLocalServer({ sessions: new SessionStore(), jobs: tightJobs });
    await new Promise<void>((resolve) => tightHandle.server.listen(0, "127.0.0.1", () => resolve()));
    const tightPort = (tightHandle.server.address() as AddressInfo).port;
    try {
      const origin = `http://127.0.0.1:${tightPort}`;
      const launched = await new Promise<{ cookie: string; token: string }>((resolve, reject) => {
        const req = request(
          { host: "127.0.0.1", port: tightPort, path: "/api/session/launch", method: "POST", setHost: false, agent: false, headers: { host: `127.0.0.1:${tightPort}`, origin } },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.on("end", () => {
              const raw = res.headers["set-cookie"];
              resolve({
                cookie: (Array.isArray(raw) ? raw.join("; ") : (raw ?? "")).split(";")[0],
                token: (JSON.parse(Buffer.concat(chunks).toString("utf8")) as { token: string }).token
              });
            });
          }
        );
        req.on("error", reject);
        req.end();
      });
      const edge = "timeoutedge";
      const manifest = JSON.stringify({ version: 1, pages: [{ sourceId: "a", page: 1 }] });
      const head = Buffer.from(
        `--${edge}\r\nContent-Disposition: form-data; name="manifest"\r\nContent-Type: application/json\r\n\r\n${manifest}\r\n` +
          `--${edge}\r\nContent-Disposition: form-data; name="source"; filename="in.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
        "utf8"
      );
      const tail = Buffer.from(`\r\n--${edge}--\r\n`, "utf8");
      const body = Buffer.concat([head, pdf, tail]);
      const result = await new Promise<HttpResult>((resolve, reject) => {
        const req = request(
          {
            host: "127.0.0.1",
            port: tightPort,
            path: "/api/pages/export",
            method: "POST",
            setHost: false,
            agent: false,
            headers: {
              host: `127.0.0.1:${tightPort}`,
              origin,
              cookie: launched.cookie,
              "x-launch-token": launched.token,
              "content-type": `multipart/form-data; boundary=${edge}`,
              "content-length": String(body.length)
            }
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
          }
        );
        req.on("error", reject);
        req.write(body);
        req.end();
      });
      expect([499, 504]).toContain(result.status);
      expect(await readdir(tightJobs.tempRoot)).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => tightHandle.server.close(() => resolve()));
      await tightJobs.shutdown();
    }
  });

  it("creates user-only job workspaces", async () => {
    const { dir } = await jobs.newJobDir("job-");
    try {
      const dirStat = await stat(dir);
      expect(dirStat.mode & 0o777).toBe(0o700);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("ignores hostile symlinks and foreign entries during startup sweeps", async () => {
    const root = await mkdtemp(join(tmpdir(), "u4-sweep-"));
    try {
      const orphan = join(root, `job-${"a".repeat(32)}`);
      await mkdir(orphan, { recursive: true });
      await writeFile(join(orphan, "stale.pdf"), Buffer.from("stale"));
      const foreign = join(root, "not-a-job");
      await mkdir(foreign, { recursive: true });
      await symlink(join("nowhere"), join(root, "link-job"), "dir").catch(() => undefined);
      const manager = await JobManager.create({ tempRoot: root });
      try {
        await expect(stat(orphan)).rejects.toThrow();
        expect((await stat(foreign)).isDirectory()).toBe(true);
        const linkStat = await lstat(join(root, "link-job")).catch(() => null);
        if (linkStat) expect(linkStat.isSymbolicLink()).toBe(true);
      } finally {
        await manager.shutdown();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
