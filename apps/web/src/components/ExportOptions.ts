import type { ExportCompression } from "../api/client.js";
import type { ExportScope } from "../editor/model.js";

export interface ExportOptionsCallbacks {
  onScopeChange(scope: ExportScope): void;
  onCompressionChange(compression: ExportCompression): void;
}

export interface ExportOptionsState {
  totalCount: number;
  selectedCount: number;
  scope: ExportScope;
  compression: ExportCompression;
  ghostscriptAvailable: boolean | null;
  exporting: boolean;
}

export interface ExportOptionsHandle {
  readonly element: HTMLElement;
  update(state: ExportOptionsState): void;
}

const COMPRESSION_CHOICES: Array<{ value: ExportCompression; label: string }> = [
  { value: "none", label: "None" },
  { value: "conservative", label: "Conservative" },
  { value: "balanced", label: "Balanced" },
  { value: "aggressive", label: "Aggressive" }
];

/**
 * Export scope plus optional compression. Compression choices stay hidden
 * until Ghostscript capability is known and stay hidden when Ghostscript is
 * missing; export scope always reflects the live selection count.
 */
export function createExportOptions(callbacks: ExportOptionsCallbacks): ExportOptionsHandle {
  const section = document.createElement("div");
  section.className = "export-options";

  const scopeGroup = document.createElement("div");
  scopeGroup.className = "export-options__scope";
  scopeGroup.setAttribute("role", "radiogroup");
  scopeGroup.setAttribute("aria-label", "Page scope");

  const allLabel = document.createElement("label");
  const allRadio = document.createElement("input");
  allRadio.type = "radio";
  allRadio.name = "export-scope";
  allRadio.value = "all";
  allRadio.checked = true;
  allRadio.addEventListener("change", () => callbacks.onScopeChange("all"));
  const allText = document.createElement("span");
  allLabel.append(allRadio, allText);

  const selectionLabel = document.createElement("label");
  const selectionRadio = document.createElement("input");
  selectionRadio.type = "radio";
  selectionRadio.name = "export-scope";
  selectionRadio.value = "selection";
  selectionRadio.addEventListener("change", () => callbacks.onScopeChange("selection"));
  const selectionText = document.createElement("span");
  selectionLabel.append(selectionRadio, selectionText);

  scopeGroup.append(allLabel, selectionLabel);

  const compressionGroup = document.createElement("fieldset");
  compressionGroup.className = "export-options__compression";
  const compressionLegend = document.createElement("legend");
  compressionLegend.textContent = "Compression (optional)";
  compressionGroup.append(compressionLegend);

  const compressionLabels: Array<{ label: HTMLLabelElement; input: HTMLInputElement; value: ExportCompression }> = [];
  for (const choice of COMPRESSION_CHOICES) {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "export-compression";
    input.value = choice.value;
    input.checked = choice.value === "none";
    input.addEventListener("change", () => callbacks.onCompressionChange(choice.value));
    const text = document.createElement("span");
    text.textContent = choice.label;
    label.append(input, text);
    compressionGroup.append(label);
    compressionLabels.push({ label, input, value: choice.value });
  }

  const compressionNote = document.createElement("p");
  compressionNote.className = "export-options__note";

  section.append(scopeGroup, compressionGroup, compressionNote);

  function render(state: ExportOptionsState): void {
    allText.textContent = `All ${state.totalCount} pages`;
    selectionText.textContent = `Selection only (${state.selectedCount})`;
    allRadio.checked = state.scope === "all";
    selectionRadio.checked = state.scope === "selection";
    allRadio.disabled = state.exporting;
    selectionRadio.disabled = state.exporting || state.selectedCount === 0;
    if (state.scope === "selection" && state.selectedCount === 0) {
      allRadio.checked = true;
    }

    const showCompression = state.ghostscriptAvailable === true;
    compressionGroup.hidden = !showCompression;
    compressionNote.hidden = state.ghostscriptAvailable !== false;
    if (state.ghostscriptAvailable === false) {
      compressionNote.textContent = "Compression is unavailable here: Ghostscript was not found on this computer.";
    } else {
      compressionNote.textContent = "";
    }
    for (const entry of compressionLabels) {
      entry.input.checked = state.compression === entry.value;
      entry.input.disabled = state.exporting;
    }
  }

  render({
    totalCount: 0,
    selectedCount: 0,
    scope: "all",
    compression: "none",
    ghostscriptAvailable: null,
    exporting: false
  });
  return { element: section, update: render };
}
