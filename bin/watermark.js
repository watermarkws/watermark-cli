#!/usr/bin/env node
import { main } from '../src/cli.js';

main(process.argv.slice(2), { env: process.env, stdout: process.stdout, stderr: process.stderr })
  .then((code) => { process.exitCode = code; });
