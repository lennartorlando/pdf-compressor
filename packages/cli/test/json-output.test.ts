import { describe, expect, it } from "vitest";
import { CompressionError } from "@pdf-compressor/core";
import { PageManifestError } from "@pdf-compressor/core/page-manifest";
import { exitCodeFor, formatJsonError, formatJsonSuccess } from "../src/output.js";

describe("JSON output", () => {
  it("formats stable success fields for agents", () => {
    const payload = JSON.parse(formatJsonSuccess({
      status: "success",
      inputPath: "input.pdf",
      outputPath: "out.pdf",
      profile: "balanced",
      originalBytes: 1000,
      outputBytes: 650,
      reductionBytes: 350,
      reductionPercent: 35,
      outputSmaller: true,
      engine: "mock",
      warnings: []
    }));

    expect(payload).toMatchObject({
      ok: true,
      profile: "balanced",
      originalBytes: 1000,
      outputBytes: 650,
      reductionPercent: 35,
      engine: "mock"
    });
  });

  it("formats validation failures with parseable codes", () => {
    const error = new CompressionError("INPUT_ENCRYPTED", "Encrypted PDFs are not supported yet.");
    expect(JSON.parse(formatJsonError(error))).toMatchObject({
      ok: false,
      code: "INPUT_ENCRYPTED"
    });
    expect(exitCodeFor(error)).toBe(2);
  });

  it("keeps stdout to exactly one JSON object for page failures", () => {
    for (const code of [
      "MANIFEST_UNKNOWN_SOURCE",
      "MANIFEST_INVALID_ROTATION",
      "INPUT_HAS_ACTIVE_CONTENT",
      "INPUT_SIGNED",
      "OUTPUT_EXISTS"
    ] as const) {
      const error = new CompressionError(code, "page failure");
      const stdout = formatJsonError(error);
      expect(stdout.endsWith("\n")).toBe(true);
      expect(stdout.trim().split("\n")).toHaveLength(1);
      expect(JSON.parse(stdout)).toMatchObject({ ok: false, code });
      expect(exitCodeFor(error)).toBe(2);
    }
  });

  it("maps native failures to exit 3 and cancellation to exit 4", () => {
    for (const code of ["ENGINE_FAILED", "NATIVE_VERSION_UNSUPPORTED", "INSPECTION_INCOMPLETE"] as const) {
      expect(exitCodeFor(new CompressionError(code, "native failure"))).toBe(3);
    }
    expect(exitCodeFor(new CompressionError("JOB_CANCELLED", "cancelled"))).toBe(4);
    expect(exitCodeFor(new CompressionError("JOB_TIMEOUT", "timed out"))).toBe(4);
  });

  it("formats browser-safe manifest errors as validation failures", () => {
    const error = new PageManifestError("MANIFEST_INVALID_ROTATION", "Invalid rotation 45.");
    expect(JSON.parse(formatJsonError(error))).toMatchObject({
      ok: false,
      code: "MANIFEST_INVALID_ROTATION"
    });
    expect(exitCodeFor(error)).toBe(2);
  });
});
