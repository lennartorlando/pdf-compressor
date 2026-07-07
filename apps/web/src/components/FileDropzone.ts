export function createFileDropzone(onFile: (file: File) => void): HTMLElement {
  const label = document.createElement("label");
  label.className = "dropzone";
  label.innerHTML = `
    <span class="dropzone__title">Drop a PDF here</span>
    <span class="dropzone__hint">or choose one from your computer</span>
    <input type="file" accept="application/pdf,.pdf" />
  `;

  const input = label.querySelector("input")!;
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    if (file) onFile(file);
  });

  label.addEventListener("dragover", (event) => {
    event.preventDefault();
    label.classList.add("dropzone--active");
  });

  label.addEventListener("dragleave", () => {
    label.classList.remove("dropzone--active");
  });

  label.addEventListener("drop", (event) => {
    event.preventDefault();
    label.classList.remove("dropzone--active");
    const file = event.dataTransfer?.files?.[0];
    if (file) onFile(file);
  });

  return label;
}
