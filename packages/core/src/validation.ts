import { readFile, stat } from "node:fs/promises";
import { CompressionError } from "./errors.js";

export interface PdfValidationResult {
  inputPath: string;
  sizeBytes: number;
}

export async function validatePdfInput(inputPath: string, outputPath?: string): Promise<PdfValidationResult> {
  if (outputPath && inputPath === outputPath) {
    throw new CompressionError(
      "OUTPUT_WOULD_OVERWRITE_INPUT",
      "Output path must be different from the source PDF."
    );
  }

  let fileStat;
  try {
    fileStat = await stat(inputPath);
  } catch {
    throw new CompressionError("INPUT_NOT_FOUND", "Source PDF was not found.", { inputPath });
  }

  if (!fileStat.isFile()) {
    throw new CompressionError("INPUT_NOT_FOUND", "Source PDF path is not a file.", { inputPath });
  }

  const bytes = await readFile(inputPath);
  const header = bytes.subarray(0, 1024).toString("latin1");
  if (!header.includes("%PDF-")) {
    throw new CompressionError("INPUT_NOT_PDF", "Source file is not a supported PDF.");
  }

  const bodySample = bytes.toString("latin1");
  if (/\/Encrypt\b/.test(bodySample)) {
    throw new CompressionError("INPUT_ENCRYPTED", "Encrypted PDFs are not supported yet.");
  }

  return {
    inputPath,
    sizeBytes: fileStat.size
  };
}
