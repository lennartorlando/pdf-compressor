import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LIMITS } from "../src/jobs.js";
import { MultipartError, streamExportMultipart } from "../src/multipart.js";

describe("multipart aggregate byte cap", () => {
  let jobDir = "";
  let scratch = "";

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), "u4f-multi-test-"));
    jobDir = join(scratch, "job");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(jobDir, { recursive: true });
  });

  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  function streamBody(body: Buffer, contentType: string): Promise<{
    manifestRaw: string;
    sourcePaths: string[];
    sourceBytes: number[];
    totalBytes: number;
  }> {
    const req = new PassThrough() as PassThrough & {
      headers: Record<string, string>;
    };
    req.headers = { "content-type": contentType, "content-length": String(body.length) };
    const pending = streamExportMultipart(req as unknown as IncomingMessage, jobDir);
    req.end(body);
    return pending;
  }

  function buildMultipart(boundary: string, manifest: string, sources: Buffer[]): Buffer {
    const chunks: Buffer[] = [];
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="manifest"\r\nContent-Type: application/json\r\n\r\n${manifest}\r\n`,
        "utf8"
      )
    );
    for (const source of sources) {
      chunks.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="source"; filename="s.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
          "utf8"
        ),
        source,
        Buffer.from("\r\n", "utf8")
      );
    }
    chunks.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
    return Buffer.concat(chunks);
  }

  it("counts manifest field bytes in the aggregate total", async () => {
    const manifest = JSON.stringify({ version: 1, pages: [{ sourceId: "a", page: 1 }] });
    const source = Buffer.alloc(1024, 0x25);
    const boundary = "aggregateedge";
    const body = buildMultipart(boundary, manifest, [source]);
    const upload = await streamBody(body, `multipart/form-data; boundary=${boundary}`);
    expect(upload.sourceBytes).toEqual([1024]);
    expect(upload.totalBytes).toBe(Buffer.byteLength(manifest, "utf8") + 1024);
    await rm(upload.sourcePaths[0], { force: true });
  });

  it("rejects when manifest bytes push the aggregate over the cap", async () => {
    const manifest = JSON.stringify({ version: 1, pages: [{ sourceId: "a", page: 1 }] });
    const manifestBytes = Buffer.byteLength(manifest, "utf8");
    // One byte over the aggregate cap once the manifest is included.
    const source = Buffer.alloc(LIMITS.maxTotalBytes - manifestBytes + 1, 0x25);
    const boundary = "aggregateoveredge";
    const body = buildMultipart(boundary, manifest, [source]);
    await expect(streamBody(body, `multipart/form-data; boundary=${boundary}`)).rejects.toMatchObject({
      name: "MultipartError",
      code: "TOTAL_TOO_LARGE"
    } satisfies Partial<MultipartError>);
  }, 60_000);
});
