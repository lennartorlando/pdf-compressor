import { describe, expect, it } from "vitest";
import { CompressionError, type NativeRunner } from "@pdf-compressor/core";
import { runCapabilitiesCommand } from "../src/commands/capabilities.js";

function json(stdout: string): Record<string, unknown> {
  expect(stdout.endsWith("\n")).toBe(true);
  expect(stdout.trim().split("\n")).toHaveLength(1);
  return JSON.parse(stdout) as Record<string, unknown>;
}

describe("runCapabilitiesCommand", () => {
  it("reports every native tool and installed OCR languages in stable JSON", async () => {
    const run: NativeRunner = async (command, args) => {
      if (command === "qpdf") return { stdout: "qpdf version 12.4.1", stderr: "", exitCode: 0 };
      if (command === "gs") return { stdout: "10.07.1\n", stderr: "", exitCode: 0 };
      if (command === "ocrmypdf") return { stdout: "17.1.0\n", stderr: "", exitCode: 0 };
      if (command === "tesseract" && args[0] === "--version") return { stdout: "tesseract 5.5.3\n", stderr: "", exitCode: 0 };
      if (command === "tesseract" && args[0] === "--list-langs") return { stdout: "List of available languages (2):\ndeu\neng\n", stderr: "", exitCode: 0 };
      throw new Error("unexpected command");
    };
    const result = await runCapabilitiesCommand(["--json"], { run });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(json(result.stdout)).toEqual({
      ok: true,
      status: "success",
      capabilities: {
        qpdf: { available: true, version: "12.4.1" },
        ghostscript: { available: true, version: "10.07.1" },
        ocrmypdf: { available: true, version: "17.1.0" },
        tesseract: { available: true, version: "5.5.3", languages: ["deu", "eng"] }
      }
    });
  });

  it("reports missing tools independently without failing the command", async () => {
    const run: NativeRunner = async (command, args) => {
      if (command === "qpdf") return { stdout: "qpdf version 12.4.1", stderr: "", exitCode: 0 };
      if (command === "tesseract" && args[0] === "--list-langs") return { stdout: "eng\n", stderr: "", exitCode: 0 };
      if (command === "tesseract") return { stdout: "tesseract 5.5.3\n", stderr: "", exitCode: 0 };
      throw new CompressionError("ENGINE_FAILED", `${command} is missing`);
    };
    const result = await runCapabilitiesCommand(["--json"], { run });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(json(result.stdout)).toMatchObject({
      ok: true,
      capabilities: {
        qpdf: { available: true, version: "12.4.1" },
        ghostscript: { available: false, version: null },
        ocrmypdf: { available: false, version: null },
        tesseract: { available: true, version: "5.5.3", languages: ["eng"] }
      }
    });
  });

  it("marks installed tools below their floors unavailable while preserving versions", async () => {
    const run: NativeRunner = async (command, args) => {
      if (command === "qpdf") return { stdout: "qpdf version 11.9.0", stderr: "", exitCode: 0 };
      if (command === "gs") return { stdout: "10.06.0\n", stderr: "", exitCode: 0 };
      if (command === "ocrmypdf") return { stdout: "16.12.0\n", stderr: "", exitCode: 0 };
      if (command === "tesseract" && args[0] === "--version") {
        return { stdout: "tesseract 5.5.3\n", stderr: "", exitCode: 0 };
      }
      if (command === "tesseract") return { stdout: "eng\n", stderr: "", exitCode: 0 };
      throw new Error("unexpected command");
    };
    const result = await runCapabilitiesCommand(["--json"], { run });
    expect(json(result.stdout)).toMatchObject({
      capabilities: {
        qpdf: { available: false, version: "11.9.0" },
        ghostscript: { available: false, version: "10.06.0" },
        ocrmypdf: { available: false, version: "16.12.0" }
      }
    });
  });

  it("marks Tesseract unavailable when language discovery fails", async () => {
    const run: NativeRunner = async (command, args) => {
      if (command === "tesseract" && args[0] === "--version") {
        return { stdout: "tesseract 5.5.3\n", stderr: "", exitCode: 0 };
      }
      throw new CompressionError("ENGINE_FAILED", "probe failed");
    };
    const result = await runCapabilitiesCommand(["--json"], { run });
    expect(json(result.stdout)).toMatchObject({
      capabilities: { tesseract: { available: false, version: "5.5.3", languages: [] } }
    });
  });

  it("returns JSON usage failures without stderr", async () => {
    const result = await runCapabilitiesCommand(["--unexpected", "--json"]);
    expect(result.exitCode).toBe(64);
    expect(result.stderr).toBe("");
    expect(json(result.stdout)).toMatchObject({ ok: false, code: "USAGE" });
  });
});
