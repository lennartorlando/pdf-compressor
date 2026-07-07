import { compressFile, downloadUrl } from "./api/client.js";
import { createFileDropzone } from "./components/FileDropzone.js";
import { createJobProgress, setProgress } from "./components/JobProgress.js";
import { createProfileSelector } from "./components/ProfileSelector.js";
import { createResultSummary, renderError, renderResult } from "./components/ResultSummary.js";
import type { CompressionProfileName } from "./profiles.js";

export function mountApp(root: HTMLElement): void {
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
  actions.append(button, cancelButton);

  root.replaceChildren(title, subtitle, dropzone, profiles, actions, progress, result);
}
