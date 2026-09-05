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

describe("download abort lifecycle", () => {
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
  ): Promise<{ status: number; headers: Record<string, string | undefined>; body: Buffer }> {
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
          res.on("end", () => {
            const headers: Record<string, string | undefined> = {};
            for (const [key, value] of Object.entries(res.headers)) {
              headers[key] = Array.isArray(value) ? value.join("; ") : value;
            }
            resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks) });
          });
        }
      );
      req.on("error", reject);
      req.end();
    });
  }

  async function retainPdf(sessionId: string, bytes: Buffer): Promise<{ handle: string; url: string }> {
    const { dir } = await jobs.newJobDir("job-");
    const outputPath = join(dir, "output.pdf");
    await writeFile(outputPath, bytes);
    const retained = await jobs.retainOutput({ sessionId, jobDir: dir, outputPath, pageCount: 1 });
    return { handle: retained.handle, url: `/api/outputs/${retained.handle}/download` };
  }

  function pdfBytes(size: number): Buffer {
    const body = Buffer.alloc(size, 0x61);
    body.write("%PDF-1.4\n", 0, "latin1");
    body.write("%%EOF", size - 5, "latin1");
    return body;
  }

  async function waitForLeaseRelease(handle: string): Promise<void> {
    const deadline = Date.now() + 5000;
    for (;;) {
      if (jobs.peekRetained(handle)?.leased === false) return;
      if (Date.now() > deadline) throw new Error("lease was not released after abort");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), "u4f-download-test-"));
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

  it("a normal completed GET consumes the output", async () => {
    const auth = await launch();
    const sessionId = decodeURIComponent(auth.cookie.split("=")[1]);
    const expected = pdfBytes(64 * 1024);
    const { url } = await retainPdf(sessionId, expected);

    const first = await get(url, auth);
    expect(first.status).toBe(200);
    expect(first.headers["cache-control"]).toBe("no-store");
    expect(first.body.equals(expected)).toBe(true);

    const replay = await get(url, auth);
    expect(replay.status).toBe(404);
  });

  it("an interrupted transfer releases the lease for exactly one retry", async () => {
    const auth = await launch();
    const sessionId = decodeURIComponent(auth.cookie.split("=")[1]);
    const expected = pdfBytes(8 * 1024 * 1024);
    const { handle, url } = await retainPdf(sessionId, expected);

    // Abort mid-download: destroy the client socket on the first chunk.
    let settled = false;
    const received = await new Promise<number>((resolve) => {
      const finish = (bytes: number): void => {
        if (settled) return;
        settled = true;
        resolve(bytes);
      };
      const req = request(
        {
          host: "127.0.0.1",
          port,
          path: url,
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
          let bytes = 0;
          res.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            req.destroy();
          });
          res.on("close", () => finish(bytes));
          res.on("end", () => finish(bytes));
        }
      );
      req.on("error", () => finish(0));
      req.end();
    });
    expect(received).toBeLessThan(expected.length);

    // The failed transfer releases the lease, so one retry stays possible.
    await waitForLeaseRelease(handle);
    const retry = await get(url, auth);
    expect(retry.status).toBe(200);
    expect(retry.body.equals(expected)).toBe(true);

    // The completed retry consumes the artifact.
    const replay = await get(url, auth);
    expect(replay.status).toBe(404);
  });
});
