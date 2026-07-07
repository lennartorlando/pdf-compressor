import type { CompressionEngine } from "./types.js";
import { runProcess } from "./process.js";

export const ghostscriptEngine: CompressionEngine = {
  name: "ghostscript",
  supports(profile) {
    return profile.lossy;
  },
  async compress(inputPath, outputPath, profile, signal) {
    const stderr = await runProcess("gs", [
      "-sDEVICE=pdfwrite",
      "-dCompatibilityLevel=1.7",
      `-dPDFSETTINGS=/${profile.pdfSettings}`,
      "-dNOPAUSE",
      "-dQUIET",
      "-dBATCH",
      `-sOutputFile=${outputPath}`,
      inputPath
    ], signal);

    return {
      engine: "ghostscript",
      warnings: stderr ? [stderr] : []
    };
  }
};
