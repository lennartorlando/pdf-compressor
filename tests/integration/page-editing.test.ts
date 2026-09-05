import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assemblePages, inspectSources } from "@pdf-compressor/core";
import { buildTestPdf } from "../../packages/core/test/pdf-fixtures.js";
import { runAssembleCommand } from "../../packages/cli/src/commands/assemble.js";
import { runInspectCommand } from "../../packages/cli/src/commands/inspect.js";
import { JobManager } from "../../apps/local-server/src/jobs.js";
import { createLocalServer } from "../../apps/local-server/src/server.js";
import { SessionStore } from "../../apps/local-server/src/session.js";
import {
  outputContainsMarker,
  readOutputGeometries,
  sha256OfFile
} from "../helpers/pdf-assertions.js";

/**
 * U6 end-to-end native proof: the same real-qpdf page manifest through the
 * shared core, the CLI adapter, and the loopback multipart route.
 *
 * Deterministic synthetic PDFs only. Structural validation is backed by a
 * content-marker inspection so it is not the sole assertion.
 */

interface HttpResult {
  status: number;
  headers: Record<string, string | undefined>;
  body: Buffer;
}

function buildMultipart(parts: Array<{ name: string; filename?: string; contentType?: string; data: Buffer | string }>): {
  body: Buffer;
  contentType: string;
} {
  const boundary = `----u6proof${randomBytes(8).toString("hex")}`;
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const data = typeof part.data === "string" ? Buffer.from(part.data, "utf8") : part.data;
    let header = `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"`;
    if (part.filename) header += `; filename="${part.filename}"`;
    header += "\r\n";
    if (part.contentType) header += `Content-Type: ${part.contentType}\r\n`;
    header += "\r\n";
    chunks.push(Buffer.from(header, "utf8"), data, Buffer.from("\r\n", "utf8"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

describe("U6 page-editing integration proof (real qpdf)", () => {
  let scratch = "";
  let sourceA = "";
  let sourceB = "";
  let jobs: JobManager;
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
            resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks) });
          });
        }
      );
      req.on("error", reject);
      if (options.body) req.write(options.body);
      req.end();
    });
  }

  async function launch(): Promise<{ origin: string; cookie: string; token: string }> {
    const origin = `http://127.0.0.1:${port}`;
    const result = await call("/api/session/launch", { method: "POST", headers: { origin } });
    expect(result.status).toBe(200);
    const payload = JSON.parse(result.body.toString("utf8")) as { token: string };
    return { origin, cookie: (result.headers["set-cookie"] ?? "").split(";")[0], token: payload.token };
  }

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), "u6-page-proof-"));
    sourceA = join(scratch, "a.pdf");
    sourceB = join(scratch, "b.pdf");
    await writeFile(
      sourceA,
      buildTestPdf(
        [
          { width: 610, label: "U6-A-1" },
          { width: 611, label: "U6-A-2" },
          { width: 612, label: "U6-A-3" }
        ],
        { bookmarks: true }
      )
    );
    await writeFile(
      sourceB,
      buildTestPdf(
        [
          { width: 710, label: "U6-B-1" },
          { width: 711, label: "U6-B-2" }
        ],
        { formTextField: true }
      )
    );
    jobs = await JobManager.create({ tempRoot: join(scratch, "app-temp") });
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

  const manifest = {
    version: 1 as const,
    pages: [
      { sourceId: "b", page: 2 },
      { sourceId: "a", page: 3, rotate: 90 as const },
      { sourceId: "a", page: 1 }
    ]
  };
  const expectedGeometries = [
    { width: 711, rotate: 0 },
    { width: 612, rotate: 90 },
    { width: 610, rotate: 0 }
  ];

  it("proves the same manifest through core, CLI, and the loopback route", async () => {
    const hashABefore = await sha256OfFile(sourceA);
    const hashBBefore = await sha256OfFile(sourceB);

    // 1. Shared core: inspect is authoritative, assembly is exact.
    const inspections = await inspectSources([
      { id: "a", path: sourceA },
      { id: "b", path: sourceB }
    ]);
    expect(inspections.map((inspection) => inspection.pageCount)).toEqual([3, 2]);
    expect(inspections[0].compatWarnings).toContain("bookmarks");
    expect(inspections[1].compatWarnings).toContain("forms");

    const coreOut = join(scratch, "core-out.pdf");
    const coreSummary = await assemblePages({
      sources: [
        { id: "a", path: sourceA },
        { id: "b", path: sourceB }
      ],
      manifest,
      destinationPath: coreOut
    });
    expect(coreSummary.status).toBe("success");
    expect(coreSummary.pageCount).toBe(3);
    expect(coreSummary.sourceHashes).toEqual({ a: hashABefore, b: hashBBefore });
    expect(await readOutputGeometries(coreOut)).toEqual(expectedGeometries);
    expect(await outputContainsMarker(coreOut, "U6-B-2")).toBe(true);
    expect(await outputContainsMarker(coreOut, "U6-A-3")).toBe(true);

    // 2. CLI parity: inspect plus assemble of the same manifest.
    const inspectResult = await runInspectCommand([sourceA, sourceB, "--json"]);
    expect(inspectResult.exitCode).toBe(0);
    const inspectPayload = JSON.parse(inspectResult.stdout) as {
      ok: boolean;
      status: string;
      sources: Array<{ pageCount: number; compatWarnings: string[] }>;
    };
    expect(inspectPayload.ok).toBe(true);
    expect(inspectPayload.sources.map((source) => source.pageCount)).toEqual([3, 2]);

    const manifestPath = join(scratch, "manifest.json");
    await writeFile(manifestPath, JSON.stringify(manifest));
    const cliOut = join(scratch, "cli-out.pdf");
    const assembleResult = await runAssembleCommand(
      [
        "--source",
        `a=${sourceA}`,
        "--source",
        `b=${sourceB}`,
        "--manifest",
        manifestPath,
        "--output",
        cliOut,
        "--json"
      ],
      {}
    );
    expect(assembleResult.exitCode).toBe(0);
    const cliPayload = JSON.parse(assembleResult.stdout) as {
      ok: boolean;
      pageCount: number;
      warnings: string[];
      compatWarnings: string[];
      sourceHashes: Record<string, string>;
    };
    expect(cliPayload.ok).toBe(true);
    expect(cliPayload.pageCount).toBe(3);
    expect(cliPayload.sourceHashes).toEqual(coreSummary.sourceHashes);
    expect(cliPayload.compatWarnings).toEqual(coreSummary.compatWarnings);
    expect(await readOutputGeometries(cliOut)).toEqual(expectedGeometries);
    expect(await outputContainsMarker(cliOut, "U6-B-2")).toBe(true);
    expect((await readFile(coreOut)).length).toBeGreaterThan(0);
    expect((await readFile(cliOut)).length).toBeGreaterThan(0);

    // 3. Loopback route: protected multipart upload, one-time download, cleanup.
    const auth = await launch();
    const authed = (extra: Record<string, string> = {}): Record<string, string> => ({
      origin: auth.origin,
      cookie: auth.cookie,
      "x-launch-token": auth.token,
      ...extra
    });
    const fixtureA = await readFile(sourceA);
    const fixtureB = await readFile(sourceB);
    const upload = buildMultipart([
      { name: "manifest", contentType: "application/json", data: JSON.stringify(manifest) },
      { name: "source", filename: "client-b.pdf", contentType: "application/pdf", data: fixtureB },
      { name: "source", filename: "client-a.pdf", contentType: "application/pdf", data: fixtureA }
    ]);
    const exported = await call("/api/pages/export", {
      method: "POST",
      headers: authed({ "content-type": upload.contentType, "content-length": String(upload.body.length) }),
      body: upload.body
    });
    expect(exported.status).toBe(200);
    const proof = JSON.parse(exported.body.toString("utf8")) as {
      ok: boolean;
      handle: string;
      downloadUrl: string;
      pageCount: number;
    };
    expect(proof.ok).toBe(true);
    expect(proof.pageCount).toBe(3);
    expect(proof.downloadUrl).toBe(`/api/outputs/${proof.handle}/download`);
    const proofText = exported.body.toString("utf8");
    expect(proofText).not.toContain(jobs.tempRoot);
    expect(proofText).not.toContain("client-a.pdf");

    // Only the validated output survives publication; sources are removed.
    const retained = await readdir(jobs.tempRoot);
    expect(retained).toHaveLength(1);

    const download = await call(proof.downloadUrl, { headers: authed() });
    expect(download.status).toBe(200);
    expect(download.headers["content-type"]).toBe("application/pdf");
    expect(download.headers["cache-control"]).toBe("no-store");
    expect(download.body.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    const downloadedPath = join(scratch, "server-out.pdf");
    await writeFile(downloadedPath, download.body);
    expect(await readOutputGeometries(downloadedPath)).toEqual(expectedGeometries);
    expect(await outputContainsMarker(downloadedPath, "U6-B-2")).toBe(true);

    // One-time output: replay fails and the completed download is consumed.
    const replay = await call(proof.downloadUrl, { headers: authed() });
    expect(replay.status).toBe(404);
    expect(await readdir(jobs.tempRoot)).toHaveLength(0);

    // Cross-site forgery reaches no disk: rejected before a job workspace exists.
    const before = await readdir(jobs.tempRoot);
    const forged = await call("/api/pages/export", {
      method: "POST",
      headers: {
        host: `127.0.0.1:${port}`,
        origin: "https://evil.example",
        "content-type": upload.contentType,
        "content-length": String(upload.body.length)
      },
      body: upload.body
    });
    expect([400, 401, 403]).toContain(forged.status);
    expect(await readdir(jobs.tempRoot)).toEqual(before);

    // Sources are immutable across success, CLI, and server flows.
    expect(await sha256OfFile(sourceA)).toBe(hashABefore);
    expect(await sha256OfFile(sourceB)).toBe(hashBBefore);
  });
});
