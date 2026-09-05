export interface EditorActionCallbacks {
  onSelectAll(): void;
  onClearSelection(): void;
  onRotateSelected(): void;
  onDeleteSelected(): void;
  onReset(): void;
}

export interface EditorActionState {
  totalCount: number;
  selectedCount: number;
  exporting: boolean;
}

export interface EditorActionHandle {
  readonly element: HTMLElement;
  update(state: EditorActionState): void;
}

/** Bulk selection bar for the arrange step. All controls are native buttons. */
export function createEditorActions(callbacks: EditorActionCallbacks): EditorActionHandle {
  const bar = document.createElement("div");
  bar.className = "editor-actions";

  const selectAll = document.createElement("button");
  selectAll.type = "button";
  selectAll.className = "button button--secondary button--small";
  selectAll.textContent = "Select all";
  selectAll.addEventListener("click", () => callbacks.onSelectAll());

  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "button button--secondary button--small";
  clear.textContent = "Clear";
  clear.addEventListener("click", () => callbacks.onClearSelection());

  const rotateSelected = document.createElement("button");
  rotateSelected.type = "button";
  rotateSelected.className = "button button--secondary button--small";
  rotateSelected.textContent = "⟳ Rotate selected";
  rotateSelected.addEventListener("click", () => callbacks.onRotateSelected());

  const deleteSelected = document.createElement("button");
  deleteSelected.type = "button";
  deleteSelected.className = "button button--secondary button--small";
  deleteSelected.textContent = "Delete selected";
  deleteSelected.addEventListener("click", () => callbacks.onDeleteSelected());

  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "button button--secondary button--small";
  reset.textContent = "Reset order";
  reset.addEventListener("click", () => callbacks.onReset());

  const count = document.createElement("span");
  count.className = "editor-actions__count";
  count.setAttribute("role", "status");

  bar.append(selectAll, clear, rotateSelected, deleteSelected, reset, count);

  function render(state: EditorActionState): void {
    const frozen = state.exporting;
    const hasPages = state.totalCount > 0;
    const hasSelection = state.selectedCount > 0;
    selectAll.disabled = frozen || !hasPages;
    clear.disabled = frozen || !hasSelection;
    rotateSelected.disabled = frozen || !hasSelection;
    deleteSelected.disabled = frozen || !hasSelection;
    reset.disabled = frozen || !hasPages;
    count.textContent =
      state.totalCount === 0
        ? "No pages yet"
        : `${state.selectedCount} of ${state.totalCount} selected`;
  }

  render({ totalCount: 0, selectedCount: 0, exporting: false });
  return { element: bar, update: render };
}
