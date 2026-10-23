// .github/workflows/release.yml: tag-only trigger, OIDC permissions, no
// secrets, and step order. Parsed with js-yaml from the hq-cli install the
// suite already needs, and cross-checked against the dependency-free parser
// in scripts/lib/release-verify.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, parseSimpleYaml } from '../scripts/lib/release-verify.mjs';
import { requireFromHqCli } from './helpers/hq-cli.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOWS = path.join(REPO, '.github', 'workflows');
const TEXT = fs.readFileSync(path.join(WORKFLOWS, 'release.yml'), 'utf8');
const yaml = requireFromHqCli('js-yaml');
const wf = yaml.load(TEXT);
const job = wf.jobs.release;
const runs = job.steps.map((s) => s.run ?? '');
const indexOf = (re) => runs.findIndex((r) => re.test(r));

test('the file name is release.yml (the npm trusted publisher is bound to it)', () => {
  assert.ok(fs.existsSync(path.join(WORKFLOWS, 'release.yml')));
});

test('triggers only on pushed v* tags: no branches, no pull_request, no manual or scheduled runs', () => {
  assert.deepEqual(Object.keys(wf.on), ['push']);
  assert.deepEqual(Object.keys(wf.on.push), ['tags']);
  assert.deepEqual(wf.on.push.tags, ['v*']);
});

test('no other workflow runs on push to a branch', () => {
  for (const f of fs.readdirSync(WORKFLOWS).filter((x) => /\.ya?ml$/.test(x))) {
    const w = yaml.load(fs.readFileSync(path.join(WORKFLOWS, f), 'utf8'));
    const on = typeof w.on === 'string' ? { [w.on]: null } : Array.isArray(w.on) ? Object.fromEntries(w.on.map((k) => [k, null])) : w.on;
    if (on.push) {
      assert.equal(on.push.branches, undefined, `${f} runs on push to branches`);
      assert.equal(on.push['branches-ignore'], undefined, `${f} runs on push to branches`);
      assert.ok(Array.isArray(on.push.tags), `${f} runs on every push`);
    }
  }
});

test('permissions are contents: write and id-token: write only', () => {
  assert.deepEqual(wf.permissions, { contents: 'write', 'id-token': 'write' });
  assert.equal(job.permissions, undefined);
});

test('one Linux job', () => {
  assert.deepEqual(Object.keys(wf.jobs), ['release']);
  assert.equal(job['runs-on'], 'ubuntu-latest');
});

test('no secrets and no npm token: publish is OIDC only', () => {
  assert.doesNotMatch(TEXT, /secrets\./);
  assert.doesNotMatch(TEXT, /NODE_AUTH_TOKEN|NPM_TOKEN/);
});

test('actions are pinned to commit SHAs', () => {
  for (const s of job.steps.filter((x) => x.uses)) assert.match(s.uses, /@[0-9a-f]{40}$/, s.uses);
});

test('the tag guard runs first, then check, test, build, npm-content check, publish, release, npm verification', () => {
  const order = [
    indexOf(/git fetch --force --no-tags origin "refs\/tags\/\$\{TAG\}:refs\/tags\/\$\{TAG\}"/),
    indexOf(/bash scripts\/check-release-tag\.sh "\$TAG"/),
    indexOf(/^npm run check$/),
    indexOf(/^npm test$/),
    indexOf(/bash scripts\/build-tarball\.sh --out/),
    indexOf(/node scripts\/check-npm-contents\.mjs --tarball/),
    indexOf(/npm publish --provenance --access public$/m),
    indexOf(/gh release create "\$TAG" "\$TARBALL" "\$RUNNER_TEMP\/release\/SHA256SUMS"/),
    indexOf(/node scripts\/verify-release\.mjs "\$VERSION" --npm-only --npm-view --wait 600/),
  ];
  for (const i of order) assert.ok(i >= 0, `missing step (indexes ${order})`);
  assert.deepEqual([...order].sort((a, b) => a - b), order, `steps out of order: ${order}`);
  // The checkout is the only step before the guard.
  assert.ok(job.steps.slice(0, order[0]).every((s) => s.uses && s.uses.startsWith('actions/checkout@')));
});

test('every publish command passes --provenance --access public', () => {
  const publishLines = runs.join('\n').split('\n').filter((l) => /\bnpm publish\b/.test(l));
  assert.ok(publishLines.length > 0);
  for (const l of publishLines) assert.match(l, /npm publish --provenance --access public/);
});

// parseSimpleYaml keeps every scalar a string; js-yaml types numbers and booleans.
const scalarsAsStrings = (v) =>
  Array.isArray(v)
    ? v.map(scalarsAsStrings)
    : v && typeof v === 'object'
      ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scalarsAsStrings(x)]))
      : v === null
        ? null
        : String(v);

test('the dependency-free YAML parser reads release.yml, ci.yml and package.yaml the same as js-yaml', () => {
  for (const f of [path.join(WORKFLOWS, 'release.yml'), path.join(WORKFLOWS, 'ci.yml'), path.join(REPO, 'package.yaml')]) {
    const text = fs.readFileSync(f, 'utf8');
    assert.equal(canonicalJson(parseSimpleYaml(text)), canonicalJson(scalarsAsStrings(yaml.load(text))), f);
  }
});
