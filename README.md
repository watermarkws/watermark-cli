# Watermark CLI

Watermark, resize and convert images, videos and PDFs from the command line with the [Watermark API](https://api.watermark.ws/docs). Built for people and for AI agents: `--json` prints machine-readable output and exit codes mean something.

```bash
export WATERMARK_API_KEY=wm_test_…   # https://watermark.ws/developers
npx @watermarkws/cli image process https://example.com/photo.jpg \
  --op resize:width=1600,height=1600 \
  --op watermark:image_url=https://example.com/logo.png,x=40,y=40 \
  --format webp --out photo.webp
```

Node 18+, no dependencies.

## Install

```bash
brew install watermarkws/tap/watermark   # Homebrew, macOS and Linux
npm install -g @watermarkws/cli          # npm
```

Either way the command is `watermark`. Homebrew brings its own Node; `npx @watermarkws/cli` runs it without installing.

## Commands

```
watermark image process <source> --op <operation> [--op ...] [--format webp] [--out file]
watermark image read <source> [--level]   # --level also finds the angle that levels a tilted horizon
watermark image create --width 1200 --height 300 --op 'text:text=Hi,font=inter-bold,size=96' --op trim --out logo.png
watermark video process <source> --op <operation> [--max-duration 30] [--out file]
watermark video read <source> | watermark video screenshot <source> --seconds 5
watermark document process <source> --op <operation> [--max-pages 10] [--out file]
watermark document read <source> | watermark document snapshot <source> --page 1
watermark preview <source> [--media image|video|document] [--at 5] [--page 0] [--width 1024] [--design <dsn_id>] [--op ...] [--out preview.webp]
watermark batch create <source> [<source> ...] [--media image|video|document] [--design <dsn_id>] [--op ...] [--format webp] [--zip|--no-zip] [--destination stg_7a:done/] [--max-duration 30] [--max-pages 10] [--out dir]
watermark batch get <id> [--wait] | watermark batch requests <id> [--status failed] [--after <position>] [--limit 50] | watermark batch retry <id> | watermark batch abort <id>
watermark batches [--limit 20] [--before <id>] [--status failed]
watermark design create --name <name> [--media image|video|document|any] --op <operation> [--op ...]
watermark design update <dsn_id> [--name <name>] [--media <media>] [--op ...] | watermark design get|delete <dsn_id> | watermark designs [--limit 20] [--before <dsn_id>]
watermark request get <id> [--wait] | watermark request abort <id>
watermark requests [--before <id>] | watermark account | watermark usage --group-by endpoint [--customer <id>]
watermark upload photo.heic | watermark upload get|delete <upl_id>
watermark file get|delete <file_id>
watermark storage list | connect --bucket b --region us-east-1 --role-arn <arn> --prefix in/ [--read true|false] [--write true|false] | get|verify|disconnect <stg_id>
watermark storage update <stg_id> --prefix photos/ --prefix archive/ [--read true|false] [--write true|false]   # the whole new list; checked before it is kept
watermark events --since 2026-10-13T15:00:00Z
watermark fonts
watermark operations image
```

Processing commands wait for the request to finish (up to `--timeout`, default 300 seconds) unless `--no-wait` is given; `--out` downloads the result.

Operations run in order: `--op type:param=value,param=value`, or all at once with `--ops-json '[{"type":"resize","width":800,"height":600}]'`. `watermark operations` lists them all. A `watermark` operation is placed by `anchor`, `margin` and `size` as percentages of the file (`anchor=bottom_right,margin=3%,size=18%`), which lands the same on every size of file, or by `x` and `y` in pixels; percentages pass through as text.

`--design <dsn_id>` runs a saved design's operations first, on `process`, `create`, `preview` and `batch create`; `--op` is then optional. `watermark design create` keeps an operations list, and the logo it names, under a name on the account.

`watermark preview` makes one small WebP of what the operations do to a file (a frame of a video with `--at`, a page of a document with `--page`), usually within the call.

`watermark batch create` runs the same operations on many files in one call. A source that is a local file or folder is uploaded first (a folder means every file in it, sorted; four uploads at a time), `stg_7a:folder/` means every object under that prefix, and URLs and ids pass through. The command waits (up to `--timeout`, default 3600 seconds for a batch) and prints the counts as they move; `--out <dir>` asks for the results as zips (`--zip`) and downloads them into that directory; `--destination stg_7a:done/` writes each file into your bucket instead. With `--no-wait` the accepted batch is printed with `price.estimate_micro_usd`, and `watermark batch get <id> --wait` follows it later. `watermark batch requests <id> --status failed` lists the files that failed; `watermark batch retry <id>` runs them again.

More than one file from a request, each with its own operations and format: `--outputs-json '[{"name":"large","format":"webp"},{"name":"thumb","operations":[{"type":"resize","width":200,"height":200}]}]'`.

Other options: `--webhook <url>`, `--event <type>` (repeatable, such as `request.progress` or `batch.progress`), `--request-event <type>` (for a batch: the `request.*` events to post for each file), `--customer <id>`, `--metadata key=value`, `--idempotency-key <key>`, `--json`, `--api-key`, `--base-url` (or `WATERMARK_API_URL`).

A source is a public http(s) URL, a local file (uploaded first), an upload
(`upl_…`), a file an earlier request kept (`file_…`), or an object in a
connected bucket (`stg_7a:path/to/key`). A batch also takes a local folder and
`stg_7a:folder/` (every object under the prefix; note the trailing slash).

## Errors

The CLI passes every error code through as the API sends it: `Error 422 validation_failed: …`, with every invalid field below it, or with `--json` the whole error object (`type`, `code`, `message`, `param`, `request_id`, `errors`, and the `permissions_policy` a storage change whose check failed needs). The codes are listed at https://api.watermark.ws/docs/errors.md. Batches and designs add these:

- `batch_too_large` (422): more files than the account's `batch_max_files`, a listed prefix included.
- `empty_source_list` (422): the sources named no file.
- `batch_not_found` (404): no such batch on the account.
- `batch_not_finished` (409): a retry of a batch that is still running.
- `nothing_to_retry` (409): a retry of a batch with no failed file.
- `batch_finished` (409): an abort of a batch that is already done.
- `design_not_found` (404): no such design on the account, or it was deleted.
- `design_media_mismatch` (422): a design made for another media.
- `too_many_designs` (422): the account already keeps `max_designs`.
- `upload_in_use` (409): an upload a request or design has already taken.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Succeeded, or every file of the batch did (or queued, with `--no-wait`). |
| 1 | The API refused the call, or the request or batch failed or was aborted, or the batch finished `partial`. The error code is printed. |
| 2 | The command was used wrongly. |

Rate limits (429) and server errors are retried twice with the same `Idempotency-Key`, so a retry never runs a request twice.

## For AI agents

`SKILL.md` is an [Agent Skill](https://agentskills.io) for this CLI: when to use it, the commands, the output shape, exit codes and the rules an agent should follow (ask before a big batch, never paste file bytes). Save it as `.claude/skills/watermark/SKILL.md` in a project for Claude Code, or paste it into any agent's instructions. The API's own guide for agents, with its MCP server and plain HTTP, is at https://api.watermark.ws/docs/agents.md.

## Development

```bash
npm test
```

`test/spec-coverage.test.js` holds the CLI to the API's OpenAPI spec: every endpoint has a command, every parameter is sent, and the spec is the one in `spec/openapi.json`, whose sha256 is in `spec.sha`. It reads the spec from `WATERMARK_API_SPEC` (a path or URL), else `../watermark-api`, else `spec/openapi.json`. When the API changes, update the CLI, then run `npm run spec:refresh` to record the new spec as checked.
