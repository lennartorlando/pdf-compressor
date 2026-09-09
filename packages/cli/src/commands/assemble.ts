import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  CompressionError,
  assemblePages,
  compressionProfiles,
  type CompressionProfileName,
  type NativeRunner,
  type OcrOptions,
  type PageSourceBinding
} from "@pdf-compressor/core";
import {
  PageManifestError,
  parsePageManifest,
  type PageManifest
} from "@pdf-compressor/core/page-manifest";
import { withDestinationPublication } from "../destination.js";
import { parseOcrLanguages } from "./ocr.js";
import {
  exitCodeFor,
  formatJsonError,
  formatJsonSuccess,
  usageErrorResult,
  type CliResult
} from "../output.js";

export interface AssembleCommandOptions {
  sources: PageSourceBinding[];
  manifestPath: string;
  destinationPath: string;
  compression: CompressionProfileName | null;
  ocr: OcrOptions | null;
  json: boolean;
  overwrite: boolean;
}

export interface AssembleCommandDeps {
  run?: NativeRunner;
  signal?: AbortSignal;
}

export function parseAssembleArgs(args: string[]): AssembleCommandOptions {
  const sources: PageSourceBinding[] = [];
  let manifestPath: string | undefined;
  let destinationPath: string | undefined;
  let compression: CompressionProfileName | null = null;
  let ocrEnabled = false;
  let ocrLanguages = parseOcrLanguages("deu+eng");
  let ocrAutoRotate = true;
  let ocrLanguageSpecified = false;
  let ocrRotationSpecified = false;
  let json = false;
  let overwrite = false;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--source") {
      const binding = args[++index];
      if (!binding) throw new Error("Missing value for --source. Use --source <id>=<path>.");
      sources.push(parseSourceBinding(binding));
    } else if (token.startsWith("--source=")) {
      sources.push(parseSourceBinding(token.slice("--source=".length)));
    } else if (token === "--manifest") {
      manifestPath = args[++index];
      if (!manifestPath) throw new Error("Missing value for --manifest.");
    } else if (token.startsWith("--manifest=")) {
      manifestPath = token.slice("--manifest=".length);
    } else if (token === "--output" || token === "-o") {
      destinationPath = args[++index];
      if (!destinationPath) throw new Error("Missing value for --output.");
    } else if (token.startsWith("--output=")) {
      destinationPath = token.slice("--output=".length);
    } else if (token === "--compression" || token === "--compress" || token === "--profile") {
      const name = args[++index];
      if (!name) throw new Error("Missing value for --compression.");
      if (!compressionProfiles[name as CompressionProfileName]) {
        throw new Error(`Unsupported compression profile: ${name}`);
      }
      compression = name as CompressionProfileName;
    } else if (token.startsWith("--compression=")) {
      const name = token.slice("--compression=".length);
      if (!compressionProfiles[name as CompressionProfileName]) {
        throw new Error(`Unsupported compression profile: ${name}`);
      }
      compression = name as CompressionProfileName;
    } else if (token === "--json") {
      json = true;
    } else if (token === "--overwrite") {
      overwrite = true;
    } else if (token === "--ocr") {
      ocrEnabled = true;
    } else if (token === "--ocr-language") {
      const value = args[++index];
      if (!value) throw new Error("Missing value for --ocr-language.");
      ocrLanguages = parseOcrLanguages(value);
      ocrLanguageSpecified = true;
    } else if (token.startsWith("--ocr-language=")) {
      const value = token.slice("--ocr-language=".length);
      if (!value) throw new Error("Missing value for --ocr-language.");
      ocrLanguages = parseOcrLanguages(value);
      ocrLanguageSpecified = true;
    } else if (token === "--no-ocr-rotate-pages") {
      ocrAutoRotate = false;
      ocrRotationSpecified = true;
    } else if (token.startsWith("-")) {
      throw new Error(`Unknown option: ${token}`);
    } else {
      throw new Error(`Unexpected positional argument: ${token}`);
    }
  }

  if (sources.length === 0) throw new Error("Missing --source bindings. Use --source <id>=<path>.");
  if (!manifestPath) throw new Error("Missing --manifest path.");
  if (!destinationPath) throw new Error("Missing --output path.");
  if (!ocrEnabled && ocrLanguageSpecified) throw new Error("--ocr-language requires --ocr.");
  if (!ocrEnabled && ocrRotationSpecified) throw new Error("--no-ocr-rotate-pages requires --ocr.");
  const ocr = ocrEnabled ? { languages: ocrLanguages, autoRotate: ocrAutoRotate } : null;
  return { sources, manifestPath, destinationPath, compression, ocr, json, overwrite };
}

function parseSourceBinding(binding: string): PageSourceBinding {
  const separator = binding.indexOf("=");
  if (separator <= 0 || separator === binding.length - 1) {
    throw new Error(`Invalid --source binding "${binding}". Use --source <id>=<path>.`);
  }
  return { id: binding.slice(0, separator), path: binding.slice(separator + 1) };
}

function manifestErrorToCore(error: PageManifestError): CompressionError {
  switch (error.code) {
    case "MANIFEST_INVALID_PAGE_NUMBER":
      return new CompressionError("MANIFEST_INVALID_PAGE", error.message);
    case "MANIFEST_INVALID_SOURCE_ID":
    case "MANIFEST_INVALID_INDEX":
    case "MANIFEST_INVALID":
      return new CompressionError("MANIFEST_INVALID", error.message);
    case "MANIFEST_INVALID_ROTATION":
      return new CompressionError("MANIFEST_INVALID_ROTATION", error.message);
  }
}

async function readManifest(manifestPath: string): Promise<PageManifest> {
  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch {
    throw new CompressionError("MANIFEST_INVALID", `Manifest file was not found: ${manifestPath}.`, {
      manifestPath
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CompressionError("MANIFEST_INVALID", `Manifest file is not valid JSON: ${manifestPath}.`, {
      manifestPath
    });
  }
  try {
    return parsePageManifest(parsed);
  } catch (error) {
    if (error instanceof PageManifestError) throw manifestErrorToCore(error);
    throw error;
  }
}

export async function runAssembleCommand(
  args: string[],
  deps: AssembleCommandDeps = {}
): Promise<CliResult> {
  let options: AssembleCommandOptions;
  try {
    options = parseAssembleArgs(args);
  } catch (error) {
    if (error instanceof CompressionError) {
      if (args.includes("--json")) {
        return { exitCode: exitCodeFor(error), stdout: formatJsonError(error), stderr: "" };
      }
      return { exitCode: exitCodeFor(error), stdout: "", stderr: `${error.message}\n` };
    }
    if (args.includes("--json")) {
      return usageErrorResult(error);
    }
    return {
      exitCode: 64,
      stdout: "",
      stderr: `${error instanceof Error ? error.message : "Invalid arguments"}\n${assembleUsage()}`
    };
  }

  try {
    const manifest = await readManifest(resolve(options.manifestPath));
    // The core runs native tools from a private working directory, so the
    // adapter resolves invocation-relative paths to absolute paths here.
    const sources = options.sources.map((source) => ({ id: source.id, path: resolve(source.path) }));
    const destinationPath = resolve(options.destinationPath);
    const summary = await withDestinationPublication(
      destinationPath,
      sources.map((source) => source.path),
      options.overwrite,
      (outputPath) => assemblePages({
        sources,
        manifest,
        destinationPath: outputPath,
        compression: options.compression,
        ocr: options.ocr,
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
        `Assembled ${summary.pageCount} pages`,
        `Output: ${summary.outputPath}`,
        `Engine: ${summary.engine}`,
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
      stderr: `${error instanceof Error ? error.message : "Assembly failed"}\n`
    };
  }
}

export function assembleUsage(): string {
  return [
    "Usage: pdf-compressor assemble --source <id>=<path> [--source ...] --manifest <manifest.json> --output <out.pdf> [--compression conservative|balanced|aggressive] [--ocr] [--ocr-language deu+eng] [--no-ocr-rotate-pages] [--overwrite] [--json]",
    ""
  ].join("\n");
}
