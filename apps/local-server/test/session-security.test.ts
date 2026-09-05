import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkApiBoundary } from "../src/api-guard.js";
import { JobManager } from "../src/jobs.js";
import { createLocalServer, type LocalServerHandle } from "../src/server.js";
import { SessionStore } from "../src/session.js";

interface HttpResult {
  status: number;
  headers: Record<string, string | undefined>;
  body: string;
}

function fakeReq(overrides: {
  remoteAddress?: string;
  host?: string;
  origin?: string;
  fetchSite?: string;
}): Parameters<typeof checkApiBoundary>[0] {
  return {
    socket: { remoteAddress: overrides.remoteAddress ?? "127.0.0.1" },
    headers: {
      ...(overrides.host !== undefined ? { host: overrides.host } : { host: "127.0.0.1:5174" }),
      ...(overrides.origin !== undefined ? { origin: overrides.origin } : {}),
      ...(overrides.fetchSite !== undefined ? { "sec-fetch-site": overrides.fetchSite } : {})
    }
  } as unknown as Parameters<typeof checkApiBoundary>[0];
}

describe("loopback api guard", () => {
  it("accepts a same-origin loopback request", () => {
    const result = checkApiBoundary(
      fakeReq({ origin: "http://127.0.0.1:5174", fetchSite: "same-origin" })
    );
    expect(result).toEqual({ ok: true });
  });

  it("rejects non-loopback peers, unexpected hosts, foreign origins, and cross-site metadata", () => {
    expect(checkApiBoundary(fakeReq({ remoteAddress: "192.168.1.10" }))).toMatchObject({
      ok: false,
      failure: { code: "NOT_LOOPBACK" }
    });
    expect(checkApiBoundary(fakeReq({ host: "evil.example:5174" }))).toMatchObject({
      ok: false,
      failure: { code: "BAD_HOST" }
    });
    expect(checkApiBoundary(fakeReq({ origin: "https://evil.example" }))).toMatchObject({
      ok: false,
      failure: { code: "BAD_ORIGIN" }
    });
    expect(checkApiBoundary(fakeReq({ fetchSite: "cross-site" }))).toMatchObject({
      ok: false,
      failure: { code: "CROSS_SITE_REQUEST" }
    });
    expect(checkApiBoundary(fakeReq({ fetchSite: "same-site" }))).toMatchObject({
      ok: false,
      failure: { code: "CROSS_SITE_REQUEST" }
    });
  });

  it("allows loopback origins on any loopback hostname", () => {
    expect(checkApiBoundary(fakeReq({ host: "localhost:5174", origin: "http://localhost:5174" }))).toEqual({
      ok: true
    });
    expect(checkApiBoundary(fakeReq({ host: "[::1]:5174", origin: "http://[::1]:5174" }))).toEqual({ ok: true });
  });
});

describe("launch session security", () => {
  let scratch = "";
  let jobs: JobManager;
  let handle: LocalServerHandle;
  let server: Server;
  let port = 0;

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
          res.on("end", () => {
            const headers: Record<string, string | undefined> = {};
            for (const [key, value] of Object.entries(res.headers)) {
              headers[key] = Array.isArray(value) ? value.join("; ") : value;
            }
            resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks).toString("utf8") });
          });
        }
      );
      req.on("error", reject);
      if (options.body) req.write(options.body);
      req.end();
    });
  }

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), "u4-session-test-"));
    jobs = await JobManager.create({ tempRoot: join(scratch, "app") });
    handle = createLocalServer({ sessions: new SessionStore(), jobs });
    server = handle.server;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await jobs.shutdown();
    await rm(scratch, { recursive: true, force: true });
  });

  it("issues a token bound to a SameSite=Strict session", async () => {
    const result = await call("/api/session/launch", { method: "POST" });
    expect(result.status).toBe(200);
    const payload = JSON.parse(result.body) as { ok: boolean; token: string; expiresInMs: number };
    expect(payload.ok).toBe(true);
    expect(payload.token).toMatch(/^[0-9a-f]{64}$/);
    expect(payload.expiresInMs).toBeLessThanOrEqual(5 * 60 * 1000);
    expect(result.headers["set-cookie"] ?? "").toMatch(/pc_session=[0-9a-f]{32}; .*Path=\/; .*HttpOnly; .*SameSite=Strict/);
  });

  it("rejects token issuance for foreign origins before allocating anything", async () => {
    const result = await call("/api/session/launch", {
      method: "POST",
      headers: { origin: "https://evil.example" }
    });
    expect(result.status).toBe(400);
    expect(JSON.parse(result.body)).toMatchObject({ ok: false, code: "BAD_ORIGIN" });
    expect(await readdir(jobs.tempRoot)).toEqual([]);
    expect(handle.sessions.sessionCount()).toBeGreaterThanOrEqual(0);
  });

  it("rejects token issuance for unexpected hosts and cross-site metadata", async () => {
    const badHost = await call("/api/session/launch", {
      method: "POST",
      headers: { host: "evil.example" }
    });
    expect(badHost.status).toBe(400);
    expect(JSON.parse(badHost.body)).toMatchObject({ ok: false, code: "BAD_HOST" });

    const crossSite = await call("/api/session/launch", {
      method: "POST",
      headers: { origin: `http://127.0.0.1:${port}`, "sec-fetch-site": "cross-site" }
    });
    expect(crossSite.status).toBe(400);
    expect(JSON.parse(crossSite.body)).toMatchObject({ ok: false, code: "CROSS_SITE_REQUEST" });
    expect(await readdir(jobs.tempRoot)).toEqual([]);
  });

  it("requires the session plus token on protected routes", async () => {
    const origin = `http://127.0.0.1:${port}`;
    const launch = await call("/api/session/launch", { method: "POST", headers: { origin } });
    const cookie = (launch.headers["set-cookie"] ?? "").split(";")[0];
    const token = (JSON.parse(launch.body) as { token: string }).token;

    const anonymous = await call("/api/capabilities", { headers: { origin } });
    expect(anonymous.status).toBe(401);
    expect(JSON.parse(anonymous.body)).toMatchObject({ ok: false, code: "TOKEN_REQUIRED" });

    const wrongSession = await call("/api/capabilities", {
      headers: { origin, cookie: "pc_session=00000000000000000000000000000000", "x-launch-token": token }
    });
    expect(wrongSession.status).toBe(401);
    expect(JSON.parse(wrongSession.body)).toMatchObject({ ok: false, code: "TOKEN_INVALID" });

    const wrongToken = await call("/api/capabilities", {
      headers: { origin, cookie, "x-launch-token": "f".repeat(64) }
    });
    expect(wrongToken.status).toBe(401);
    expect(JSON.parse(wrongToken.body)).toMatchObject({ ok: false, code: "TOKEN_INVALID" });

    const authorized = await call("/api/capabilities", {
      headers: { origin, cookie, "x-launch-token": token }
    });
    expect(authorized.status).toBe(200);
    expect(JSON.parse(authorized.body)).toMatchObject({ ok: true });
  });

  it("rejects expired tokens", async () => {
    const expiring = new SessionStore({ tokenTtlMs: 0 });
    const expiringJobs = await JobManager.create({ tempRoot: join(scratch, "expiring") });
    const expiringHandle = createLocalServer({ sessions: expiring, jobs: expiringJobs });
    await new Promise<void>((resolve) => expiringHandle.server.listen(0, "127.0.0.1", () => resolve()));
    const expiringPort = (expiringHandle.server.address() as AddressInfo).port;
    try {
      const launch = await new Promise<HttpResult>((resolve, reject) => {
        const req = request(
          { host: "127.0.0.1", port: expiringPort, path: "/api/session/launch", method: "POST", setHost: false,
          agent: false, headers: { host: `127.0.0.1:${expiringPort}` } },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: {}, body: Buffer.concat(chunks).toString("utf8") }));
          }
        );
        req.on("error", reject);
        req.end();
      });
      expect(launch.status).toBe(200);
    } finally {
      await new Promise<void>((resolve) => expiringHandle.server.close(() => resolve()));
      await expiringJobs.shutdown();
    }
    // A zero-TTL store expires tokens immediately at verify time.
    const session = expiring.issueSession();
    const issued = expiring.issueToken(session.id);
    expect(issued).not.toBeNull();
    expect(expiring.verify(session.id, issued?.token ?? null)).toBe("expired");
  });

  it("never emits temp paths in rejection bodies", async () => {
    const result = await call("/api/session/launch", {
      method: "POST",
      headers: { origin: "https://evil.example" }
    });
    expect(result.body).not.toContain(scratch);
    expect(result.body).not.toContain("tmp");
  });
});
