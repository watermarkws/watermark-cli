# Watermark CLI

Watermark, resize and convert images, videos and PDFs from the command line with the [Watermark API](https://api.watermark.ws/docs). Built for people and for AI agents: `--json` prints machine-readable output and exit codes mean something.

```bash
export WATERMARK_API_KEY=wm_test_…   # https://watermark.ws/developers
npx @watermark/cli image process https://example.com/photo.jpg \
  --op resize:width=1600,height=1600 \
  --op watermark:image_url=https://example.com/logo.png,x=40,y=40 \
  --format webp --out photo.webp
```

Node 18+, no dependencies.

## Commands

```
watermark image process <url> --op <operation> [--op ...] [--format webp] [--out file]
watermark image read <url>
watermark video process <url> --op <operation> [--max-duration 30] [--out file]
watermark video read <url> | watermark video screenshot <url> --seconds 5
watermark document process <url> --op <operation> [--max-pages 10] [--out file]
watermark document read <url> | watermark document snapshot <url> --page 1
watermark request get <id> | watermark request abort <id>
watermark requests | watermark account | watermark usage --group-by endpoint
watermark operations image
```

Processing commands wait for the request to finish (up to `--timeout`, default 300 seconds) unless `--no-wait` is given; `--out` downloads the result.

Operations run in order: `--op type:param=value,param=value`, or all at once with `--ops-json '[{"type":"resize","width":800,"height":600}]'`. `watermark operations` lists them all.

Other options: `--webhook <url>`, `--customer <id>`, `--metadata key=value`, `--idempotency-key <key>`, `--json`, `--api-key`, `--base-url` (or `WATERMARK_API_URL`).

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Succeeded (or queued, with `--no-wait`). |
| 1 | The API refused the call, or the request failed or was aborted. The error code is printed. |
| 2 | The command was used wrongly. |

Rate limits (429) and server errors are retried twice with the same `Idempotency-Key`, so a retry never runs a request twice.

## Development

```bash
npm test
```
