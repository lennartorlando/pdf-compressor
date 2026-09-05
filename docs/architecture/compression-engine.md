# Compression and Page Engine

The engine lives in `packages/core` and is consumed by the local web
server and the CLI for both compression and page-level editing. Page
assembly is documented in detail in
[`page-editing.md`](page-editing.md).

## Pipeline

1. Validate that the input exists, is a PDF, is not encrypted, and will not be overwritten by the output path.
2. Resolve the requested profile.
3. Select an engine adapter that supports the profile.
4. Run the adapter inside an isolated temporary workspace.
5. Copy the candidate output to the requested output path.
6. Compare input and output sizes and return a structured summary.
7. Remove intermediate workspace files.

## Profiles

- `conservative`: fidelity-first, intended for lossless structural optimization.
- `balanced`: image recompression allowed, intended for everyday size reduction.
- `aggressive`: stronger image recompression, with visible fidelity risk.

## Engine Adapters

Adapters hide the native tool details from the product surfaces.

- `qpdf` adapter: structural optimization.
- `ghostscript` adapter: image-oriented lossy compression through `pdfwrite`.

The default local machine may not have either tool installed. In that case, the app reports `ENGINE_UNAVAILABLE` and stays local.
Missing qpdf disables page export; missing Ghostscript disables only
compression profiles.
