import { resolve } from "node:path";
import { inspectSources, type PageSourceBinding, type NativeRunner } from "@pdf-compressor/core";
import { exitCodeFor, formatJsonError, formatJsonSuccess, type CliResult } from "../output.js";

export interface InspectCommandOptions {
  paths: string[];
  json: boolean;
}

export interface InspectCommandDeps {
  run?: NativeRunner;
  signal?: AbortSignal;
}

export function parseInspectArgs(args: string[]): InspectCommandOptions {
  const options: InspectCommandOptions = { paths: [], json: false };
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--json") {
      options.json = true;
    } else if (token.startsWith("-")) {
      throw new Error(`Unknown option: ${token}`);
    } else {
      options.paths.push(token);
    }
  }
  if (options.paths.length === 0) throw new Error("Missing input PDF path. Provide one or more PDF paths.");
  return options;
}

export async function runInspectCommand(args: string[], deps: InspectCommandDeps = {}): Promise<CliResult> {
  let options: InspectCommandOptions;
  try {
    options = parseInspectArgs(args);
  } catch (error) {
    return {
      exitCode: 64,
      stdout: "",
      stderr: `${error instanceof Error ? error.message : "Invalid arguments"}\n${inspectUsage()}`
    };
  }

  try {
    const bindings: PageSourceBinding[] = options.paths.map((path, index) => ({
      id: `source-${index + 1}`,
      // The core runs native tools from a private working directory, so the
      // adapter resolves invocation-relative paths to absolute paths here.
      path: resolve(path)
    }));
    const inspections = await inspectSources(bindings, { run: deps.run, signal: deps.signal });
    const payload = {
      status: "success",
      qpdfVersion: inspections[0]?.qpdfVersion ?? "unknown",
      sources: inspections.map((inspection, index) => ({
        id: bindings[index].id,
        path: inspection.path,
        pageCount: inspection.pageCount,
        pdfVersion: inspection.pdfVersion,
        qpdfVersion: inspection.qpdfVersion,
        encrypted: inspection.encrypted,
        signed: inspection.signed,
        activeContent: inspection.activeContent,
        compatWarnings: inspection.compatWarnings,
        warnings: inspection.warnings
      }))
    };

    if (options.json) {
      return { exitCode: 0, stdout: formatJsonSuccess(payload), stderr: "" };
    }
    const lines = payload.sources.map(
      (source) =>
        `${source.id}: ${source.path} (${source.pageCount} pages, PDF ${source.pdfVersion}, qpdf ${source.qpdfVersion})` +
        (source.signed ? " [signed]" : "") +
        (source.activeContent.length ? ` [active: ${source.activeContent.join(",")}]` : "") +
        (source.compatWarnings.length ? ` [compat: ${source.compatWarnings.join(",")}]` : "")
    );
    const diagnostics = payload.sources.flatMap((source) => source.warnings);
    return {
      exitCode: 0,
      stdout: `${lines.join("\n")}\n`,
      stderr: diagnostics.length ? `${diagnostics.join("\n")}\n` : ""
    };
  } catch (error) {
    if (options.json) {
      return { exitCode: exitCodeFor(error), stdout: formatJsonError(error), stderr: "" };
    }
    return {
      exitCode: exitCodeFor(error),
      stdout: "",
      stderr: `${error instanceof Error ? error.message : "Inspection failed"}\n`
    };
  }
}

export function inspectUsage(): string {
  return ["Usage: pdf-compressor inspect <input.pdf> [input2.pdf ...] [--json]", ""].join("\n");
}
