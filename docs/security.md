# Security

## Local Trust Boundary

The local server is designed to bind to `127.0.0.1` by default. It is not intended to be exposed as a LAN or internet service.

## File Handling

- The original input path is never overwritten.
- Temporary job directories are isolated per job.
- Validation rejects non-PDF files and PDFs with an encryption marker.
- Compression errors return local error codes rather than partial success.

## External Tools

The shared core can call local PDF tools through adapter modules.

- `qpdf` is used for lossless structural optimization.
- Ghostscript is used for lossy image-oriented profiles.

The app treats missing tools as a local setup problem. It does not fall back to a remote compressor.

## Reporting Vulnerabilities

Please report security issues through GitHub Security Advisories when available, or by opening a minimal public issue that does not include private PDFs, document content, credentials, or exploit payloads.
