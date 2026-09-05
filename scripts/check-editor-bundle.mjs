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
 * Reproducible baseline: `npm run build` on the reference tree, then
 * `node scripts/check-editor-bundle.mjs`. The eager-shell baseline is the
 * measured gzip size of dist/assets/index-*.js at the time the Option B UI
 * landed (3386 bytes); only growth beyond EAGER_GROWTH_BUDGET fails.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const DIST = new URL("../apps/web/dist/", import.meta.url);
const ASSETS = new URL("../apps/web/dist/assets/", import.meta.url);

const EAGER_BASELINE_GZIP = 3386;
const EAGER_GROWTH_BUDGET = 20 * 1024;
const DISPLAY_PLUS_WORKER_CAP = 650 * 1024;
const LAZY_GRAPH_CAP = 2 * 1024 * 1024;

function fail(message) {
  console.error(`check-editor-bundle: FAIL: ${message}`);
  process.exit(1);
}

function assetPath(file) {
  return join(new URL(ASSETS).pathname, file);
}

function gzipBytes(file) {
  return gzipSync(readFileSync(assetPath(file))).length;
}

let html;
try {
  html = readFileSync(new URL("../apps/web/dist/index.html", import.meta.url), "utf8");
} catch {
  fail("apps/web/dist/index.html is missing; run `npm run build` first.");
}

const eagerRefs = [...html.matchAll(/src="\/assets\/(index-[^"]+\.js)"/g)].map((m) => m[1]);
if (eagerRefs.length === 0) fail("no eager index-*.js asset referenced by dist/index.html.");
let files;
try {
  files = readdirSync(new URL(ASSETS));
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

let failed = false;
if (eagerGzip - EAGER_BASELINE_GZIP > EAGER_GROWTH_BUDGET) {
  console.error(`  SC1 violated: eager shell grew by ${eagerGzip - EAGER_BASELINE_GZIP} bytes gzip (budget ${EAGER_GROWTH_BUDGET}).`);
  failed = true;
}
if (displayPlusWorker > DISPLAY_PLUS_WORKER_CAP) {
  console.error(`  SC2 violated: display + worker is ${displayPlusWorker} bytes gzip (cap ${DISPLAY_PLUS_WORKER_CAP}).`);
  failed = true;
}
if (lazyGraph > LAZY_GRAPH_CAP) {
  console.error(`  SC2 violated: lazy editor graph is ${lazyGraph} bytes gzip (cap ${LAZY_GRAPH_CAP}).`);
  failed = true;
}
// Eager/HTML hygiene: the compressor shell must not eagerly load PDF.js.
if (/pdf\.worker|PageEditor|pdf-[\w-]+\.js/.test(html)) {
  console.error("  SC1 violated: dist/index.html eagerly references editor/PDF.js assets.");
  failed = true;
}
try {
  const stat = statSync(new URL(ASSETS).pathname);
  void stat;
} catch {
  failed = true;
}

if (failed) process.exit(1);
console.log("check-editor-bundle: PASS");
