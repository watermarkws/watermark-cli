import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseArgs, parseOperation } from '../src/cli.js';

// Every `watermark …` line in SKILL.md's code blocks must be a command the CLI
// takes: a known command and action, options the CLI reads, and operations
// that parse. An agent copies these lines as they are.

const skill = await readFile(new URL('../SKILL.md', import.meta.url), 'utf8');
const source = await readFile(new URL('../src/cli.js', import.meta.url), 'utf8');

const COMMANDS = {
  image: ['process', 'read', 'create'],
  video: ['process', 'read', 'screenshot'],
  document: ['process', 'read', 'snapshot'],
  request: ['get', 'abort'],
  upload: null,
  file: ['get', 'delete'],
  storage: ['list', 'connect', 'update', 'get', 'verify', 'disconnect'],
  preview: null,
  batch: ['create', 'get', 'requests', 'retry', 'abort'],
  batches: [],
  template: ['create', 'update', 'get', 'delete'],
  templates: [],
  operations: ['image', 'video', 'document'],
  requests: [],
  account: [],
  usage: [],
  events: [],
  fonts: [],
};

// The option names the CLI reads: options.name, options['long-name'] and
// every --flag its help and usage strings mention.
const knownOptions = new Set();
for (const match of source.matchAll(/options(?:\.([a-z]\w*)|\['([a-z][\w-]*)'\])/g)) knownOptions.add(match[1] || match[2]);
for (const match of source.matchAll(/--([a-z][a-z-]*)/g)) knownOptions.add(match[1]);

// The watermark command lines in fenced code blocks, continuation lines
// joined, a `name=$(` prefix and anything piped after the command dropped.
function commandLines(markdown) {
  const lines = [];
  for (const block of markdown.matchAll(/```(?:bash|sh|console)\n([\s\S]*?)```/g)) {
    const joined = block[1].replace(/\\\n\s*/g, ' ');
    for (const raw of joined.split('\n')) {
      const line = raw.trim().replace(/^\$ /, '').replace(/^\w+=\$\(/, '').replace(/\)$/, '');
      if (!line.startsWith('watermark ')) continue;
      lines.push(line.replace(/\s+#.*$/, ''));
    }
  }
  return lines;
}

// A shell line as argv: single and double quotes group, a backslash escapes,
// and an unquoted | ends the command.
function tokenize(line) {
  const tokens = [];
  let current = '';
  let quote = null;
  let started = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; started = true; continue; }
    if (char === '\\') { current += line[++i]; started = true; continue; }
    if (char === '|') break;
    if (/\s/.test(char)) {
      if (started) tokens.push(current);
      current = '';
      started = false;
      continue;
    }
    current += char;
    started = true;
  }
  if (started) tokens.push(current);
  assert.equal(quote, null, `Unclosed quote in: ${line}`);
  return tokens;
}

const lines = commandLines(skill);

test('SKILL.md has command lines to check', () => {
  assert.ok(lines.length >= 15, `Found ${lines.length} watermark lines`);
});

for (const line of lines) {
  test(`SKILL.md command parses: ${line.slice(0, 80)}`, () => {
    const argv = tokenize(line).slice(1);
    const { positionals, options } = parseArgs(argv);

    const [command, action] = positionals;
    if (command === undefined) {
      assert.ok(options.version || options.help, line);
      return;
    }
    assert.ok(command in COMMANDS, `Unknown command "${command}"`);
    const actions = COMMANDS[command];
    if (actions === null) {
      assert.ok(action, `${command} needs a file or a source`);
    } else if (actions.length) {
      assert.ok(actions.includes(action), `"${command}" takes ${actions.join('|')}, not "${action}"`);
    }
    if (['process', 'read', 'screenshot', 'snapshot'].includes(action) && command in { image: 1, video: 1, document: 1 }) {
      assert.ok(positionals[2], 'needs a source');
    }
    if (action === 'process' || command === 'preview' || (command === 'batch' && action === 'create')) {
      assert.ok(options.op.length || options['ops-json'] || options.template, `${command} ${action} needs --op, --ops-json or --template`);
    }
    if (command === 'image' && action === 'create') {
      assert.ok(options.width && options.height, 'create needs --width and --height');
    }
    if (command === 'batch' && action === 'create') assert.ok(positionals[2], 'batch create needs a source');
    if (command === 'template' && action === 'create') assert.ok(options.name && options.op.length, 'template create needs --name and --op');
    if (action === 'screenshot') assert.ok(options.seconds, 'screenshot needs --seconds');

    for (const name of Object.keys(options)) {
      assert.ok(knownOptions.has(name), `Unknown option --${name}`);
    }
    for (const op of options.op) {
      const operation = parseOperation(op);
      assert.match(operation.type, /^[a-z_]+$/);
    }
  });
}
