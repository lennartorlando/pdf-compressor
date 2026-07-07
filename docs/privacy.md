# Privacy

PDF Compressor is local-first.

## Default Data Flow

- The web app talks to a loopback server on the same machine.
- PDF bytes are sent to that local server only.
- No default cloud upload, telemetry endpoint, account system, or third-party document storage exists.
- The CLI reads local files and writes local output paths supplied by the user or agent.

## Temporary Files

Compression jobs use isolated temporary directories.

- The local server writes a temporary input file for the active job.
- The shared core creates its own per-job workspace for intermediate output.
- Source input files written by the local server are removed after compression.
- Cancelled and failed jobs remove their temporary workspace.

The current implementation keeps compressed output in a local temporary job directory until the browser downloads it or the job is explicitly deleted. A follow-up should add automatic expiry for stale downloaded results.

## What Is Not Collected

- No document content leaves the machine by default.
- No PDF metadata is retained in app storage after a job.
- No analytics or telemetry library is configured.
- No account identifier, email address, or user profile is required.

## Known Limits

- Native compression tools such as `qpdf` or Ghostscript must be installed on the user's machine until binary distribution is decided.
- Password-protected PDFs are rejected rather than decrypted or re-encrypted.
- Desktop packaging is deferred.
