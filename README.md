# PDF Compressor

PDF Compressor ist eine lokale, quelloffene Anwendung zum Verkleinern von PDF-Dateien. Dokumente bleiben auf dem eigenen Rechner; Weboberfläche und CLI verwenden dieselbe Kompressionslogik.

## Status

Die erste vollständige Version ist implementiert. Das Repository enthält:

- eine lokale Weboberfläche zum Auswählen, Komprimieren und Herunterladen von PDFs,
- einen nur an `127.0.0.1` gebundenen HTTP-Server,
- eine CLI für Skripte, Automationen und Agenten,
- drei Profile: `conservative`, `balanced` und `aggressive`,
- strukturierte JSON-Ausgabe für maschinelle Verbraucher.

PDF Compressor ist bewusst kein PDF-Editor. Der aktuelle Umfang beschränkt sich auf Kompression.

## Voraussetzungen

- Node.js und npm
- [`qpdf`](https://qpdf.sourceforge.io/)
- [Ghostscript](https://www.ghostscript.com/)

Auf macOS lassen sich die nativen Werkzeuge mit Homebrew installieren:

```bash
brew install qpdf ghostscript
```

Fehlen die Werkzeuge, meldet die Anwendung einen lokalen Setup-Fehler. Sie lädt keine Datei ersatzweise zu einem externen Dienst hoch.

## Lokale Web-App

```bash
npm install
npm run build
npm run dev
```

Der lokale Server ist anschließend standardmäßig unter `http://127.0.0.1:5174` erreichbar. Mit `PORT` kann ein anderer Port gewählt werden.

## CLI

Nach dem Build:

```bash
node packages/cli/dist/index.js compress input.pdf \
  --output output.pdf \
  --profile balanced
```

Für Automationen:

```bash
node packages/cli/dist/index.js compress input.pdf \
  --output output.pdf \
  --profile aggressive \
  --json
```

Eine vorhandene Ausgabedatei wird nur mit `--overwrite` ersetzt.

## Repository-Struktur

```text
apps/web/          Browseroberfläche
apps/local-server/ Lokaler Server und Kompressionsroute
packages/core/     Validierung, Profile und native Kompression
packages/cli/      Kommandozeilenoberfläche
tests/fixtures/    Testdateien
docs/              Architektur-, Sicherheits- und Datenschutzdokumentation
```

## Entwicklung

```bash
npm test
npm run typecheck
npm run build
```

Weitere Details stehen in [`docs/privacy.md`](docs/privacy.md), [`docs/security.md`](docs/security.md) und [`docs/architecture`](docs/architecture).

## Lizenz

AGPL-3.0-or-later. Siehe [`LICENSE`](LICENSE).
