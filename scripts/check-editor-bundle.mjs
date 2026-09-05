#!/usr/bin/env node
/**
 * U6 production asset-budget enforcement (SC1 + SC2).
 *
 * Measures gzip bytes from the built Vite asset graph (apps/web/dist),
 * never from source estimates:
 * - SC1: the eager compressor shell (JS referenced by dist/index.html)
 *   grows by no more than 20 KiB gzip against the documented baseline below.
 * - SC2: initial PDF.js display chunk + worker <= 650 KiB gzip;
 *   complete lazy editor graph <= 2 MiB gzip.
 *
 * Reproducible baseline: `npm run build` on the reference tree at commit
 * 72af7a1 (pre-editor eager shell), then
 * `node scripts/check-editor-bundle.mjs`. The eager-shell baseline is
 * 1973 gzip bytes; only growth beyond EAGER_GROWTH_BUDGET fails.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, "..", "apps", "web", "dist");
const ASSETS = join(DIST, "assets");
const INDEX_HTML = join(DIST, "index.html");

export const EAGER_BASELINE_GZIP = 1973;
const EAGER_GROWTH_BUDGET = 20 * 1024;
const DISPLAY_PLUS_WORKER_CAP = 650 * 1024;
const LAZY_GRAPH_CAP = 2 * 1024 * 1024;

/**
 * Pure budget evaluation, exported for tests: proves the gate fails on a
 * deliberately impossible budget without committing a failing threshold.
 */
export function evaluateBundleGate({ eagerGzip, displayPlusWorker, lazyGraph }) {
  return {
    sc1Ok: eagerGzip - EAGER_BASELINE_GZIP <= EAGER_GROWTH_BUDGET,
    displayOk: displayPlusWorker <= DISPLAY_PLUS_WORKER_CAP,
    lazyOk: lazyGraph <= LAZY_GRAPH_CAP
  };
}

/** Path-with-spaces self-check: this repo path must round-trip, never %20. */
function assertPathDecoding() {
  const self = fileURLToPath(import.meta.url);
  if (/%20/i.test(self)) {
    console.error("check-editor-bundle: FAIL: script path still URL-encoded; use fileURLToPath.");
    process.exit(1);
  }
  // The workspace itself contains spaces; prove directory reads work there.
  try {
    statSync(ASSETS);
  } catch {
    // The missing-dist failure below reports this case; no silent %20 ENOENT.
  }
}

export function assetPath(file) {
  return join(ASSETS, file);
}

export function gzipBytes(file) {
  return gzipSync(readFileSync(assetPath(file))).length;
}

function fail(message) {
  console.error(`check-editor-bundle: FAIL: ${message}`);
  process.exit(1);
}

const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  assertPathDecoding();

  let html;
  try {
    html = readFileSync(INDEX_HTML, "utf8");
  } catch {
    fail("apps/web/dist/index.html is missing; run `npm run build` first.");
  }

  const eagerRefs = [...html.matchAll(/src="\/assets\/(index-[^"]+\.js)"/g)].map((m) => m[1]);
  if (eagerRefs.length === 0) fail("no eager index-*.js asset referenced by dist/index.html.");
  let files;
  try {
    files = readdirSync(ASSETS);
  } catch {
    fail("apps/web/dist/assets is missing; run `npm run build` first.");
  }

  const missing = eagerRefs.filter((f) => !files.includes(f));
  if (missing.length > 0) fail(`eager assets missing from dist: ${missing.join(", ")}.`);

  const workerFiles = files.filter((f) => f.startsWith("pdf.worker.min-"));
  const displayFiles = files.filter((f) => /^pdf-[\w-]+\.js$/.test(f));
  const editorFiles = files.filter((f) => f.startsWith("PageEditor-") && f.endsWith(".js"));
  if (workerFiles.length === 0) fail("no local pdf.worker.min-*.mjs asset in dist (worker must be served locally).");
  if (displayFiles.length === 0) fail("no lazy pdf-*.js display chunk in dist.");
  if (editorFiles.length === 0) fail("no lazy PageEditor-*.js chunk in dist.");

  const eagerGzip = eagerRefs.reduce((sum, f) => sum + gzipBytes(f), 0);
  const workerGzip = workerFiles.reduce((sum, f) => sum + gzipBytes(f), 0);
  const displayGzip = displayFiles.reduce((sum, f) => sum + gzipBytes(f), 0);
  const editorGzip = editorFiles.reduce((sum, f) => sum + gzipBytes(f), 0);

  // Unrelated assets (CSS) are reported but never counted twice or against JS caps.
  const cssFiles = files.filter((f) => f.endsWith(".css"));
  const cssGzip = cssFiles.reduce((sum, f) => sum + gzipBytes(f), 0);

  const displayPlusWorker = displayGzip + workerGzip;
  const lazyGraph = editorGzip + displayGzip + workerGzip;

  console.log("check-editor-bundle (gzip bytes from built Vite asset graph):");
  console.log(`  eager shell (${eagerRefs.join(", ")}): ${eagerGzip} (baseline ${EAGER_BASELINE_GZIP}, growth budget ${EAGER_GROWTH_BUDGET})`);
  console.log(`  display + worker: ${displayPlusWorker} (cap ${DISPLAY_PLUS_WORKER_CAP})`);
  console.log(`  lazy editor graph: ${lazyGraph} (cap ${LAZY_GRAPH_CAP})`);
  console.log(`  css (informational, not counted): ${cssGzip}`);

  const gate = evaluateBundleGate({ eagerGzip, displayPlusWorker, lazyGraph });
  let failed = false;
  if (!gate.sc1Ok) {
    console.error(`  SC1 violated: eager shell grew by ${eagerGzip - EAGER_BASELINE_GZIP} bytes gzip (budget ${EAGER_GROWTH_BUDGET}).`);
    failed = true;
  }
  if (!gate.displayOk) {
    console.error(`  SC2 violated: display + worker is ${displayPlusWorker} bytes gzip (cap ${DISPLAY_PLUS_WORKER_CAP}).`);
    failed = true;
  }
  if (!gate.lazyOk) {
    console.error(`  SC2 violated: lazy editor graph is ${lazyGraph} bytes gzip (cap ${LAZY_GRAPH_CAP}).`);
    failed = true;
  }
  // Eager/HTML hygiene: the compressor shell must not eagerly load PDF.js.
  if (/pdf\.worker|PageEditor|pdf-[\w-]+\.js/.test(html)) {
    console.error("  SC1 violated: dist/index.html eagerly references editor/PDF.js assets.");
    failed = true;
  }
  try {
    const stat = statSync(ASSETS);
    void stat;
  } catch {
    failed = true;
  }

  if (failed) process.exit(1);
  console.log("check-editor-bundle: PASS");
}
