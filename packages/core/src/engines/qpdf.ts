import type { CompressionEngine } from "./types.js";
import { runProcess } from "./process.js";

export const qpdfEngine: CompressionEngine = {
  name: "qpdf",
  supports() {
    return true;
  },
  async compress(inputPath, outputPath, _profile, signal) {
    const result = await runProcess(
      "qpdf",
      [
        "--object-streams=generate",
        "--compress-streams=y",
        "--recompress-flate",
        "--",
        inputPath,
        outputPath
      ],
      { signal, allowedExitCodes: [0, 3] }
    );

    return {
      engine: "qpdf",
      warnings: result.stderr ? [result.stderr] : []
    };
  }
};
