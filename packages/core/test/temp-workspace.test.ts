import { stat, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createTempWorkspace } from "../src/index.js";

describe("createTempWorkspace", () => {
  it("creates and cleans an isolated temporary directory", async () => {
    const workspace = await createTempWorkspace();
    const marker = workspace.file("marker.txt");
    await writeFile(marker, "ok");
    await expect(stat(marker)).resolves.toBeTruthy();
    await workspace.cleanup();
    await expect(stat(marker)).rejects.toBeTruthy();
  });
});
