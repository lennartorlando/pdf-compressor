# PDF Compressor & Page Editor

PDF Compressor ist eine lokale, quelloffene Anwendung zum Verkleinern und
seiteweisen Bearbeiten von PDF-Dateien. Dokumente bleiben auf dem eigenen
Rechner; Weboberfläche und CLI verwenden dieselbe Core-Logik.

## Status

Die erste vollständige Version ist implementiert. Das Repository enthält:

- eine lokale Weboberfläche zum Auswählen, Komprimieren und Herunterladen von PDFs,
- einen nur an `127.0.0.1` gebundenen HTTP-Server,
- eine CLI für Skripte, Automationen und Agenten,
- lokale Texterkennung für deutsche und englische Scans,
- drei Profile: `conservative`, `balanced` und `aggressive`,
- strukturierte JSON-Ausgabe für maschinelle Verbraucher.

PDF Compressor ist kein reiner Kompressor mehr: Die App kann lokale PDFs
als Thumbnails vorschauen, Seiten umsortieren, rotieren, löschen,
mehrere Quellen mischen und eine Auswahl als neues PDF exportieren.
Die Bearbeitung bleibt auf Seitenebene. Optional ergänzt OCR eine durchsuchbare
Textebene, ohne einen Cloud-Dienst zu verwenden. Details stehen in
[`docs/architecture/page-editing.md`](docs/architecture/page-editing.md).

## Voraussetzungen

- Node.js und npm
- [`qpdf`](https://qpdf.sourceforge.io/) >= 12.4.1 (Pflicht für
  Seitenexport; darunter bricht die App geschlossen ab)
- [Ghostscript](https://www.ghostscript.com/) >= 10.07.1 (optional, nur
  für Kompressionsprofile nach dem Export)
- [OCRmyPDF](https://ocrmypdf.readthedocs.io/) >= 17.0.0 und Tesseract
  (optional, für lokale OCR; Sprachdaten `deu` und `eng` sowie `osd` für
  automatische Drehung)

Auf macOS lassen sich die nativen Werkzeuge mit Homebrew installieren:

```bash
brew install qpdf ghostscript ocrmypdf tesseract-lang
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

Seiten prüfen und zusammensetzen (gleiche Core-Logik wie die Web-App):

```bash
node packages/cli/dist/index.js inspect a.pdf b.pdf --json
node packages/cli/dist/index.js assemble \
  --source a=a.pdf --source b=b.pdf \
  --manifest manifest.json --output out.pdf \
  --ocr --ocr-language deu+eng --json
node packages/cli/dist/index.js ocr scan.pdf \
  --output scan-searchable.pdf --language deu+eng --json
node packages/cli/dist/index.js capabilities --json
```

Verschlüsselte, signierte oder aktiv-inhaltliche PDFs (JavaScript,
Launch-/Open-Actions, eingebettete Dateien u. a.) werden geschlossen
abgewiesen. Formulare, Lesezeichen, Tags und Seitenlabels überleben den
Export ggf. nicht; die App meldet sie als Kompatibilitätswarnung.
Exporte erzeugen immer eine neue Datei, sind einmalig herunterladbar und
werden nach Download, Verwerfen oder Ablauf (10 Minuten) gelöscht.

## Repository-Struktur

```text
apps/web/          Browseroberfläche (Kompressor + Seiteneditor)
apps/local-server/ Lokaler Server, Kompressions- und Seitenexportrouten
packages/core/     Validierung, Profile, native Kompression und Seitenmontage
packages/cli/      Kommandozeilenoberfläche (compress, inspect, assemble, ocr, capabilities)
tests/fixtures/    Testdateien
tests/integration/ E2E-Nachweis über Core, CLI und Server (reales qpdf)
tests/performance/ Deterministische Benchmark-Korpora (20/100/500 Seiten)
scripts/           Bundle-Budget, Native-Versionstor, Benchmark-Harness
docs/              Architektur-, Sicherheits- und Datenschutzdokumentation
```

## Entwicklung

```bash
npm test
npm run test:integration
npm run typecheck
npm run build
npm run check:editor-bundle
npm run check:native-versions
npm run benchmark:page-editor
```

Weitere Details stehen in [`docs/privacy.md`](docs/privacy.md), [`docs/security.md`](docs/security.md) und [`docs/architecture`](docs/architecture).

## Lizenz

AGPL-3.0-or-later. Siehe [`LICENSE`](LICENSE).
