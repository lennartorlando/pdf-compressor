import { mkdtemp, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { assertFreshDestination, CompressionError } from "@pdf-compressor/core";

interface OutputSummary {
  outputPath: string;
}

async function destinationExists(
  destinationPath: string,
  sourcePaths: readonly string[]
): Promise<boolean> {
  try {
    await assertFreshDestination(destinationPath, sourcePaths);
    return false;
  } catch (error) {
    if (error instanceof CompressionError && error.code === "OUTPUT_EXISTS") return true;
    throw error;
  }
}

/** Keep an existing destination intact until a complete result can replace it atomically. */
export async function withDestinationPublication<T extends OutputSummary>(
  destinationPath: string,
  sourcePaths: readonly string[],
  overwrite: boolean,
  operation: (outputPath: string) => Promise<T>
): Promise<T> {
  const exists = await destinationExists(destinationPath, sourcePaths);

  if (!exists) return operation(destinationPath);
  if (!overwrite) {
    throw new CompressionError(
      "OUTPUT_EXISTS",
      "Output path already exists. Pass --overwrite to replace it."
    );
  }

  const stagingDirectory = await mkdtemp(
    join(dirname(destinationPath), ".pdf-compressor-overwrite-")
  );
  const stagingPath = join(stagingDirectory, basename(destinationPath));
  try {
    const summary = await operation(stagingPath);
    await destinationExists(destinationPath, sourcePaths);
    await rename(stagingPath, destinationPath);
    return { ...summary, outputPath: destinationPath };
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
}
