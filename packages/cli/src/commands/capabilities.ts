import {
  CompressionError,
  GHOSTSCRIPT_SECURITY_FLOOR,
  QPDF_SECURITY_FLOOR,
  assertNativeFloor,
  getGhostscriptVersion,
  getOcrMyPdfVersion,
  getQpdfVersion,
  getTesseractLanguages,
  getTesseractVersion,
  type NativeRunner
} from "@pdf-compressor/core";
import {
  exitCodeFor,
  formatJsonError,
  formatJsonSuccess,
  usageErrorResult,
  type CliResult
} from "../output.js";

interface ToolCapability {
  available: boolean;
  version: string | null;
}

interface TesseractCapability extends ToolCapability {
  languages: string[];
}

export interface CapabilitiesCommandDeps {
  run?: NativeRunner;
  signal?: AbortSignal;
}

const CAPABILITY_PROBE_TIMEOUT_MS = 15_000;

async function probeVersion(operation: () => Promise<string>): Promise<ToolCapability> {
  try {
    return { available: true, version: await operation() };
  } catch (error) {
    if (
      error instanceof CompressionError &&
      (error.code === "JOB_CANCELLED" || error.code === "JOB_TIMEOUT")
    ) {
      throw error;
    }
    const found = error instanceof CompressionError && typeof error.details?.found === "string"
      ? error.details.found
      : null;
    return { available: false, version: found };
  }
}

async function probeLanguages(operation: () => Promise<string[]>): Promise<string[]> {
  try {
    return await operation();
  } catch (error) {
    if (
      error instanceof CompressionError &&
      (error.code === "JOB_CANCELLED" || error.code === "JOB_TIMEOUT")
    ) {
      throw error;
    }
    return [];
  }
}

export async function runCapabilitiesCommand(
  args: string[],
  deps: CapabilitiesCommandDeps = {}
): Promise<CliResult> {
  const json = args.includes("--json");
  const unknown = args.find((token) => token !== "--json");
  if (unknown) {
    const error = new Error(`Unknown option: ${unknown}`);
    if (json) return usageErrorResult(error);
    return { exitCode: 64, stdout: "", stderr: `${error.message}\n${capabilitiesUsage()}` };
  }

  const calls = { run: deps.run, signal: deps.signal, timeoutMs: CAPABILITY_PROBE_TIMEOUT_MS };
  try {
    const [qpdf, ghostscript, ocrmypdf, tesseractBase, detectedLanguages] = await Promise.all([
      probeVersion(async () => {
        const version = await getQpdfVersion(calls);
        assertNativeFloor("qpdf", version, QPDF_SECURITY_FLOOR);
        return version;
      }),
      probeVersion(async () => {
        const version = await getGhostscriptVersion(calls);
        assertNativeFloor("gs", version, GHOSTSCRIPT_SECURITY_FLOOR);
        return version;
      }),
      probeVersion(() => getOcrMyPdfVersion(calls)),
      probeVersion(() => getTesseractVersion(calls)),
      probeLanguages(() => getTesseractLanguages(calls))
    ]);
    const languages = tesseractBase.available ? detectedLanguages : [];
    const tesseract: TesseractCapability = {
      ...tesseractBase,
      available: tesseractBase.available && detectedLanguages.length > 0,
      languages
    };
    const payload = {
      status: "success" as const,
      capabilities: { qpdf, ghostscript, ocrmypdf, tesseract }
    };

    if (json) return { exitCode: 0, stdout: formatJsonSuccess(payload), stderr: "" };
    const lines = Object.entries(payload.capabilities).map(([name, capability]) =>
      `${name}: ${capability.available ? capability.version : "unavailable"}`
    );
    lines.push(`ocr languages: ${languages.length ? languages.join(", ") : "none"}`);
    return { exitCode: 0, stdout: `${lines.join("\n")}\n`, stderr: "" };
  } catch (error) {
    if (json) {
      return { exitCode: exitCodeFor(error), stdout: formatJsonError(error), stderr: "" };
    }
    return {
      exitCode: exitCodeFor(error),
      stdout: "",
      stderr: `${error instanceof Error ? error.message : "Capability inspection failed"}\n`
    };
  }
}

export function capabilitiesUsage(): string {
  return ["Usage: pdf-compressor capabilities [--json]", ""].join("\n");
}
