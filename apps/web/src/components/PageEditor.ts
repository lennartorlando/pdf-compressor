import {
  downloadOutput,
  exportPages,
  getCapabilities,
  type Capabilities,
  type ExportCompression
} from "../api/client.js";
import { QPDF_SECURITY_FLOOR } from "@pdf-compressor/core/native-floors";
import {
  addSource,
  checkSourceCapacity,
  clearSelection,
  createEditorState,
  deleteEntries,
  deriveExportSnapshot,
  editorLimitMessage,
  moveEntry,
  removeSource,
  resetWorkspace,
  rotateEntry,
  selectAll,
  setFocus,
  setSelection,
  toggleSelected,
  type EditorState,
  type ExportScope
} from "../editor/model.js";
import {
  createPdfJsLoader,
  PreviewStore,
  thumbnailByteSize,
  type PdfPreviewLoader
} from "../editor/pdf-preview.js";
import { createEditorActions } from "./EditorActions.js";
import { createExportOptions } from "./ExportOptions.js";
import { createPageThumbnail, type ThumbnailHandle } from "./PageThumbnail.js";

export interface PageEditorDeps {
  onExit: () => void;
  /** Injected fake loader for tests; production lazily loads PDF.js. */
  loader?: PdfPreviewLoader;
}

export interface PageEditorHandle {
  readonly element: HTMLElement;
  destroy(): void;
}

/**
 * Vertical pipeline editor (selected direction B): Add PDFs, arrange the
 * combined sequence, export. Gestures stay local; export freezes an
 * immutable snapshot, streams each source once, and restores editing after
 * success, failure, or cancellation without losing the manifest.
 */
export function createPageEditor(deps: PageEditorDeps): PageEditorHandle {
  let editorState: EditorState = createEditorState();
  const files = new Map<string, File>();
  const loader: PdfPreviewLoader = deps.loader ?? createPdfJsLoader();
  const store = new PreviewStore();
  let capabilities: Capabilities | null = null;
  let capabilitiesError: string | null = null;
  let scope: ExportScope = "all";
  let compression: ExportCompression = "none";
  let exporting = false;
  let exportController: AbortController | null = null;
  let exportError: string | null = null;
  let exportWarnings: string[] = [];
  let exportResult: { pageCount: number; fileName: string } | null = null;
  let downloadHref: string | null = null;
  let addError: string | null = null;
  let destroyed = false;
  const thumbnails = new Map<number, ThumbnailHandle>();
  let observer: IntersectionObserver | null = null;
  // Pending renders stamped by grid generation. Keys embed the visible
  // index and are reused across refreshes, so a bare key comparison would
  // let a stale (cancelled) batch delete a newer batch's bookkeeping.
  let thumbGeneration = 0;
  const pendingKeys = new Map<number, { key: string; generation: number }>();

  const root = document.createElement("div");
  root.className = "page-editor";

  const topBar = document.createElement("header");
  topBar.className = "page-editor__bar";
  const backLink = document.createElement("button");
  backLink.type = "button";
  backLink.className = "button button--secondary button--small";
  backLink.textContent = "← Compressor";
  backLink.addEventListener("click", () => deps.onExit());
  const barTitle = document.createElement("strong");
  barTitle.textContent = "Page editor";
  const barStep = document.createElement("span");
  barStep.className = "muted small";
  barStep.textContent = "Add, arrange, export";
  topBar.append(backLink, barTitle, barStep);

  // Step 1: add PDFs.
  const stepAdd = document.createElement("section");
  stepAdd.className = "card";
  stepAdd.setAttribute("aria-label", "Step 1 add PDFs");
  const addHeading = document.createElement("h2");
  addHeading.textContent = "1. Add PDFs";
  const addHint = document.createElement("p");
  addHint.className = "muted small";
  addHint.textContent = "Local only. PDFs stay on this computer until you export.";
  const dropLabel = document.createElement("label");
  dropLabel.className = "dropzone dropzone--small";
  const dropTitle = document.createElement("span");
  dropTitle.className = "dropzone__title";
  dropTitle.textContent = "Drop PDFs here";
  const dropHint = document.createElement("span");
  dropHint.className = "dropzone__hint";
  dropHint.textContent = "or choose files from your computer";
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = "application/pdf,.pdf";
  fileInput.multiple = true;
  fileInput.addEventListener("change", () => {
    void addFiles([...(fileInput.files ?? [])]);
    fileInput.value = "";
  });
  dropLabel.append(dropTitle, dropHint, fileInput);
  dropLabel.addEventListener("dragover", (event) => {
    event.preventDefault();
    dropLabel.classList.add("dropzone--active");
  });
  dropLabel.addEventListener("dragleave", () => {
    dropLabel.classList.remove("dropzone--active");
  });
  dropLabel.addEventListener("drop", (event) => {
    event.preventDefault();
    dropLabel.classList.remove("dropzone--active");
    void addFiles([...(event.dataTransfer?.files ?? [])].filter((file) => file instanceof File));
  });
  const sourceList = document.createElement("ul");
  sourceList.className = "filelist";
  const addErrorNote = document.createElement("p");
  addErrorNote.className = "error";
  addErrorNote.setAttribute("role", "alert");
  stepAdd.append(addHeading, addHint, dropLabel, sourceList, addErrorNote);

  // Step 2: arrange.
  const stepArrange = document.createElement("section");
  stepArrange.className = "card";
  stepArrange.setAttribute("aria-label", "Step 2 arrange pages");
  const arrangeHeading = document.createElement("h2");
  arrangeHeading.textContent = "2. Arrange combined sequence";
  const arrangeHint = document.createElement("p");
  arrangeHint.className = "muted small";
  arrangeHint.textContent = "Reorder, rotate, and delete pages. Changes stay in this browser.";
  const actions = createEditorActions({
    onSelectAll: () => {
      if (exporting) return;
      editorState = selectAll(editorState);
      refresh();
    },
    onClearSelection: () => {
      if (exporting) return;
      editorState = clearSelection(editorState);
      refresh();
    },
    onRotateSelected: () => {
      if (exporting) return;
      for (const index of editorState.selection) {
        editorState = rotateEntry(editorState, index);
      }
      refresh();
    },
    onDeleteSelected: () => {
      if (exporting) return;
      editorState = deleteEntries(editorState, editorState.selection);
      refresh();
    },
    onReset: () => {
      if (exporting) return;
      editorState = resetWorkspace(editorState);
      refresh();
    }
  });
  const grid = document.createElement("ol");
  grid.className = "thumb-grid";
  grid.setAttribute("role", "list");
  grid.setAttribute("aria-label", "Combined page sequence");
  const arrangeEmpty = document.createElement("p");
  arrangeEmpty.className = "muted";
  arrangeEmpty.textContent = "No pages yet. Add a PDF above to start.";
  stepArrange.append(arrangeHeading, arrangeHint, actions.element, grid, arrangeEmpty);

  // Step 3: export.
  const stepExport = document.createElement("section");
  stepExport.className = "card";
  stepExport.setAttribute("aria-label", "Step 3 export");
  const exportHeading = document.createElement("h2");
  exportHeading.textContent = "3. Export";
  const exportOptions = createExportOptions({
    onScopeChange: (next) => {
      scope = next;
      refresh();
    },
    onCompressionChange: (next) => {
      compression = next;
      refresh();
    }
  });
  const exportRow = document.createElement("div");
  exportRow.className = "exportrow";
  const exportButton = document.createElement("button");
  exportButton.type = "button";
  exportButton.className = "button";
  exportButton.textContent = "Export PDF";
  exportButton.addEventListener("click", () => void runExport());
  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.className = "button button--secondary";
  cancelButton.textContent = "Cancel";
  cancelButton.addEventListener("click", () => exportController?.abort());
  const backButton = document.createElement("button");
  backButton.type = "button";
  backButton.className = "button button--secondary";
  backButton.textContent = "Back to compressor";
  backButton.addEventListener("click", () => deps.onExit());
  exportRow.append(exportButton, cancelButton, backButton);
  const exportStatus = document.createElement("p");
  exportStatus.className = "progress";
  exportStatus.setAttribute("role", "status");
  const capsNote = document.createElement("p");
  capsNote.className = "warn";
  const capsRetry = document.createElement("button");
  capsRetry.type = "button";
  capsRetry.className = "button button--secondary button--small";
  capsRetry.textContent = "Retry";
  capsRetry.addEventListener("click", () => void loadCapabilities());
  const exportErrorNote = document.createElement("p");
  exportErrorNote.className = "error";
  exportErrorNote.setAttribute("role", "alert");
  const warningList = document.createElement("ul");
  warningList.className = "warnlist";
  const resultBox = document.createElement("div");
  resultBox.className = "result result--inline";
  stepExport.append(exportHeading, exportOptions.element, exportRow, exportStatus, capsNote, exportErrorNote, warningList, resultBox);

  root.append(topBar, stepAdd, stepArrange, stepExport);

  function sourceNameOf(sourceId: string): string {
    return editorState.sources.find((source) => source.id === sourceId)?.displayName ?? "PDF";
  }

  async function addFiles(incoming: File[]): Promise<void> {
    if (exporting || incoming.length === 0) return;
    addError = null;
    for (const file of incoming) {
      if (exporting) break;
      try {
        // Pre-allocation gate: enforce count plus per-source and combined
        // byte caps from `file.size` before touching `arrayBuffer`/PDF.js.
        checkSourceCapacity(editorState, file.size);
      } catch (error) {
        addError = `${file.name || "PDF"}: ${editorLimitMessage(error)}`;
        continue;
      }
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        checkSourceCapacity(editorState, bytes.length);
        const handle = await loader.openDocument(bytes);
        try {
          editorState = addSource(editorState, {
            displayName: file.name || "PDF",
            bytes: bytes.length,
            pageCount: handle.pageCount
          });
        } catch (error) {
          try {
            await handle.destroy();
          } catch {
            // Best effort.
          }
          throw error;
        }
        const added = editorState.sources[editorState.sources.length - 1];
        files.set(added.id, file);
        store.registerDocument(added.id, handle);
      } catch (error) {
        addError = `${file.name || "PDF"}: ${editorLimitMessage(error)}`;
        if (isPasswordError(error)) {
          addError = `${file.name || "PDF"}: This file is password-protected. Page editing needs an unencrypted PDF.`;
        }
      }
    }
    refresh();
  }

  function isPasswordError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    return error.name === "PasswordException" || /password/i.test(error.message);
  }

  function onRemoveSource(sourceId: string): void {
    if (exporting) return;
    editorState = removeSource(editorState, sourceId);
    files.delete(sourceId);
    void store.removeSource(sourceId);
    refresh();
  }

  function renderSources(): void {
    sourceList.replaceChildren();
    for (const source of editorState.sources) {
      const item = document.createElement("li");
      const name = document.createElement("strong");
      name.textContent = source.displayName;
      const pages = document.createElement("span");
      pages.className = "tag";
      pages.textContent = `${source.pageCount} pages`;
      const size = document.createElement("span");
      size.className = "tag";
      size.textContent = formatBytes(source.bytes);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "Remove";
      remove.disabled = exporting;
      remove.setAttribute("aria-label", `Remove ${source.displayName}`);
      remove.addEventListener("click", () => onRemoveSource(source.id));
      item.append(name, pages, size, remove);
      sourceList.append(item);
    }
    addErrorNote.textContent = addError ?? "";
    addErrorNote.hidden = addError === null;
    fileInput.disabled = exporting;
  }

  function renderGrid(): void {
    observer?.disconnect();
    observer = null;
    // Full refresh invalidates every in-flight render: keys embed the
    // visible index, so reorder/delete/reset/source-removal all obsolete
    // old tasks. Cancel them and release stale canvas accounting before
    // dropping DOM nodes so caps hold in reality, not just counters.
    const nextKeys = new Set<string>();
    editorState.manifest.pages.forEach((entry, index) => {
      nextKeys.add(`${entry.sourceId}:${entry.page}@${index}`);
    });
    for (const pending of pendingKeys.values()) {
      store.cancelRender(pending.key);
    }
    pendingKeys.clear();
    thumbGeneration += 1;
    store.unmountStale(nextKeys);
    thumbnails.clear();
    grid.replaceChildren();
    const pages = editorState.manifest.pages;
    arrangeEmpty.hidden = pages.length > 0;
    const useObserver = typeof IntersectionObserver !== "undefined";
    if (useObserver) {
      observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            const index = Number((entry.target as HTMLElement).dataset["index"]);
            if (entry.isIntersecting) void requestThumb(index);
            else cancelThumb(index);
          }
        },
        { rootMargin: "200px" }
      );
    }
    pages.forEach((entry, index) => {
      const thumb = createPageThumbnail(
        {
          index,
          sourceName: sourceNameOf(entry.sourceId),
          pageNumber: entry.page,
          rotation: entry.rotate ?? 0,
          selected: editorState.selection.includes(index),
          isFirst: index === 0,
          isLast: index === pages.length - 1,
          disabled: exporting
        },
        {
          onMove: (at, direction) => {
            if (exporting) return;
            editorState = moveEntry(editorState, at, at + direction);
            editorState = setFocus(editorState, at + direction);
            refresh();
          },
          onRotate: (at) => {
            if (exporting) return;
            editorState = rotateEntry(editorState, at);
            editorState = setFocus(editorState, at);
            refresh();
          },
          onDelete: (at) => {
            if (exporting) return;
            editorState = deleteEntries(editorState, [at]);
            refresh();
          },
          onToggleSelect: (at, selected) => {
            if (exporting) return;
            editorState = selected
              ? setSelection(editorState, [...editorState.selection, at])
              : toggleSelected(editorState, at);
            editorState = setFocus(editorState, at);
            refreshSelectionOnly();
          },
          onFocus: (at) => {
            editorState = setFocus(editorState, at);
          }
        }
      );
      thumb.element.dataset["index"] = String(index);
      thumb.element.classList.toggle("thumb--rot90", (entry.rotate ?? 0) === 90);
      thumb.element.classList.toggle("thumb--rot180", (entry.rotate ?? 0) === 180);
      thumb.element.classList.toggle("thumb--rot270", (entry.rotate ?? 0) === 270);
      thumbnails.set(index, thumb);
      grid.append(thumb.element);
      if (observer) observer.observe(thumb.element);
      else void requestThumb(index);
    });
    if (editorState.focusIndex !== null) {
      thumbnails.get(editorState.focusIndex)?.element.querySelector("input")?.focus();
    }
  }

  function refreshSelectionOnly(): void {
    const pages = editorState.manifest.pages;
    pages.forEach((entry, index) => {
      thumbnails.get(index)?.update({
        index,
        sourceName: sourceNameOf(entry.sourceId),
        pageNumber: entry.page,
        rotation: entry.rotate ?? 0,
        selected: editorState.selection.includes(index),
        isFirst: index === 0,
        isLast: index === pages.length - 1,
        disabled: exporting
      });
    });
    actions.update({
      totalCount: pages.length,
      selectedCount: editorState.selection.length,
      exporting
    });
    renderExportSection();
  }

  function thumbKey(index: number): string | null {
    const entry = editorState.manifest.pages[index];
    if (!entry) return null;
    return `${entry.sourceId}:${entry.page}@${index}`;
  }

  async function requestThumb(index: number): Promise<void> {
    const key = thumbKey(index);
    const thumb = thumbnails.get(index);
    if (!key || !thumb) return;
    const entry = editorState.manifest.pages[index];
    const handle = store.getDocument(entry.sourceId);
    if (!handle) return;
    const generation = thumbGeneration;
    pendingKeys.set(index, { key, generation });
    store.cancelRender(key);
    await store.scheduleRender(key, (isCancelled) => {
      let cancelInner: (() => void) | null = null;
      const done = (async (): Promise<void> => {
        if (isCancelled() || destroyed) return;
        const page = await handle.getPage(entry.page);
        if (isCancelled() || destroyed) return;
        const live = thumbnails.get(index);
        if (!live || pendingKeys.get(index)?.key !== key) return;
        const render = page.render(live.canvas);
        cancelInner = (): void => render.cancel();
        await render.done.catch(() => undefined);
        if (isCancelled() || destroyed) return;
        if (pendingKeys.get(index)?.key !== key) return;
        const stillLive = thumbnails.get(index);
        if (!stillLive) return;
        const evicted = store.trackMounted(
          key,
          thumbnailByteSize(stillLive.canvas.width, stillLive.canvas.height),
          stillLive.canvas
        );
        for (const evictedKey of evicted) {
          for (const [pendingIndex, pending] of [...pendingKeys]) {
            if (pending.key === evictedKey && pending.generation !== generation) {
              pendingKeys.delete(pendingIndex);
            }
          }
        }
      })();
      return {
        done,
        cancel: (): void => {
          cancelInner?.();
        }
      };
    }).catch(() => undefined);
    const settled = pendingKeys.get(index);
    if (settled?.key === key && settled.generation === generation) pendingKeys.delete(index);
  }

  function cancelThumb(index: number): void {
    const pending = pendingKeys.get(index);
    pendingKeys.delete(index);
    if (pending) store.cancelRender(pending.key);
  }

  async function loadCapabilities(): Promise<void> {
    capabilitiesError = null;
    renderExportSection();
    try {
      capabilities = await getCapabilities();
    } catch (error) {
      capabilities = null;
      capabilitiesError = error instanceof Error ? error.message : "Capabilities are unavailable.";
    }
    if (!destroyed) refresh();
  }

  async function runExport(): Promise<void> {
    if (exporting) return;
    exportError = null;
    exportWarnings = [];
    exportResult = null;
    let snapshot;
    try {
      snapshot = deriveExportSnapshot(editorState, scope);
    } catch (error) {
      exportError = editorLimitMessage(error);
      renderExportSection();
      return;
    }
    const missing = snapshot.sourceIds.filter((id) => !files.has(id));
    if (missing.length > 0) {
      exportError = "A source file is no longer available. Re-add it and try again.";
      renderExportSection();
      return;
    }
    // Freeze: the snapshot is immutable, so late gestures cannot change it.
    exporting = true;
    exportController = new AbortController();
    refresh();
    exportStatus.textContent = "Exporting locally...";
    try {
      const result = await exportPages({
        manifest: snapshot.manifest,
        files: snapshot.sourceIds.map((id) => files.get(id)!),
        compression: compression === "none" || capabilities?.ghostscript.available ? compression : "none",
        signal: exportController.signal
      });
      if (!result.ok || !result.handle || !result.downloadUrl) {
        throw new Error(result.message ?? `Export failed (${result.code ?? "EXPORT_FAILED"}).`);
      }
      exportWarnings = [...(result.warnings ?? []), ...(result.compatWarnings ?? [])];
      const fileName = scope === "selection" ? "selection.pdf" : "pages.pdf";
      const blob = await downloadOutput(result.downloadUrl, exportController.signal);
      // The server consumes the retained artifact on a completed download,
      // so the handle is dead from here on. Keep only the Blob/object URL
      // locally; never present a server discard for a consumed output.
      exportResult = { pageCount: result.pageCount ?? snapshot.manifest.pages.length, fileName };
      offerDownload(blob, fileName);
      exportStatus.textContent = "Export ready.";
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        exportError = "Export cancelled. Your pages are unchanged.";
        exportStatus.textContent = "Cancelled.";
      } else {
        // The editable manifest is preserved: only status and error change.
        exportError = error instanceof Error ? error.message : "Export failed. Your pages are unchanged.";
        exportStatus.textContent = "Export failed.";
      }
    } finally {
      exporting = false;
      exportController = null;
      if (!destroyed) refresh();
    }
  }

  function offerDownload(blob: Blob, fileName: string): void {
    resultBox.replaceChildren();
    const heading = document.createElement("h2");
    heading.textContent = "Export ready";
    const detail = document.createElement("p");
    detail.className = "muted small";
    detail.textContent = exportResult
      ? `${exportResult.pageCount} pages · local file, nothing uploaded.`
      : "Local file, nothing uploaded.";
    resultBox.append(heading, detail);
    try {
      if (downloadHref) URL.revokeObjectURL(downloadHref);
      downloadHref = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.className = "button";
      link.textContent = "Download PDF";
      link.href = downloadHref;
      link.download = fileName;
      resultBox.append(link);
      link.click();
    } catch {
      const note = document.createElement("p");
      note.className = "error";
      note.textContent = "Automatic download is unavailable in this browser context.";
      resultBox.append(note);
    }
    if (exportResult) {
      const again = document.createElement("p");
      again.className = "muted small";
      again.textContent = "This file is saved locally in your browser. Keep this view open to download it again.";
      const clear = document.createElement("button");
      clear.type = "button";
      clear.className = "button button--secondary button--small";
      clear.textContent = "Clear result";
      clear.addEventListener("click", () => {
        if (downloadHref) {
          try {
            URL.revokeObjectURL(downloadHref);
          } catch {
            // Best effort.
          }
          downloadHref = null;
        }
        exportResult = null;
        resultBox.replaceChildren();
        refresh();
      });
      resultBox.append(again, clear);
    }
  }

  function renderExportSection(): void {
    exportOptions.update({
      totalCount: editorState.manifest.pages.length,
      selectedCount: editorState.selection.length,
      scope: editorState.selection.length === 0 && scope === "selection" ? "all" : scope,
      compression,
      ghostscriptAvailable: capabilities ? capabilities.ghostscript.available : null,
      exporting
    });
    if (editorState.selection.length === 0 && scope === "selection") scope = "all";
    const qpdfReady = capabilities?.qpdf.available === true;
    const hasPages = editorState.manifest.pages.length > 0;
    exportButton.disabled = exporting || !hasPages || !qpdfReady;
    cancelButton.disabled = !exporting;
    backButton.disabled = exporting;
    backLink.disabled = exporting;
    if (capabilitiesError) {
      capsNote.hidden = false;
      capsNote.textContent = `Capabilities are unavailable: ${capabilitiesError} Export stays disabled.`;
      capsRetry.hidden = exporting;
    } else if (capabilities && !capabilities.qpdf.available) {
      capsNote.hidden = false;
      capsNote.textContent =
        `Page export needs qpdf ${QPDF_SECURITY_FLOOR} or newer on this computer. Preview still works; install qpdf to export.`;
      capsRetry.hidden = true;
    } else {
      capsNote.hidden = true;
      capsNote.textContent = "";
      capsRetry.hidden = true;
    }
    if (!exporting && exportStatus.textContent === "Exporting locally...") {
      exportStatus.textContent = "";
    }
    exportErrorNote.textContent = exportError ?? "";
    exportErrorNote.hidden = exportError === null;
    warningList.replaceChildren();
    for (const warning of exportWarnings) {
      const item = document.createElement("li");
      item.textContent = warning;
      warningList.append(item);
    }
    warningList.hidden = exportWarnings.length === 0;
  }

  function refresh(): void {
    if (destroyed) return;
    renderSources();
    renderGrid();
    actions.update({
      totalCount: editorState.manifest.pages.length,
      selectedCount: editorState.selection.length,
      exporting
    });
    renderExportSection();
  }

  function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  refresh();
  void loadCapabilities();

  return {
    element: root,
    destroy(): void {
      destroyed = true;
      exportController?.abort();
      observer?.disconnect();
      observer = null;
      for (const pending of pendingKeys.values()) {
        store.cancelRender(pending.key);
      }
      pendingKeys.clear();
      thumbnails.clear();
      if (downloadHref) {
        try {
          URL.revokeObjectURL(downloadHref);
        } catch {
          // Best effort.
        }
        downloadHref = null;
      }
      void store.destroy();
    }
  };
}
