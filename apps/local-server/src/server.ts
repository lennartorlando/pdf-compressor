import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkApiBoundary, isLoopbackHost } from "./api-guard.js";
import { JobManager } from "./jobs.js";
import { getCapabilities, handlePageExport, writeJson } from "./routes/edit.js";
import { handleCompressRequest } from "./routes/compress.js";
import { SessionStore, type TokenCheck } from "./session.js";

const webRoot = resolve(process.cwd(), "apps", "web", "dist");
export const defaultHost = "127.0.0.1";

export interface LocalServerDeps {
  sessions?: SessionStore;
  jobs?: JobManager;
}

export interface LocalServerHandle {
  server: Server;
  sessions: SessionStore;
  jobs: JobManager;
}

export function createLocalServer(deps: LocalServerDeps = {}): LocalServerHandle {
  const sessions = deps.sessions ?? new SessionStore();
  const jobs = deps.jobs ?? JobManager.createSync();
  const server = createServer((req, res) => {
    void dispatch(req, res, sessions, jobs).catch(() => {
      if (!res.headersSent) {
        writeJson(res, 500, { ok: false, code: "UNKNOWN", message: "Request failed." });
      } else {
        try {
          res.destroy();
        } catch {
          // Best effort.
        }
      }
    });
  });
  return { server, sessions, jobs };
}

/** Test/embedding entrypoint with a fully swept job manager. */
export async function createReadyLocalServer(deps: LocalServerDeps = {}): Promise<LocalServerHandle> {
  const sessions = deps.sessions ?? new SessionStore();
  const jobs = deps.jobs ?? (await JobManager.create());
  const handle = createLocalServer({ sessions, jobs });
  return handle;
}

async function dispatch(
  req: IncomingMessage,
  res: ServerResponse,
  sessions: SessionStore,
  jobs: JobManager
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (!url.pathname.startsWith("/api/")) {
    await serveStatic(req, res);
    return;
  }

  const guard = checkApiBoundary(req);
  if (!guard.ok) {
    const status = guard.failure.code === "NOT_LOOPBACK" ? 403 : 400;
    writeJson(res, status, { ok: false, code: guard.failure.code, message: guard.failure.message });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/session/launch") {
    await handleLaunch(req, res, sessions);
    return;
  }

  // Every other API route requires the session plus its launch token.
  const sessionId = sessions.sessionFromRequest(req);
  const token = sessions.tokenFromRequest(req);
  const check = sessions.verify(sessionId, token);
  if (check !== "ok") {
    writeJson(res, 401, { ok: false, code: tokenCode(check), message: "A valid session and launch token are required." });
    return;
  }
  const authenticated = sessionId as string;

  if (req.method === "POST" && url.pathname === "/api/compress") {
    if (!jobs.tryAcquireNative()) {
      writeJson(res, 429, { ok: false, code: "NATIVE_BUSY", message: "Another native operation is in flight." });
      return;
    }
    try {
      await handleCompressRequest(req, res, url, {
        sessions,
        jobs,
        sessionId: authenticated,
        releaseNative: () => jobs.releaseNative()
      });
    } finally {
      jobs.releaseNative();
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/pages/export") {
    if (!jobs.tryAcquireNative()) {
      writeJson(res, 429, { ok: false, code: "NATIVE_BUSY", message: "Another native operation is in flight." });
      return;
    }
    try {
      await handlePageExport(req, res, url, {
        sessions,
        jobs,
        sessionId: authenticated,
        releaseNative: () => jobs.releaseNative()
      });
    } finally {
      jobs.releaseNative();
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/capabilities") {
    const capabilities = await getCapabilities();
    writeJson(res, 200, { ok: true, capabilities });
    return;
  }

  const downloadMatch = /^\/api\/outputs\/([0-9a-f]{32})\/download$/.exec(url.pathname);
  if (req.method === "GET" && downloadMatch) {
    await handleDownload(req, res, downloadMatch[1], authenticated, jobs);
    return;
  }

  const discardMatch = /^\/api\/outputs\/([0-9a-f]{32})$/.exec(url.pathname);
  if (req.method === "DELETE" && discardMatch) {
    const removed = await jobs.discard(discardMatch[1], authenticated);
    if (!removed) {
      writeJson(res, 404, { ok: false, code: "HANDLE_NOT_FOUND", message: "Output is unavailable." });
      return;
    }
    writeJson(res, 200, { ok: true });
    return;
  }

  // Legacy compression job paths stay unreadable: handles are opaque now.
  const legacyDownload = /^\/api\/jobs\/.+\/download$/.exec(url.pathname);
  const legacyDelete = /^\/api\/jobs\/.+$/.exec(url.pathname);
  if ((req.method === "GET" && legacyDownload) || (req.method === "DELETE" && legacyDelete)) {
    writeJson(res, 404, { ok: false, code: "HANDLE_NOT_FOUND", message: "Output is unavailable." });
    return;
  }

  writeJson(res, 404, { ok: false, code: "NOT_FOUND", message: "Route not found." });
}

function tokenCode(check: TokenCheck): string {
  switch (check) {
    case "missing":
      return "TOKEN_REQUIRED";
    case "expired":
      return "TOKEN_EXPIRED";
    default:
      return "TOKEN_INVALID";
  }
}

async function handleLaunch(req: IncomingMessage, res: ServerResponse, sessions: SessionStore): Promise<void> {
  // Drain any body without interpreting it so the socket stays reusable.
  await drainBody(req);
  sessions.sweep();
  let sessionId = sessions.sessionFromRequest(req);
  if (!sessionId || !sessions.hasSession(sessionId)) {
    const record = sessions.issueSession();
    sessionId = record.id;
  }
  const token = sessions.issueToken(sessionId);
  if (!token) {
    writeJson(res, 500, { ok: false, code: "SESSION_FAILED", message: "Session could not be issued." });
    return;
  }
  res.setHeader("set-cookie", sessions.cookieFor(sessionId));
  writeJson(res, 200, { ok: true, token: token.token, expiresInMs: token.expiresAt - token.createdAt });
}

/**
 * Session-bound leased download. Exactly one transfer holds the lease; a
 * failed transfer releases it for one retry, while a completed response
 * consumes the artifact. `Cache-Control: no-store` is always sent.
 */
async function handleDownload(
  req: IncomingMessage,
  res: ServerResponse,
  handle: string,
  sessionId: string,
  jobs: JobManager
): Promise<void> {
  const leased = jobs.lease(handle, sessionId);
  if (leased.outcome !== "leased" || !leased.record) {
    const code =
      leased.outcome === "forbidden"
        ? "HANDLE_FORBIDDEN"
        : leased.outcome === "expired"
          ? "HANDLE_EXPIRED"
          : leased.outcome === "busy"
            ? "HANDLE_BUSY"
            : "HANDLE_NOT_FOUND";
    const status = code === "HANDLE_BUSY" ? 429 : code === "HANDLE_FORBIDDEN" ? 403 : 404;
    writeJson(res, status, { ok: false, code, message: "Output is unavailable." });
    return;
  }
  const record = leased.record;
  let fileSize = 0;
  try {
    fileSize = (await stat(record.outputPath)).size;
  } catch {
    jobs.release(handle, sessionId);
    writeJson(res, 404, { ok: false, code: "HANDLE_NOT_FOUND", message: "Output is unavailable." });
    return;
  }

  let sourceDone = false;
  let responseDone = false;
  let settled = false;
  const settle = (completed: boolean): void => {
    if (settled) return;
    settled = true;
    if (completed && sourceDone && responseDone) {
      void jobs.consume(handle, sessionId);
    } else {
      jobs.release(handle, sessionId);
    }
  };

  res.writeHead(200, {
    "content-type": "application/pdf",
    "content-length": fileSize,
    "content-disposition": "attachment; filename=\"output.pdf\"",
    "cache-control": "no-store"
  });
  const stream = createReadStream(record.outputPath);
  req.on("close", () => {
    stream.destroy();
    settle(false);
  });
  stream.on("error", () => {
    try {
      res.destroy();
    } catch {
      // Best effort.
    }
    settle(false);
  });
  stream.on("end", () => {
    sourceDone = true;
  });
  res.on("close", () => {
    // `close` fires after `finish` on a completed response.
    if (sourceDone && responseDone) settle(true);
    else settle(false);
  });
  res.on("finish", () => {
    responseDone = true;
    if (sourceDone) settle(true);
  });
  stream.pipe(res);
}

function drainBody(req: IncomingMessage): Promise<void> {
  return new Promise<void>((resolve) => {
    req.on("data", () => undefined);
    req.on("end", () => resolve());
    req.on("error", () => resolve());
    req.on("aborted", () => resolve());
    req.resume();
  });
}

async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = resolve(join(webRoot, requestedPath));
  if (!filePath.startsWith(webRoot)) {
    res.writeHead(403).end("Forbidden");
    return;
  }

  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) throw new Error("Not a file");
    res.writeHead(200, { "content-type": contentType(filePath) });
    createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404).end("Not found");
  }
}

function contentType(filePath: string): string {
  switch (extname(filePath)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}

// Legacy export kept for existing imports.
export function createCompressionHttpServer(): Server {
  return createLocalServer().server;
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  const requestedHost = process.env.HOST ?? defaultHost;
  if (!isLoopbackHost(requestedHost)) {
    console.error(`Refusing to bind a non-loopback host: ${requestedHost}`);
    process.exit(1);
  }
  const start = async (): Promise<void> => {
    const handle = await createReadyLocalServer();
    const port = Number(process.env.PORT ?? 5174);
    handle.server.listen(port, requestedHost, () => {
      console.log(`PDF Compressor running at http://${requestedHost}:${port}`);
    });
    const shutdown = (): void => {
      handle.server.close(() => {
        void handle.jobs.shutdown().finally(() => process.exit(0));
      });
      setTimeout(() => process.exit(1), 5000).unref?.();
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  };
  start().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
