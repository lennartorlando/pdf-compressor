export { compressPdf, type CompressionOptions, type CompressionSummary } from "./compress.js";
export { CompressionError, isCompressionError, type CompressionErrorCode } from "./errors.js";
export { compressionProfiles, getCompressionProfile, type CompressionProfileName, type CompressionProfile } from "./profiles.js";
export { createTempWorkspace, type TempWorkspace } from "./temp-workspace.js";
export { validatePdfInput, assertFreshDestination, type PdfValidationResult } from "./validation.js";
export type { CompressionEngine, EngineResult } from "./engines/types.js";
export {
  assemblePages,
  inspectSources,
  normalizeBindings,
  MAX_OUTPUT_PAGES,
  DEFAULT_EXPORT_TIMEOUT_MS,
  type PageSourceBinding,
  type AssemblePagesOptions,
  type AssemblySummary,
  type InspectSourcesOptions
} from "./pages.js";
export {
  QPDF_FEATURE_FLOOR,
  QPDF_SECURITY_FLOOR,
  GHOSTSCRIPT_SECURITY_FLOOR,
} from "./native-floors.js";
export {
  NATIVE_PARSER_RISK_NOTE,
  parseVersionTuple,
  compareVersionTuples,
  assertNativeFloor,
  getQpdfVersion,
  getGhostscriptVersion,
  classifyQpdfJson,
  inspectPdfSource,
  runQpdfAssemblyMutation,
  validatePdfArtifact,
  publishNoClobber,
  type ActiveContentKind,
  type CompatWarningKind,
  type PdfInspection,
  type NativeRunner,
  type PageGroup,
  type AssemblyMutation,
  type NativeCallOptions
} from "./engines/qpdf-pages.js";
export { ghostscriptArgs } from "./engines/ghostscript.js";
