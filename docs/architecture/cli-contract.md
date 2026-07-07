# CLI Contract

The CLI exposes the same shared compression core used by the local web app.

## Command

```bash
pdf-compressor compress input.pdf --output output.pdf --profile balanced --json
```

## Profiles

- `conservative`
- `balanced`
- `aggressive`

## JSON Output

When `--json` is set, stdout is reserved for one JSON object.
Human-readable progress and warnings belong on stderr.

Successful output includes:

- `ok`
- `status`
- `inputPath`
- `outputPath`
- `profile`
- `originalBytes`
- `outputBytes`
- `reductionBytes`
- `reductionPercent`
- `outputSmaller`
- `engine`
- `warnings`

Failures include:

- `ok`
- `code`
- `message`

## Exit Codes

- `0`: success
- `2`: validation failure
- `3`: compression failure
- `4`: cancellation
- `64`: usage error
