import { describe, expect, it } from "vitest";
import { CompressionError } from "@pdf-compressor/core";
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
});
