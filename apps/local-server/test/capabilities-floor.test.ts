import { describe, expect, it } from "vitest";
import { CAPABILITY_PROBE_TIMEOUT_MS, getCapabilities, meetsNativeFloor } from "../src/routes/edit.js";
import { CompressionError, GHOSTSCRIPT_SECURITY_FLOOR, OCRMY_PDF_FEATURE_FLOOR, QPDF_SECURITY_FLOOR } from "@pdf-compressor/core";

describe("capability version floors", () => {
  it("bounds every default native probe", async () => {
    const seen: Array<number | undefined> = [];
    const capture = (version: string) => async (options?: { timeoutMs?: number }) => {
      seen.push(options?.timeoutMs);
      return version;
    };
    await getCapabilities({
      getQpdfVersion: capture("12.4.1"),
      getGhostscriptVersion: capture("10.07.1"),
      getOcrMyPdfVersion: capture("17.1.0"),
      getTesseractVersion: capture("5.5.0"),
      getTesseractLanguages: async (options) => {
        seen.push(options?.timeoutMs);
        return ["eng"];
      }
    });
    expect(seen).toEqual(Array(5).fill(CAPABILITY_PROBE_TIMEOUT_MS));
  });

  it("meets the exported core floors exactly", () => {
    expect(QPDF_SECURITY_FLOOR).toBe("12.4.1");
    expect(GHOSTSCRIPT_SECURITY_FLOOR).toBe("10.07.1");
    expect(meetsNativeFloor("12.4.1", QPDF_SECURITY_FLOOR)).toBe(true);
    expect(meetsNativeFloor("12.5.0", QPDF_SECURITY_FLOOR)).toBe(true);
    expect(meetsNativeFloor("12.4.0", QPDF_SECURITY_FLOOR)).toBe(false);
    expect(meetsNativeFloor("11.9.0", QPDF_SECURITY_FLOOR)).toBe(false);
    expect(meetsNativeFloor("10.07.1", GHOSTSCRIPT_SECURITY_FLOOR)).toBe(true);
    expect(meetsNativeFloor("10.08.0", GHOSTSCRIPT_SECURITY_FLOOR)).toBe(true);
    expect(meetsNativeFloor("10.06.0", GHOSTSCRIPT_SECURITY_FLOOR)).toBe(false);
    expect(meetsNativeFloor("9.55.0", GHOSTSCRIPT_SECURITY_FLOOR)).toBe(false);
    expect(meetsNativeFloor("not a version", QPDF_SECURITY_FLOOR)).toBe(false);
  });

  it("reports a below-floor qpdf as unavailable but keeps its version", async () => {
    const capabilities = await getCapabilities({
      getQpdfVersion: async () => "11.9.0",
      getGhostscriptVersion: async () => "10.07.1",
      getOcrMyPdfVersion: async () => "17.1.0",
      getTesseractVersion: async () => "5.5.0",
      getTesseractLanguages: async () => ["eng", "deu"]
    });
    expect(capabilities.qpdf).toEqual({ available: false, version: "11.9.0" });
    expect(capabilities.ghostscript).toEqual({ available: true, version: "10.07.1" });
  });

  it("reports a below-floor Ghostscript as unavailable independently of qpdf", async () => {
    const capabilities = await getCapabilities({
      getQpdfVersion: async () => "12.4.1",
      getGhostscriptVersion: async () => "9.55.0",
      getOcrMyPdfVersion: async () => "17.1.0",
      getTesseractVersion: async () => "5.5.0",
      getTesseractLanguages: async () => ["eng"]
    });
    expect(capabilities.qpdf).toEqual({ available: true, version: "12.4.1" });
    expect(capabilities.ghostscript).toEqual({ available: false, version: "9.55.0" });
  });

  it("fails closed when a version cannot be read", async () => {
    const capabilities = await getCapabilities({
      getQpdfVersion: async () => {
        throw new Error("no binary");
      },
      getGhostscriptVersion: async () => {
        throw new Error("no binary");
      },
      getOcrMyPdfVersion: async () => {
        throw new Error("no binary");
      },
      getTesseractVersion: async () => {
        throw new Error("no binary");
      },
      getTesseractLanguages: async () => {
        throw new Error("no data");
      }
    });
    expect(capabilities.qpdf).toEqual({ available: false, version: null });
    expect(capabilities.ghostscript).toEqual({ available: false, version: null });
    expect(capabilities.ocrmypdf).toEqual({ available: false, version: null });
    expect(capabilities.tesseract).toEqual({ available: false, version: null, languages: [] });
  });

  it("reports OCR tools and installed Tesseract languages independently", async () => {
    expect(OCRMY_PDF_FEATURE_FLOOR).toBe("17.0.0");
    const capabilities = await getCapabilities({
      getQpdfVersion: async () => "12.4.1",
      getGhostscriptVersion: async () => "10.07.1",
      getOcrMyPdfVersion: async () => "17.11.0",
      getTesseractVersion: async () => "5.5.3",
      getTesseractLanguages: async () => ["eng", "deu", "osd"]
    });
    expect(capabilities.ocrmypdf).toEqual({ available: true, version: "17.11.0" });
    expect(capabilities.tesseract).toEqual({
      available: true,
      version: "5.5.3",
      languages: ["eng", "deu", "osd"]
    });
  });

  it("keeps an OCRmyPDF version below 17 unavailable and preserves cancellation", async () => {
    const belowFloor = await getCapabilities({
      getQpdfVersion: async () => "12.4.1",
      getGhostscriptVersion: async () => "10.07.1",
      getOcrMyPdfVersion: async () => "16.9.0",
      getTesseractVersion: async () => "5.5.3",
      getTesseractLanguages: async () => ["eng"]
    });
    expect(belowFloor.ocrmypdf).toEqual({ available: false, version: "16.9.0" });

    const cancelled = new CompressionError("JOB_CANCELLED", "cancelled");
    await expect(getCapabilities({
      getQpdfVersion: async () => { throw cancelled; },
      getGhostscriptVersion: async () => "10.07.1",
      getOcrMyPdfVersion: async () => "17.1.0",
      getTesseractVersion: async () => "5.5.3",
      getTesseractLanguages: async () => ["eng"]
    })).rejects.toBe(cancelled);
  });

  it("waits for sibling probes before surfacing a terminal probe failure", async () => {
    let releaseSibling!: () => void;
    const sibling = new Promise<void>((resolve) => {
      releaseSibling = resolve;
    });
    const timeout = new CompressionError("JOB_TIMEOUT", "timed out");
    const pending = getCapabilities({
      getQpdfVersion: async () => { throw timeout; },
      getGhostscriptVersion: async () => { await sibling; return "10.07.1"; },
      getOcrMyPdfVersion: async () => { await sibling; return "17.1.0"; },
      getTesseractVersion: async () => { await sibling; return "5.5.3"; },
      getTesseractLanguages: async () => { await sibling; return ["eng"]; }
    });
    let settled = false;
    void pending.catch(() => undefined).then(() => { settled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    releaseSibling();
    await expect(pending).rejects.toBe(timeout);
  });
});
