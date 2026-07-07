import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { parseCompressArgs, runCompressCommand } from "../src/commands/compress.js";

describe("parseCompressArgs", () => {
  it("parses the agent-facing compression contract", () => {
    expect(parseCompressArgs([
      "input.pdf",
      "--output",
      "out.pdf",
      "--profile",
      "aggressive",
      "--json"
    ])).toMatchObject({
      inputPath: "input.pdf",
      outputPath: "out.pdf",
      profile: "aggressive",
      json: true
    });
  });

  it("rejects unsupported profiles", () => {
    expect(() => parseCompressArgs(["input.pdf", "--output", "out.pdf", "--profile", "tiny"])).toThrow("Unsupported profile");
  });

  it("preserves existing output files unless overwrite is explicit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pdf-compressor-cli-test-"));
    const output = join(dir, "existing.pdf");
    try {
      await writeFile(output, "already here");

      const result = await runCompressCommand([
        "tests/fixtures/minimal.pdf",
        "--output",
        output,
        "--json"
      ]);

      expect(result.exitCode).toBe(2);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        code: "OUTPUT_EXISTS"
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
