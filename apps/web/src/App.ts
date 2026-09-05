import { compressFile, downloadUrl } from "./api/client.js";
import { createFileDropzone } from "./components/FileDropzone.js";
import { createJobProgress, setProgress } from "./components/JobProgress.js";
import { createProfileSelector } from "./components/ProfileSelector.js";
import { createResultSummary, renderError, renderResult } from "./components/ResultSummary.js";
import type { CompressionProfileName } from "./profiles.js";

// NOTE: the page editor and PDF.js stay behind a dynamic import so the
// compressor shell never eagerly loads them (SC1). Do not add a static
// import of the editor or pdfjs-dist here.
type PageEditorModule = typeof import("./components/PageEditor.js");

export function mountApp(root: HTMLElement): void {
  mountCompressor(root);
}

function mountCompressor(root: HTMLElement): void {
  let selectedFile: File | undefined;
  let selectedProfile: CompressionProfileName = "balanced";
  let currentController: AbortController | undefined;

  const title = document.createElement("h1");
  title.textContent = "PDF Compressor";

  const subtitle = document.createElement("p");
  subtitle.className = "subtitle";
  subtitle.textContent = "Compress PDFs locally. Nothing is uploaded to a third-party service.";

  const progress = createJobProgress();
  const result = createResultSummary();
  const button = document.createElement("button");
  button.className = "button";
  button.textContent = "Compress";
  button.disabled = true;

  const cancelButton = document.createElement("button");
  cancelButton.className = "button button--secondary";
  cancelButton.textContent = "Cancel";
  cancelButton.disabled = true;

  const editorButton = document.createElement("button");
  editorButton.className = "button button--secondary";
  editorButton.textContent = "Edit pages";
  editorButton.addEventListener("click", () => {
    void mountEditor(root);
  });

  const dropzone = createFileDropzone((file) => {
    selectedFile = file;
    button.disabled = false;
    setProgress(progress, `${file.name} selected`);
    result.innerHTML = "";
  });

  const profiles = createProfileSelector((profile) => {
    selectedProfile = profile;
  });

  button.addEventListener("click", async () => {
    if (!selectedFile) return;
    currentController = new AbortController();
    button.disabled = true;
    cancelButton.disabled = false;
    setProgress(progress, "Compressing locally...");
    result.innerHTML = "";

    try {
      const response = await compressFile(selectedFile, selectedProfile, currentController.signal);
      if (response.ok && response.summary && response.downloadUrl) {
        renderResult(result, response.summary, downloadUrl(response.downloadUrl));
        setProgress(progress, "Done");
      } else {
        renderError(result, response.message ?? "Compression failed.");
        setProgress(progress, "Could not compress this PDF");
      }
    } catch (error) {
      const cancelled = error instanceof DOMException && error.name === "AbortError";
      renderError(result, cancelled ? "Compression cancelled." : "Compression failed.");
      setProgress(progress, cancelled ? "Cancelled" : "Could not compress this PDF");
    } finally {
      currentController = undefined;
      button.disabled = false;
      cancelButton.disabled = true;
    }
  });

  cancelButton.addEventListener("click", () => {
    currentController?.abort();
  });

  const actions = document.createElement("div");
  actions.className = "actions";
  actions.append(button, cancelButton, editorButton);

  root.replaceChildren(title, subtitle, dropzone, profiles, actions, progress, result);
}

async function mountEditor(root: HTMLElement): Promise<void> {
  const loading = document.createElement("p");
  loading.className = "progress";
  loading.setAttribute("role", "status");
  loading.textContent = "Opening the page editor...";
  root.replaceChildren(loading);
  try {
    const module: PageEditorModule = await import("./components/PageEditor.js");
    if (!root.contains(loading)) return;
    const editor = module.createPageEditor({ onExit: () => mountCompressor(root) });
    root.replaceChildren(editor.element);
  } catch {
    renderError(root, "The page editor could not be opened. Go back and try again.");
    const back = document.createElement("button");
    back.className = "button button--secondary";
    back.textContent = "Back to compressor";
    back.addEventListener("click", () => mountCompressor(root));
    root.append(back);
  }
}
