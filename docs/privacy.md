# Privacy

PDF Compressor is local-first.

## Default Data Flow

- The web app talks to a loopback server on the same machine.
- PDF bytes are sent to that local server only.
- No default cloud upload, telemetry endpoint, account system, or third-party document storage exists.
- The CLI reads local files and writes local output paths supplied by the user or agent.

## Temporary Files

Compression, page-export, and OCR jobs use isolated temporary directories.

- The local server streams each uploaded source once into a private
  per-job workspace and never buffers complete multipart uploads in memory.
- The shared core creates its own per-job workspace for intermediate output.
- OCRmyPDF and Tesseract receive a private working directory and `TMPDIR`;
  OCR text and intermediate images stay inside the server-owned job directory,
  count toward its live storage limits, and are deleted with that workspace.
- Source input files written by the local server are removed after every
  terminal state; only the validated output is retained.
- A session-bound output survives interrupted downloads for one retry but
  is consumed after the first completed download, explicit discard, or a
  short TTL (10 minutes). Cancelled and failed jobs remove their workspace.

## What Is Not Collected

- No document content leaves the machine by default.
- No PDF metadata is retained in app storage after a job.
- No analytics or telemetry library is configured.
- No account identifier, email address, or user profile is required.

## Known Limits

- Native PDF tools such as `qpdf` (>= 12.4.1, required for page export)
  or Ghostscript (>= 10.07.1, optional for compression), and OCRmyPDF >= 17
  with the selected Tesseract languages (optional for OCR), must be installed
  on the user's machine until binary distribution is decided.
- Password-protected, signed, and active-content PDFs are rejected rather
  than decrypted, repaired, or sanitized.
- Page assembly may not preserve forms, bookmarks, tags, or custom page
  labels; these surface as compatibility warnings.
- Desktop packaging is deferred.
