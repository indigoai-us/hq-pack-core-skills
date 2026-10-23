#!/usr/bin/env node
// check-npm-contents.mjs — compare the npm package file list with the
// marketplace tarball built by scripts/build-tarball.sh.
//
// The two artifacts come from the same commit but are packed by different
// tools. `npm pack` always leaves out .gitignore files (and adds
// package.json), so the npm package cannot carry skills/run-project/.gitignore.
// hq-cli installs the pack from the marketplace tarball, which keeps it; npm
// carries the version list, engines and provenance. This check makes the
// difference explicit and fails on anything else:
//
//   allowed only in npm:      package.json
//   allowed only in tarball:  files named .gitignore
//
// Usage: node scripts/check-npm-contents.mjs --tarball <path> [pack-root]
// Exit 0 expected difference only · 1 other difference · 2 bad usage.

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const NPM_ONLY_ALLOWED = ['package.json'];

/** True for a file npm always leaves out and the tarball keeps. */
export function isTarballOnlyAllowed(file) {
  return path.posix.basename(file) === '.gitignore';
}

/** Normalize `tar -tzf` output lines to relative file paths (no dirs, no ./). */
export function normalizeTarList(lines) {
  return lines
    .map((l) => l.trim())
    .filter((l) => l && l !== '.' && l !== './' && !l.endsWith('/'))
    .map((l) => l.replace(/^\.\//, ''))
    .sort();
}

/**
 * Compare file lists. Returns { npmOnly, tarballOnly, unexpected[] } where
 * unexpected holds one message per difference that is not allowed.
 */
export function compareContents(npmFiles, tarballFiles) {
  const npm = new Set(npmFiles);
  const tar = new Set(tarballFiles);
  const npmOnly = [...npm].filter((f) => !tar.has(f)).sort();
  const tarballOnly = [...tar].filter((f) => !npm.has(f)).sort();
  const unexpected = [];
  for (const f of npmOnly) {
    if (!NPM_ONLY_ALLOWED.includes(f)) unexpected.push(`in the npm package but not the marketplace tarball: ${f}`);
  }
  for (const f of tarballOnly) {
    if (!isTarballOnlyAllowed(f)) unexpected.push(`in the marketplace tarball but not the npm package: ${f}`);
  }
  for (const f of NPM_ONLY_ALLOWED) {
    if (!npm.has(f)) unexpected.push(`npm package has no ${f}`);
  }
  return { npmOnly, tarballOnly, unexpected };
}

export function npmPackFiles(root) {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const parsed = JSON.parse(out);
  const entry = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!entry || !Array.isArray(entry.files)) throw new Error('npm pack --dry-run --json returned no file list');
  return entry.files.map((f) => f.path).sort();
}

export function tarballFiles(tarball) {
  const out = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return normalizeTarList(out.split('\n'));
}

function main(argv) {
  let tarball;
  let root;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--tarball') tarball = argv[++i];
    else if (argv[i].startsWith('-')) return usage(`unknown option ${argv[i]}`);
    else root = argv[i];
  }
  if (!tarball) return usage('--tarball <path> is required');
  root = path.resolve(root ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));

  const { npmOnly, tarballOnly, unexpected } = compareContents(npmPackFiles(root), tarballFiles(tarball));
  if (unexpected.length) {
    for (const m of unexpected) process.stderr.write(`check-npm-contents: ${m}\n`);
    process.exit(1);
  }
  process.stdout.write(
    `OK: npm package and marketplace tarball differ only by ${npmOnly.join(', ') || 'nothing'} (npm only) ` +
      `and ${tarballOnly.length ? tarballOnly.join(', ') : 'nothing'} (tarball only)\n`,
  );
}

function usage(msg) {
  process.stderr.write(`check-npm-contents: ${msg}\nusage: check-npm-contents.mjs --tarball <path> [pack-root]\n`);
  process.exit(2);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
