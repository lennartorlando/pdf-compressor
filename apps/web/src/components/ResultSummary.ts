import type { CompressionResponse } from "../api/client.js";

type CompressionSummary = NonNullable<CompressionResponse["summary"]>;

export function createResultSummary(): HTMLElement {
  const section = document.createElement("section");
  section.className = "result";
  section.setAttribute("aria-live", "polite");
  return section;
}

export function renderResult(
  target: HTMLElement,
  summary: CompressionSummary,
  href: string,
  fileName = "compressed.pdf"
): void {
  target.innerHTML = `
    <h2>${summary.outputSmaller ? "Compressed PDF ready" : "No useful reduction"}</h2>
    <dl>
      <div><dt>Original</dt><dd>${formatBytes(summary.originalBytes)}</dd></div>
      <div><dt>Result</dt><dd>${formatBytes(summary.outputBytes)}</dd></div>
      <div><dt>Reduction</dt><dd>${summary.reductionPercent}%</dd></div>
      <div><dt>Profile</dt><dd>${summary.profile}</dd></div>
    </dl>
    <a class="button" href="${href}" download="${fileName}">Download PDF</a>
  `;
}

export function renderError(target: HTMLElement, message: string): void {
  target.innerHTML = `<p class="error">${message}</p>`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
