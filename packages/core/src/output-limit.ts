import { stat } from "node:fs/promises";
import { CompressionError } from "./errors.js";
import type { NativeCallOptions } from "./engines/qpdf-pages.js";

const OUTPUT_POLL_INTERVAL_MS = 25;
const RESOURCE_POLL_INTERVAL_MS = 250;

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
  let outputCheckInFlight: Promise<void> | null = null;
  let resourceCheckInFlight: Promise<void> | null = null;
  const checkOutput = (): Promise<void> => {
    if (maxOutputBytes === undefined) return Promise.resolve();
    if (outputCheckInFlight) return outputCheckInFlight;
    outputCheckInFlight = stat(candidatePath)
      .catch(() => null)
      .then((candidateStat) => {
        if (active && candidateStat && candidateStat.size > maxOutputBytes) {
          exceeded = true;
          controller.abort();
        }
      })
      .finally(() => {
        outputCheckInFlight = null;
      });
    return outputCheckInFlight;
  };
  const checkResource = (): Promise<void> => {
    if (!resourceCheck) return Promise.resolve();
    if (resourceCheckInFlight) return resourceCheckInFlight;
    resourceCheckInFlight = resourceCheck()
      .catch((error: unknown) => {
        if (active) {
          resourceError = error;
          controller.abort();
        }
      })
      .finally(() => {
        resourceCheckInFlight = null;
      });
    return resourceCheckInFlight;
  };
  const outputWatcher = maxOutputBytes === undefined
    ? undefined
    : setInterval(() => void checkOutput(), OUTPUT_POLL_INTERVAL_MS);
  const resourceWatcher = resourceCheck === undefined
    ? undefined
    : setInterval(() => void checkResource(), RESOURCE_POLL_INTERVAL_MS);
  outputWatcher?.unref?.();
  resourceWatcher?.unref?.();
  try {
    const result = await operation({ ...calls, signal });
    await Promise.all([checkOutput(), checkResource()]);
    if (resourceError) throw resourceError;
    if (exceeded) throw outputTooLarge(candidatePath, maxOutputBytes!);
    return result;
  } catch (error) {
    if (resourceError) throw resourceError;
    if (exceeded) throw outputTooLarge(candidatePath, maxOutputBytes!);
    throw error;
  } finally {
    active = false;
    if (outputWatcher) clearInterval(outputWatcher);
    if (resourceWatcher) clearInterval(resourceWatcher);
  }
}
