import { describe, expect, it } from "vitest";
import {
  appendSourcePages,
  createManifest,
  deriveSelection,
  movePage,
  parsePageManifest,
  removePages,
  rotatePage,
  PageManifestError
} from "../src/page-manifest.js";

const base = createManifest([
  { sourceId: "a", page: 1 },
  { sourceId: "a", page: 2 },
  { sourceId: "b", page: 1 }
]);

describe("page-manifest contract", () => {
  it("creates an immutable manifest with default rotations", () => {
    expect(base.pages).toHaveLength(3);
    expect(base.pages[0]).toEqual({ sourceId: "a", page: 1, rotate: 0 });
    expect(Object.isFrozen(base)).toBe(true);
    expect(Object.isFrozen(base.pages)).toBe(true);
  });

  it("parses a transport value and rejects unknown fields", () => {
    const parsed = parsePageManifest({
      version: 1,
      pages: [{ sourceId: "a", page: 2, rotate: 90 }]
    });
    expect(parsed.pages[0]).toEqual({ sourceId: "a", page: 2, rotate: 90 });
    expect(() => parsePageManifest({ version: 1, pages: [], extra: true })).toThrow(PageManifestError);
    expect(() => parsePageManifest({ version: 2, pages: [] })).toThrow(PageManifestError);
    expect(() => parsePageManifest({ version: 1, pages: [{ sourceId: "a", page: 1, rotate: 45 }] })).toThrow(
      expect.objectContaining({ code: "MANIFEST_INVALID_ROTATION" })
    );
    expect(() => parsePageManifest({ version: 1, pages: [{ sourceId: "a", page: 0 }] })).toThrow(
      expect.objectContaining({ code: "MANIFEST_INVALID_PAGE_NUMBER" })
    );
    expect(() => parsePageManifest({ version: 1, pages: [{ sourceId: "has space", page: 1 }] })).toThrow(
      expect.objectContaining({ code: "MANIFEST_INVALID_SOURCE_ID" })
    );
  });

  it("moves pages without mutating the input", () => {
    const moved = movePage(base, 2, 0);
    expect(moved.pages.map((entry) => [entry.sourceId, entry.page])).toEqual([
      ["b", 1],
      ["a", 1],
      ["a", 2]
    ]);
    expect(base.pages[0]).toEqual({ sourceId: "a", page: 1, rotate: 0 });
    expect(() => movePage(base, 0, 7)).toThrow(expect.objectContaining({ code: "MANIFEST_INVALID_INDEX" }));
  });

  it("accumulates relative rotations modulo 360", () => {
    const once = rotatePage(base, 0, 90);
    expect(once.pages[0].rotate).toBe(90);
    const twice = rotatePage(rotatePage(rotatePage(base, 0, 270), 0, 90), 0, 90);
    expect(twice.pages[0].rotate).toBe(90);
    expect(base.pages[0].rotate).toBe(0);
  });

  it("removes pages and appends source pages", () => {
    const removed = removePages(base, [0, 2]);
    expect(removed.pages).toEqual([{ sourceId: "a", page: 2, rotate: 0 }]);
    const appended = appendSourcePages(removed, "c", 2);
    expect(appended.pages.map((entry) => [entry.sourceId, entry.page])).toEqual([
      ["a", 2],
      ["c", 1],
      ["c", 2]
    ]);
    expect(base.pages).toHaveLength(3);
  });

  it("derives a selection manifest without changing the workspace", () => {
    const snapshot = JSON.parse(JSON.stringify(base)) as typeof base;
    const selection = deriveSelection(base, [2, 0]);
    expect(selection.pages.map((entry) => [entry.sourceId, entry.page])).toEqual([
      ["b", 1],
      ["a", 1]
    ]);
    expect(base).toEqual(snapshot);
    expect(() => deriveSelection(base, [0, 0])).toThrow(
      expect.objectContaining({ code: "MANIFEST_INVALID_INDEX" })
    );
  });

  it("stays below 50 ms for a 100-page manifest", () => {
    let manifest = createManifest([]);
    manifest = appendSourcePages(manifest, "bulk", 100);
    const started = performance.now();
    let current = manifest;
    for (let index = 0; index < 100; index += 1) {
      current = rotatePage(current, index % 100, 90);
    }
    current = movePage(current, 99, 0);
    current = deriveSelection(current, [0, 50, 99]);
    const elapsed = performance.now() - started;
    expect(current.pages).toHaveLength(3);
    expect(elapsed).toBeLessThan(50);
  });
});
