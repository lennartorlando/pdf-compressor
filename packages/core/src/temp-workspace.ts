import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

export interface TempWorkspace {
  path: string;
  file(name: string): string;
  cleanup(): Promise<void>;
}

export async function createTempWorkspace(
  prefix = "pdf-compressor-",
  parentDirectory = tmpdir()
): Promise<TempWorkspace> {
  const directory = await mkdtemp(join(parentDirectory, prefix));
  return {
    path: directory,
    file(name: string) {
      return join(directory, name);
    },
    async cleanup() {
      await rm(directory, { recursive: true, force: true });
    }
  };
}
