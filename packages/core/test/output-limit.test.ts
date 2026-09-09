import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CompressionError } from "../src/errors.js";
import { withOutputLimit } from "../src/output-limit.js";

describe("withOutputLimit", () => {
  it("checks aggregate capacity less often than candidate output size", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const operation = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const resourceCheck = vi.fn(async () => undefined);

    try {
      const pending = withOutputLimit(
        "unused-without-an-output-cap.pdf",
        {},
        undefined,
        () => new CompressionError("OUTPUT_TOO_LARGE", "output too large"),
        async () => operation,
        resourceCheck
      );

      await vi.advanceTimersByTimeAsync(249);
      expect(resourceCheck).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(resourceCheck).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(749);
      expect(resourceCheck).toHaveBeenCalledTimes(3);

      finish();
      await pending;
      expect(resourceCheck).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts an oversized candidate before the slower resource poll", async () => {
    vi.useFakeTimers();
    const dir = await mkdtemp(join(tmpdir(), "pdf-output-limit-"));
    const candidatePath = join(dir, "candidate.pdf");
    await writeFile(candidatePath, Buffer.alloc(2));
    let finish!: () => void;
    const operation = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const resourceCheck = vi.fn(async () => undefined);
    let observedSignal: AbortSignal | undefined;
    let resolveAbort!: () => void;
    const abortObserved = new Promise<void>((resolve) => {
      resolveAbort = resolve;
    });
    let pending: Promise<void> | undefined;

    try {
      pending = withOutputLimit(
        candidatePath,
        {},
        1,
        () => new CompressionError("OUTPUT_TOO_LARGE", "output too large"),
        async ({ signal }) => {
          observedSignal = signal;
          if (signal?.aborted) resolveAbort();
          else signal?.addEventListener("abort", () => resolveAbort(), { once: true });
          return operation;
        },
        resourceCheck
      );
      const result = pending.then(
        () => undefined,
        (error: unknown) => error
      );

      await vi.advanceTimersByTimeAsync(24);
      expect(observedSignal?.aborted).toBe(false);
      expect(resourceCheck).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await abortObserved;
      expect(observedSignal?.aborted).toBe(true);
      expect(resourceCheck).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(224);
      expect(resourceCheck).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(resourceCheck).toHaveBeenCalledTimes(1);

      finish();
      await expect(result).resolves.toMatchObject({ code: "OUTPUT_TOO_LARGE" });
    } finally {
      finish();
      await pending?.catch(() => undefined);
      vi.useRealTimers();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
