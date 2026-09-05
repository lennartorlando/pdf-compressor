/**
 * Pure browser-side page-editor model.
 *
 * The combined page sequence lives in the transport-neutral `PageManifest`
 * from `@pdf-compressor/core/page-manifest` (browser-safe subpath only; the
 * Node-coupled core root is never imported here). Reorder, rotation,
 * deletion, reset, selection, and focus are immutable local transitions and
 * perform no HTTP or native work. Export derives a separate immutable
 * snapshot without changing the workspace.
 */

import {
  appendSourcePages,
  createManifest,
  deriveSelection,
  movePage,
  removePages,
  rotatePage,
  type PageManifest,
  type PageRotation
} from "@pdf-compressor/core/page-manifest";

/** Browser-side caps applied before any PDF.js allocation (mirrors server LIMITS). */
export const EDITOR_LIMITS = {
  /** Source PDFs per export workspace. */
  maxSources: 10,
  /** Bytes per source file. */
  maxSourceBytes: 100 * 1024 * 1024,
  /** Aggregate source bytes in the workspace. */
  maxTotalBytes: 100 * 1024 * 1024,
  /** Output pages per manifest. */
  maxOutputPages: 500
} as const;

export type EditorLimitCode =
  | "TOO_MANY_SOURCES"
  | "SOURCE_TOO_LARGE"
  | "TOTAL_TOO_LARGE"
  | "OUTPUT_PAGE_LIMIT_EXCEEDED"
  | "INVALID_PAGE_COUNT"
  | "UNKNOWN_SOURCE"
  | "INVALID_SELECTION"
  | "EXPORT_EMPTY_SELECTION";

export class EditorLimitError extends Error {
  constructor(
    public readonly code: EditorLimitCode,
    message: string
  ) {
    super(message);
    this.name = "EditorLimitError";
  }
}

/** One loaded local PDF. The id is opaque; the display name may repeat. */
export interface EditorSource {
  readonly id: string;
  readonly displayName: string;
  readonly bytes: number;
  readonly pageCount: number;
}

export interface EditorState {
  readonly sources: readonly EditorSource[];
  /** Combined visible sequence. Selection, focus, and files stay outside. */
  readonly manifest: PageManifest;
  /** Positions into `manifest.pages`. Browser UI state only. */
  readonly selection: readonly number[];
  /** Focused position into `manifest.pages`. Browser UI state only. */
  readonly focusIndex: number | null;
}

export type ExportScope = "all" | "selection";

export interface ExportSnapshot {
  /** Immutable manifest to submit; never aliases workspace state for selection. */
  readonly manifest: PageManifest;
  /** Distinct source ids in manifest order; each streams exactly once. */
  readonly sourceIds: readonly string[];
}

/** Opaque source handle: 32 lowercase hex chars, no names or paths. */
export function generateSourceId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createEditorState(): EditorState {
  return {
    sources: Object.freeze([]),
    manifest: createManifest([]),
    selection: Object.freeze([]),
    focusIndex: null
  };
}

function withManifest(state: EditorState, manifest: PageManifest): EditorState {
  return {
    sources: state.sources,
    manifest,
    selection: pruneSelection(manifest.pages.length, state.selection),
    focusIndex: state.focusIndex !== null && state.focusIndex < manifest.pages.length ? state.focusIndex : null
  };
}

/** Drop out-of-range positions, keep the rest in ascending order. */
function pruneSelection(length: number, selection: readonly number[]): readonly number[] {
  const kept = [...new Set(selection)].filter((index) => Number.isInteger(index) && index >= 0 && index < length);
  kept.sort((left, right) => left - right);
  return Object.freeze(kept);
}

function assertSelectionPositions(length: number, indexes: readonly number[]): void {
  const seen = new Set<number>();
  for (const index of indexes) {
    if (!Number.isInteger(index) || index < 0 || index >= length || seen.has(index)) {
      throw new EditorLimitError("INVALID_SELECTION", `Invalid selection position ${String(index)}.`);
    }
    seen.add(index);
  }
}

export interface AddSourceInput {
  displayName: string;
  bytes: number;
  pageCount: number;
}

/**
 * Add one local PDF. Caps are enforced before the caller hands bytes to
 * PDF.js. Duplicate display names receive distinct opaque ids.
 */
export function addSource(state: EditorState, input: AddSourceInput): EditorState {
  if (state.sources.length >= EDITOR_LIMITS.maxSources) {
    throw new EditorLimitError("TOO_MANY_SOURCES", `At most ${EDITOR_LIMITS.maxSources} source PDFs are supported.`);
  }
  if (!Number.isInteger(input.bytes) || input.bytes < 1 || input.bytes > EDITOR_LIMITS.maxSourceBytes) {
    throw new EditorLimitError("SOURCE_TOO_LARGE", "A source exceeds its 100 MiB byte cap.");
  }
  if (!Number.isInteger(input.pageCount) || input.pageCount < 1) {
    throw new EditorLimitError("INVALID_PAGE_COUNT", "A source must report at least one page.");
  }
  const totalBytes = state.sources.reduce((sum, source) => sum + source.bytes, 0) + input.bytes;
  if (totalBytes > EDITOR_LIMITS.maxTotalBytes) {
    throw new EditorLimitError("TOTAL_TOO_LARGE", "Sources exceed the 100 MiB combined cap.");
  }
  if (state.manifest.pages.length + input.pageCount > EDITOR_LIMITS.maxOutputPages) {
    throw new EditorLimitError(
      "OUTPUT_PAGE_LIMIT_EXCEEDED",
      `At most ${EDITOR_LIMITS.maxOutputPages} output pages are supported.`
    );
  }
  let id = generateSourceId();
  while (state.sources.some((source) => source.id === id)) {
    id = generateSourceId();
  }
  const source: EditorSource = Object.freeze({
    id,
    displayName: input.displayName,
    bytes: input.bytes,
    pageCount: input.pageCount
  });
  return {
    sources: Object.freeze([...state.sources, source]),
    manifest: appendSourcePages(state.manifest, id, input.pageCount),
    selection: state.selection,
    focusIndex: state.focusIndex
  };
}

/** Remove a source and every manifest entry pointing at it. */
export function removeSource(state: EditorState, sourceId: string): EditorState {
  if (!state.sources.some((source) => source.id === sourceId)) {
    throw new EditorLimitError("UNKNOWN_SOURCE", "Unknown source id.");
  }
  const doomed = new Set<number>();
  state.manifest.pages.forEach((entry, index) => {
    if (entry.sourceId === sourceId) doomed.add(index);
  });
  const manifest = removePages(state.manifest, [...doomed]);
  const keptSelection = state.selection
    .filter((index) => !doomed.has(index))
    .map((index) => index - [...doomed].filter((removed) => removed < index).length);
  const focusIndex =
    state.focusIndex === null || doomed.has(state.focusIndex)
      ? null
      : state.focusIndex - [...doomed].filter((removed) => removed < state.focusIndex!).length;
  return {
    sources: Object.freeze(state.sources.filter((source) => source.id !== sourceId)),
    manifest,
    selection: pruneSelection(manifest.pages.length, keptSelection),
    focusIndex
  };
}

/** Move the entry at `fromIndex` to `toIndex`, immutably. */
export function moveEntry(state: EditorState, fromIndex: number, toIndex: number): EditorState {
  return withManifest(state, movePage(state.manifest, fromIndex, toIndex));
}

/** Rotate one entry 90 degrees clockwise, immutably. */
export function rotateEntry(state: EditorState, index: number): EditorState {
  return withManifest(state, rotatePage(state.manifest, index, 90 as PageRotation));
}

/** Delete entries at the given positions, immutably. */
export function deleteEntries(state: EditorState, indexes: readonly number[]): EditorState {
  return withManifest(state, removePages(state.manifest, indexes));
}

/** Restore the initial order: every source appended in load order, unrotated. */
export function resetWorkspace(state: EditorState): EditorState {
  let manifest = createManifest([]);
  for (const source of state.sources) {
    manifest = appendSourcePages(manifest, source.id, source.pageCount);
  }
  return { sources: state.sources, manifest, selection: Object.freeze([]), focusIndex: null };
}

export function setSelection(state: EditorState, indexes: readonly number[]): EditorState {
  assertSelectionPositions(state.manifest.pages.length, indexes);
  const sorted = [...new Set(indexes)].sort((left, right) => left - right);
  return { ...state, selection: Object.freeze(sorted) };
}

export function toggleSelected(state: EditorState, index: number): EditorState {
  assertSelectionPositions(state.manifest.pages.length, [index]);
  const selected = new Set(state.selection);
  if (selected.has(index)) selected.delete(index);
  else selected.add(index);
  return { ...state, selection: Object.freeze([...selected].sort((left, right) => left - right)) };
}

export function selectAll(state: EditorState): EditorState {
  return {
    ...state,
    selection: Object.freeze(state.manifest.pages.map((_, index) => index))
  };
}

export function clearSelection(state: EditorState): EditorState {
  return { ...state, selection: Object.freeze([]) };
}

export function setFocus(state: EditorState, index: number | null): EditorState {
  if (index !== null) assertSelectionPositions(state.manifest.pages.length, [index]);
  return { ...state, focusIndex: index };
}

/**
 * Freeze an immutable export snapshot. Selection scope derives a separate
 * manifest in ascending visible order; the workspace manifest is untouched.
 * The returned snapshot is safe to submit while later gestures continue.
 */
export function deriveExportSnapshot(state: EditorState, scope: ExportScope): ExportSnapshot {
  const manifest =
    scope === "all" ? state.manifest : deriveSelection(state.manifest, [...state.selection].sort((a, b) => a - b));
  if (manifest.pages.length === 0) {
    throw new EditorLimitError(
      "EXPORT_EMPTY_SELECTION",
      scope === "all" ? "There are no pages to export." : "Select at least one page to export."
    );
  }
  const sourceIds: string[] = [];
  for (const entry of manifest.pages) {
    if (!sourceIds.includes(entry.sourceId)) sourceIds.push(entry.sourceId);
  }
  return { manifest, sourceIds: Object.freeze(sourceIds) };
}

/**
 * Pre-allocation capacity check: source count plus per-source and combined
 * byte caps, enforced before bytes reach PDF.js. Page-count caps are checked
 * by `addSource` after inspection, since page counts are unknown beforehand.
 */
export function checkSourceCapacity(state: EditorState, bytes: number): void {
  if (state.sources.length >= EDITOR_LIMITS.maxSources) {
    throw new EditorLimitError("TOO_MANY_SOURCES", `At most ${EDITOR_LIMITS.maxSources} source PDFs are supported.`);
  }
  if (!Number.isInteger(bytes) || bytes < 1 || bytes > EDITOR_LIMITS.maxSourceBytes) {
    throw new EditorLimitError("SOURCE_TOO_LARGE", "A source exceeds its 100 MiB byte cap.");
  }
  const totalBytes = state.sources.reduce((sum, source) => sum + source.bytes, 0) + bytes;
  if (totalBytes > EDITOR_LIMITS.maxTotalBytes) {
    throw new EditorLimitError("TOTAL_TOO_LARGE", "Sources exceed the 100 MiB combined cap.");
  }
}

/** Friendly blocked-input message for an editor limit error. */
export function editorLimitMessage(error: unknown): string {
  if (error instanceof EditorLimitError) return error.message;
  return "That file could not be added.";
}
