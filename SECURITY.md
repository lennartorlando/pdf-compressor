# Security Policy

## Supported Versions

The project is pre-1.0. Security fixes target the current `main` branch.

Native parser floors fail closed: qpdf below 12.4.1 blocks inspection,
assembly, and export; Ghostscript below 10.07.1 blocks compression
candidates. See `packages/core/src/native-floors.ts`.

## Reporting a Vulnerability

Do not attach private PDFs or sensitive document content to public issues.

Use GitHub Security Advisories when available. If that is not available, open a concise issue that describes the affected area and reproduction shape without confidential files.
