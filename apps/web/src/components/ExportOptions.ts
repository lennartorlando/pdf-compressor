import type { ExportCompression, OcrLanguage } from "../api/client.js";
import type { ExportScope } from "../editor/model.js";

export interface ExportOptionsCallbacks {
  onScopeChange(scope: ExportScope): void;
  onCompressionChange(compression: ExportCompression): void;
  onOcrEnabledChange(enabled: boolean): void;
  onOcrLanguagesChange(languages: OcrLanguage[]): void;
}

export interface ExportOptionsState {
  totalCount: number;
  selectedCount: number;
  scope: ExportScope;
  compression: ExportCompression;
  ghostscriptAvailable: boolean | null;
  ocrEnabled: boolean;
  ocrLanguages: OcrLanguage[];
  ocrmypdfAvailable: boolean | null;
  tesseractAvailable: boolean | null;
  tesseractLanguages: string[];
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

  const ocrGroup = document.createElement("div");
  ocrGroup.className = "export-options__ocr";
  const ocrToggleLabel = document.createElement("label");
  ocrToggleLabel.className = "export-options__ocr-toggle";
  const ocrToggle = document.createElement("input");
  ocrToggle.type = "checkbox";
  ocrToggle.name = "export-ocr";
  ocrToggle.addEventListener("change", () => callbacks.onOcrEnabledChange(ocrToggle.checked));
  const ocrToggleCopy = document.createElement("span");
  const ocrTitle = document.createElement("strong");
  ocrTitle.textContent = "Make text searchable";
  const ocrDescription = document.createElement("span");
  ocrDescription.className = "muted small";
  ocrDescription.textContent = "Adds an invisible text layer. Existing text stays unchanged.";
  ocrToggleCopy.append(ocrTitle, ocrDescription);
  ocrToggleLabel.append(ocrToggle, ocrToggleCopy);

  const languageGroup = document.createElement("fieldset");
  languageGroup.className = "export-options__languages";
  const languageLegend = document.createElement("legend");
  languageLegend.textContent = "Languages";
  languageGroup.append(languageLegend);
  const languageInputs = new Map<OcrLanguage, HTMLInputElement>();
  for (const choice of [
    { value: "deu" as const, label: "German" },
    { value: "eng" as const, label: "English" }
  ]) {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = choice.value;
    input.addEventListener("change", () => {
      const languages = [...languageInputs]
        .filter(([, candidate]) => candidate.checked)
        .map(([language]) => language);
      callbacks.onOcrLanguagesChange(languages);
    });
    const text = document.createElement("span");
    text.textContent = choice.label;
    label.append(input, text);
    languageGroup.append(label);
    languageInputs.set(choice.value, input);
  }
  const rotateNote = document.createElement("p");
  rotateNote.className = "export-options__note";
  rotateNote.textContent = "Automatic rotation is always on.";
  languageGroup.append(rotateNote);
  const ocrSetup = document.createElement("p");
  ocrSetup.className = "export-options__note warn";
  ocrGroup.append(ocrToggleLabel, languageGroup, ocrSetup);

  section.append(scopeGroup, compressionGroup, compressionNote, ocrGroup);

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

    const showCompression = state.ghostscriptAvailable === true && !state.ocrEnabled;
    compressionGroup.hidden = !showCompression;
    compressionNote.hidden = state.ghostscriptAvailable !== false && !state.ocrEnabled;
    if (state.ocrEnabled) {
      compressionNote.textContent = "Compression is off for searchable exports.";
    } else if (state.ghostscriptAvailable === false) {
      compressionNote.textContent = "Compression is unavailable here: Ghostscript was not found on this computer.";
    } else {
      compressionNote.textContent = "";
    }
    for (const entry of compressionLabels) {
      entry.input.checked = state.compression === entry.value;
      entry.input.disabled = state.exporting;
    }

    ocrToggle.checked = state.ocrEnabled;
    ocrToggle.disabled = state.exporting;
    languageGroup.hidden = !state.ocrEnabled;
    for (const [language, input] of languageInputs) {
      input.checked = state.ocrLanguages.includes(language);
      input.disabled = state.exporting;
    }
    const setup: string[] = [];
    if (state.ocrEnabled && state.ocrmypdfAvailable === false) {
      setup.push("Install OCRmyPDF 17 or newer with brew install ocrmypdf.");
    }
    if (state.ocrEnabled && state.tesseractAvailable === false) {
      setup.push("Install Tesseract with brew install tesseract.");
    }
    if (state.ocrEnabled && state.ocrLanguages.some((language) => !state.tesseractLanguages.includes(language))) {
      setup.push("Install German and English language data with brew install tesseract-lang.");
    }
    if (state.ocrEnabled && !state.tesseractLanguages.includes("osd")) {
      setup.push("Install Tesseract orientation data (osd) for automatic rotation.");
    }
    if (state.ocrEnabled && state.ocrLanguages.length === 0) {
      setup.push("Choose at least one OCR language.");
    }
    ocrSetup.textContent = setup.join(" ");
    ocrSetup.hidden = setup.length === 0;
  }

  render({
    totalCount: 0,
    selectedCount: 0,
    scope: "all",
    compression: "none",
    ghostscriptAvailable: null,
    ocrEnabled: false,
    ocrLanguages: ["deu", "eng"],
    ocrmypdfAvailable: null,
    tesseractAvailable: null,
    tesseractLanguages: [],
    exporting: false
  });
  return { element: section, update: render };
}
