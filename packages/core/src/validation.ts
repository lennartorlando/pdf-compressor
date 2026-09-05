import { lstat, readFile, realpath, stat } from "node:fs/promises";
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

interface FileIdentity {
  dev: number;
  ino: number;
  realPath: string;
}

async function identityOf(path: string): Promise<FileIdentity | null> {
  try {
    const [fileStat, canonical] = await Promise.all([stat(path), realpath(path)]);
    if (typeof fileStat.dev !== "number" || typeof fileStat.ino !== "number") return null;
    return { dev: fileStat.dev, ino: fileStat.ino, realPath: canonical };
  } catch {
    return null;
  }
}

/**
 * Reject an existing destination and any destination that aliases a source
 * through a symlink or hard link, before any mutation starts. Canonical
 * file identity (device + inode + real path) is compared, not path strings.
 */
export async function assertFreshDestination(
  destinationPath: string,
  sourcePaths: readonly string[]
): Promise<void> {
  for (const sourcePath of sourcePaths) {
    if (destinationPath === sourcePath) {
      throw new CompressionError(
        "OUTPUT_WOULD_OVERWRITE_INPUT",
        "Output path must be different from every source PDF."
      );
    }
  }

  let destinationStat;
  try {
    destinationStat = await lstat(destinationPath);
  } catch {
    return;
  }
  if (!destinationStat) return;

  const [destinationIdentity, sourceIdentities] = await Promise.all([
    identityOf(destinationPath),
    Promise.all(sourcePaths.map((sourcePath) => identityOf(sourcePath)))
  ]);
  if (destinationIdentity) {
    for (const sourceIdentity of sourceIdentities) {
      if (!sourceIdentity) continue;
      if (
        destinationIdentity.realPath === sourceIdentity.realPath ||
        (destinationIdentity.dev === sourceIdentity.dev && destinationIdentity.ino === sourceIdentity.ino)
      ) {
        throw new CompressionError(
          "OUTPUT_WOULD_OVERWRITE_INPUT",
          "Output path aliases a source PDF and would overwrite it."
        );
      }
    }
  }
  throw new CompressionError("OUTPUT_EXISTS", "Output path already exists.", { outputPath: destinationPath });
}
