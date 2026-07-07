import type { CompressionProfile } from "../profiles.js";

export interface EngineResult {
  engine: string;
  warnings: string[];
}

export interface CompressionEngine {
  name: string;
  supports(profile: CompressionProfile): boolean;
  compress(inputPath: string, outputPath: string, profile: CompressionProfile, signal?: AbortSignal): Promise<EngineResult>;
}
