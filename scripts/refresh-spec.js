// Record the API's current OpenAPI spec as the one this CLI is checked
// against: copy it to spec/openapi.json and write its sha256 to spec.sha.
// Run it only after the CLI has been updated for the spec.
//
// The spec comes from WATERMARK_API_SPEC (a path or URL), else the API
// checkout next to this one.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const source = process.env.WATERMARK_API_SPEC || join(root, '..', 'watermark-api', 'resources', 'docs', 'build', 'openapi.json');

let bytes;
try {
  bytes = /^https?:\/\//.test(source) ? Buffer.from(await (await fetch(source)).arrayBuffer()) : readFileSync(source);
} catch (error) {
  console.error(`Cannot read ${source}: ${error.message}. Set WATERMARK_API_SPEC to the API's openapi.json (a path or a URL).`);
  process.exit(1);
}

let spec;
try {
  spec = JSON.parse(bytes.toString('utf8'));
} catch {
  spec = null;
}
if (!spec?.openapi || !spec?.paths) {
  console.error(`${source} is not an OpenAPI spec.`);
  process.exit(1);
}

const sha = createHash('sha256').update(bytes).digest('hex');
mkdirSync(join(root, 'spec'), { recursive: true });
writeFileSync(join(root, 'spec', 'openapi.json'), bytes);
writeFileSync(join(root, 'spec.sha'), `${sha}\n`);
console.log(`spec/openapi.json and spec.sha now record ${source} (sha256 ${sha}).`);
