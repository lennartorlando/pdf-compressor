import { compressFile, downloadUrl } from "./api/client.js";
import { createFileDropzone } from "./components/FileDropzone.js";
import { createJobProgress, setProgress } from "./components/JobProgress.js";
import { createProfileSelector } from "./components/ProfileSelector.js";
import { createResultSummary, renderError, renderResult } from "./components/ResultSummary.js";
import type { CompressionProfileName } from "./profiles.js";

export function mountApp(root: HTMLElement): void {
  let selectedFile: File | undefined;
  let selectedProfile: CompressionProfileName = "balanced";

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
    button.disabled = true;
    setProgress(progress, "Compressing locally...");
    result.innerHTML = "";

    const response = await compressFile(selectedFile, selectedProfile);
    if (response.ok && response.summary && response.downloadUrl) {
      renderResult(result, response.summary, downloadUrl(response.downloadUrl));
      setProgress(progress, "Done");
    } else {
      renderError(result, response.message ?? "Compression failed.");
      setProgress(progress, "Could not compress this PDF");
    }
    button.disabled = false;
  });

  root.replaceChildren(title, subtitle, dropzone, profiles, button, progress, result);
}
