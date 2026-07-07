# Test Fixtures

Fixtures are synthetic and redistributable.

- `minimal.pdf` is a tiny PDF used for validation and compression-contract tests.
- `encrypted-marker.pdf` is not a real encrypted document; it contains an `/Encrypt` marker so validation can exercise the unsupported encrypted-PDF path.
- `not-a-pdf.txt` exercises the non-PDF validation path.
