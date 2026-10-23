// PRD US-002 e2e: install the pack tarball through hq-cli's real marketplace
// transport (installPack with injected MarketplaceDeps, no network), then show
// that a tarball with one changed byte fails before anything is extracted.
//
// The tarball is the one scripts/build-tarball.sh builds from this repo. The
// listing is signed with a throwaway Ed25519 key that hq-cli trusts through
// its test-only HQ_PACK_PUBLIC_KEY override (honored only when NODE_ENV is
// test or development). Everything else is hq-cli's production code:
// verifyArtifact, trustedMarketplaceSigningKey, safeExtractTarball,
// validateManifest and installToPackages.
//
// "Before extract" is observed directly: fetchMarketplace writes the
// downloaded bytes to <tmp>/marketplace.tar.gz only after verification passes
// and then extracts that file. A spy on fs.writeFileSync records that write;
// the success case shows the spy sees it, the tamper cases show it never
// happens.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hqCliVersion, importHqCli } from './helpers/hq-cli.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version;
const SOURCE = `marketplace:core-skills@${VERSION}`;

let scratch;
let tarball;
let pack;
let platformKey;
let attackerKey;
const saved = {};
const writes = [];
const realWriteFileSync = fs.writeFileSync;

const pem = (k) => k.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const signHash = (hash, key) => sign(null, Buffer.from(hash, 'utf-8'), key.privateKey).toString('base64');

before(async () => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tamper-install-'));
  const out = path.join(scratch, 'out');
  const built = execFileSync('bash', [path.join(REPO, 'scripts', 'build-tarball.sh'), '--out', out, REPO], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  tarball = fs.readFileSync(built);

  platformKey = generateKeyPairSync('ed25519');
  attackerKey = generateKeyPairSync('ed25519');
  for (const k of ['NODE_ENV', 'HQ_PACK_PUBLIC_KEY', 'HOME', 'HQ_API_KEY']) saved[k] = process.env[k];
  process.env.NODE_ENV = 'test';
  process.env.HQ_PACK_PUBLIC_KEY = pem(platformKey);
  // hq-cli syncs Codex skills under $HOME; keep that inside the scratch tree.
  process.env.HOME = path.join(scratch, 'home');
  fs.mkdirSync(process.env.HOME);
  delete process.env.HQ_API_KEY;

  pack = await importHqCli('commands/pack-install.js');

  fs.writeFileSync = function spy(file, ...rest) {
    writes.push(String(file));
    return realWriteFileSync.call(this, file, ...rest);
  };
  syncBuiltinESMExports();
});

after(() => {
  fs.writeFileSync = realWriteFileSync;
  syncBuiltinESMExports();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  process.chdir(REPO);
  fs.rmSync(scratch, { recursive: true, force: true });
});

function fakeHqRoot(name) {
  const root = path.join(scratch, name);
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(root, 'core'), { recursive: true });
  fs.writeFileSync(path.join(root, 'core', 'core.yaml'), 'hqVersion: 99.0.0\n');
  return root;
}

function listing(overrides = {}) {
  const contentHash = sha256(tarball);
  return {
    listingId: 'lst_core_skills_test',
    slug: 'core-skills',
    version: VERSION,
    downloadUrl: 'https://s3.example.invalid/presigned',
    contentHash,
    contentHashAlg: 'sha256',
    signature: signHash(contentHash, platformKey),
    signingKeyId: 'mkt-sign-v1',
    publicKey: pem(platformKey),
    ...overrides,
  };
}

function deps(detail, bytes) {
  const calls = { resolve: [], download: 0 };
  return {
    calls,
    resolveListing: async (slug, version) => {
      calls.resolve.push(`${slug}@${version}`);
      return { ...detail };
    },
    refreshListing: async () => ({ ...detail }),
    download: async () => {
      calls.download++;
      return new Uint8Array(bytes);
    },
  };
}

async function install(root, d) {
  // hq-cli before the hqRoot option resolves the HQ root from the cwd.
  process.chdir(root);
  writes.length = 0;
  return pack.installPack(SOURCE, { hqRoot: root, marketplaceDeps: d, quiet: true });
}

function oneByteChanged(bytes) {
  const b = Buffer.from(bytes);
  b[Math.floor(b.length / 2)] ^= 0x01;
  return b;
}

const tarballWrites = () => writes.filter((w) => path.basename(w) === 'marketplace.tar.gz');

function assertNothingInstalled(root) {
  assert.equal(fs.existsSync(path.join(root, 'core', 'packages', 'hq-pack-core-skills')), false, 'pack dir must not exist');
  const skills = path.join(root, '.claude', 'skills');
  assert.deepEqual(fs.existsSync(skills) ? fs.readdirSync(skills) : [], [], '.claude/skills must stay empty');
  assert.deepEqual(tarballWrites(), [], 'the downloaded bytes must never be written for extraction');
}

test(`hq-cli ${hqCliVersion()} installs the signed release tarball from ${SOURCE}`, async () => {
  const root = fakeHqRoot('hq-ok');
  const d = deps(listing(), tarball);
  const result = await install(root, d);
  assert.ok(result, 'installPack returned no result');
  assert.deepEqual(d.calls.resolve, [`core-skills@${VERSION}`]);
  const dest = path.join(root, 'core', 'packages', 'hq-pack-core-skills');
  assert.equal(fs.realpathSync(result.destDir), fs.realpathSync(dest));
  assert.equal(result.pkg.name, 'hq-pack-core-skills');
  assert.equal(result.pkg.version, VERSION);
  for (const f of ['skills/prd/SKILL.md', 'skills/run-project/.gitignore', 'commands.json', 'core-resident-skills.txt']) {
    assert.ok(fs.existsSync(path.join(dest, f)), `${f} missing from the installed pack`);
  }
  assert.match(fs.readFileSync(path.join(dest, 'package.yaml'), 'utf8'), new RegExp(`marketplace:core-skills@${VERSION.replace(/\./g, '\\.')}`));
  // Anti-vacuity for the tamper cases: on success the spy sees the write.
  assert.equal(tarballWrites().length, 1);
});

test('one changed byte, listing unchanged: hash mismatch, nothing extracted', async () => {
  const root = fakeHqRoot('hq-hash');
  const bad = oneByteChanged(tarball);
  assert.notEqual(sha256(bad), sha256(tarball));
  const d = deps(listing(), bad);
  await assert.rejects(install(root, d), (e) => {
    assert.equal(e.name, 'ArtifactVerificationError');
    assert.match(e.message, /hash mismatch/i);
    return true;
  });
  assert.equal(d.calls.download, 1);
  assertNothingInstalled(root);
});

test('one changed byte, contentHash rewritten to match, old signature: signature error, nothing extracted', async () => {
  const root = fakeHqRoot('hq-sig');
  const bad = oneByteChanged(tarball);
  const d = deps(listing({ contentHash: sha256(bad) }), bad);
  await assert.rejects(install(root, d), (e) => {
    assert.equal(e.name, 'ArtifactVerificationError');
    assert.match(e.message, /signature/i);
    return true;
  });
  assertNothingInstalled(root);
});

test('one changed byte, re-signed with another key that the listing echoes: refused, nothing extracted', async () => {
  const root = fakeHqRoot('hq-key');
  const bad = oneByteChanged(tarball);
  const hash = sha256(bad);
  const d = deps(listing({ contentHash: hash, signature: signHash(hash, attackerKey), publicKey: pem(attackerKey) }), bad);
  await assert.rejects(install(root, d), /does not match pinned signing key/);
  assertNothingInstalled(root);
});

test('unsigned listing for the untouched tarball: refused, nothing extracted', async () => {
  const root = fakeHqRoot('hq-unsigned');
  const d = deps(listing({ signature: undefined }), tarball);
  await assert.rejects(install(root, d), (e) => {
    assert.equal(e.name, 'ArtifactVerificationError');
    assert.match(e.message, /unsigned/i);
    return true;
  });
  assertNothingInstalled(root);
});
