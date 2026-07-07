export type CompressionErrorCode =
  | "INPUT_NOT_FOUND"
  | "INPUT_NOT_PDF"
  | "INPUT_ENCRYPTED"
  | "OUTPUT_WOULD_OVERWRITE_INPUT"
  | "OUTPUT_EXISTS"
  | "ENGINE_UNAVAILABLE"
  | "ENGINE_FAILED"
  | "JOB_CANCELLED";

export class CompressionError extends Error {
  constructor(
    public readonly code: CompressionErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "CompressionError";
  }
}

export function isCompressionError(error: unknown): error is CompressionError {
  return error instanceof CompressionError;
}
