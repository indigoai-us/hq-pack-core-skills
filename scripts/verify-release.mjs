#!/usr/bin/env node
// verify-release.mjs — check a published release end to end. No dependencies.
//
//   node scripts/verify-release.mjs <version> [options]
//
// Checks (see scripts/lib/release-verify.mjs for the exact rules):
//   1. npm: the per-version document for @indigoai-us/hq-pack-core-skills@<version>
//      exists and carries dist.attestations.
//   2. GitHub release v<version>: the tarball asset's sha256 equals its line
//      in the SHA256SUMS asset.
//   3. Marketplace: an approved listing for slug core-skills at <version>
//      (GET /v1/listings?slug=&q=&version=, then GET /v1/listings/{id}, the
//      calls hq-cli makes) has signingKeyId mkt-sign-v1 and an Ed25519
//      signature over its hex contentHash that verifies with the public key
//      pinned in this repo (copied from hq-cli src/lib/pack-signing-keys.ts).
//   4. The listing tarball's sha256 equals contentHash, and its content equals
//      the GitHub release tarball (identical bytes, or identical files with
//      package.yaml equal apart from the `author` key that `hq publish` adds).
//
// Options:
//   --release-tarball <path>  use a local release tarball instead of the asset
//   --sums <path>             use a local SHA256SUMS instead of the asset
//   --npm-only                run check 1 only (the release workflow uses this)
//   --skip-npm                skip check 1
//   --npm-view                also run `npm view <pkg>@<version> version
//                             dist.attestations --json` as part of check 1
//   --wait <seconds>          with --npm-only: retry every 15s until it passes
//                             or the time is up
//   --api <url>               marketplace API base (default $HQ_VAULT_API_URL
//                             or https://hqapi.hq.computer)
//   --registry <url>          npm registry (default https://registry.npmjs.org)
//
// Exit 0 every check passed · 1 a check failed · 2 bad usage.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_API_BASE, DEFAULT_REGISTRY, PACKAGE_NAME, verifyRelease } from './lib/release-verify.mjs';

function usage(msg) {
  process.stderr.write(`verify-release: ${msg}\nusage: verify-release.mjs <version> [--release-tarball <path>] [--sums <path>] [--npm-only] [--skip-npm] [--npm-view] [--wait <s>] [--api <url>] [--registry <url>]\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const opts = {
    apiBase: process.env.HQ_VAULT_API_URL || DEFAULT_API_BASE,
    registry: DEFAULT_REGISTRY,
    waitSeconds: 0,
  };
  const need = (i, flag) => {
    if (i >= argv.length || argv[i].startsWith('--')) usage(`${flag} needs a value`);
    return argv[i];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--release-tarball') opts.releaseTarball = need(++i, a);
    else if (a === '--sums') opts.sums = need(++i, a);
    else if (a === '--npm-only') opts.npmOnly = true;
    else if (a === '--skip-npm') opts.skipNpm = true;
    else if (a === '--npm-view') opts.npmView = true;
    else if (a === '--wait') opts.waitSeconds = Number(need(++i, a));
    else if (a === '--api') opts.apiBase = need(++i, a);
    else if (a === '--registry') opts.registry = need(++i, a);
    else if (a === '-h' || a === '--help') {
      process.stdout.write(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 34).map((l) => l.replace(/^\/\/ ?/, '')).join('\n') + '\n');
      process.exit(0);
    } else if (a.startsWith('-')) usage(`unknown option ${a}`);
    else if (opts.version) usage(`unexpected argument ${a}`);
    else opts.version = a.replace(/^v/, '');
  }
  if (!opts.version) usage('a version is required');
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(opts.version)) usage(`"${opts.version}" is not a semver version`);
  if (opts.npmOnly && opts.skipNpm) usage('--npm-only and --skip-npm are exclusive');
  if (opts.npmView && opts.skipNpm) usage('--npm-view and --skip-npm are exclusive');
  if (!Number.isFinite(opts.waitSeconds) || opts.waitSeconds < 0) usage('--wait needs a number of seconds');
  if (opts.waitSeconds && !opts.npmOnly) usage('--wait is only valid with --npm-only');
  if (Boolean(opts.releaseTarball) !== Boolean(opts.sums)) usage('--release-tarball and --sums go together');
  return opts;
}

async function request(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000), redirect: 'follow' });
  return res;
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-release-'));
process.on('exit', () => fs.rmSync(scratch, { recursive: true, force: true }));
let extractCount = 0;

const deps = {
  fetchJson: async (url) => {
    const res = await request(url);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GET ${redact(url)} answered HTTP ${res.status}`);
    return res.json();
  },
  fetchText: async (url) => {
    const res = await request(url);
    if (!res.ok) throw new Error(`GET ${redact(url)} answered HTTP ${res.status}`);
    return res.text();
  },
  fetchBytes: async (url) => {
    const res = await request(url);
    if (!res.ok) throw new Error(`GET ${redact(url)} answered HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  },
  readFile: (p) => fs.readFileSync(p),
  npmView: (version) => {
    try {
      return execFileSync('npm', ['view', `${PACKAGE_NAME}@${version}`, 'version', 'dist.attestations', '--json'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      // npm view exits non-zero on E404 and prints the error JSON on stdout.
      if (typeof e.stdout === 'string' && e.stdout.trim()) return e.stdout;
      throw new Error(`npm view exited ${e.status ?? 'with an error'}`);
    }
  },
  // Called only after the listing signature and hash have been checked.
  extract: (bytes) => {
    const n = ++extractCount;
    const file = path.join(scratch, `t${n}.tar.gz`);
    const dir = path.join(scratch, `x${n}`);
    fs.writeFileSync(file, bytes);
    const entries = execFileSync('tar', ['-tzf', file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n');
    for (const e of entries) {
      if (e.startsWith('/') || e.split('/').includes('..')) throw new Error(`tarball entry escapes its root: ${e}`);
    }
    fs.mkdirSync(dir);
    execFileSync('tar', ['-xzf', file, '-C', dir], { stdio: ['ignore', 'ignore', 'pipe'] });
    return dir;
  },
};

// Presigned S3 URLs carry credentials in the query string; never print them.
function redact(url) {
  return String(url).replace(/\?.*$/, '?<redacted>');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const deadline = Date.now() + opts.waitSeconds * 1000;
  let result;
  for (;;) {
    result = await verifyRelease(opts, deps);
    if (!result.errors.length || Date.now() >= deadline) break;
    process.stderr.write(`verify-release: not yet (${result.errors[0]}); retrying in 15s\n`);
    await new Promise((r) => setTimeout(r, Math.min(15_000, Math.max(0, deadline - Date.now()))));
  }
  for (const n of result.notes) process.stdout.write(`ok   ${n}\n`);
  for (const e of result.errors) process.stderr.write(`FAIL ${e}\n`);
  if (result.errors.length) {
    process.stderr.write(`verify-release: ${result.errors.length} check(s) failed for ${opts.version}\n`);
    process.exit(1);
  }
  process.stdout.write(`verify-release: ${opts.version} passed${opts.npmOnly ? ' (npm only)' : ''}\n`);
}

main().catch((e) => {
  process.stderr.write(`verify-release: ${e.message}\n`);
  process.exit(1);
});
