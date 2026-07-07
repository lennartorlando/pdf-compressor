import { stat } from "node:fs/promises";
import { CompressionError, compressPdf, compressionProfiles, type CompressionProfileName } from "@pdf-compressor/core";
import { exitCodeFor, formatJsonError, formatJsonSuccess, type CliResult } from "../output.js";

export interface CompressCommandOptions {
  inputPath?: string;
  outputPath?: string;
  profile: CompressionProfileName;
  json: boolean;
  overwrite: boolean;
}

export function parseCompressArgs(args: string[]): CompressCommandOptions {
  const options: CompressCommandOptions = {
    profile: "balanced",
    json: false,
    overwrite: false
  };

  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--output" || token === "-o") {
      options.outputPath = args[++index];
    } else if (token === "--profile" || token === "-p") {
      options.profile = args[++index] as CompressionProfileName;
    } else if (token === "--json") {
      options.json = true;
    } else if (token === "--overwrite") {
      options.overwrite = true;
    } else if (token.startsWith("-")) {
      throw new Error(`Unknown option: ${token}`);
    } else {
      positional.push(token);
    }
  }

  options.inputPath = positional[0];
  if (!options.inputPath) throw new Error("Missing input PDF path.");
  if (!options.outputPath) throw new Error("Missing --output path.");
  if (!compressionProfiles[options.profile]) throw new Error(`Unsupported profile: ${options.profile}`);
  return options;
}

export async function runCompressCommand(args: string[]): Promise<CliResult> {
  let options: CompressCommandOptions;
  try {
    options = parseCompressArgs(args);
  } catch (error) {
    return {
      exitCode: 64,
      stdout: "",
      stderr: `${error instanceof Error ? error.message : "Invalid arguments"}\n${usage()}`
    };
  }

  try {
    if (!options.overwrite && await pathExists(options.outputPath!)) {
      throw new CompressionError("OUTPUT_EXISTS", "Output path already exists. Pass --overwrite to replace it.");
    }

    const summary = await compressPdf({
      inputPath: options.inputPath!,
      outputPath: options.outputPath!,
      profile: options.profile
    });

    if (options.json) {
      return { exitCode: 0, stdout: formatJsonSuccess(summary), stderr: "" };
    }

    return {
      exitCode: 0,
      stdout: [
        `Compressed ${summary.inputPath}`,
        `Output: ${summary.outputPath}`,
        `Original: ${summary.originalBytes} bytes`,
        `Result: ${summary.outputBytes} bytes`,
        `Reduction: ${summary.reductionPercent}%`
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
      stderr: `${error instanceof Error ? error.message : "Compression failed"}\n`
    };
  }
}

export function usage(): string {
  return [
    "Usage: pdf-compressor compress <input.pdf> --output <output.pdf> [--profile conservative|balanced|aggressive] [--json]",
    ""
  ].join("\n");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
