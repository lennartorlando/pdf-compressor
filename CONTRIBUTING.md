# Contributing

Thanks for helping build PDF Compressor.

## Scope

The app covers local PDF compression and page-level editing (preview,
reorder, rotate, delete, merge, selection export) through the shared core.

Please keep issues and pull requests aligned with:

- local web app compression and page-editing flows
- shared compression and page-assembly core
- CLI support for agents and automation (`compress`, `inspect`, `assemble`)
- privacy, security, and license clarity

Content editing, OCR, signing, redaction, persistent projects, desktop
packaging, and cloud features are deferred.

## Development

```bash
npm install
npm test
npm run typecheck
npm run build
```

## Test Fixtures

Use synthetic or explicitly redistributable PDFs only. Do not commit private documents.
