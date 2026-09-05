import type { CompressionProfile } from "../profiles.js";
import type { CompressionEngine } from "./types.js";
import { runProcess } from "./process.js";

/** Argument vector for the optional Ghostscript compression candidate (no shell). */
export function ghostscriptArgs(outputPath: string, profile: CompressionProfile, inputPath: string): string[] {
  return [
    "-sDEVICE=pdfwrite",
    "-dCompatibilityLevel=1.7",
    `-dPDFSETTINGS=/${profile.pdfSettings}`,
    "-dNOPAUSE",
    "-dQUIET",
    "-dBATCH",
    "-dSAFER",
    `-sOutputFile=${outputPath}`,
    "--",
    inputPath
  ];
}

export const ghostscriptEngine: CompressionEngine = {
  name: "ghostscript",
  supports(profile) {
    return profile.lossy;
  },
  async compress(inputPath, outputPath, profile, signal) {
    const result = await runProcess("gs", ghostscriptArgs(outputPath, profile, inputPath), { signal });

    return {
      engine: "ghostscript",
      warnings: result.stderr ? [result.stderr] : []
    };
  }
};
