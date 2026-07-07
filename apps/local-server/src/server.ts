import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createCompressionHttpServer, createCompressionRouteState, handleCompressionRequest } from "./routes/compress.js";

const webRoot = resolve(process.cwd(), "apps", "web", "dist");
export const defaultHost = "127.0.0.1";

export function createLocalServer() {
  const state = createCompressionRouteState();
  return createServer(async (req, res) => {
    if ((req.url ?? "").startsWith("/api/")) {
      await handleCompressionRequest(req, res, state);
      return;
    }
    await serveStatic(req, res);
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
    case ".html": return "text/html; charset=utf-8";
    case ".js": return "text/javascript; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".svg": return "image/svg+xml";
    default: return "application/octet-stream";
  }
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  const server = createLocalServer();
  const port = Number(process.env.PORT ?? 5174);
  const host = process.env.HOST ?? defaultHost;
  server.listen(port, host, () => {
    console.log(`PDF Compressor running at http://${host}:${port}`);
  });
}

export { createCompressionHttpServer };
