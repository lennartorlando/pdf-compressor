import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import Busboy from "@fastify/busboy";
import { LIMITS } from "./jobs.js";

export type MultipartFailureCode =
  | "NOT_MULTIPART"
  | "MISSING_MANIFEST"
  | "MANIFEST_TOO_LARGE"
  | "MANIFEST_INVALID"
  | "DUPLICATE_MANIFEST"
  | "UNKNOWN_PART"
  | "DUPLICATE_PART"
  | "TOO_MANY_PARTS"
  | "TOO_MANY_SOURCES"
  | "TOO_MANY_HEADERS"
  | "SOURCE_TOO_LARGE"
  | "TOTAL_TOO_LARGE"
  | "UPLOAD_ABORTED";

export class MultipartError extends Error {
  readonly status: number;
  constructor(
    readonly code: MultipartFailureCode,
    message: string,
    status = 400
  ) {
    super(message);
    this.name = "MultipartError";
    this.status = status;
  }
}

export interface StreamedUpload {
  /** Bounded manifest field bytes (never a file-sized buffer). */
  manifestRaw: string;
  /** Server-generated private paths, one per source part, in arrival order. */
  sourcePaths: string[];
  sourceBytes: number[];
  /** Aggregate of manifest field bytes plus all source bytes. */
  totalBytes: number;
}

interface FileStreamLike {
  truncated: boolean;
  bytesRead: number;
  pipe(dest: NodeJS.WritableStream): NodeJS.WritableStream;
  pause(): void;
  resume(): void;
  destroy(): void;
  on(event: string, listener: (...args: never[]) => void): void;
  once(event: string, listener: (...args: never[]) => void): void;
}

interface BusboyInstanceLike {
  on(event: string, listener: (...args: never[]) => void): void;
  emit(event: string, ...args: never[]): boolean;
}

/**
 * Stream exactly one bounded manifest field plus generated source parts
 * into a private per-job directory. Each source is written once to a
 * server-generated name; client filenames are never persisted. No
 * file-sized JavaScript buffer is retained.
 */
export function streamExportMultipart(
  req: IncomingMessage,
  jobDir: string,
  signal?: AbortSignal
): Promise<StreamedUpload> {
  const contentType = req.headers["content-type"];
  if (typeof contentType !== "string" || !contentType.includes("multipart/form-data")) {
    return Promise.reject(new MultipartError("NOT_MULTIPART", "Export requires multipart form data.", 415));
  }

  return new Promise<StreamedUpload>((resolve, reject) => {
    let settled = false;
    const writtenPaths: string[] = [];
    const cleanup = (): Promise<void> =>
      Promise.all(writtenPaths.map((path) => rm(path, { force: true }).catch(() => undefined))).then(() => undefined);

    const fail = (error: MultipartError): void => {
      if (settled) return;
      settled = true;
      try {
        req.unpipe(busboy as unknown as import("node:stream").Writable);
      } catch {
        // Best effort: the parser may already be torn down.
      }
      void cleanup().finally(() => reject(error));
    };

    const succeed = (upload: StreamedUpload): void => {
      if (settled) return;
      settled = true;
      resolve(upload);
    };

    let busboy: BusboyInstanceLike;
    try {
      const ctor = Busboy as unknown as new (options: Record<string, unknown>) => BusboyInstanceLike;
      busboy = new ctor({
        headers: req.headers,
        limits: {
          fieldNameSize: 128,
          fieldSize: LIMITS.maxManifestBytes + 1,
          fields: 2,
          files: LIMITS.maxSources,
          parts: LIMITS.maxParts,
          headerPairs: LIMITS.maxHeaderPairs
        }
      });
    } catch {
      reject(new MultipartError("NOT_MULTIPART", "Export requires multipart form data.", 415));
      return;
    }

    if (signal?.aborted) {
      fail(new MultipartError("UPLOAD_ABORTED", "Upload was cancelled.", 499));
      return;
    }

    let manifestRaw: string | null = null;
    let manifestCount = 0;
    const sourcePaths: string[] = [];
    const sourceBytes: number[] = [];
    let totalBytes = 0;
    let partCount = 0;
    let sourceIndex = 0;
    const pendingWrites: Promise<void>[] = [];

    const onAbort = (): void => fail(new MultipartError("UPLOAD_ABORTED", "Upload was cancelled.", 499));
    signal?.addEventListener("abort", onAbort, { once: true });

    const finishSweep = (): void => {
      signal?.removeEventListener("abort", onAbort);
    };

    busboy.on("field", ((fieldname: string, value: string, _truncated: boolean, valueTruncated: boolean) => {
      partCount += 1;
      if (partCount > LIMITS.maxParts) {
        fail(new MultipartError("TOO_MANY_PARTS", "Too many multipart sections.", 413));
        return;
      }
      if (fieldname !== "manifest") {
        fail(new MultipartError("UNKNOWN_PART", "Unknown multipart field.", 400));
        return;
      }
      manifestCount += 1;
      if (manifestCount > 1) {
        fail(new MultipartError("DUPLICATE_MANIFEST", "Only one manifest is accepted.", 400));
        return;
      }
      if (valueTruncated || Buffer.byteLength(value, "utf8") > LIMITS.maxManifestBytes) {
        fail(new MultipartError("MANIFEST_TOO_LARGE", "Manifest exceeds its byte cap.", 413));
        return;
      }
      // The aggregate cap covers manifest field bytes as well as source
      // bytes; the manifest stays a bounded field, never a file buffer.
      totalBytes += Buffer.byteLength(value, "utf8");
      if (totalBytes > LIMITS.maxTotalBytes) {
        fail(new MultipartError("TOTAL_TOO_LARGE", "Upload exceeds its total byte cap.", 413));
        return;
      }
      manifestRaw = value;
    }) as (...args: never[]) => void);

    busboy.on("file", ((fieldname: string, stream: FileStreamLike) => {
      partCount += 1;
      if (partCount > LIMITS.maxParts) {
        stream.resume();
        fail(new MultipartError("TOO_MANY_PARTS", "Too many multipart sections.", 413));
        return;
      }
      if (fieldname !== "source") {
        stream.resume();
        fail(new MultipartError("UNKNOWN_PART", "Unknown multipart file part.", 400));
        return;
      }
      if (sourceIndex >= LIMITS.maxSources) {
        stream.resume();
        fail(new MultipartError("TOO_MANY_SOURCES", "Too many source files.", 413));
        return;
      }
      const slot = sourceIndex;
      sourceIndex += 1;
      const target = join(jobDir, `source-${slot}.pdf`);
      writtenPaths.push(target);
      sourcePaths.push(target);
      sourceBytes.push(0);
      const out = createWriteStream(target, { mode: 0o600 });
      let fileBytes = 0;
      let fileFailed = false;
      const writeDone = new Promise<void>((resolveWrite, rejectWrite) => {
        stream.on("data", ((chunk: Buffer) => {
          const size = chunk.length;
          fileBytes += size;
          totalBytes += size;
          if (fileBytes > LIMITS.maxSourceBytes) {
            fileFailed = true;
            fail(new MultipartError("SOURCE_TOO_LARGE", "A source exceeds its byte cap.", 413));
            stream.destroy();
            out.destroy();
            rejectWrite(new Error("source too large"));
            return;
          }
          if (totalBytes > LIMITS.maxTotalBytes) {
            fileFailed = true;
            fail(new MultipartError("TOTAL_TOO_LARGE", "Upload exceeds its total byte cap.", 413));
            stream.destroy();
            out.destroy();
            rejectWrite(new Error("total too large"));
            return;
          }
          sourceBytes[slot] = fileBytes;
          if (!out.write(chunk)) {
            stream.pause();
            out.once("drain", () => stream.resume());
          }
        }) as (...args: never[]) => void);
        stream.on("limit", (() => {
          fileFailed = true;
          fail(new MultipartError("SOURCE_TOO_LARGE", "A source exceeds its byte cap.", 413));
          out.destroy();
          rejectWrite(new Error("source too large"));
        }) as (...args: never[]) => void);
        stream.on("end", (() => {
          if (fileFailed) return;
          if ((stream.truncated as boolean) === true) {
            fileFailed = true;
            fail(new MultipartError("SOURCE_TOO_LARGE", "A source exceeds its byte cap.", 413));
            out.destroy();
            rejectWrite(new Error("source too large"));
            return;
          }
          out.end(() => resolveWrite());
        }) as (...args: never[]) => void);
        stream.on("error", (() => {
          fileFailed = true;
          out.destroy();
          fail(new MultipartError("UPLOAD_ABORTED", "A source stream failed.", 499));
          rejectWrite(new Error("source stream failed"));
        }) as (...args: never[]) => void);
        out.on("error", () => {
          fileFailed = true;
          stream.destroy();
          fail(new MultipartError("UPLOAD_ABORTED", "A source could not be stored.", 499));
          rejectWrite(new Error("source write failed"));
        });
      });
      pendingWrites.push(writeDone);
      // Observe teardown rejections even when the parser never reaches
      // `finish` after an unpipe, so a capped upload cannot surface an
      // unhandled rejection. The `finish` handler still settles the outcome.
      writeDone.catch(() => undefined);
    }) as (...args: never[]) => void);

    busboy.on("partsLimit", (() => {
      fail(new MultipartError("TOO_MANY_PARTS", "Too many multipart sections.", 413));
    }) as (...args: never[]) => void);

    busboy.on("filesLimit", (() => {
      fail(new MultipartError("TOO_MANY_SOURCES", "Too many source files.", 413));
    }) as (...args: never[]) => void);

    busboy.on("fieldsLimit", (() => {
      fail(new MultipartError("DUPLICATE_MANIFEST", "Only one manifest is accepted.", 400));
    }) as (...args: never[]) => void);

    busboy.on("error", ((err: Error) => {
      const message = err?.message ?? "";
      if (/header/i.test(message)) {
        fail(new MultipartError("TOO_MANY_HEADERS", "Too many multipart headers.", 413));
        return;
      }
      fail(new MultipartError("UPLOAD_ABORTED", "Upload could not be parsed.", 400));
    }) as (...args: never[]) => void);

    busboy.on("finish", (() => {
      if (settled) return;
      if (manifestRaw === null) {
        fail(new MultipartError("MISSING_MANIFEST", "Export requires exactly one manifest.", 400));
        return;
      }
      const manifest = manifestRaw;
      void Promise.allSettled(pendingWrites).then((outcomes) => {
        finishSweep();
        if (settled) return;
        if (outcomes.some((outcome) => outcome.status === "rejected")) {
          fail(new MultipartError("UPLOAD_ABORTED", "A source could not be stored.", 499));
          return;
        }
        succeed({ manifestRaw: manifest, sourcePaths, sourceBytes, totalBytes });
      });
    }) as (...args: never[]) => void);

    req.on("aborted", () => fail(new MultipartError("UPLOAD_ABORTED", "Client disconnected during upload.", 499)));
    req.on("error", () => fail(new MultipartError("UPLOAD_ABORTED", "Upload transport failed.", 499)));
    req.pipe(busboy as unknown as import("node:stream").Writable);
  });
}

/**
 * Bounded JSON depth check for the closed-schema manifest (primitives are
 * depth 0; each array/object level adds one).
 */
export function jsonDepth(value: unknown): number {
  if (Array.isArray(value)) {
    let deepest = 0;
    for (const entry of value) deepest = Math.max(deepest, jsonDepth(entry));
    return deepest + 1;
  }
  if (typeof value === "object" && value !== null) {
    let deepest = 0;
    for (const key of Object.keys(value)) {
      deepest = Math.max(deepest, jsonDepth((value as Record<string, unknown>)[key]));
    }
    return deepest + 1;
  }
  return 0;
}

export function assertManifestDepth(value: unknown): void {
  if (jsonDepth(value) > LIMITS.maxJsonDepth) {
    throw new MultipartError("MANIFEST_INVALID", "Manifest exceeds its JSON depth cap.", 400);
  }
}
