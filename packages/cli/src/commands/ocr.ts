import { resolve } from "node:path";
import {
  CompressionError,
  ocrPdf,
  type NativeRunner,
  type OcrLanguage
} from "@pdf-compressor/core";
import { withDestinationPublication } from "../destination.js";
import {
  exitCodeFor,
  formatJsonError,
  formatJsonSuccess,
  usageErrorResult,
  type CliResult
} from "../output.js";

export interface OcrCommandOptions {
  inputPath: string;
  outputPath: string;
  languages: OcrLanguage[];
  autoRotate: boolean;
  overwrite: boolean;
  json: boolean;
}

export interface OcrCommandDeps {
  run?: NativeRunner;
  signal?: AbortSignal;
}

function isOcrLanguage(value: string): value is OcrLanguage {
  return value === "deu" || value === "eng";
}

export function parseOcrLanguages(value: string): OcrLanguage[] {
  if (value !== "deu" && value !== "eng" && value !== "deu+eng") {
    throw new CompressionError("OCR_OPTIONS_INVALID", "OCR languages must be deu, eng, or deu+eng.");
  }
  const languages = value.split("+");
  return languages.filter(isOcrLanguage);
}

export function parseOcrArgs(args: string[]): OcrCommandOptions {
  let inputPath: string | undefined;
  let outputPath: string | undefined;
  let languages: OcrLanguage[] = ["deu", "eng"];
  let autoRotate = true;
  let overwrite = false;
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--output" || token === "-o") {
      outputPath = args[++index];
      if (!outputPath) throw new Error("Missing value for --output.");
    } else if (token.startsWith("--output=")) {
      outputPath = token.slice("--output=".length);
      if (!outputPath) throw new Error("Missing value for --output.");
    } else if (token === "--language") {
      const value = args[++index];
      if (!value) throw new Error("Missing value for --language.");
      languages = parseOcrLanguages(value);
    } else if (token.startsWith("--language=")) {
      const value = token.slice("--language=".length);
      if (!value) throw new Error("Missing value for --language.");
      languages = parseOcrLanguages(value);
    } else if (token === "--no-rotate-pages") {
      autoRotate = false;
    } else if (token === "--overwrite") {
      overwrite = true;
    } else if (token === "--json") {
      json = true;
    } else if (token.startsWith("-")) {
      throw new Error(`Unknown option: ${token}`);
    } else if (inputPath === undefined) {
      inputPath = token;
    } else {
      throw new Error(`Unexpected positional argument: ${token}`);
    }
  }

  if (!inputPath) throw new Error("Missing input PDF path.");
  if (!outputPath) throw new Error("Missing --output path.");
  return { inputPath, outputPath, languages, autoRotate, overwrite, json };
}

export async function runOcrCommand(
  args: string[],
  deps: OcrCommandDeps = {}
): Promise<CliResult> {
  let options: OcrCommandOptions;
  try {
    options = parseOcrArgs(args);
  } catch (error) {
    if (error instanceof CompressionError) {
      if (args.includes("--json")) {
        return { exitCode: exitCodeFor(error), stdout: formatJsonError(error), stderr: "" };
      }
      return { exitCode: exitCodeFor(error), stdout: "", stderr: `${error.message}\n` };
    }
    if (args.includes("--json")) return usageErrorResult(error);
    return {
      exitCode: 64,
      stdout: "",
      stderr: `${error instanceof Error ? error.message : "Invalid arguments"}\n${ocrUsage()}`
    };
  }

  try {
    const inputPath = resolve(options.inputPath);
    const outputPath = resolve(options.outputPath);
    const summary = await withDestinationPublication(
      outputPath,
      [inputPath],
      options.overwrite,
      (publishedPath) => ocrPdf({
        inputPath,
        outputPath: publishedPath,
        languages: options.languages,
        autoRotate: options.autoRotate,
        signal: deps.signal,
        run: deps.run
      })
    );

    if (options.json) {
      return { exitCode: 0, stdout: formatJsonSuccess(summary), stderr: "" };
    }
    return {
      exitCode: 0,
      stdout: [
        `OCR completed for ${summary.inputPath}`,
        `Output: ${summary.outputPath}`,
        `Engine: ${summary.engine} ${summary.version}`,
        `Languages: ${summary.languages.join("+")}`,
        `Size: ${summary.outputBytes} bytes`
      ].join("\n") + "\n",
      stderr: summary.warnings.length ? `${summary.warnings.join("\n")}\n` : ""
    };
  } catch (error) {
    if (options.json) {
      return { exitCode: exitCodeFor(error), stdout: formatJsonError(error), stderr: "" };
    }
    return {
      exitCode: exitCodeFor(error),
      stdout: "",
      stderr: `${error instanceof Error ? error.message : "OCR failed"}\n`
    };
  }
}

export function ocrUsage(): string {
  return [
    "Usage: pdf-compressor ocr <input.pdf> --output <out.pdf> [--language deu+eng] [--no-rotate-pages] [--overwrite] [--json]",
    ""
  ].join("\n");
}
