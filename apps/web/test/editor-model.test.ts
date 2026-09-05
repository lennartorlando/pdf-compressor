import { describe, expect, it, vi } from "vitest";
import {
  addSource,
  checkSourceCapacity,
  clearSelection,
  createEditorState,
  deleteEntries,
  deriveExportSnapshot,
  EditorLimitError,
  EDITOR_LIMITS,
  moveEntry,
  removeSource,
  resetWorkspace,
  rotateEntry,
  selectAll,
  setFocus,
  setSelection,
  toggleSelected
} from "../src/editor/model.js";

function stateWithTwoSources() {
  let state = createEditorState();
  state = addSource(state, { displayName: "a.pdf", bytes: 1000, pageCount: 3 });
  state = addSource(state, { displayName: "b.pdf", bytes: 2000, pageCount: 2 });
  return state;
}

describe("editor model", () => {
  it("starts empty with a frozen manifest", () => {
    const state = createEditorState();
    expect(state.manifest.pages).toHaveLength(0);
    expect(state.selection).toEqual([]);
    expect(state.focusIndex).toBeNull();
    expect(Object.isFrozen(state.manifest)).toBe(true);
  });

  it("never performs network or native work per gesture", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("must stay local"));
    try {
      let state = stateWithTwoSources();
      state = moveEntry(state, 0, 4);
      state = rotateEntry(state, 1);
      state = deleteEntries(state, [2]);
      state = setSelection(state, [0, 1]);
      state = setFocus(state, 0);
      state = toggleSelected(state, 0);
      state = selectAll(state);
      state = clearSelection(state);
      state = resetWorkspace(state);
      deriveExportSnapshot(state, "all");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("applies deterministic immutable move, rotate, delete, and reset transitions", () => {
    const before = stateWithTwoSources();
    const beforePages = before.manifest.pages;
    const moved = moveEntry(before, 0, 4);
    expect(moved.manifest.pages.map((entry) => entry.page)).toEqual([2, 3, 1, 2, 1]);
    expect(before.manifest.pages).toBe(beforePages);
    expect(before.manifest.pages[0]).toEqual({ sourceId: before.sources[0].id, page: 1, rotate: 0 });

    const rotated = rotateEntry(moved, 0);
    expect(rotated.manifest.pages[0].rotate).toBe(90);
    expect(moved.manifest.pages[0].rotate).toBe(0);

    const deleted = deleteEntries(rotated, [0]);
    expect(deleted.manifest.pages).toHaveLength(4);

    const reset = resetWorkspace(deleted);
    expect(reset.manifest.pages.map((entry) => `${entry.sourceId}:${entry.page}:${entry.rotate}`)).toEqual([
      `${before.sources[0].id}:1:0`,
      `${before.sources[0].id}:2:0`,
      `${before.sources[0].id}:3:0`,
      `${before.sources[1].id}:1:0`,
      `${before.sources[1].id}:2:0`
    ]);
    expect(reset.selection).toEqual([]);
    expect(Object.isFrozen(reset.manifest)).toBe(true);
  });

  it("accumulates rotation modulo 360", () => {
    let state = stateWithTwoSources();
    state = rotateEntry(state, 0);
    state = rotateEntry(state, 0);
    state = rotateEntry(state, 0);
    state = rotateEntry(state, 0);
    expect(state.manifest.pages[0].rotate).toBe(0);
  });

  it("keeps selection and focus as browser-only state", () => {
    const before = stateWithTwoSources();
    const manifest = before.manifest;
    const selected = setSelection(before, [2, 0]);
    expect(selected.manifest).toBe(manifest);
    expect(selected.selection).toEqual([0, 2]);
    const focused = setFocus(selected, 4);
    expect(focused.manifest).toBe(manifest);
    expect(focused.focusIndex).toBe(4);
    const toggled = toggleSelected(focused, 0);
    expect(toggled.manifest).toBe(manifest);
    expect(toggled.selection).toEqual([2]);
  });

  it("keeps selection and focus attached to logical pages across moves and deletes", () => {
    let state = setSelection(stateWithTwoSources(), [0, 2, 4]);
    state = setFocus(state, 1);

    state = moveEntry(state, 0, 4);
    expect(state.selection).toEqual([1, 3, 4]);
    expect(state.focusIndex).toBe(0);

    state = deleteEntries(state, [0, 3]);
    expect(state.selection).toEqual([0, 2]);
    expect(state.focusIndex).toBeNull();

    let backward = setSelection(stateWithTwoSources(), [1, 4]);
    backward = setFocus(backward, 3);
    backward = moveEntry(backward, 4, 1);
    expect(backward.selection).toEqual([1, 2]);
    expect(backward.focusIndex).toBe(4);
  });

  it("rejects invalid selection positions", () => {
    const state = stateWithTwoSources();
    expect(() => setSelection(state, [5])).toThrow(EditorLimitError);
    expect(() => setSelection(state, [0, 0])).toThrow(EditorLimitError);
    expect(() => toggleSelected(state, -1)).toThrow(EditorLimitError);
    expect(() => setFocus(state, 99)).toThrow(EditorLimitError);
  });

  it("generates distinct opaque ids for duplicate display names", () => {
    let state = createEditorState();
    state = addSource(state, { displayName: "report.pdf", bytes: 500, pageCount: 1 });
    state = addSource(state, { displayName: "report.pdf", bytes: 700, pageCount: 2 });
    const [first, second] = state.sources;
    expect(first.displayName).toBe("report.pdf");
    expect(second.displayName).toBe("report.pdf");
    expect(first.id).not.toBe(second.id);
    expect(first.id).toMatch(/^[0-9a-f]{32}$/);
    expect(second.id).toMatch(/^[0-9a-f]{32}$/);
    expect(state.manifest.pages.map((entry) => entry.sourceId)).toEqual([first.id, second.id, second.id]);
  });

  it("derives a separate immutable selection snapshot without changing the workspace", () => {
    const state = setSelection(stateWithTwoSources(), [4, 0, 2]);
    const workspacePages = state.manifest.pages;
    const snapshot = deriveExportSnapshot(state, "selection");
    expect(snapshot.manifest.pages.map((entry) => entry.page)).toEqual([1, 3, 2]);
    expect(state.manifest.pages).toBe(workspacePages);
    expect(state.selection).toEqual([0, 2, 4]);
    expect(Object.isFrozen(snapshot.manifest)).toBe(true);
    expect(snapshot.sourceIds).toHaveLength(2);
    const all = deriveExportSnapshot(state, "all");
    expect(all.manifest).toBe(state.manifest);
  });

  it("rejects empty exports", () => {
    expect(() => deriveExportSnapshot(createEditorState(), "all")).toThrow(
      expect.objectContaining({ code: "EXPORT_EMPTY_SELECTION" })
    );
    const state = stateWithTwoSources();
    expect(() => deriveExportSnapshot(state, "selection")).toThrow(
      expect.objectContaining({ code: "EXPORT_EMPTY_SELECTION" })
    );
  });

  it("removes a source with its pages and remaps selection and focus", () => {
    let state = setSelection(stateWithTwoSources(), [0, 3, 4]);
    state = setFocus(state, 3);
    const removedId = state.sources[0].id;
    state = removeSource(state, removedId);
    expect(state.sources).toHaveLength(1);
    expect(state.manifest.pages).toHaveLength(2);
    expect(state.selection).toEqual([0, 1]);
    expect(state.focusIndex).toBe(0);
    expect(() => removeSource(state, removedId)).toThrow(
      expect.objectContaining({ code: "UNKNOWN_SOURCE" })
    );
  });

  it("enforces source, byte, and page caps", () => {
    // Pre-allocation capacity probe used before PDF.js receives bytes.
    const empty = createEditorState();
    expect(() => checkSourceCapacity(empty, 0)).toThrow(
      expect.objectContaining({ code: "SOURCE_TOO_LARGE" })
    );
    expect(() => checkSourceCapacity(empty, EDITOR_LIMITS.maxSourceBytes + 1)).toThrow(
      expect.objectContaining({ code: "SOURCE_TOO_LARGE" })
    );
    expect(() =>
      checkSourceCapacity(addSource(empty, { displayName: "a.pdf", bytes: EDITOR_LIMITS.maxTotalBytes, pageCount: 1 }), 1)
    ).toThrow(expect.objectContaining({ code: "TOTAL_TOO_LARGE" }));

    let state = createEditorState();
    for (let i = 0; i < EDITOR_LIMITS.maxSources; i += 1) {
      state = addSource(state, { displayName: `s${i}.pdf`, bytes: 8, pageCount: 1 });
    }
    expect(() => addSource(state, { displayName: "extra.pdf", bytes: 8, pageCount: 1 })).toThrow(
      expect.objectContaining({ code: "TOO_MANY_SOURCES" })
    );
    expect(() => addSource(empty, { displayName: "big.pdf", bytes: EDITOR_LIMITS.maxSourceBytes + 1, pageCount: 1 })).toThrow(
      expect.objectContaining({ code: "SOURCE_TOO_LARGE" })
    );
    expect(() => addSource(empty, { displayName: "zero.pdf", bytes: 8, pageCount: 0 })).toThrow(
      expect.objectContaining({ code: "INVALID_PAGE_COUNT" })
    );
    expect(() =>
      addSource(empty, { displayName: "many.pdf", bytes: 8, pageCount: EDITOR_LIMITS.maxOutputPages + 1 })
    ).toThrow(expect.objectContaining({ code: "OUTPUT_PAGE_LIMIT_EXCEEDED" }));
  });
});
