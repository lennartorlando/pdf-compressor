import { stat } from "node:fs/promises";
import { CompressionError } from "./errors.js";
import type { NativeCallOptions } from "./engines/qpdf-pages.js";

/** Monitor a native candidate and translate the local size abort into its public error. */
export async function withOutputLimit<T, C extends NativeCallOptions>(
  candidatePath: string,
  calls: C,
  maxOutputBytes: number | undefined,
  outputTooLarge: (path: string, maxOutputBytes: number) => CompressionError,
  operation: (limitedCalls: C) => Promise<T>,
  resourceCheck?: () => Promise<void>
): Promise<T> {
  if (maxOutputBytes === undefined && resourceCheck === undefined) return operation(calls);
  if (maxOutputBytes !== undefined && (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1)) {
    throw new CompressionError("OUTPUT_TOO_LARGE", "Output byte cap must be a positive integer.", {
      maxOutputBytes
    });
  }

  const controller = new AbortController();
  const signal = calls.signal ? AbortSignal.any([calls.signal, controller.signal]) : controller.signal;
  let active = true;
  let exceeded = false;
  let resourceError: unknown;
  let checkInFlight: Promise<void> | null = null;
  const check = (): Promise<void> => {
    if (checkInFlight) return checkInFlight;
    checkInFlight = Promise.all([
      maxOutputBytes === undefined ? Promise.resolve(null) : stat(candidatePath).catch(() => null),
      resourceCheck?.()
    ])
      .then(([candidateStat]) => {
        if (active && candidateStat && maxOutputBytes !== undefined && candidateStat.size > maxOutputBytes) {
          exceeded = true;
          controller.abort();
        }
      })
      .catch((error: unknown) => {
        if (active) {
          resourceError = error;
          controller.abort();
        }
      })
      .finally(() => {
        checkInFlight = null;
      });
    return checkInFlight;
  };
  const watcher = setInterval(() => void check(), 25);
  watcher.unref?.();
  try {
    const result = await operation({ ...calls, signal });
    await check();
    if (resourceError) throw resourceError;
    if (exceeded) throw outputTooLarge(candidatePath, maxOutputBytes!);
    return result;
  } catch (error) {
    if (resourceError) throw resourceError;
    if (exceeded) throw outputTooLarge(candidatePath, maxOutputBytes!);
    throw error;
  } finally {
    active = false;
    clearInterval(watcher);
  }
}
