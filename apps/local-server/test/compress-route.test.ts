import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { defaultHost } from "../src/server.js";
import { compressBufferForRequest, createCompressionRouteState, toPublicSummary } from "../src/routes/compress.js";

describe("compression route", () => {
  it("returns a local validation error for encrypted PDFs", async () => {
    const body = await readFile("tests/fixtures/encrypted-marker.pdf");
    const response = await compressBufferForRequest(body, "balanced", createCompressionRouteState());

    expect(response.status).toBe(422);
    expect(response.payload).toMatchObject({
      ok: false,
      code: "INPUT_ENCRYPTED"
    });
  });

  it("uses loopback as the default host", () => {
    expect(defaultHost).toBe("127.0.0.1");
  });

  it("does not expose temporary local paths in successful web summaries", () => {
    expect(toPublicSummary({
      status: "success",
      inputPath: "/tmp/private/input.pdf",
      outputPath: "/tmp/private/output.pdf",
      profile: "balanced",
      originalBytes: 100,
      outputBytes: 50,
      reductionBytes: 50,
      reductionPercent: 50,
      outputSmaller: true,
      engine: "mock",
      warnings: []
    }, "minimal.pdf")).toMatchObject({
      inputPath: "minimal.pdf",
      outputPath: "compressed.pdf"
    });
  });
});
