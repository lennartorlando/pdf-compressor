import { copyFile, rename, stat } from "node:fs/promises";
import { basename } from "node:path";
import { CompressionError } from "./errors.js";
import { getCompressionProfile, type CompressionProfileName } from "./profiles.js";
import { createTempWorkspace } from "./temp-workspace.js";
import { validatePdfInput } from "./validation.js";
import { qpdfEngine } from "./engines/qpdf.js";
import { ghostscriptEngine } from "./engines/ghostscript.js";
import type { CompressionEngine } from "./engines/types.js";

export interface CompressionOptions {
  inputPath: string;
  outputPath: string;
  profile: CompressionProfileName;
  signal?: AbortSignal;
  engines?: CompressionEngine[];
}

export interface CompressionSummary {
  status: "success" | "no_gain";
  inputPath: string;
  outputPath: string;
  profile: CompressionProfileName;
  originalBytes: number;
  outputBytes: number;
  reductionBytes: number;
  reductionPercent: number;
  outputSmaller: boolean;
  engine: string;
  warnings: string[];
}

const defaultEngines = [ghostscriptEngine, qpdfEngine];

export async function compressPdf(options: CompressionOptions): Promise<CompressionSummary> {
  if (options.signal?.aborted) {
    throw new CompressionError("JOB_CANCELLED", "Compression job was cancelled.");
  }

  const validation = await validatePdfInput(options.inputPath, options.outputPath);
  const profile = getCompressionProfile(options.profile);
  const engines = options.engines ?? defaultEngines;
  const engine = engines.find((candidate) => candidate.supports(profile));

  if (!engine) {
    throw new CompressionError("ENGINE_UNAVAILABLE", `No compression engine supports ${profile.name}.`);
  }

  const workspace = await createTempWorkspace();
  const candidatePath = workspace.file(`compressed-${basename(options.inputPath)}`);

  try {
    const result = await engine.compress(options.inputPath, candidatePath, profile, options.signal);

    if (options.signal?.aborted) {
      throw new CompressionError("JOB_CANCELLED", "Compression job was cancelled.");
    }

    const outputStat = await stat(candidatePath);
    await copyFile(candidatePath, options.outputPath);
    const finalStat = await stat(options.outputPath);
    const reductionBytes = validation.sizeBytes - finalStat.size;
    const reductionPercent = validation.sizeBytes === 0
      ? 0
      : Number(((reductionBytes / validation.sizeBytes) * 100).toFixed(2));

    return {
      status: reductionBytes > 0 ? "success" : "no_gain",
      inputPath: options.inputPath,
      outputPath: options.outputPath,
      profile: profile.name,
      originalBytes: validation.sizeBytes,
      outputBytes: outputStat.size,
      reductionBytes,
      reductionPercent,
      outputSmaller: reductionBytes > 0,
      engine: result.engine,
      warnings: result.warnings
    };
  } catch (error) {
    await rmOutputIfCancelled(options.outputPath, error);
    throw error;
  } finally {
    await workspace.cleanup();
  }
}

async function rmOutputIfCancelled(outputPath: string, error: unknown): Promise<void> {
  if (error instanceof CompressionError && error.code === "JOB_CANCELLED") {
    const { rm } = await import("node:fs/promises");
    await rm(outputPath, { force: true });
  }
}

export async function atomicMove(sourcePath: string, outputPath: string): Promise<void> {
  await rename(sourcePath, outputPath);
}
