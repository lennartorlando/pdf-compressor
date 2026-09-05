import { describe, expect, it } from "vitest";
import { getCapabilities, meetsNativeFloor } from "../src/routes/edit.js";
import { GHOSTSCRIPT_SECURITY_FLOOR, QPDF_SECURITY_FLOOR } from "@pdf-compressor/core";

describe("capability version floors", () => {
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
      getGhostscriptVersion: async () => "10.07.1"
    });
    expect(capabilities.qpdf).toEqual({ available: false, version: "11.9.0" });
    expect(capabilities.ghostscript).toEqual({ available: true, version: "10.07.1" });
  });

  it("reports a below-floor Ghostscript as unavailable independently of qpdf", async () => {
    const capabilities = await getCapabilities({
      getQpdfVersion: async () => "12.4.1",
      getGhostscriptVersion: async () => "9.55.0"
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
      }
    });
    expect(capabilities.qpdf).toEqual({ available: false, version: null });
    expect(capabilities.ghostscript).toEqual({ available: false, version: null });
  });
});
