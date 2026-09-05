# Benchmark Corpora

Deterministic, generated, redistributable synthetic PDFs. No private data.

- `corpus-20.pdf`, `corpus-100.pdf`, `corpus-500.pdf`: 20, 100, and 500
  pages. Each page has a distinct MediaBox width and marker label so page
  order survives assembly checks.
- Regenerate exactly: `node scripts/benchmark-page-editor.mjs --regen-corpora`.
- Measured results and environment metadata live in
  `docs/benchmarks/page-editor-baseline.json`. Raw repeated benchmark logs
  are not committed; only the baseline summary is.
