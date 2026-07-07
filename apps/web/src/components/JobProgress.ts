export function createJobProgress(): HTMLElement {
  const progress = document.createElement("div");
  progress.className = "progress";
  progress.setAttribute("role", "status");
  progress.textContent = "Ready";
  return progress;
}

export function setProgress(progress: HTMLElement, message: string): void {
  progress.textContent = message;
}
