// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { exportPages, resetAuthStateForTests } from "../src/api/client.js";
import { createExportOptions } from "../src/components/ExportOptions.js";

const TOKEN = "t".repeat(64);

beforeEach(() => {
  resetAuthStateForTests();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("OCR export transport", () => {
  it.each([
    [null, "/api/pages/export?compression=none&ocr=off"],
    [
      { languages: ["deu", "eng"] as const, autoRotate: true as const },
      "/api/pages/export?compression=none&ocr=deu%2Beng&ocrAutoRotate=true"
    ]
  ])("serializes the closed OCR query", async (ocr, expectedUrl) => {
    const calls: string[] = [];
    let submitted: FormData | null = null;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push(url);
      if (url === "/api/session/launch") {
        return new Response(JSON.stringify({ ok: true, token: TOKEN, expiresInMs: 300_000 }), { status: 200 });
      }
      submitted = init.body as FormData;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }));
    await exportPages({
      manifest: { version: 1, pages: [{ sourceId: "a", page: 1 }] },
      files: [new File(["pdf"], "a.pdf", { type: "application/pdf" })],
      compression: "none",
      ocr
    });
    expect(calls.at(-1)).toBe(expectedUrl);
    expect(submitted?.getAll("manifest")).toHaveLength(1);
    expect(submitted?.getAll("source")).toHaveLength(1);
    expect(JSON.parse(submitted?.get("manifest") as string)).toEqual({
      version: 1,
      pages: [{ sourceId: "a", page: 1 }]
    });
  });
});

describe("Option A OCR controls", () => {
  it("starts off with German and English selected and fixed automatic rotation", () => {
    const onEnabled = vi.fn();
    const onLanguages = vi.fn();
    const options = createExportOptions({
      onScopeChange: vi.fn(),
      onCompressionChange: vi.fn(),
      onOcrEnabledChange: onEnabled,
      onOcrLanguagesChange: onLanguages
    });
    document.body.append(options.element);
    options.update({
      totalCount: 1,
      selectedCount: 0,
      scope: "all",
      compression: "none",
      ghostscriptAvailable: true,
      ocrEnabled: false,
      ocrLanguages: ["deu", "eng"],
      ocrmypdfAvailable: true,
      tesseractAvailable: true,
      tesseractLanguages: ["deu", "eng", "osd"],
      exporting: false
    });

    const toggle = options.element.querySelector<HTMLInputElement>('input[name="export-ocr"]')!;
    const german = options.element.querySelector<HTMLInputElement>('input[value="deu"]')!;
    const english = options.element.querySelector<HTMLInputElement>('input[value="eng"]')!;
    expect(toggle.checked).toBe(false);
    expect(german.checked).toBe(true);
    expect(english.checked).toBe(true);
    expect(options.element.textContent).toContain("Automatic rotation is always on");

    toggle.click();
    expect(onEnabled).toHaveBeenCalledWith(true);
    options.update({
      totalCount: 1,
      selectedCount: 0,
      scope: "all",
      compression: "none",
      ghostscriptAvailable: true,
      ocrEnabled: true,
      ocrLanguages: ["deu", "eng"],
      ocrmypdfAvailable: true,
      tesseractAvailable: true,
      tesseractLanguages: ["deu", "eng", "osd"],
      exporting: false
    });
    expect(options.element.textContent).toContain("Compression is off for searchable exports.");
    german.click();
    expect(onLanguages).toHaveBeenCalledWith(["eng"]);
  });

  it("shows concrete local setup help for each missing OCR dependency", () => {
    const options = createExportOptions({
      onScopeChange: vi.fn(),
      onCompressionChange: vi.fn(),
      onOcrEnabledChange: vi.fn(),
      onOcrLanguagesChange: vi.fn()
    });
    options.update({
      totalCount: 1,
      selectedCount: 0,
      scope: "all",
      compression: "none",
      ghostscriptAvailable: true,
      ocrEnabled: true,
      ocrLanguages: ["deu", "eng"],
      ocrmypdfAvailable: false,
      tesseractAvailable: false,
      tesseractLanguages: [],
      exporting: false
    });
    expect(options.element.textContent).toContain("brew install ocrmypdf");
    expect(options.element.textContent).toContain("brew install tesseract");
    expect(options.element.textContent).toContain("brew install tesseract-lang");
  });
});
