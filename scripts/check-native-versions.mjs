#!/usr/bin/env node
/**
 * U6 native-version gate (KTD10).
 *
 * Source of truth for the floors: packages/core/src/native-floors.ts
 * (QPDF_SECURITY_FLOOR, GHOSTSCRIPT_SECURITY_FLOOR). The values are
 * duplicated here so this gate stays dependency-free and reusable in
 * CI/local verification without a build.
 *
 * Behavior: parse actual `qpdf --version` / `gs --version` output
 * robustly, require qpdf, treat Ghostscript as optional (missing gs only
 * disables compression), and fail closed below either floor.
 */
import { execFile } from "node:child_process";

const QPDF_SECURITY_FLOOR = "12.4.1";
const GHOSTSCRIPT_SECURITY_FLOOR = "10.07.1";

function parseTuple(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version).trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareTuples(left, right) {
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  }
  return 0;
}

/** qpdf prints e.g. "qpdf version 12.4.1\n..."; match the version triple. */
export function parseQpdfVersion(output) {
  const match = /qpdf version (\d+\.\d+\.\d+)/.exec(String(output));
  return match ? match[1] : null;
}

/** gs --version prints a bare version on the first line, e.g. "10.07.1". */
export function parseGhostscriptVersion(output) {
  const first = String(output).split("\n")[0]?.trim() ?? "";
  return parseTuple(first) ? first : null;
}

function run(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 15000 }, (error, stdout, stderr) => {
      if (error) {
        resolve({ ok: false, stdout: String(stdout ?? ""), stderr: String(stderr ?? error.message) });
        return;
      }
      resolve({ ok: true, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

function meetsFloor(found, floor) {
  const a = parseTuple(found);
  const b = parseTuple(floor);
  return a !== null && b !== null && compareTuples(a, b) >= 0;
}

const qpdf = await run("qpdf", ["--version"]);
if (!qpdf.ok) {
  console.error("check-native-versions: FAIL: qpdf is required for page export but was not found.");
  process.exit(1);
}
const qpdfVersion = parseQpdfVersion(qpdf.stdout);
if (!qpdfVersion) {
  console.error("check-native-versions: FAIL: could not parse qpdf version output; failing closed.");
  process.exit(1);
}
console.log(`check-native-versions: qpdf ${qpdfVersion} (floor ${QPDF_SECURITY_FLOOR})`);
if (!meetsFloor(qpdfVersion, QPDF_SECURITY_FLOOR)) {
  console.error(`check-native-versions: FAIL: qpdf ${qpdfVersion} is below the security floor ${QPDF_SECURITY_FLOOR}.`);
  process.exit(1);
}

const gs = await run("gs", ["--version"]);
if (!gs.ok) {
  console.log("check-native-versions: Ghostscript not found; compression stays disabled (optional).");
} else {
  const gsVersion = parseGhostscriptVersion(gs.stdout);
  if (!gsVersion) {
    console.error("check-native-versions: FAIL: could not parse Ghostscript version output; failing closed.");
    process.exit(1);
  }
  console.log(`check-native-versions: Ghostscript ${gsVersion} (floor ${GHOSTSCRIPT_SECURITY_FLOOR})`);
  if (!meetsFloor(gsVersion, GHOSTSCRIPT_SECURITY_FLOOR)) {
    console.error(
      `check-native-versions: FAIL: Ghostscript ${gsVersion} is below the security floor ${GHOSTSCRIPT_SECURITY_FLOOR}.`
    );
    process.exit(1);
  }
}

console.log("check-native-versions: PASS");
