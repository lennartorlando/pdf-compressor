import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

  it("returns usage errors as one JSON object when --json is present", async () => {
    const result = await runCompressCommand(["--json"]);
    expect(result.exitCode).toBe(64);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, code: "USAGE" });
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
  });

  it("preserves an overwrite destination when compression is cancelled", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pdf-compressor-cli-test-"));
    const output = join(dir, "existing.pdf");
    const controller = new AbortController();
    controller.abort();
    try {
      await writeFile(output, "already here");
      const result = await runCompressCommand(
        ["tests/fixtures/minimal.pdf", "--output", output, "--overwrite", "--json"],
        { signal: controller.signal }
      );
      expect(result.exitCode).toBe(4);
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, code: "JOB_CANCELLED" });
      expect(await readFile(output, "utf8")).toBe("already here");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("never lets overwrite replace the input PDF", async () => {
    const input = "tests/fixtures/minimal.pdf";
    const before = await readFile(input);
    const result = await runCompressCommand([input, "--output", input, "--overwrite", "--json"]);
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      code: "OUTPUT_WOULD_OVERWRITE_INPUT"
    });
    expect(await readFile(input)).toEqual(before);
  });
});
