import { createReadStream } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { compressPdf, compressionProfiles, isCompressionError, type CompressionProfileName, type CompressionSummary } from "@pdf-compressor/core";

export interface StoredJob {
  id: string;
  dir: string;
  outputPath: string;
  summary: CompressionSummary;
}

export interface CompressionRouteState {
  jobs: Map<string, StoredJob>;
}

export function createCompressionRouteState(): CompressionRouteState {
  return { jobs: new Map() };
}

export async function compressBufferForRequest(
  body: Buffer,
  profile: CompressionProfileName,
  state: CompressionRouteState,
  displayName = "input.pdf"
): Promise<{ status: number; payload: unknown }> {
  if (!compressionProfiles[profile]) {
    return {
      status: 400,
      payload: { ok: false, code: "UNSUPPORTED_PROFILE", message: "Unsupported compression profile." }
    };
  }

  const jobId = randomUUID();
  const jobDir = join(tmpdir(), `pdf-compressor-job-${jobId}`);
  await mkdir(jobDir, { recursive: true });
  const inputPath = join(jobDir, "input.pdf");
  const outputPath = join(jobDir, "output.pdf");

  try {
    await writeFile(inputPath, body);
    const summary = await compressPdf({ inputPath, outputPath, profile });
    await rm(inputPath, { force: true });
    state.jobs.set(jobId, { id: jobId, dir: jobDir, outputPath, summary });
    return {
      status: 200,
      payload: {
        ok: true,
        jobId,
        downloadUrl: `/api/jobs/${jobId}/download`,
        summary: toPublicSummary(summary, displayName)
      }
    };
  } catch (error) {
    await rm(jobDir, { recursive: true, force: true });
    if (isCompressionError(error)) {
      return {
        status: 422,
        payload: { ok: false, code: error.code, message: error.message }
      };
    }
    return {
      status: 500,
      payload: { ok: false, code: "UNKNOWN", message: "Compression failed." }
    };
  }
}

export async function handleCompressionRequest(req: IncomingMessage, res: ServerResponse, state: CompressionRouteState): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");

  if (req.method === "POST" && url.pathname === "/api/compress") {
    const profile = (url.searchParams.get("profile") ?? "balanced") as CompressionProfileName;
    const body = await readRequestBody(req);
    const displayName = Array.isArray(req.headers["x-filename"])
      ? req.headers["x-filename"][0]
      : req.headers["x-filename"];
    const result = await compressBufferForRequest(body, profile, state, displayName ?? "input.pdf");
    writeJson(res, result.status, result.payload);
    return;
  }

  const downloadMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/download$/);
  if (req.method === "GET" && downloadMatch) {
    const job = state.jobs.get(downloadMatch[1]);
    if (!job) {
      writeJson(res, 404, { ok: false, code: "JOB_NOT_FOUND", message: "Job was not found or has expired." });
      return;
    }

    res.writeHead(200, {
      "content-type": "application/pdf",
      "content-disposition": "attachment; filename=\"compressed.pdf\""
    });
    createReadStream(job.outputPath).pipe(res);
    return;
  }

  const deleteMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)$/);
  if (req.method === "DELETE" && deleteMatch) {
    const job = state.jobs.get(deleteMatch[1]);
    if (job) {
      state.jobs.delete(job.id);
      await rm(job.dir, { recursive: true, force: true });
    }
    writeJson(res, 200, { ok: true });
    return;
  }

  writeJson(res, 404, { ok: false, code: "NOT_FOUND", message: "Route not found." });
}

export function createCompressionHttpServer(state = createCompressionRouteState()) {
  return createServer((req, res) => {
    handleCompressionRequest(req, res, state).catch((error) => {
      writeJson(res, 500, { ok: false, code: "UNKNOWN", message: error instanceof Error ? error.message : "Unknown error" });
    });
  });
}

export function toPublicSummary(summary: CompressionSummary, displayName: string): CompressionSummary {
  return {
    ...summary,
    inputPath: displayName,
    outputPath: "compressed.pdf"
  };
}

function writeJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

async function readRequestBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function readFixture(name: string): Promise<Buffer> {
  return readFile(join(process.cwd(), "tests", "fixtures", name));
}
