import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CompressionError, type NativeRunner } from "@pdf-compressor/core";
import { main } from "../src/index.js";

function capturedOutput(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.map(([chunk]) => String(chunk)).join("");
}

describe("CLI entry point", () => {
  it("writes one JSON usage error to stdout for an unknown command", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(await main(["unknown", "--json"])).toBe(64);
      expect(stderr).not.toHaveBeenCalled();
      const output = capturedOutput(stdout);
      expect(output.trim().split("\n")).toHaveLength(1);
      expect(JSON.parse(output)).toMatchObject({ ok: false, code: "USAGE" });
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });

  it.each(["SIGINT", "SIGTERM"] as const)(
    "turns %s into native cancellation and removes both handlers",
    async (signalName) => {
      const sourcePath = join(process.cwd(), "tests", "fixtures", "minimal.pdf");
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const initialInt = new Set(process.listeners("SIGINT"));
      const initialTerm = new Set(process.listeners("SIGTERM"));
      let enteredInspection: (() => void) | undefined;
      const inspectionStarted = new Promise<void>((resolve) => {
        enteredInspection = resolve;
      });
      const run: NativeRunner = async (_command, args, options) => {
        if (args[0] === "--version") {
          return { stdout: "qpdf version 12.4.1", stderr: "", exitCode: 0 };
        }
        enteredInspection?.();
        return new Promise((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(new CompressionError("JOB_CANCELLED", "cancelled")),
            { once: true }
          );
        });
      };

      try {
        const pending = main(["inspect", sourcePath, "--json"], { run });
        await inspectionStarted;
        const initial = signalName === "SIGINT" ? initialInt : initialTerm;
        const handler = process.listeners(signalName).find((listener) => !initial.has(listener));
        expect(handler).toBeDefined();
        handler?.();

        expect(await pending).toBe(4);
        expect(stderr).not.toHaveBeenCalled();
        expect(JSON.parse(capturedOutput(stdout))).toMatchObject({
          ok: false,
          code: "JOB_CANCELLED"
        });
        expect(process.listeners("SIGINT")).toHaveLength(initialInt.size);
        expect(process.listeners("SIGTERM")).toHaveLength(initialTerm.size);
      } finally {
        stdout.mockRestore();
        stderr.mockRestore();
      }
    }
  );
});
