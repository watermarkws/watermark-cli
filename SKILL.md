---
name: watermark
description: Watermark, resize, crop, convert and stamp text on images, videos and PDF or Word documents with the Watermark API from the shell, through the `watermark` CLI. Use it when a user wants a logo or text placed on files, a folder of photos resized or converted in one batch (JPEG, PNG, WebP, HEIC, camera RAW and more), a video watermarked or trimmed to a preview, a frame or a page saved as an image, every page of a PDF stamped while it stays a PDF, a quick preview of a layout before the run, or a watermark layout kept as a reusable design. Sources can be public URLs, local files and folders (uploaded automatically) or files an earlier request made. Needs a WATERMARK_API_KEY from https://watermark.ws/developers.
---

# Watermark CLI

The `watermark` command sends a file and a list of operations to the Watermark API, waits for the result and downloads it. Use it instead of a local image library for batches, video, PDF/DOCX, camera formats (HEIC, CR3, NEF, ARW, DNG), text in real fonts, and when the result should be a link the user can download. A folder of files is one `watermark batch create` command.

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
watermark preview photo.jpg --op 'watermark:image_url=https://example.com/logo.png,anchor=bottom_right,margin=3%,size=18%,opacity=60' --out preview.webp   # a small WebP of what the operations do, before the real run ($0.0005)
watermark design create --name "Corner logo" --op 'watermark:image_url=https://example.com/logo.png,anchor=bottom_right,margin=3%,size=18%,opacity=60' --json | jq -r .id   # keep a layout; then --design dsn_… on any command
watermark designs                                            # the saved designs and their dsn_… ids
watermark operations image                                   # every operation and parameter, live from the API (also video, document)
watermark fonts                                              # font names a text operation accepts
watermark request get 1234                                   # follow a request started with --no-wait
watermark account                                            # balance and limits
```

Useful options on processing commands: `--design <dsn_id>` (a saved design's operations run first; `--op` is then optional), `--out <file>` (wait, then download), `--no-wait` (print the queued request and return), `--timeout <seconds>` (default 300), `--format <fmt>`, `--ops-json '[…]'` instead of `--op`, `--max-duration <s>` (video), `--max-pages <n>` (documents), `--customer <id>`, `--metadata key=value`, `--json`.

Operations that exist: images `resize`, `crop`, `rotate`, `flip`, `grayscale`, `border`, `watermark`, `thumbnail`, `compress`, `sepia`, `exposure`, `filter`, `remove_background`, `orient`, `text`, `trim`, `color`, `frame`, `protect`, `shave`, `line`, `adjust`, `color_profile`; videos `resize`, `crop`, `rotate`, `flip`, `grayscale`, `border`, `watermark`; documents `watermark` only (an image on every page; make a text stamp with `image create` first). `watermark` takes `image_url` or `image` (a `file_…` or `upl_…` id) and a place: prefer `anchor` (`top_left`, `top`, `top_right`, `left`, `center`, `right`, `bottom_left`, `bottom`, `bottom_right`) with `margin` and `size` as percentages of the file (`margin=3%,size=18%`), which lands the same on every size of file, over `x`, `y` in pixels from the top left; also `opacity` (0-100), `rotation` (degrees), `tile_spacing` (repeat it across the file, pixels or `25%`), `diagonal_lines_color`/`diagonal_lines_opacity`. A `text` operation takes `size` and `margin` as percentages too. Run `watermark operations image` before using a parameter you are not sure of.

## A folder of files

One batch: the folder's files are uploaded (four at a time), the API runs the same operations on every one, the command waits and, with `--out <dir>`, downloads the results as zips into that directory. Sources can also be URLs, `upl_…`/`file_…` ids and `stg_7a:folder/` (every object under that prefix of a connected bucket).

```bash
watermark batch create ./photos --op resize:width=1600,height=1600 --op 'watermark:image_url=https://example.com/logo.png,anchor=bottom_right,margin=3%,size=18%,opacity=60' --format webp --out ./out
```

To see the price before anything runs, add `--no-wait --json`: the accepted batch comes back with `price.estimate_micro_usd` (the whole batch, in millionths of a dollar) and nothing has been charged yet; follow it later with `watermark batch get <id> --wait`, or abort it with `watermark batch abort <id>`. A batch that finishes `partial` had failed files: `watermark batch requests <id> --status failed` lists them with the reason, and `watermark batch retry <id>` runs them again once the cause is fixed. Use `--design dsn_…` instead of repeating the watermark `--op`, `--media video|document` for anything but images, and `--destination stg_7a:done/` to write the files into the user's own bucket instead of zips.

Stamp text across every page of a PDF: make the stamp, then watermark the document with it.

```bash
stamp=$(watermark image create --width 800 --height 800 --op 'text:text=CONFIDENTIAL,font=inter-bold,size=80,color=#c0392b,opacity=35,position=center,rotation=-30' --op trim --format png --json | jq -r '.result.files[0].id')
watermark document process contract.pdf --op "watermark:image=$stamp,x=20,y=230" --out contract-confidential.pdf
```

## Output and exit codes

With `--json`, stdout is only the finished request (or batch, or design) as the API returns it; progress goes to stderr:

```json
{"id": 1234, "object": "request", "endpoint": "images/process", "status": "succeeded",
 "result": {"data": {"width": 1600, "height": 1067, "format": "WEBP"},
            "files": [{"id": "file_…", "url": "https://…", "url_expires_at": "2026-10-18T15:00:04Z", "format": "webp", "size": 183021}]},
 "price": {"amount": "0.002000", "currency": "usd"}, "saved_to": "photo.webp"}
```

A batch prints `{"id": 42, "object": "batch", "status": "succeeded", "counts": {"total": 240, "succeeded": 240, "failed": 0, …}, "zips": [{"url": "https://…", "files": 240, …}], "price": {…}, "saved_to": ["out/batch-42-1.zip"]}`; its statuses are `queued`, `processing`, `zipping`, `succeeded`, `partial`, `failed` and `aborted`. A failed request has `"status": "failed"` and `error.code` / `error.message`. An API error with `--json` prints `{"error": {"status": 422, "type": "…", "code": "…", "message": "…", "errors": {…}}}` on stdout. Without `--json`, the result is human-readable lines (`Request 1234 (images/process): succeeded`, `File: https://…`, `Saved to …`, `Price: $0.002000`).

| Exit | Meaning |
| --- | --- |
| 0 | The request succeeded, or every file of the batch did (or it was queued, with `--no-wait`). |
| 1 | The API refused the call, or the request or batch failed or was aborted, or the batch finished `partial`. The error code, or the failed count, is printed. |
| 2 | The command was used wrongly (bad source, missing `--op`, unknown command). |

## Rules

- Never paste file contents or base64 into a command; give the path and the CLI uploads it. Never ask the user to host a local file first.
- Credit is prepaid and every finished request is charged ($0.002 an image, $0.004 a document page, $0.02 a started minute of video; a preview $0.0005). Before a batch of more than about 200 files, more than about 20 files one request each, a video over about 10 minutes, or a document with hundreds of pages, tell the user the cost and ask. A batch's `price.estimate_micro_usd` (with `--no-wait --json`) is the exact figure to quote.
- More than a few files with the same operations are one `watermark batch create`, not a loop of single requests: one call, one price up front, paced by the account, and the failed ones listed for one `batch retry`.
- Place a watermark by `anchor`, `margin` and `size` as percentages, not pixels, unless the user gave exact numbers; `watermark preview` shows where it lands before a batch gets it.
- Failed and aborted requests are free; fix the cause (the message names the field) and run again. Rate limits and server errors are retried by the CLI itself.
- Always pass `--out` when the user wants the file, and `--json` when a script reads the result. Download links in `result.files[].url` last 7 days; `watermark file get <file_id>` gives a fresh one while the file is kept.
- Video needs a live key on an account that has bought credit; a test key gets `402 paid_account_required`. A test key's batches hold up to 20 files; a free account's 100.
- Check a file before guessing parameters: `watermark image read`, `watermark video read` and `watermark document read` give dimensions, duration and page count.

## Common errors

| Error | Fix |
| --- | --- |
| `Set WATERMARK_API_KEY or pass --api-key`, `401 missing_api_key`, `401 invalid_api_key` | No key, or a wrong or revoked key. Export `WATERMARK_API_KEY` from https://watermark.ws/developers. |
| `402 insufficient_credits` | The account has no credit left. Buy credit at https://watermark.ws/developers. |
| `402 paid_account_required` | Video, or writing to your own storage, needs an account that has bought credit; a test key cannot. |
| `422 validation_failed` | A parameter is wrong; the invalid fields are listed under the message. Check `watermark operations <media>`. |
| `422 batch_too_large` / `422 empty_source_list` | More files than the account's batch limit, or a folder or prefix with no files in it. Split the batch, or check the source. |
| `409 batch_not_finished` / `409 nothing_to_retry` / `409 batch_finished` | A retry before the batch finished, a retry with no failed file, or an abort of a finished batch. |
| `404 design_not_found` / `422 design_media_mismatch` / `422 too_many_designs` | No such design (see `watermark designs`), a design made for another media, or the account's design limit; delete one. |
| `429 rate_limited` / `429 concurrency_limited` | Too many requests a minute, or too many running at once. The CLI retries twice; otherwise wait and run fewer in parallel. |
| `is not a URL, an id, stg_…:key, or a file here` | The source path does not exist or is not a file. |
| `Request … was still processing after 300 seconds` | A long video. Rerun with `--timeout 1800`, or `--no-wait` and later `watermark request get <id> --wait`. |
| `Batch … was still processing after 3600 seconds` | A big batch. `watermark batch get <id> --wait` carries on waiting; nothing was lost. |

## More

- Agent guide, with MCP server, HTTP and worked examples: https://api.watermark.ws/docs/agents.md
- Batches, and designs and layout: https://api.watermark.ws/docs/batches.md, https://api.watermark.ws/docs/designs.md
- Every operation and parameter: https://api.watermark.ws/docs/operations.md
- Every command and option: `watermark --help`, or https://api.watermark.ws/docs/cli.md
