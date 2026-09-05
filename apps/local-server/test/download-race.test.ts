import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JobManager } from "../src/jobs.js";
import { createLocalServer } from "../src/server.js";
import { SessionStore } from "../src/session.js";

interface Authed {
  origin: string;
  cookie: string;
  token: string;
}

/**
 * Repeated HTTP regression for the finish-before-end download race.
 * Each iteration retains a fresh output, downloads it fully, and replays
 * the URL: the replay must be 404 every time. Under the old settle logic a
 * `finish` arriving before the stream `end` released the lease, so replays
 * could flake back to 200. No sleeps or retries in assertions: every
 * request runs to its own `end` and asserts exactly once.
 */
describe("download one-time regression (repeated sequential cycles)", () => {
  let scratch = "";
  let jobs: JobManager;
  let server: Server;
  let port = 0;

  async function launch(): Promise<Authed> {
    const origin = `http://127.0.0.1:${port}`;
    const result = await new Promise<{ cookie: string; token: string }>((resolve, reject) => {
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
    return { origin, ...result };
  }

  function get(
    path: string,
    auth: Authed
  ): Promise<{ status: number; body: Buffer }> {
    return new Promise((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          path,
          method: "GET",
          setHost: false,
          agent: false,
          headers: {
            host: `127.0.0.1:${port}`,
            origin: auth.origin,
            cookie: auth.cookie,
            "x-launch-token": auth.token
          }
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
        }
      );
      req.on("error", reject);
      req.end();
    });
  }

  function pdfBytes(size: number): Buffer {
    const body = Buffer.alloc(size, 0x61);
    body.write("%PDF-1.4\n", 0, "latin1");
    body.write("%%EOF", size - 5, "latin1");
    return body;
  }

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), "u6f-download-race-"));
    jobs = await JobManager.create({ tempRoot: join(scratch, "app") });
    const handle = createLocalServer({ sessions: new SessionStore(), jobs });
    server = handle.server;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await jobs.shutdown();
    await rm(scratch, { recursive: true, force: true });
  });

  it("six sequential download-then-replay cycles stay one-time", async () => {
    const auth = await launch();
    const sessionId = decodeURIComponent(auth.cookie.split("=")[1]);
    for (let cycle = 0; cycle < 6; cycle += 1) {
      const expected = pdfBytes(256 * 1024 + cycle * 1024);
      const { dir } = await jobs.newJobDir("job-");
      await writeFile(join(dir, "output.pdf"), expected);
      const retained = await jobs.retainOutput({ sessionId, jobDir: dir, outputPath: join(dir, "output.pdf"), pageCount: 1 });
      const url = `/api/outputs/${retained.handle}/download`;

      const first = await get(url, auth);
      expect(first.status).toBe(200);
      expect(first.body.equals(expected)).toBe(true);

      const replay = await get(url, auth);
      expect(replay.status).toBe(404);
    }
  });

  it("consumeSync removes the record before async cleanup finishes", async () => {
    const auth = await launch();
    const sessionId = decodeURIComponent(auth.cookie.split("=")[1]);
    const { dir } = await jobs.newJobDir("job-");
    await writeFile(join(dir, "output.pdf"), pdfBytes(4096));
    const retained = await jobs.retainOutput({ sessionId, jobDir: dir, outputPath: join(dir, "output.pdf"), pageCount: 1 });
    const leased = jobs.lease(retained.handle, sessionId);
    expect(leased.outcome).toBe("leased");
    expect(jobs.consumeSync(retained.handle, sessionId)).toBe(true);
    // Synchronously gone: a second lease or release finds nothing.
    expect(jobs.lease(retained.handle, sessionId).outcome).toBe("not_found");
    expect(jobs.release(retained.handle, sessionId)).toBe(false);
    expect(auth.token.length).toBeGreaterThan(0);
  });
});
