import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assemblePages } from "@pdf-compressor/core";
import { createManifest } from "@pdf-compressor/core/page-manifest";

const execFileAsync = promisify(execFile);

async function supportsRealOcr(): Promise<boolean> {
  try {
    const [{ stdout: version }, { stdout: languages }] = await Promise.all([
      execFileAsync("ocrmypdf", ["--version"]),
      execFileAsync("tesseract", ["--list-langs"])
    ]);
    const installed = new Set(languages.split(/\r?\n/).map((language) => language.trim()));
    return /(?:^|\s)(?:1[7-9]|[2-9]\d)\.\d+\.\d+(?:\s|$)/.test(version) &&
      ["deu", "eng", "osd"].every((language) => installed.has(language));
  } catch {
    return false;
  }
}

async function extractText(path: string): Promise<string> {
  const bytes = new Uint8Array(await readFile(path));
  const document = await getDocument({ data: bytes, disableWorker: true }).promise;
  try {
    const page = await document.getPage(1);
    const content = await page.getTextContent();
    return content.items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  } finally {
    await document.destroy();
  }
}

describe("local OCR integration (real OCRmyPDF and Tesseract)", () => {
  let scratch = "";

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), "pdf-real-ocr-"));
  });

  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  it("keeps OCR searchable after real page assembly", async (context) => {
    if (!(await supportsRealOcr())) context.skip();

    const postscriptPath = join(scratch, "scan.ps");
    const inputPath = join(scratch, "scan.pdf");
    const outputPath = join(scratch, "searchable.pdf");
    await writeFile(
      postscriptPath,
      [
        "%!PS-Adobe-3.0",
        "<< /PageSize [612 792] >> setpagedevice",
        "/Helvetica-Bold findfont 32 scalefont setfont",
        "72 500 moveto",
        "(LOCAL OCR PROOF 4729) show",
        "showpage",
        ""
      ].join("\n")
    );
    await execFileAsync("gs", [
      "-q",
      "-dSAFER",
      "-dBATCH",
      "-dNOPAUSE",
      "-sDEVICE=pdfimage24",
      "-r200",
      `-sOutputFile=${inputPath}`,
      "--",
      postscriptPath
    ]);

    expect(await extractText(inputPath)).toBe("");
    const summary = await assemblePages({
      sources: [{ id: "scan", path: inputPath }],
      manifest: createManifest([{ sourceId: "scan", page: 1 }]),
      destinationPath: outputPath,
      ocr: { languages: ["deu", "eng"], autoRotate: true }
    });

    expect(summary).toMatchObject({
      status: "success",
      pageCount: 1,
      engine: "ocrmypdf"
    });
    expect(summary.ocr).toMatchObject({ languages: ["deu", "eng"], autoRotate: true });
    expect((await extractText(outputPath)).toUpperCase()).toContain("LOCAL OCR PROOF 4729");
  }, 120_000);
});
