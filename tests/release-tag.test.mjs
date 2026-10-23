// scripts/check-release-tag.sh against throwaway git repos.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(REPO, 'scripts', 'check-release-tag.sh');
let scratch;
let n = 0;

before(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'release-tag-'));
});
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** A repo with package.json / package.yaml at VERSION, one commit. */
function repo(version = '1.0.0', yamlVersion = version) {
  const dir = path.join(scratch, `r${++n}`);
  fs.mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: '@indigoai-us/hq-pack-core-skills', version, engines: { 'hq-core': '>=16.0.0', 'hq-cli': '>=5.0.0' } }, null, 2),
  );
  fs.writeFileSync(
    path.join(dir, 'package.yaml'),
    `name: hq-pack-core-skills\nversion: ${yamlVersion}\nrequires:\n  hqCore: '>=16.0.0'\n  hqCli: '>=5.0.0'\n`,
  );
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

function run(tag, dir) {
  const r = spawnSync('bash', [SCRIPT, tag, dir], { encoding: 'utf8', env: GIT_ENV });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr };
}

test('annotated tag equal to v<package.json version> at HEAD passes and prints the version', () => {
  const dir = repo('1.0.0');
  git(dir, 'tag', '-a', 'v1.0.0', '-m', 'v1.0.0');
  const r = run('v1.0.0', dir);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, '1.0.0');
});

test('refs/tags/ prefix (github.ref) is accepted', () => {
  const dir = repo('1.0.0');
  git(dir, 'tag', '-a', 'v1.0.0', '-m', 'v1.0.0');
  assert.equal(run('refs/tags/v1.0.0', dir).code, 0);
});

test('prerelease tag passes', () => {
  const dir = repo('1.1.0-rc.1');
  git(dir, 'tag', '-a', 'v1.1.0-rc.1', '-m', 'rc');
  const r = run('v1.1.0-rc.1', dir);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, '1.1.0-rc.1');
});

test('lightweight tag fails', () => {
  const dir = repo('1.0.0');
  git(dir, 'tag', 'v1.0.0');
  const r = run('v1.0.0', dir);
  assert.equal(r.code, 1);
  assert.match(r.err, /v1\.0\.0 is a lightweight tag \(refs\/tags\/v1\.0\.0 is a commit\)/);
});

test('tag that differs from package.json version fails', () => {
  const dir = repo('1.0.0');
  git(dir, 'tag', '-a', 'v1.0.1', '-m', 'v1.0.1');
  const r = run('v1.0.1', dir);
  assert.equal(r.code, 1);
  assert.match(r.err, /tag v1\.0\.1 does not match package\.json version 1\.0\.0/);
});

test('package.yaml version out of sync fails', () => {
  const dir = repo('1.0.0', '0.9.0');
  git(dir, 'tag', '-a', 'v1.0.0', '-m', 'v1.0.0');
  const r = run('v1.0.0', dir);
  assert.equal(r.code, 1);
  assert.match(r.err, /package\.json and package\.yaml disagree/);
});

test('tag not at HEAD fails', () => {
  const dir = repo('1.0.0');
  git(dir, 'tag', '-a', 'v1.0.0', '-m', 'v1.0.0');
  fs.writeFileSync(path.join(dir, 'x'), 'x');
  git(dir, 'add', 'x');
  git(dir, 'commit', '-q', '-m', 'later');
  const r = run('v1.0.0', dir);
  assert.equal(r.code, 1);
  assert.match(r.err, /v1\.0\.0 points at [0-9a-f]{40} but the checkout is at [0-9a-f]{40}/);
});

test('missing tag fails', () => {
  const dir = repo('1.0.0');
  const r = run('v1.0.0', dir);
  assert.equal(r.code, 1);
  assert.match(r.err, /refs\/tags\/v1\.0\.0 does not exist/);
});

test('malformed tags fail before any git lookup', () => {
  const dir = repo('1.0.0');
  for (const tag of ['1.0.0', 'v1.0', 'v01.0.0', 'release-1.0.0', 'v1.0.0+build']) {
    const r = run(tag, dir);
    assert.equal(r.code, 1, tag);
    assert.match(r.err, /is not vMAJOR\.MINOR\.PATCH/, tag);
  }
});

test('no tag argument is bad usage', () => {
  const r = spawnSync('bash', [SCRIPT], { encoding: 'utf8' });
  assert.equal(r.status, 2);
});
