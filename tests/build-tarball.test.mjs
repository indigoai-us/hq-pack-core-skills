// scripts/build-tarball.sh: archive layout, .gitignore files, tracked files
// only, SHA256SUMS; and scripts/check-npm-contents.mjs against the result.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareContents, normalizeTarList } from '../scripts/check-npm-contents.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = path.join(REPO, 'scripts', 'build-tarball.sh');
const NPM_CHECK = path.join(REPO, 'scripts', 'check-npm-contents.mjs');
const PAYLOAD = ['package.yaml', 'skills', 'commands.json', 'SOURCE.md', 'core-resident-skills.txt', 'README.md', 'LICENSE'];
const VERSION = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version;

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
const tarList = (file) => normalizeTarList(execFileSync('tar', ['-tzf', file], { encoding: 'utf8', maxBuffer: 1 << 26 }).split('\n'));
const rawTarList = (file) => execFileSync('tar', ['-tzf', file], { encoding: 'utf8', maxBuffer: 1 << 26 }).split('\n').filter(Boolean);

let scratch;
let n = 0;
before(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'build-tarball-'));
});
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

function build(root) {
  const out = path.join(scratch, `out${++n}`);
  const r = spawnSync('bash', [BUILD, '--out', out, root], { encoding: 'utf8' });
  return { ...r, out, tarball: r.stdout.trim() };
}

/** A small git repo shaped like the pack. */
function fixtureRepo({ commit = true } = {}) {
  const dir = path.join(scratch, `repo${++n}`);
  const files = {
    'package.json': JSON.stringify({ name: '@indigoai-us/hq-pack-core-skills', version: '2.0.0', files: ['package.yaml', 'skills/', 'SOURCE.md', 'commands.json', 'core-resident-skills.txt', 'README.md', 'LICENSE'] }),
    'package.yaml': 'name: hq-pack-core-skills\nversion: 2.0.0\n',
    'skills/a/SKILL.md': '---\nname: a\n---\n',
    'skills/a/.gitignore': 'generated/\n',
    'skills/a/hooks/x.ts': 'export {};\n',
    'commands.json': '{}\n',
    'SOURCE.md': 'source\n',
    'core-resident-skills.txt': 'setup\n',
    'README.md': 'readme\n',
    LICENSE: 'MIT\n',
    'scripts/not-shipped.sh': 'echo\n',
  };
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '-A');
  if (commit) git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

describe('build-tarball.sh on this repo', () => {
  let r;
  before(() => {
    r = build(REPO);
  });

  test('builds hq-pack-core-skills-<version>.tar.gz', () => {
    assert.equal(r.status, 0, r.stderr);
    assert.equal(path.basename(r.tarball), `hq-pack-core-skills-${VERSION}.tar.gz`);
  });

  test('package.yaml sits at the archive root, with no package/ wrapper', () => {
    const raw = rawTarList(r.tarball);
    assert.ok(raw.includes('./package.yaml') || raw.includes('package.yaml'), raw.slice(0, 10).join('\n'));
    assert.ok(!raw.some((e) => e.startsWith('package/') || e.startsWith('./package/')));
  });

  test('holds exactly the git-tracked payload files, including skills/run-project/.gitignore', () => {
    const tracked = git(REPO, 'ls-files', '--', ...PAYLOAD).split('\n').filter(Boolean).sort();
    const listed = tarList(r.tarball);
    assert.deepEqual(listed, tracked);
    assert.ok(listed.includes('skills/run-project/.gitignore'));
    assert.ok(!listed.includes('package.json'));
    assert.ok(!listed.some((f) => f.startsWith('scripts/') || f.startsWith('tests/') || f.startsWith('.github/')));
  });

  test('SHA256SUMS holds the tarball sha256 in sha256sum format', () => {
    const sums = fs.readFileSync(path.join(r.out, 'SHA256SUMS'), 'utf8');
    const digest = createHash('sha256').update(fs.readFileSync(r.tarball)).digest('hex');
    assert.equal(sums, `${digest}  hq-pack-core-skills-${VERSION}.tar.gz\n`);
  });

  test('check-npm-contents: npm differs only by package.json and .gitignore files', () => {
    const c = spawnSync('node', [NPM_CHECK, '--tarball', r.tarball, REPO], { encoding: 'utf8' });
    assert.equal(c.status, 0, c.stderr);
    assert.match(c.stdout, /package\.json \(npm only\) and skills\/run-project\/\.gitignore \(tarball only\)/);
  });
});

describe('build-tarball.sh on fixture repos', () => {
  test('untracked files are left out; tracked dotfiles are kept', () => {
    const dir = fixtureRepo();
    fs.mkdirSync(path.join(dir, 'skills/a/generated'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'skills/a/generated/types.d.ts'), 'x');
    fs.writeFileSync(path.join(dir, 'skills/a/untracked.md'), 'x');
    const r = build(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(tarList(r.tarball), [
      'LICENSE',
      'README.md',
      'SOURCE.md',
      'commands.json',
      'core-resident-skills.txt',
      'package.yaml',
      'skills/a/.gitignore',
      'skills/a/SKILL.md',
      'skills/a/hooks/x.ts',
    ]);
  });

  test('a payload path that is not tracked fails', () => {
    const dir = fixtureRepo();
    git(dir, 'rm', '-q', '--cached', 'SOURCE.md');
    const r = build(dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /SOURCE\.md is not tracked in git/);
  });

  test('a directory that is not a git checkout is bad usage', () => {
    const dir = path.join(scratch, 'plain');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'package.json'), '{"version":"1.0.0"}');
    const r = build(dir);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /is not a git checkout/);
  });

  test('check-npm-contents fails when the tarball has a file npm would not ship', () => {
    const dir = fixtureRepo();
    const r = build(dir);
    assert.equal(r.status, 0, r.stderr);
    // Ship a file through npm that the tarball lacks.
    const pj = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    pj.files.push('scripts/');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pj));
    const c = spawnSync('node', [NPM_CHECK, '--tarball', r.tarball, dir], { encoding: 'utf8' });
    assert.equal(c.status, 1);
    assert.match(c.stderr, /in the npm package but not the marketplace tarball: scripts\/not-shipped\.sh/);
  });
});

describe('compareContents', () => {
  test('package.json only in npm and .gitignore only in the tarball are expected', () => {
    const r = compareContents(['package.json', 'a', 'b/c'], ['a', 'b/c', 'b/.gitignore', '.gitignore']);
    assert.deepEqual(r.unexpected, []);
    assert.deepEqual(r.tarballOnly, ['.gitignore', 'b/.gitignore']);
  });
  test('anything else is reported', () => {
    const r = compareContents(['package.json', 'a', 'x'], ['a', 'y', 'z/.npmignore']);
    assert.deepEqual(r.unexpected, [
      'in the npm package but not the marketplace tarball: x',
      'in the marketplace tarball but not the npm package: y',
      'in the marketplace tarball but not the npm package: z/.npmignore',
    ]);
  });
  test('a missing package.json in npm is reported', () => {
    assert.deepEqual(compareContents(['a'], ['a']).unexpected, ['npm package has no package.json']);
  });
  test('normalizeTarList drops directories and ./', () => {
    assert.deepEqual(normalizeTarList(['./', './a/', './a/b', 'c', '']), ['a/b', 'c']);
  });
});
