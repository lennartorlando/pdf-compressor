# PDF Compressor

Local-first, open-source PDF compression.

This repository starts as a planning and implementation workspace for a PDF compressor that works like a simple web app but keeps documents on the user's machine. The first product surface is a local web app. A CLI follows so agents and automation can use the same compression engine. A desktop app is intentionally deferred.

## Product Direction

- Local processing by default: no PDF upload to third-party servers.
- Compression-only scope: reduce PDF file size without becoming a PDF editor.
- Web app first: browser-based workflow for drag, inspect, compress, and download.
- CLI second: stable command interface for agents, scripts, and batch jobs.
- Open source: implementation and compression choices should be auditable.
- License: AGPL-3.0-or-later.

## Planning

- Implementation plan: [docs/plans/2026-07-06-001-feat-local-pdf-compressor-plan.md](docs/plans/2026-07-06-001-feat-local-pdf-compressor-plan.md)

## Development

```bash
npm install
npm test
npm run typecheck
npm run build
```

Native compression requires local PDF tools such as `qpdf` and Ghostscript. When they are missing, the app returns a local setup error instead of uploading the PDF elsewhere.
