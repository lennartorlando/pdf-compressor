export { compressPdf, type CompressionOptions, type CompressionSummary } from "./compress.js";
export { CompressionError, isCompressionError, type CompressionErrorCode } from "./errors.js";
export { compressionProfiles, getCompressionProfile, type CompressionProfileName, type CompressionProfile } from "./profiles.js";
export { createTempWorkspace, type TempWorkspace } from "./temp-workspace.js";
export { validatePdfInput, type PdfValidationResult } from "./validation.js";
export type { CompressionEngine, EngineResult } from "./engines/types.js";
