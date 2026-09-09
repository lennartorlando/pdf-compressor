import { describe, expect, it } from "vitest";
import { CompressionError } from "@pdf-compressor/core";
import { ocrFromUrl } from "../src/routes/edit.js";

describe("page export OCR query", () => {
  it.each([
    ["?ocr=off", null],
    ["?ocr=deu&ocrAutoRotate=true", { languages: ["deu"], autoRotate: true }],
    ["?ocr=eng&ocrAutoRotate=false", { languages: ["eng"], autoRotate: false }],
    ["?ocr=deu%2Beng&ocrAutoRotate=true", { languages: ["deu", "eng"], autoRotate: true }]
  ])("parses %s", (query, expected) => {
    expect(ocrFromUrl(new URL(`/api/pages/export${query}`, "http://127.0.0.1"))).toEqual(expected);
  });

  it.each([
    "?ocr=fra&ocrAutoRotate=true",
    "?ocr=deu%2Bfra&ocrAutoRotate=true",
    "?ocr=deu&ocrAutoRotate=yes",
    "?ocr=deu",
    "?ocr=off&ocrAutoRotate=true",
    "?ocr=deu&ocr=eng&ocrAutoRotate=true",
    "?ocr=deu&ocrAutoRotate=true&ocrAutoRotate=false"
  ])("rejects the unknown or contradictory contract %s", (query) => {
    expect(() => ocrFromUrl(new URL(`/api/pages/export${query}`, "http://127.0.0.1"))).toThrowError(
      expect.objectContaining<Partial<CompressionError>>({ code: "OCR_OPTIONS_INVALID" })
    );
  });
});
