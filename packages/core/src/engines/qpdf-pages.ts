import { link, unlink } from "node:fs/promises";
import { CompressionError } from "../errors.js";
import { runProcess, type ProcessResult, type RunProcessOptions } from "./process.js";

/**
 * Low-level qpdf inspection, single-mutation page assembly, final
 * validation, native version gating, and no-clobber publication.
 *
 * Residual local-parser risk: qpdf and Ghostscript parse
 * attacker-controlled bytes with the user account's filesystem authority
 * unless packaging adds OS isolation. Current upstream has unresolved
 * parser/resource-exhaustion issues marked for a later release, so this
 * module fails closed below the security floors and caps native output.
 * Native parsing is never sandboxed here; callers must keep the documented
 * byte, page, and runtime limits.
 */

/** Feature floor: `--file=`/`--range=` page-selection syntax needs qpdf 11.9.0+. */
export const QPDF_FEATURE_FLOOR = "11.9.0";
/** Security floor: local certification covers exactly 12.4.1; fail closed below. */
export const QPDF_SECURITY_FLOOR = "12.4.1";
/** Security floor for the optional Ghostscript compression candidate. */
export const GHOSTSCRIPT_SECURITY_FLOOR = "10.07.1";

export const NATIVE_PARSER_RISK_NOTE =
  "Native PDF parsing runs with the user account's filesystem authority and is not OS-sandboxed; " +
  "upstream parser/resource-exhaustion fixes are pending a later release, so versions below the " +
  "security floor fail closed.";

export type ActiveContentKind =
  | "javascript"
  | "open-action"
  | "additional-actions"
  | "launch"
  | "submit-import"
  | "rich-media"
  | "embedded-files";

export type CompatWarningKind = "forms" | "bookmarks" | "tags" | "page-labels";

export interface PdfInspection {
  path: string;
  pageCount: number;
  pdfVersion: string;
  qpdfVersion: string;
  encrypted: boolean;
  signed: boolean;
  activeContent: ActiveContentKind[];
  compatWarnings: CompatWarningKind[];
  /** qpdf stderr warnings (exit code 3 still yields a usable inspection). */
  warnings: string[];
}

export type NativeRunner = (
  command: string,
  args: readonly string[],
  options?: RunProcessOptions
) => Promise<ProcessResult>;

export const defaultNativeRunner: NativeRunner = (command, args, options) =>
  runProcess(command, args, options ?? {});

export interface NativeCallOptions {
  run?: NativeRunner;
  signal?: AbortSignal;
  timeoutMs?: number;
}

function childOptions(options: NativeCallOptions, extra?: RunProcessOptions): RunProcessOptions {
  return { signal: options.signal, timeoutMs: options.timeoutMs, ...(extra ?? {}) };
}

export function parseVersionTuple(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareVersionTuples(
  left: [number, number, number],
  right: [number, number, number]
): number {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

/** Fail closed when a native tool reports a version below the given floor. */
export function assertNativeFloor(tool: string, found: string, floor: string): void {
  const foundTuple = parseVersionTuple(found);
  const floorTuple = parseVersionTuple(floor);
  if (!foundTuple || !floorTuple || compareVersionTuples(foundTuple, floorTuple) < 0) {
    throw new CompressionError(
      "NATIVE_VERSION_UNSUPPORTED",
      `${tool} version ${found} is below the required floor ${floor}. ${NATIVE_PARSER_RISK_NOTE}`,
      { tool, found, floor }
    );
  }
}

export async function getQpdfVersion(options: NativeCallOptions = {}): Promise<string> {
  const run = options.run ?? defaultNativeRunner;
  const result = await run("qpdf", ["--version"], childOptions(options));
  const match = /qpdf version (\d+\.\d+\.\d+)/.exec(result.stdout);
  if (!match) {
    throw new CompressionError("INSPECTION_INCOMPLETE", "Could not determine the qpdf version.", {
      stdout: result.stdout.slice(0, 500)
    });
  }
  return match[1];
}

export async function getGhostscriptVersion(options: NativeCallOptions = {}): Promise<string> {
  const run = options.run ?? defaultNativeRunner;
  const result = await run("gs", ["--version"], childOptions(options));
  const version = result.stdout.split("\n")[0]?.trim() ?? "";
  if (!parseVersionTuple(version)) {
    throw new CompressionError("INSPECTION_INCOMPLETE", "Could not determine the Ghostscript version.", {
      stdout: version.slice(0, 500)
    });
  }
  return version;
}

interface QpdfJson {
  pages?: Array<{ object?: string }>;
  outlines?: unknown[];
  acroform?: { hasacroform?: boolean; fields?: unknown[] };
  attachments?: Record<string, unknown>;
  encrypt?: { encrypted?: boolean };
  pagelabels?: unknown[];
  qpdf?: [{ pdfversion?: string }, Record<string, unknown>];
}

function scanObjects(objectsText: string, pattern: RegExp): boolean {
  return pattern.test(objectsText);
}

/**
 * Map raw qpdf object text to blocked active-content classes (fail closed)
 * and inert compatibility warnings (surface without claiming preservation).
 */
export function classifyQpdfJson(raw: QpdfJson): {
  signed: boolean;
  activeContent: ActiveContentKind[];
  compatWarnings: CompatWarningKind[];
} {
  const objectsText = JSON.stringify(raw.qpdf?.[1] ?? {});
  const activeContent: ActiveContentKind[] = [];
  if (scanObjects(objectsText, /\/JavaScript\b/) || scanObjects(objectsText, /\/JS\b/)) {
    activeContent.push("javascript");
  }
  if (scanObjects(objectsText, /\/OpenAction\b/)) activeContent.push("open-action");
  if (scanObjects(objectsText, /\/AA\b/)) activeContent.push("additional-actions");
  if (scanObjects(objectsText, /\/Launch\b/)) activeContent.push("launch");
  if (scanObjects(objectsText, /\/SubmitForm\b/) || scanObjects(objectsText, /\/ImportData\b/)) {
    activeContent.push("submit-import");
  }
  if (scanObjects(objectsText, /\/RichMedia\b/)) activeContent.push("rich-media");
  if (
    scanObjects(objectsText, /\/EmbeddedFiles\b/) ||
    scanObjects(objectsText, /\/Filespec\b/) ||
    Object.keys(raw.attachments ?? {}).length > 0
  ) {
    activeContent.push("embedded-files");
  }

  // A document signature (/Sig field, /DocMDP permissions, /ByteRange) must
  // block page export: assembly would invalidate it silently.
  const signed =
    scanObjects(objectsText, /\/Sig\b/) ||
    scanObjects(objectsText, /\/DocMDP\b/) ||
    scanObjects(objectsText, /\/ByteRange\b/);

  const compatWarnings: CompatWarningKind[] = [];
  if (raw.acroform?.hasacroform === true || (raw.acroform?.fields?.length ?? 0) > 0) {
    compatWarnings.push("forms");
  }
  if ((raw.outlines?.length ?? 0) > 0) compatWarnings.push("bookmarks");
  if (
    scanObjects(objectsText, /\/StructTreeRoot\b/) ||
    scanObjects(objectsText, /\/MarkInfo\b/)
  ) {
    compatWarnings.push("tags");
  }
  if ((raw.pagelabels?.length ?? 0) > 0) compatWarnings.push("page-labels");

  return { signed, activeContent, compatWarnings };
}

function isPasswordError(stderr: string): boolean {
  return /invalid password|incorrect password|password/i.test(stderr) && /password/i.test(stderr);
}

/**
 * Read-only inspection of one source PDF via `qpdf --json`.
 * Exit code 3 (warnings) still yields an inspection plus warnings; qpdf
 * warnings that prevent complete inspection are fatal.
 */
export async function inspectPdfSource(
  sourcePath: string,
  options: NativeCallOptions = {}
): Promise<PdfInspection> {
  const run = options.run ?? defaultNativeRunner;
  const qpdfVersion = await getQpdfVersion(options);
  assertNativeFloor("qpdf", qpdfVersion, QPDF_SECURITY_FLOOR);

  let result: ProcessResult;
  try {
    result = await run("qpdf", ["--json", "--", sourcePath], childOptions(options, { allowedExitCodes: [0, 3] }));
  } catch (error) {
    if (error instanceof CompressionError && error.code === "ENGINE_FAILED") {
      const stderr = String((error.details?.["stderr"] as string | undefined) ?? "");
      if (isPasswordError(stderr) || /\/Encrypt\b/.test(stderr)) {
        throw new CompressionError("INPUT_ENCRYPTED", `Source PDF is encrypted: ${sourcePath}.`, {
          inputPath: sourcePath
        });
      }
      // qpdf warnings that prevent complete inspection are fatal: the file
      // cannot be trusted as an assembly input.
      throw new CompressionError(
        "INSPECTION_INCOMPLETE",
        `qpdf could not inspect ${sourcePath}; treating inspection as incomplete.`,
        { inputPath: sourcePath, stderr: stderr.slice(0, 500) }
      );
    }
    throw error;
  }

  let parsed: QpdfJson;
  try {
    parsed = JSON.parse(result.stdout) as QpdfJson;
  } catch {
    throw new CompressionError(
      "INSPECTION_INCOMPLETE",
      `qpdf inspection of ${sourcePath} did not produce complete JSON output.`,
      { inputPath: sourcePath, stderr: result.stderr.slice(0, 500) }
    );
  }
  if (!Array.isArray(parsed.pages)) {
    throw new CompressionError(
      "INSPECTION_INCOMPLETE",
      `qpdf inspection of ${sourcePath} did not report any pages.`,
      { inputPath: sourcePath }
    );
  }
  if (parsed.encrypt?.encrypted === true) {
    throw new CompressionError("INPUT_ENCRYPTED", `Source PDF is encrypted: ${sourcePath}.`, {
      inputPath: sourcePath
    });
  }

  const { signed, activeContent, compatWarnings } = classifyQpdfJson(parsed);
  return {
    path: sourcePath,
    pageCount: parsed.pages.length,
    pdfVersion: parsed.qpdf?.[0]?.pdfversion ?? "unknown",
    qpdfVersion,
    encrypted: false,
    signed,
    activeContent,
    compatWarnings,
    warnings: result.stderr ? [result.stderr] : []
  };
}

export interface PageGroup {
  /** Absolute source path (passed as --file=<path>, safe for leading dashes). */
  path: string;
  /** qpdf page range, e.g. "3" or "1,4,6". */
  range: string;
}

export interface AssemblyMutation {
  /** Null primary path selects --empty (multi-source assembly is a new document). */
  primaryPath: string | null;
  groups: PageGroup[];
  /** Output-position page ranges per relative rotation, e.g. { 90: ["1,3"] }. */
  rotations: Partial<Record<90 | 180 | 270, string[]>>;
  candidatePath: string;
}

/**
 * Run exactly one qpdf page-selection mutation with structural optimization.
 * Relative rotations are addressed against output page positions.
 */
export async function runQpdfAssemblyMutation(
  mutation: AssemblyMutation,
  options: NativeCallOptions = {}
): Promise<string[]> {
  const run = options.run ?? defaultNativeRunner;
  const args: string[] = [];
  if (mutation.primaryPath === null) {
    args.push("--empty");
  } else {
    args.push("--", mutation.primaryPath);
  }
  args.push("--pages");
  for (const group of mutation.groups) {
    args.push(`--file=${group.path}`, `--range=${group.range}`);
  }
  args.push("--");
  for (const angle of [90, 180, 270] as const) {
    const ranges = mutation.rotations[angle];
    if (ranges && ranges.length > 0) {
      args.push(`--rotate=+${angle}:${ranges.join(",")}`);
    }
  }
  args.push(
    "--object-streams=generate",
    "--compress-streams=y",
    "--recompress-flate",
    "--",
    mutation.candidatePath
  );
  const result = await run("qpdf", args, childOptions(options, { allowedExitCodes: [0, 3] }));
  return result.stderr ? [result.stderr] : [];
}

/**
 * Validate a candidate or final artifact: `qpdf --check` must pass and a
 * fresh `--json` inspection must report the expected page count with no
 * blocked content. Returns the final inspection.
 */
export async function validatePdfArtifact(
  candidatePath: string,
  expectedPages: number,
  options: NativeCallOptions = {}
): Promise<PdfInspection> {
  const run = options.run ?? defaultNativeRunner;
  await run("qpdf", ["--check", "--", candidatePath], childOptions(options, { allowedExitCodes: [0, 3] }));
  const inspection = await inspectPdfSource(candidatePath, options);
  if (inspection.pageCount !== expectedPages) {
    throw new CompressionError(
      "OUTPUT_INVALID",
      `Final PDF has ${inspection.pageCount} pages but the manifest describes ${expectedPages}.`,
      { outputPath: candidatePath, pageCount: inspection.pageCount, expectedPages }
    );
  }
  if (inspection.encrypted) {
    throw new CompressionError("OUTPUT_INVALID", "Final PDF reports encryption.", {
      outputPath: candidatePath
    });
  }
  if (inspection.signed || inspection.activeContent.length > 0) {
    throw new CompressionError(
      "OUTPUT_INVALID",
      "Final PDF contains blocked signatures or active content.",
      {
        outputPath: candidatePath,
        signed: inspection.signed,
        activeContent: inspection.activeContent
      }
    );
  }
  return inspection;
}

/**
 * Publish a staged file beside the destination without clobbering: an
 * atomic hard link fails with EEXIST when the destination appeared during
 * export. Staging beside the destination keeps both on one filesystem so
 * EXDEV cannot silently downgrade the guarantee; anything else fails closed.
 */
export async function publishNoClobber(stagingPath: string, destinationPath: string): Promise<void> {
  try {
    await link(stagingPath, destinationPath);
  } catch (error) {
    await unlink(stagingPath).catch(() => undefined);
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
      throw new CompressionError(
        "OUTPUT_EXISTS",
        "Destination was created while the export was running; nothing was overwritten.",
        { outputPath: destinationPath }
      );
    }
    throw new CompressionError("PUBLISH_FAILED", `Could not publish ${destinationPath} without clobbering.`, {
      outputPath: destinationPath
    });
  }
  await unlink(stagingPath).catch(() => undefined);
}
