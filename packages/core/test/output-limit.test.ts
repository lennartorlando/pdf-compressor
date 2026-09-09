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
});
