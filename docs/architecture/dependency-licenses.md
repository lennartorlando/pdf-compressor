# Dependency Licenses

The project starts with AGPL-3.0-or-later to keep the repository compatible with AGPL-licensed PDF engine options.

## Runtime PDF Tools

| Tool | Purpose | License posture |
|---|---|---|
| qpdf | Lossless structural optimization and page assembly | Permissive upstream licensing; suitable for conservative optimization. |
| Ghostscript | `pdfwrite` lossy compression profiles | AGPL/commercial upstream licensing; bundling or tight distribution must honor AGPL obligations. |

## Bundled JavaScript Dependencies

| Package | Version | Purpose | License |
|---|---|---|---|
| `pdfjs-dist` | 6.3.289 (exact pin) | Lazy local thumbnail rendering with a version-matched worker; scripting and dynamic evaluation disabled | Apache-2.0 |
| `@fastify/busboy` | 3.2.2 (exact pin) | Streaming multipart parser for the page-export route; no file-sized buffers | MIT |

## Current Distribution Decision

The app calls local binaries by name and reports `ENGINE_UNAVAILABLE` when they are missing.
It does not bundle PDF engine binaries yet.

Before distributing installers or a desktop app, revisit whether binaries are bundled, downloaded, or user-installed.
