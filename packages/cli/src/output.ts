import { isCompressionError } from "@pdf-compressor/core";
import { PageManifestError } from "@pdf-compressor/core/page-manifest";

export const exitCodes = {
  success: 0,
  validationFailure: 2,
  compressionFailure: 3,
  cancelled: 4,
  usage: 64
} as const;

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export function formatJsonSuccess(summary: object): string {
  return `${JSON.stringify({
    ok: true,
    ...summary
  })}\n`;
}

export function formatJsonError(error: unknown): string {
  if (isCompressionError(error)) {
    return `${JSON.stringify({
      ok: false,
      code: error.code,
      message: error.message
    })}\n`;
  }
  if (error instanceof PageManifestError) {
    return `${JSON.stringify({
      ok: false,
      code: error.code,
      message: error.message
    })}\n`;
  }
  return `${JSON.stringify({
    ok: false,
    code: "UNKNOWN",
    message: error instanceof Error ? error.message : "Unknown error"
  })}\n`;
}

export function exitCodeFor(error: unknown): number {
  if (error instanceof PageManifestError) return exitCodes.validationFailure;
  if (!isCompressionError(error)) return exitCodes.compressionFailure;
  if (error.code === "JOB_CANCELLED" || error.code === "JOB_TIMEOUT") return exitCodes.cancelled;
  if (
    error.code.startsWith("INPUT_") ||
    error.code.startsWith("OUTPUT_") ||
    error.code.startsWith("MANIFEST_")
  ) {
    return exitCodes.validationFailure;
  }
  return exitCodes.compressionFailure;
}
