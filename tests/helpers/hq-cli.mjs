// Locate an hq-cli package with a built dist/ for the tests that drive hq-cli's
// real install and publish code.
//
// Order: $HQ_CLI_DIR (an installed package or a built checkout), then the
// global npm root. CI installs the oldest supported hq-cli with
// scripts/install-test-hq-cli.sh and exports HQ_CLI_DIR. There is no skip:
// when no hq-cli is found the tests fail and say how to provide one.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

let cached;

export function hqCliDir() {
  if (cached) return cached;
  const candidates = [];
  if (process.env.HQ_CLI_DIR) candidates.push(process.env.HQ_CLI_DIR);
  else {
    try {
      const root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (root) candidates.push(path.join(root, '@indigoai-us', 'hq-cli'));
    } catch {
      // fall through to the error below
    }
  }
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'dist', 'commands', 'pack-install.js'))) {
      cached = path.resolve(c);
      return cached;
    }
  }
  throw new Error(
    `no hq-cli with dist/commands/pack-install.js found (looked in: ${candidates.join(', ') || 'nothing'}). ` +
      'Run `bash scripts/install-test-hq-cli.sh /tmp/hq-cli` and export the HQ_CLI_DIR it prints, ' +
      'or set HQ_CLI_DIR to a built hq-cli checkout.',
  );
}

export function importHqCli(relFromDist) {
  return import(pathToFileURL(path.join(hqCliDir(), 'dist', relFromDist)).href);
}

export function requireFromHqCli(mod) {
  return createRequire(path.join(hqCliDir(), 'package.json'))(mod);
}

export function hqCliVersion() {
  return JSON.parse(fs.readFileSync(path.join(hqCliDir(), 'package.json'), 'utf8')).version;
}
