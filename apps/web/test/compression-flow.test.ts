// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { mountApp } from "../src/App.js";

describe("web compression flow", () => {
  it("renders the local-first workflow", () => {
    const root = document.createElement("main");
    mountApp(root);

    expect(root.textContent).toContain("PDF Compressor");
    expect(root.textContent).toContain("Compress PDFs locally");
    expect(root.textContent).toContain("Balanced");
    expect(root.querySelector("button")?.textContent).toBe("Compress");
    expect(root.textContent).toContain("Cancel");
  });
});
