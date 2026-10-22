---
name: watermark
description: Watermark, resize, crop, convert and stamp text on images, videos and PDF or Word documents with the Watermark API from the shell, through the `watermark` CLI. Use it when a user wants a logo or text placed on files, a batch of photos resized or converted (JPEG, PNG, WebP, HEIC, camera RAW and more), a video watermarked or trimmed to a preview, a frame or a page saved as an image, or every page of a PDF stamped while it stays a PDF. Sources can be public URLs, local files (uploaded automatically) or files an earlier request made. Needs a WATERMARK_API_KEY from https://watermark.ws/developers.
---

# Watermark CLI

The `watermark` command sends a file and a list of operations to the Watermark API, waits for the result and downloads it. Use it instead of a local image library for batches, video, PDF/DOCX, camera formats (HEIC, CR3, NEF, ARW, DNG), text in real fonts, and when the result should be a link the user can download.

## Install and set the key

```bash
npm install -g @watermarkws/cli          # or: brew install watermarkws/tap/watermark
npx @watermarkws/cli --version           # or run it once without installing (Node 18+)
export WATERMARK_API_KEY=wm_test_…       # keys: https://watermark.ws/developers
```

`wm_test_…` keys are free and return real results within small limits (10 requests a minute, 100 a day, sources up to 10 MB, no video). `wm_live_…` keys spend the account's prepaid credit. If the user has no key, send them to https://watermark.ws/developers; new accounts start with $1 of free credit.

## Core commands

A `<source>` is a public http(s) URL, a local file path (uploaded first, automatically), an upload id `upl_…`, a file an earlier request made `file_…`, or `stg_7a:path/key` in a connected bucket. Operations run in the order given: `--op type:param=value,param=value`; numbers and `true`/`false` are typed, everything else is text.

```bash
watermark image process photo.jpg --op resize:width=1600,height=1600 --op watermark:image_url=https://example.com/logo.png,x=40,y=40 --format webp --out photo.webp
watermark image read photo.jpg --json                       # width, height, format; add --level for the angle that levels the horizon
watermark image create --width 1200 --height 300 --op 'text:text=Lena Hart,font=inter-bold,size=96,color=#202020,position=center' --op trim --format png --out logo.png
watermark video process clip.mp4 --op watermark:image_url=https://example.com/logo.png,x=24,y=24 --max-duration 30 --out preview.mp4
watermark video screenshot clip.mp4 --seconds 5 --format png --out frame.png
watermark document process contract.pdf --op watermark:image_url=https://example.com/stamp.png,x=20,y=230 --out contract-stamped.pdf
watermark document snapshot contract.pdf --page 1 --format png --out page-1.png
watermark operations image                                   # every operation and parameter, live from the API (also video, document)
watermark fonts                                              # font names a text operation accepts
watermark request get 1234                                   # follow a request started with --no-wait
watermark account                                            # balance and limits
```

Useful options on processing commands: `--out <file>` (wait, then download), `--no-wait` (print the queued request and return), `--timeout <seconds>` (default 300), `--format <fmt>`, `--ops-json '[…]'` instead of `--op`, `--max-duration <s>` (video), `--max-pages <n>` (documents), `--customer <id>`, `--metadata key=value`, `--json`.

Operations that exist: images `resize`, `crop`, `rotate`, `flip`, `grayscale`, `border`, `watermark`, `thumbnail`, `compress`, `sepia`, `exposure`, `filter`, `remove_background`, `orient`, `text`, `trim`, `color`, `frame`, `protect`, `shave`, `line`, `adjust`, `color_profile`; videos `resize`, `crop`, `rotate`, `flip`, `grayscale`, `border`, `watermark`; documents `watermark` only (an image on every page; make a text stamp with `image create` first). `watermark` takes `image_url` or `image` (a `file_…` id), `x`, `y` from the top left, `tile_spacing_x`/`tile_spacing_y` to repeat it, `diagonal_lines_color`/`diagonal_lines_opacity`. Run `watermark operations image` before using a parameter you are not sure of.

## A folder of files

Prepare the watermark once and reuse its `file_…` id; one request per file after that.

```bash
logo=$(watermark image process logo.png --op orient --format png --json | jq -r '.result.files[0].id')
mkdir -p out
for f in photos/*; do
  name=$(basename "${f%.*}")
  watermark image process "$f" --op resize:width=1600,height=1600 --op "watermark:image=$logo,x=40,y=40" --format webp --out "out/$name.webp"
done
```

Stamp text across every page of a PDF: make the stamp, then watermark the document with it.

```bash
stamp=$(watermark image create --width 800 --height 800 --op 'text:text=CONFIDENTIAL,font=inter-bold,size=80,color=#c0392b,opacity=35,position=center,rotation=-30' --op trim --format png --json | jq -r '.result.files[0].id')
watermark document process contract.pdf --op "watermark:image=$stamp,x=20,y=230" --out contract-confidential.pdf
```

## Output and exit codes

With `--json`, stdout is only the finished request as the API returns it (progress goes to stderr):

```json
{"id": 1234, "object": "request", "endpoint": "images/process", "status": "succeeded",
 "result": {"data": {"width": 1600, "height": 1067, "format": "WEBP"},
            "files": [{"id": "file_…", "url": "https://…", "url_expires_at": "2026-10-18T15:00:04Z", "format": "webp", "size": 183021}]},
 "price": {"amount": "0.002000", "currency": "usd"}, "saved_to": "photo.webp"}
```

A failed request has `"status": "failed"` and `error.code` / `error.message`. An API error with `--json` prints `{"error": {"status": 422, "type": "…", "code": "…", "message": "…", "errors": {…}}}` on stdout. Without `--json`, the result is human-readable lines (`Request 1234 (images/process): succeeded`, `File: https://…`, `Saved to …`, `Price: $0.002000`).

| Exit | Meaning |
| --- | --- |
| 0 | The request succeeded (or was queued, with `--no-wait`). |
| 1 | The API refused the call, or the request failed or was aborted. The error code is printed. |
| 2 | The command was used wrongly (bad source, missing `--op`, unknown command). |

## Rules

- Never paste file contents or base64 into a command; give the path and the CLI uploads it. Never ask the user to host a local file first.
- Credit is prepaid and every finished request is charged ($0.002 an image, $0.004 a document page, $0.02 a started minute of video). Before more than about 20 files, a video over about 10 minutes, or a document with hundreds of pages, tell the user the cost and ask.
- Failed and aborted requests are free; fix the cause (the message names the field) and run again. Rate limits and server errors are retried by the CLI itself.
- Always pass `--out` when the user wants the file, and `--json` when a script reads the result. Download links in `result.files[].url` last 7 days; `watermark file get <file_id>` gives a fresh one while the file is kept.
- Video needs a live key on an account that has bought credit; a test key gets `402 paid_account_required`.
- Check a file before guessing parameters: `watermark image read`, `watermark video read` and `watermark document read` give dimensions, duration and page count.

## Common errors

| Error | Fix |
| --- | --- |
| `Set WATERMARK_API_KEY or pass --api-key`, `401 missing_api_key`, `401 invalid_api_key` | No key, or a wrong or revoked key. Export `WATERMARK_API_KEY` from https://watermark.ws/developers. |
| `402 insufficient_credits` | The account has no credit left. Buy credit at https://watermark.ws/developers. |
| `402 paid_account_required` | Video, or writing to your own storage, needs an account that has bought credit; a test key cannot. |
| `422 validation_failed` | A parameter is wrong; the invalid fields are listed under the message. Check `watermark operations <media>`. |
| `429 rate_limited` / `429 concurrency_limited` | Too many requests a minute, or too many running at once. The CLI retries twice; otherwise wait and run fewer in parallel. |
| `is not a URL, an id, stg_…:key, or a file here` | The source path does not exist or is not a file. |
| `Request … was still processing after 300 seconds` | A long video. Rerun with `--timeout 1800`, or `--no-wait` and later `watermark request get <id>`. |

## More

- Agent guide, with MCP server, HTTP and worked examples: https://api.watermark.ws/docs/agents.md
- Every operation and parameter: https://api.watermark.ws/docs/operations.md
- Every command and option: `watermark --help`, or https://api.watermark.ws/docs/cli.md
