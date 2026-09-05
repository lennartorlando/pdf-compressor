// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAuthStateForTests } from "../src/api/client.js";
import { mountApp } from "../src/App.js";

/**
 * U5G regression: leaving the editor must destroy the exact live editor
 * handle exactly once, before the compressor view replaces the editor.
 * The PageEditor module is mocked narrowly (same { element, destroy }
 * handle contract) so the test exercises the real App mounting/navigation
 * seam without loading PDF.js.
 */
const editorProbe = vi.hoisted(() => ({
  destroyCalls: 0,
  onExit: undefined as (() => void) | undefined,
  editorConnectedAtDestroy: undefined as boolean | undefined,
  compressorPresentAtDestroy: undefined as boolean | undefined,
}));

vi.mock("../src/components/PageEditor.js", () => ({
  createPageEditor: (deps: { onExit: () => void }): { element: HTMLElement; destroy: () => void } => {
    editorProbe.onExit = deps.onExit;
    const element = document.createElement("div");
    element.className = "page-editor";
    const back = document.createElement("button");
    back.type = "button";
    back.textContent = "← Compressor";
    back.addEventListener("click", () => deps.onExit());
    element.append(back);
    return {
      element,
      destroy: (): void => {
        editorProbe.destroyCalls += 1;
        editorProbe.editorConnectedAtDestroy = element.isConnected;
        editorProbe.compressorPresentAtDestroy =
          document.querySelector("main h1")?.textContent === "PDF Compressor";
      },
    };
  },
}));

const tick = async (rounds = 10): Promise<void> => {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

beforeEach(() => {
  resetAuthStateForTests();
  vi.unstubAllGlobals();
  editorProbe.destroyCalls = 0;
  editorProbe.onExit = undefined;
  editorProbe.editorConnectedAtDestroy = undefined;
  editorProbe.compressorPresentAtDestroy = undefined;
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("editor exit lifecycle (U5G)", () => {
  it("aborts active compression before replacing the compressor view", async () => {
    let compressionSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit = {}): Promise<Response> => {
        if (url === "/api/session/launch") {
          return {
            ok: true,
            status: 200,
            json: async () => ({ ok: true, token: "t".repeat(64), expiresInMs: 300_000 })
          } as Response;
        }
        if (url.startsWith("/api/compress")) {
          compressionSignal = init.signal ?? undefined;
          return new Promise<Response>((_, reject) => {
            compressionSignal?.addEventListener(
              "abort",
              () => reject(new DOMException("Aborted", "AbortError")),
              { once: true }
            );
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      })
    );
    const root = document.createElement("main");
    document.body.append(root);
    mountApp(root);
    const input = root.querySelector('.dropzone input[type="file"]') as HTMLInputElement;
    const file = new File([new Uint8Array(10)], "in.pdf", { type: "application/pdf" });
    if (typeof file.arrayBuffer !== "function") {
      Object.defineProperty(file, "arrayBuffer", { value: async () => new Uint8Array(10).buffer });
    }
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    const buttons = [...root.querySelectorAll<HTMLButtonElement>(".actions .button")];
    buttons[0].click();
    await tick(2);
    expect(compressionSignal?.aborted).toBe(false);

    const staleCompressButton = buttons[0];
    const staleCancelButton = buttons[1];
    buttons[2].click();
    await tick();

    expect(compressionSignal?.aborted).toBe(true);
    expect(root.querySelector(".page-editor")).not.toBeNull();
    expect(staleCompressButton.disabled).toBe(true);
    expect(staleCancelButton.disabled).toBe(false);
  });

  it("destroys the live editor exactly once before the compressor replaces it", async () => {
    const root = document.createElement("main");
    document.body.append(root);
    mountApp(root);
    expect(root.querySelector("h1")?.textContent).toBe("PDF Compressor");

    const editButton = [...root.querySelectorAll<HTMLButtonElement>(".actions .button")].find(
      (button) => button.textContent === "Edit pages",
    );
    expect(editButton).toBeDefined();
    editButton?.click();
    await tick();

    const editorElement = root.querySelector(".page-editor");
    expect(editorElement).not.toBeNull();
    expect(editorProbe.destroyCalls).toBe(0);

    (editorElement?.querySelector("button") as HTMLButtonElement | null)?.click();

    // destroy runs synchronously inside onExit, before mountCompressor.
    expect(editorProbe.destroyCalls).toBe(1);
    expect(editorProbe.editorConnectedAtDestroy).toBe(true);
    expect(editorProbe.compressorPresentAtDestroy).toBe(false);

    // After exit the compressor view replaces the editor.
    expect(root.querySelector(".page-editor")).toBeNull();
    expect(root.querySelector("h1")?.textContent).toBe("PDF Compressor");

    // A repeated exit must not destroy again (re-entrancy guard).
    editorProbe.onExit?.();
    expect(editorProbe.destroyCalls).toBe(1);
    expect(root.querySelector("h1")?.textContent).toBe("PDF Compressor");
  });
});
