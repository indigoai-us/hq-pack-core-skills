// Facts about hq-cli that the release process depends on, checked against the
// hq-cli build the suite runs with (see tests/helpers/hq-cli.mjs):
//
//   - scripts/lib/release-verify.mjs pins the same signing key as hq-cli.
//   - `hq publish` (runPublish, upload faked) derives slug core-skills, stamps
//     `author` into package.yaml and re-packs the directory, so the listing's
//     contentHash differs from the GitHub release tarball's sha256. The
//     content comparison in verifyRelease still passes for that tarball and
//     fails when a file was changed.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MARKETPLACE_SLUG,
  PINNED_SIGNING_KEYS,
  npmVersionDocUrl,
  sha256Hex,
  tarballName,
  verifyRelease,
} from '../scripts/lib/release-verify.mjs';
import { importHqCli } from './helpers/hq-cli.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version;

let scratch;
let releaseBytes;
let publish;
let n = 0;

before(async () => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-cli-compat-'));
  const built = execFileSync('bash', [path.join(REPO, 'scripts', 'build-tarball.sh'), '--out', path.join(scratch, 'out'), REPO], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  releaseBytes = fs.readFileSync(built);
  publish = await importHqCli('commands/publish.js');
});
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

function extract(bytes) {
  const file = path.join(scratch, `e${++n}.tar.gz`);
  const dir = path.join(scratch, `x${n}`);
  fs.writeFileSync(file, bytes);
  fs.mkdirSync(dir);
  execFileSync('tar', ['-xzf', file, '-C', dir]);
  return dir;
}

/** Run hq-cli's real runPublish on dir with a faked upload; return the request. */
async function hqPublish(dir) {
  const hqRoot = path.join(scratch, `hq${++n}`);
  fs.mkdirSync(path.join(hqRoot, '.claude'), { recursive: true });
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const idToken = [b64({ alg: 'none' }), b64({ sub: 'u-test', preferred_username: 'tester', name: 'Test Er' }), 'x'].join('.');
  let sent;
  await publish.runPublish(dir, {
    loadIdToken: () => idToken,
    getAccessToken: async () => 'test-access',
    getIdToken: async () => idToken,
    upload: async ({ listing }) => {
      sent = listing;
      return { status: 201, body: { listing: { id: 'lst_test', status: 'pending_review' } } };
    },
    hqRoot,
    hqVersion: '99.0.0',
  });
  return sent;
}

test('the pinned signing key equals hq-cli MARKETPLACE_SIGNING_KEYS', async () => {
  const keys = await importHqCli('lib/pack-signing-keys.js');
  assert.deepEqual({ ...PINNED_SIGNING_KEYS }, { ...keys.MARKETPLACE_SIGNING_KEYS });
});

test('hq publish of the extracted release tarball: slug core-skills, bytes change, content check passes', async () => {
  const sent = await hqPublish(extract(releaseBytes));
  assert.equal(sent.slug, MARKETPLACE_SLUG);
  assert.equal(sent.name, 'hq-pack-core-skills');
  assert.equal(sent.version, VERSION);
  const listingBytes = Buffer.from(sent.tarball, 'base64');
  assert.notEqual(sha256Hex(listingBytes), sha256Hex(releaseBytes), 'hq publish re-packs, so the hashes differ');
  const listingDir = extract(listingBytes);
  assert.match(fs.readFileSync(path.join(listingDir, 'package.yaml'), 'utf8'), /^author:\n {2}uid: u-test$/m);
  assert.ok(fs.existsSync(path.join(listingDir, 'skills', 'run-project', '.gitignore')), 'hq publish keeps .gitignore');

  const r = await verifyRelease({ version: VERSION, skipNpm: true }, fakeDeps(listingBytes));
  assert.deepEqual(r.errors, []);
  assert.ok(r.notes.some((x) => /re-packed \(hq publish\)/.test(x)));
});

test('hq publish of a directory with one changed skill file: content check fails', async () => {
  const dir = extract(releaseBytes);
  fs.appendFileSync(path.join(dir, 'skills', 'prd', 'SKILL.md'), '\nextra line\n');
  const sent = await hqPublish(dir);
  const r = await verifyRelease({ version: VERSION, skipNpm: true }, fakeDeps(Buffer.from(sent.tarball, 'base64')));
  assert.deepEqual(r.errors, ['content: listing tarball has different bytes for skills/prd/SKILL.md']);
});

/** Deps for verifyRelease serving the release tarball and a signed listing of listingBytes. */
function fakeDeps(listingBytes) {
  const key = generateKeyPairSync('ed25519');
  const pub = key.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const contentHash = sha256Hex(listingBytes);
  const detail = {
    id: 'lst_test',
    slug: MARKETPLACE_SLUG,
    version: VERSION,
    downloadUrl: 'https://s3.example.invalid/x',
    contentHash,
    signature: sign(null, Buffer.from(contentHash, 'utf-8'), key.privateKey).toString('base64'),
    signingKeyId: 'mkt-sign-v1',
    publicKey: pub,
  };
  return {
    pinnedKeys: { 'mkt-sign-v1': pub },
    fetchJson: async (url) => {
      if (url === npmVersionDocUrl(VERSION)) return null;
      if (url.includes('/v1/listings?')) return { listings: [{ id: 'lst_test', slug: MARKETPLACE_SLUG, version: VERSION }] };
      if (url.endsWith('/v1/listings/lst_test')) return { listing: detail };
      return null;
    },
    fetchText: async () => `${sha256Hex(releaseBytes)}  ${tarballName(VERSION)}\n`,
    fetchBytes: async (url) => (url === detail.downloadUrl ? listingBytes : releaseBytes),
    readFile: (p) => fs.readFileSync(p),
    extract,
  };
}
