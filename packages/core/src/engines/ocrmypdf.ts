import { CompressionError } from "../errors.js";
import { OCRMY_PDF_FEATURE_FLOOR } from "../native-floors.js";
import type { OcrLanguage, OcrOptions } from "../ocr.js";
import {
  assertNativeFloor,
  defaultNativeRunner,
  type NativeCallOptions,
  type NativeRunner
} from "./qpdf-pages.js";
import type { RunProcessOptions } from "./process.js";

export interface OcrCapabilities {
  version: string;
  tesseractVersion: string;
  availableLanguages: string[];
}

export interface OcrMyPdfResult extends OcrCapabilities {
  warnings: string[];
}

export interface OcrMyPdfCallOptions extends NativeCallOptions {
  workspacePath: string;
}

function childOptions(options: NativeCallOptions, extra?: RunProcessOptions): RunProcessOptions {
  return { signal: options.signal, timeoutMs: options.timeoutMs, ...(extra ?? {}) };
}

function runnerOf(options: NativeCallOptions): NativeRunner {
  return options.run ?? defaultNativeRunner;
}

export async function getOcrMyPdfVersion(options: NativeCallOptions = {}): Promise<string> {
  const result = await runnerOf(options)("ocrmypdf", ["--version"], childOptions(options));
  const match = [result.stderr, result.stdout]
    .map((output) => /(?:^|\s)(\d+\.\d+\.\d+)(?:\s|$)/.exec(output.trim()))
    .find((candidate) => candidate !== null);
  if (!match) {
    throw new CompressionError("INSPECTION_INCOMPLETE", "Could not determine the OCRmyPDF version.", {
      stdout: result.stdout.slice(0, 500),
      stderr: result.stderr.slice(0, 500)
    });
  }
  const version = match[1];
  assertNativeFloor("ocrmypdf", version, OCRMY_PDF_FEATURE_FLOOR);
  return version;
}

export async function getTesseractVersion(options: NativeCallOptions = {}): Promise<string> {
  const result = await runnerOf(options)("tesseract", ["--version"], childOptions(options));
  const match = /tesseract\s+(\d+\.\d+\.\d+)/i.exec(`${result.stdout}\n${result.stderr}`);
  if (!match) {
    throw new CompressionError("INSPECTION_INCOMPLETE", "Could not determine the Tesseract version.", {
      stdout: result.stdout.slice(0, 500),
      stderr: result.stderr.slice(0, 500)
    });
  }
  return match[1];
}

export async function getTesseractLanguages(options: NativeCallOptions = {}): Promise<string[]> {
  const result = await runnerOf(options)("tesseract", ["--list-langs"], childOptions(options));
  const output = `${result.stdout}\n${result.stderr}`;
  const languages = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[A-Za-z][A-Za-z0-9_-]*$/.test(line));
  if (languages.length === 0) {
    throw new CompressionError("INSPECTION_INCOMPLETE", "Tesseract did not report any installed languages.");
  }
  return [...new Set(languages)];
}

export async function inspectOcrCapabilities(
  ocrOptions: Required<OcrOptions>,
  options: NativeCallOptions = {}
): Promise<OcrCapabilities> {
  const [version, tesseractVersion, availableLanguages] = await Promise.all([
    getOcrMyPdfVersion(options),
    getTesseractVersion(options),
    getTesseractLanguages(options)
  ]);
  const available = new Set(availableLanguages);
  const requiredLanguages = [...ocrOptions.languages, ...(ocrOptions.autoRotate ? ["osd"] : [])];
  const missingLanguages = requiredLanguages.filter((language) => !available.has(language));
  if (missingLanguages.length > 0) {
    throw new CompressionError(
      "OCR_LANGUAGE_UNAVAILABLE",
      `Tesseract is missing the requested language data: ${missingLanguages.join(", ")}.`,
      { missingLanguages, requestedLanguages: requiredLanguages, availableLanguages }
    );
  }
  return { version, tesseractVersion, availableLanguages };
}

/** Fixed v17 CLI contract: preserve text pages, emit PDF, and leave optimization to the app. */
export function ocrMyPdfArgs(
  inputPath: string,
  outputPath: string,
  options: Required<OcrOptions>
): string[] {
  return [
    "--mode",
    "skip",
    "--output-type",
    "pdf",
    "--optimize",
    "0",
    "--language",
    options.languages.join("+"),
    ...(options.autoRotate ? ["--rotate-pages"] : []),
    "--",
    inputPath,
    outputPath
  ];
}

export async function runOcrMyPdf(
  inputPath: string,
  outputPath: string,
  options: Required<OcrOptions>,
  calls: OcrMyPdfCallOptions
): Promise<OcrMyPdfResult> {
  const run = runnerOf(calls);
  const privateRun: NativeRunner = (command, args, options) =>
    run(command, args, {
      ...(options ?? {}),
      cwd: calls.workspacePath,
      tempDir: calls.workspacePath
    });
  const privateCalls = { ...calls, run: privateRun };
  const capabilities = await inspectOcrCapabilities(options, privateCalls);
  const result = await privateRun(
    "ocrmypdf",
    ocrMyPdfArgs(inputPath, outputPath, options),
    childOptions(calls)
  );
  return {
    ...capabilities,
    warnings: result.stderr ? [result.stderr] : []
  };
}
