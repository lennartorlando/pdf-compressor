import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeTestPdf } from "../../../packages/core/test/pdf-fixtures.js";
import { JobManager } from "../src/jobs.js";
import { createLocalServer } from "../src/server.js";
import { SessionStore } from "../src/session.js";

interface HttpResult {
  status: number;
  body: Buffer;
}

describe("native slot single ownership", () => {
  let scratch = "";
  let jobs: JobManager;
  let server: Server;
  let port = 0;
  let fixture = Buffer.alloc(0);

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

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), "u4f-slot-test-"));
    jobs = await JobManager.create({ tempRoot: join(scratch, "app") });
    const handle = createLocalServer({ sessions: new SessionStore(), jobs });
    server = handle.server;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    port = (server.address() as AddressInfo).port;
    const { readFile } = await import("node:fs/promises");
    const pdfPath = await writeTestPdf(scratch, "slot.pdf", [{ width: 210 }]);
    fixture = await readFile(pdfPath);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await jobs.shutdown();
    await rm(scratch, { recursive: true, force: true });
  });

  it("a stale guard can never release a later acquisition", async () => {
    const manager = await JobManager.create({ tempRoot: join(scratch, "epochs") });
    try {
      const first = manager.acquireNativeSlot();
      expect(first).not.toBeNull();
      // Simulate the legacy interleaving: request A releases internally,
      // request B acquires, then A's outer finally fires late.
      manager.releaseNative();
      const second = manager.acquireNativeSlot();
      expect(second).not.toBeNull();
      expect(manager.isNativeBusy()).toBe(true);
      first?.release();
      // The stale guard from A must leave B's active slot protected.
      expect(manager.isNativeBusy()).toBe(true);
      second?.release();
      expect(manager.isNativeBusy()).toBe(false);
      // Double release of one guard is a single release.
      second?.release();
      expect(manager.isNativeBusy()).toBe(false);
      expect(manager.acquireNativeSlot()).not.toBeNull();
    } finally {
      await manager.shutdown();
    }
  });

  it("one export releases exactly once and the next holder stays protected", async () => {
    const origin = `http://127.0.0.1:${port}`;
    const launched = await new Promise<{ cookie: string; token: string }>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          path: "/api/session/launch",
          method: "POST",
          setHost: false,
          agent: false,
          headers: { host: `127.0.0.1:${port}`, origin }
        },
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

    const nativeRelease = jobs.releaseNative.bind(jobs);
    let innerReleases = 0;
    jobs.releaseNative = (): void => {
      innerReleases += 1;
      nativeRelease();
    };
    try {
      const edge = "slotedge";
      const manifest = JSON.stringify({ version: 1, pages: [{ sourceId: "a", page: 1 }] });
      const head = Buffer.from(
        `--${edge}\r\nContent-Disposition: form-data; name="manifest"\r\nContent-Type: application/json\r\n\r\n${manifest}\r\n` +
          `--${edge}\r\nContent-Disposition: form-data; name="source"; filename="in.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
        "utf8"
      );
      const tail = Buffer.from(`\r\n--${edge}--\r\n`, "utf8");
      const body = Buffer.concat([head, fixture, tail]);
      const result = await call("/api/pages/export", {
        method: "POST",
        headers: {
          origin,
          cookie: launched.cookie,
          "x-launch-token": launched.token,
          "content-type": `multipart/form-data; boundary=${edge}`,
          "content-length": String(body.length)
        },
        body
      });
      expect(result.status).toBe(200);
    } finally {
      jobs.releaseNative = nativeRelease;
    }
    // Route handlers never touch the slot; dispatch releases exactly once.
    expect(innerReleases).toBe(0);
    expect(jobs.isNativeBusy()).toBe(false);

    // A second operation acquired after the first completes stays protected:
    // no trailing release from the first request may clear it.
    expect(jobs.tryAcquireNative()).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(jobs.isNativeBusy()).toBe(true);
    jobs.releaseNative();
    expect(jobs.isNativeBusy()).toBe(false);
  });
});
