# Architecture: Lightweight PDF Page Editing (Option B)

Page-level editing: preview, reorder, rotate, delete, merge, selection export,
and an optional OCR export step. Direct content editing, redaction, and signing
remain out of scope.

## Contracts

- Browser-safe manifest: `@pdf-compressor/core/page-manifest` (opaque
  `sourceId`, one-based `page`, relative `rotate`). Browser `File` objects,
  server temp paths, and CLI paths stay in adapter-owned bindings.
- Node core: `inspectSources`, `assemblePages`, and `ocrPdf` in `packages/core`.
- CLI: `inspect` and `assemble` (`docs/architecture/cli-contract.md`).
- Server: `POST /api/pages/export` (multipart) plus session-bound
  one-time download handles (`apps/local-server/src/routes/edit.ts`).

## Data flow

Local files become PDF.js thumbnails (lazy worker); gestures mutate only
browser state. OCR settings are export options and never enter the manifest.
Export freezes an immutable snapshot, streams each source once to the loopback
server, and the core runs exactly one qpdf page-selection mutation, validation,
either optional Ghostscript candidate selection or mandatory OCR, validation,
and no-clobber publication. Compression is skipped with a `no_gain` warning
when OCR is selected so recognition quality and the searchable layer stay intact.

## Boundaries

- qpdf (>= 12.4.1) is required for export; Ghostscript (>= 10.07.1) is
  optional and only used for post-assembly compression candidates.
- OCRmyPDF (>= 17.0.0), Tesseract language data, and `osd` orientation data
  for automatic rotation are optional. Selecting OCR
  makes that step mandatory for the export; missing tools or languages fail
  clearly instead of returning an unrecognized PDF.
- Blocked inputs fail closed: encrypted, signed, JavaScript, open or
  additional actions, launch, submit/import, rich media, embedded files.
- Inert structures (forms, bookmarks, tags, page labels) surface as
  compatibility warnings without preservation claims.
- Upload, output, page-count, runtime, storage, and concurrency caps live
  in `apps/local-server/src/jobs.ts` (`LIMITS`).
- Outputs are session-bound, one-time downloads with TTL, discard, and
  startup/shutdown cleanup.

## Budgets and evidence

- SC1/SC2 enforced by `scripts/check-editor-bundle.mjs` against the built
  Vite asset graph.
- Native floors enforced by `scripts/check-native-versions.mjs`, read from
  the built browser-safe `@pdf-compressor/core/native-floors` output
  (single source of truth in `packages/core/src/native-floors.ts`). The
  gate always runs after the core build/typecheck and fails clearly when
  the core has not been built.
- Reproducible measurements in `docs/benchmarks/page-editor-baseline.json`
  via `scripts/benchmark-page-editor.mjs`. SC5 compares core assemble p95
  against max(300ms, 20% beyond the equivalent direct native pipeline p95)
  and exits nonzero when exceeded. Browser-only criteria
  (SC3, browser gesture p95, browser-to-download overhead, in-flight SC7,
  SC8 streaming RSS) are marked unverified there: no real-browser driver
  is installed and this project fabricates no such evidence.
