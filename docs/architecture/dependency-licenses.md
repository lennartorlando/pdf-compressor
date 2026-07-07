# Dependency Licenses

The project starts with AGPL-3.0-or-later to keep the repository compatible with AGPL-licensed PDF engine options.

## Runtime PDF Tools

| Tool | Purpose | License posture |
|---|---|---|
| qpdf | Lossless structural optimization | Permissive upstream licensing; suitable for conservative optimization. |
| Ghostscript | `pdfwrite` lossy compression profiles | AGPL/commercial upstream licensing; bundling or tight distribution must honor AGPL obligations. |

## Current Distribution Decision

The app calls local binaries by name and reports `ENGINE_UNAVAILABLE` when they are missing.
It does not bundle PDF engine binaries yet.

Before distributing installers or a desktop app, revisit whether binaries are bundled, downloaded, or user-installed.
