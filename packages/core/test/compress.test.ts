import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { CompressionError, compressPdf, type CompressionEngine } from "../src/index.js";

const fixture = (name: string) => join(process.cwd(), "tests", "fixtures", name);

function mockEngine(writeBytes: Buffer, engine = "mock"): CompressionEngine {
  return {
    name: engine,
    supports: () => true,
    async compress(_inputPath, outputPath) {
      await writeFile(outputPath, writeBytes);
      return { engine, warnings: [] };
    }
  };
}

describe("compressPdf", () => {
  it("returns byte summary and reduction metadata for a smaller output", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pdf-compressor-test-"));
    const outputPath = join(dir, "out.pdf");

    try {
      const summary = await compressPdf({
        inputPath: fixture("minimal.pdf"),
        outputPath,
        profile: "conservative",
        engines: [mockEngine(Buffer.from("%PDF-1.4\n%%EOF\n"))]
      });

      expect(summary.status).toBe("success");
      expect(summary.outputSmaller).toBe(true);
      expect(summary.originalBytes).toBeGreaterThan(summary.outputBytes);
      expect(summary.reductionPercent).toBeGreaterThan(0);
      expect(summary.engine).toBe("mock");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports no_gain when compression output is larger", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pdf-compressor-test-"));
    const outputPath = join(dir, "out.pdf");
    const input = await readFile(fixture("minimal.pdf"));

    try {
      const summary = await compressPdf({
        inputPath: fixture("minimal.pdf"),
        outputPath,
        profile: "balanced",
        engines: [mockEngine(Buffer.concat([input, Buffer.alloc(100)]))]
      });

      expect(summary.status).toBe("no_gain");
      expect(summary.outputSmaller).toBe(false);
      expect(summary.reductionBytes).toBeLessThanOrEqual(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects encrypted PDFs without creating output", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pdf-compressor-test-"));
    const outputPath = join(dir, "out.pdf");

    try {
      await expect(compressPdf({
        inputPath: fixture("encrypted-marker.pdf"),
        outputPath,
        profile: "conservative",
        engines: [mockEngine(Buffer.from("unused"))]
      })).rejects.toMatchObject({ code: "INPUT_ENCRYPTED" });
    } finally {
      await expect(stat(outputPath)).rejects.toBeTruthy();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects non-PDF input", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pdf-compressor-test-"));

    try {
      await expect(compressPdf({
        inputPath: fixture("not-a-pdf.txt"),
        outputPath: join(dir, "out.pdf"),
        profile: "conservative",
        engines: [mockEngine(Buffer.from("unused"))]
      })).rejects.toMatchObject({ code: "INPUT_NOT_PDF" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not allow overwriting the input path", async () => {
    await expect(compressPdf({
      inputPath: fixture("minimal.pdf"),
      outputPath: fixture("minimal.pdf"),
      profile: "conservative",
      engines: [mockEngine(Buffer.from("unused"))]
    })).rejects.toMatchObject({ code: "OUTPUT_WOULD_OVERWRITE_INPUT" });
  });

  it("cleans partial output on cancellation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pdf-compressor-test-"));
    const outputPath = join(dir, "out.pdf");
    const controller = new AbortController();
    const cancellingEngine: CompressionEngine = {
      name: "cancelling",
      supports: () => true,
      async compress(_inputPath, candidatePath) {
        await writeFile(candidatePath, Buffer.from("%PDF-1.4\n%%EOF\n"));
        await writeFile(outputPath, Buffer.from("partial"));
        controller.abort();
        throw new CompressionError("JOB_CANCELLED", "Compression job was cancelled.");
      }
    };

    try {
      await expect(compressPdf({
        inputPath: fixture("minimal.pdf"),
        outputPath,
        profile: "conservative",
        signal: controller.signal,
        engines: [cancellingEngine]
      })).rejects.toMatchObject({ code: "JOB_CANCELLED" });
      await expect(stat(outputPath)).rejects.toBeTruthy();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
