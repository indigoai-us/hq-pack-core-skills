#!/usr/bin/env node
// check-manifest-sync.mjs — fail when package.json and package.yaml disagree.
//
// The hq-cli resolver reads compatibility from npm metadata, which carries
// only package.json, while HQ reads package.yaml after install. Both must say
// the same thing:
//   package.json version            == package.yaml version
//   package.json engines["hq-core"] == package.yaml requires.hqCore
//   package.json engines["hq-cli"]  == package.yaml requires.hqCli
//
// package.yaml is read with a shallow line grammar (top-level `version:`, and
// two-space `hqCore:` / `hqCli:` keys under a top-level `requires:`), so the
// check needs no YAML dependency. Values may be single- or double-quoted.
//
// Usage: node scripts/check-manifest-sync.mjs [pack-root]   (default: this repo)
// Exit 0 in sync · 1 mismatch · 2 bad usage.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const yamlPath = path.join(root, 'package.yaml');
const jsonPath = path.join(root, 'package.json');

function usage(msg) {
  process.stderr.write(`check-manifest-sync: ${msg}\n`);
  process.exit(2);
}

if (!fs.existsSync(yamlPath)) usage(`no package.yaml at ${yamlPath}`);
if (!fs.existsSync(jsonPath)) usage(`no package.json at ${jsonPath}`);

function unquote(v) {
  v = v.replace(/\s+#.*$/, '').trim();
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.endsWith(v[0])) return v.slice(1, -1);
  return v;
}

function readYaml(file) {
  const out = { version: undefined, hqCore: undefined, hqCli: undefined };
  let inRequires = false;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (/^\s*#/.test(line) || /^\s*$/.test(line)) continue;
    if (/^\S/.test(line)) {
      inRequires = /^requires:\s*$/.test(line);
      const m = /^version:(.*)$/.exec(line);
      if (m) out.version = unquote(m[1]);
      continue;
    }
    const m = inRequires && /^ {2}(hqCore|hqCli):(.*)$/.exec(line);
    if (m) out[m[1]] = unquote(m[2]);
  }
  return out;
}

let pkg;
try {
  pkg = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
} catch (e) {
  usage(`package.json is not valid JSON: ${e.message}`);
}
const yaml = readYaml(yamlPath);
const engines = pkg.engines ?? {};

const pairs = [
  ['version', 'package.json version', pkg.version, 'package.yaml version', yaml.version],
  ['hq-core', 'package.json engines["hq-core"]', engines['hq-core'], 'package.yaml requires.hqCore', yaml.hqCore],
  ['hq-cli', 'package.json engines["hq-cli"]', engines['hq-cli'], 'package.yaml requires.hqCli', yaml.hqCli],
];

let bad = 0;
for (const [, jsonLabel, jsonValue, yamlLabel, yamlValue] of pairs) {
  if (jsonValue === undefined || jsonValue === '') {
    process.stderr.write(`check-manifest-sync: ${jsonLabel} is missing (package.yaml has ${JSON.stringify(yamlValue ?? null)})\n`);
    bad++;
  } else if (yamlValue === undefined || yamlValue === '') {
    process.stderr.write(`check-manifest-sync: ${yamlLabel} is missing (package.json has ${JSON.stringify(jsonValue)})\n`);
    bad++;
  } else if (String(jsonValue) !== yamlValue) {
    process.stderr.write(`check-manifest-sync: ${jsonLabel} is ${JSON.stringify(jsonValue)} but ${yamlLabel} is ${JSON.stringify(yamlValue)}\n`);
    bad++;
  }
}

if (bad) process.exit(1);
process.stdout.write(`OK: package.json and package.yaml agree on version ${yaml.version}, hq-core ${yaml.hqCore}, hq-cli ${yaml.hqCli}\n`);
