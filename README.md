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
watermark image process <source> --op <operation> [--op ...] [--format webp] [--out file]
watermark image read <source>
watermark image create --width 1200 --height 300 --op 'text:text=Hi,font=inter-bold,size=96' --op trim --out logo.png
watermark video process <source> --op <operation> [--max-duration 30] [--out file]
watermark video read <source> | watermark video screenshot <source> --seconds 5
watermark document process <source> --op <operation> [--max-pages 10] [--out file]
watermark document read <source> | watermark document snapshot <source> --page 1
watermark request get <id> | watermark request abort <id>
watermark requests | watermark account | watermark usage --group-by endpoint
watermark upload photo.heic | watermark upload get|delete <upl_id>
watermark file get|delete <file_id>
watermark storage list | connect --bucket b --region us-east-1 --role-arn <arn> | get|verify|disconnect <stg_id>
watermark events --since 2026-10-13T15:00:00Z
watermark fonts
watermark operations image
```

Processing commands wait for the request to finish (up to `--timeout`, default 300 seconds) unless `--no-wait` is given; `--out` downloads the result.

Operations run in order: `--op type:param=value,param=value`, or all at once with `--ops-json '[{"type":"resize","width":800,"height":600}]'`. `watermark operations` lists them all.

Other options: `--webhook <url>`, `--customer <id>`, `--metadata key=value`, `--idempotency-key <key>`, `--json`, `--api-key`, `--base-url` (or `WATERMARK_API_URL`).

A source is a public http(s) URL, a local file (uploaded first), an upload
(`upl_…`), a file an earlier request kept (`file_…`), or an object in a
connected bucket (`stg_7a:path/to/key`).

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
