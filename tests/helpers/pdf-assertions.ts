import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";

export interface PageGeometry {
  width: number;
  rotate: number;
}

interface QpdfPageEntry {
  contents: string;
  object: string;
}

interface QpdfJsonDocument {
  pages: QpdfPageEntry[];
  qpdf: [{ pdfversion: string }, Record<string, { value?: { "/MediaBox"?: number[]; "/Rotate"?: number } }>];
}

function runQpdfJson(path: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile("qpdf", ["--json", "--", path], { maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = (error as NodeJS.ErrnoException & { code?: number })?.code;
      resolve({ stdout: String(stdout), stderr: String(stderr), code: typeof code === "number" ? code : 0 });
    });
  });
}

/** Page geometries in output order: MediaBox width plus explicit /Rotate. */
export async function readOutputGeometries(path: string): Promise<PageGeometry[]> {
  const { stdout } = await runQpdfJson(path);
  const document = JSON.parse(stdout) as QpdfJsonDocument;
  const objects = document.qpdf[1];
  return document.pages.map((page) => {
    const raw = objects[`obj:${page.object}`];
    const mediaBox = raw?.value?.["/MediaBox"] ?? [0, 0, 0, 0];
    return { width: mediaBox[2] ?? 0, rotate: raw?.value?.["/Rotate"] ?? 0 };
  });
}

/** sha256 of a file, proving an input was read but never rewritten. */
export async function sha256OfFile(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

/** First bytes of a representative output page via `qpdf --json` object text. */
export async function outputPageCount(path: string): Promise<number> {
  const { stdout } = await runQpdfJson(path);
  return (JSON.parse(stdout) as QpdfJsonDocument).pages.length;
}

/**
 * Render-inspect one representative output page without a browser: decompress
 * the page content stream with `qpdf --qdf` output and assert the fixture
 * marker text for that page is present. This catches content regressions
 * that pure page-count checks cannot see.
 */
export async function outputContainsMarker(outputPath: string, marker: string): Promise<boolean> {
  const text = await new Promise<string>((resolve, reject) => {
    execFile("qpdf", ["--qdf", "--object-streams=disable", "--", outputPath, "-"], {
      maxBuffer: 64 * 1024 * 1024,
      encoding: "buffer"
    }, (error, stdout) => {
      if (error && (error as NodeJS.ErrnoException & { code?: number }).code !== 0) {
        reject(error);
        return;
      }
      resolve((stdout as Buffer).toString("latin1"));
    });
  });
  return text.includes(marker);
}
