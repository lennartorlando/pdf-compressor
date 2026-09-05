/**
 * Browser-safe native version floors (no Node imports).
 *
 * Single source of truth for the qpdf/Ghostscript floors shared by the
 * Node core, the local server, and the browser UI. `qpdf-pages.ts`
 * re-exports these values so existing `@pdf-compressor/core` imports keep
 * working; browser code imports this subpath directly
 * (`@pdf-compressor/core/native-floors`) so the compressor shell never
 * eagerly pulls Node-coupled modules.
 */

/** Feature floor: `--file=`/`--range=` page-selection syntax needs qpdf 11.9.0+. */
export const QPDF_FEATURE_FLOOR = "11.9.0";
/** Security floor: local certification covers exactly 12.4.1; fail closed below. */
export const QPDF_SECURITY_FLOOR = "12.4.1";
/** Security floor for the optional Ghostscript compression candidate. */
export const GHOSTSCRIPT_SECURITY_FLOOR = "10.07.1";
