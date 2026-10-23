// Unit tests for scripts/lib/release-verify.mjs: a throwaway Ed25519 key pair,
// fake npm documents and fake listings, no network.

import { after, before, describe, test } from 'node:test';
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
  canonicalJson,
  checkListingSignature,
  checkNpmVersionDoc,
  checkNpmViewOutput,
  comparePackageYaml,
  compareTrees,
  npmVersionDocUrl,
  parseSha256Sums,
  parseSimpleYaml,
  pickListingId,
  releaseAssetUrl,
  sha256Hex,
  tarballName,
  unwrapListingDetail,
  verifyRelease,
} from '../scripts/lib/release-verify.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = '1.2.3';
const platform = generateKeyPairSync('ed25519');
const attacker = generateKeyPairSync('ed25519');
const pem = (k) => k.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const signHash = (h, k) => sign(null, Buffer.from(h, 'utf-8'), k.privateKey).toString('base64');
const PINNED = { 'mkt-sign-v1': pem(platform) };

let scratch;
before(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-release-test-'));
});
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

let n = 0;
/** Write files into a fresh dir and return a tar.gz of it (tar -C dir .). */
function makeTarball(files) {
  const dir = path.join(scratch, `src${++n}`);
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  const out = path.join(scratch, `t${n}.tar.gz`);
  execFileSync('tar', ['-czf', out, '-C', dir, '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  return fs.readFileSync(out);
}

function extract(bytes) {
  const file = path.join(scratch, `e${++n}.tar.gz`);
  const dir = path.join(scratch, `x${n}`);
  fs.writeFileSync(file, bytes);
  fs.mkdirSync(dir);
  execFileSync('tar', ['-xzf', file, '-C', dir]);
  return dir;
}

const PACKAGE_YAML = `name: hq-pack-core-skills
version: ${VERSION}
publisher: '@indigoai-us'
# comment
requires:
  hqCore: '>=16.0.0'
contributes:
  skills:
    - _shared
    - prd
  hooks: []
`;
// What hq publish writes: js-yaml dump of the parsed manifest plus author.
const PUBLISHED_YAML = `name: hq-pack-core-skills
version: ${VERSION}
publisher: '@indigoai-us'
requires:
  hqCore: '>=16.0.0'
contributes:
  skills:
    - _shared
    - prd
  hooks: []
author:
  uid: u-1
  handle: someone
  displayName: Some One
`;
const FILES = {
  'package.yaml': PACKAGE_YAML,
  'skills/prd/SKILL.md': '---\nname: prd\n---\nBody\n',
  'skills/run-project/.gitignore': '.claude-plugin/types/\n',
  'commands.json': '{}\n',
};

/** A world where every check passes; override pieces per test. */
function world({ releaseBytes, listingBytes, listing = {}, npmDoc, sums, search } = {}) {
  const rel = releaseBytes ?? makeTarball(FILES);
  const lst = listingBytes ?? rel;
  const contentHash = sha256Hex(lst);
  const detail = {
    id: 'lst_1',
    slug: MARKETPLACE_SLUG,
    version: VERSION,
    downloadUrl: 'https://s3.example.invalid/listing.tar.gz?X-Amz-Signature=secret',
    contentHash,
    contentHashAlg: 'sha256',
    signature: signHash(contentHash, platform),
    signingKeyId: 'mkt-sign-v1',
    publicKey: pem(platform),
    ...listing,
  };
  const urls = {
    [npmVersionDocUrl(VERSION)]: npmDoc === undefined ? { version: VERSION, dist: { attestations: { url: 'https://registry.npmjs.org/-/npm/v1/attestations/x', provenance: { predicateType: 'https://slsa.dev/provenance/v1' } } } } : npmDoc,
    [`https://hqapi.hq.computer/v1/listings?slug=${MARKETPLACE_SLUG}&q=${MARKETPLACE_SLUG}&version=${VERSION}`]:
      search ?? { listings: [{ id: 'lst_other', slug: 'core-skills-extra', version: VERSION }, { id: 'lst_1', slug: MARKETPLACE_SLUG, version: VERSION }] },
    'https://hqapi.hq.computer/v1/listings/lst_1': { listing: detail },
  };
  const fetched = [];
  const deps = {
    pinnedKeys: PINNED,
    fetchJson: async (url) => {
      fetched.push(url);
      return Object.hasOwn(urls, url) ? urls[url] : null;
    },
    fetchText: async (url) => {
      fetched.push(url);
      assert.equal(url, releaseAssetUrl(VERSION, 'SHA256SUMS'));
      return sums ?? `${sha256Hex(rel)}  ${tarballName(VERSION)}\n`;
    },
    fetchBytes: async (url) => {
      fetched.push(url);
      if (url === releaseAssetUrl(VERSION, tarballName(VERSION))) return rel;
      if (url === detail.downloadUrl) return lst;
      throw new Error(`unexpected URL ${url}`);
    },
    readFile: (p) => fs.readFileSync(p),
    extract,
    npmView: async () => JSON.stringify({ version: VERSION, 'dist.attestations': { url: 'x', provenance: { predicateType: 'p' } } }),
  };
  return { deps, fetched, detail };
}

describe('verifyRelease', () => {
  test('identical bytes, signed with the pinned key: passes', async () => {
    const { deps, fetched } = world();
    const r = await verifyRelease({ version: VERSION, npmView: true }, deps);
    assert.deepEqual(r.errors, []);
    assert.ok(r.notes.some((x) => /contentHash equals the GitHub release tarball sha256/.test(x)));
    assert.ok(fetched.includes('https://hqapi.hq.computer/v1/listings/lst_1'), 'detail fetched by the exact-slug id');
  });

  test('listing re-packed with an author-stamped package.yaml: passes on content', async () => {
    const listingBytes = makeTarball({ ...FILES, 'package.yaml': PUBLISHED_YAML });
    const { deps } = world({ listingBytes });
    const r = await verifyRelease({ version: VERSION }, deps);
    assert.deepEqual(r.errors, []);
    assert.ok(r.notes.some((x) => /re-packed/.test(x)));
  });

  test('listing signed by another key that it echoes: fails, the echoed key is not trusted', async () => {
    const { deps, detail } = world();
    const r = await verifyRelease(
      { version: VERSION },
      { ...deps, fetchJson: async (url) => (url.endsWith('/lst_1') ? { listing: { ...detail, signature: signHash(detail.contentHash, attacker), publicKey: pem(attacker) } } : deps.fetchJson(url)) },
    );
    assert.ok(r.errors.some((e) => /publicKey does not match the pinned mkt-sign-v1 key/.test(e)), r.errors.join('\n'));
    assert.ok(r.errors.some((e) => /signature does not verify with the pinned mkt-sign-v1 key/.test(e)), r.errors.join('\n'));
  });

  test('wrong signingKeyId: fails', async () => {
    const { deps } = world({ listing: { signingKeyId: 'mkt-sign-v0' } });
    const r = await verifyRelease({ version: VERSION }, deps);
    assert.ok(r.errors.some((e) => /signingKeyId is "mkt-sign-v0", expected mkt-sign-v1/.test(e)), r.errors.join('\n'));
  });

  test('listing tarball bytes differ from contentHash: fails', async () => {
    const rel = makeTarball(FILES);
    const { deps, detail } = world({ releaseBytes: rel });
    const tampered = Buffer.from(rel);
    tampered[Math.floor(tampered.length / 2)] ^= 1;
    const r = await verifyRelease(
      { version: VERSION },
      { ...deps, fetchBytes: async (url) => (url === detail.downloadUrl ? tampered : deps.fetchBytes(url)) },
    );
    assert.ok(r.errors.some((e) => /listing tarball: sha256 is [0-9a-f]{64} but the listing contentHash is/.test(e)), r.errors.join('\n'));
  });

  test('listing content differs from the release: fails and names the file', async () => {
    const listingBytes = makeTarball({ ...FILES, 'skills/prd/SKILL.md': '---\nname: prd\n---\nChanged\n', 'extra.txt': 'x' });
    const { deps } = world({ listingBytes });
    const r = await verifyRelease({ version: VERSION }, deps);
    assert.ok(r.errors.includes('content: listing tarball has different bytes for skills/prd/SKILL.md'), r.errors.join('\n'));
    assert.ok(r.errors.includes('content: listing tarball has an extra file extra.txt'), r.errors.join('\n'));
  });

  test('listing package.yaml differs beyond author: fails', async () => {
    const listingBytes = makeTarball({ ...FILES, 'package.yaml': PUBLISHED_YAML.replace('    - prd\n', '') });
    const { deps } = world({ listingBytes });
    const r = await verifyRelease({ version: VERSION }, deps);
    assert.ok(r.errors.some((e) => /^content: package.yaml contributes differs/.test(e)), r.errors.join('\n'));
  });

  test('listing missing .gitignore from the release: fails', async () => {
    const { 'skills/run-project/.gitignore': _drop, ...rest } = FILES;
    const listingBytes = makeTarball(rest);
    const { deps } = world({ listingBytes });
    const r = await verifyRelease({ version: VERSION }, deps);
    assert.ok(r.errors.includes('content: listing tarball is missing skills/run-project/.gitignore'), r.errors.join('\n'));
  });

  test('no listing for the slug and version: fails; a different slug is not accepted', async () => {
    const { deps } = world({ search: { listings: [{ id: 'lst_x', slug: 'hq-pack-core-skills', version: VERSION }] } });
    const r = await verifyRelease({ version: VERSION }, deps);
    assert.ok(r.errors.includes(`marketplace: no approved listing for core-skills@${VERSION}`), r.errors.join('\n'));
  });

  test('SHA256SUMS does not match the release tarball: fails', async () => {
    const { deps } = world({ sums: `${'0'.repeat(64)}  ${tarballName(VERSION)}\n` });
    const r = await verifyRelease({ version: VERSION }, deps);
    assert.ok(r.errors.some((e) => /SHA256SUMS says 0{64}/.test(e)), r.errors.join('\n'));
  });

  test('npm version missing (404): fails', async () => {
    const { deps } = world({ npmDoc: null });
    const r = await verifyRelease({ version: VERSION, npmOnly: true }, deps);
    assert.deepEqual(r.errors, [`npm: npm has no document for @indigoai-us/hq-pack-core-skills@${VERSION}`]);
  });

  test('npm version without attestations: fails', async () => {
    const { deps } = world({ npmDoc: { version: VERSION, dist: {} } });
    const r = await verifyRelease({ version: VERSION, npmOnly: true }, deps);
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0], /has no dist\.attestations/);
  });

  test('--npm-only stops after npm', async () => {
    const { deps, fetched } = world();
    const r = await verifyRelease({ version: VERSION, npmOnly: true }, deps);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(fetched, [npmVersionDocUrl(VERSION)]);
  });

  test('local --release-tarball and --sums are used instead of the assets', async () => {
    const rel = makeTarball(FILES);
    const tp = path.join(scratch, 'local.tar.gz');
    const sp = path.join(scratch, 'SHA256SUMS');
    fs.writeFileSync(tp, rel);
    fs.writeFileSync(sp, `${sha256Hex(rel)}  ${tarballName(VERSION)}\n`);
    const { deps, fetched } = world({ releaseBytes: rel });
    const r = await verifyRelease({ version: VERSION, releaseTarball: tp, sums: sp, skipNpm: true }, deps);
    assert.deepEqual(r.errors, []);
    assert.ok(!fetched.some((u) => u.startsWith('https://github.com/')));
  });
});

describe('checkListingSignature', () => {
  const hash = sha256Hex(Buffer.from('x'));
  const good = { signingKeyId: 'mkt-sign-v1', contentHash: hash, signature: signHash(hash, platform), publicKey: pem(platform) };

  test('valid', () => assert.deepEqual(checkListingSignature(good, { pinnedKeys: PINNED }), []));
  test('signature over another hash fails', () => {
    const other = sha256Hex(Buffer.from('y'));
    assert.deepEqual(checkListingSignature({ ...good, signature: signHash(other, platform) }, { pinnedKeys: PINNED }), [
      'listing signature does not verify with the pinned mkt-sign-v1 key',
    ]);
  });
  test('missing signature fails', () => {
    assert.deepEqual(checkListingSignature({ ...good, signature: undefined }, { pinnedKeys: PINNED }), ['listing has no signature']);
  });
  test('uppercase or short contentHash fails', () => {
    assert.match(checkListingSignature({ ...good, contentHash: hash.toUpperCase() }, { pinnedKeys: PINNED })[0], /not a lowercase hex sha256/);
  });
  test('the default pinned key is the production mkt-sign-v1 key, so a throwaway signature fails', () => {
    const errs = checkListingSignature(good);
    assert.ok(errs.includes('listing signature does not verify with the pinned mkt-sign-v1 key'));
    assert.match(PINNED_SIGNING_KEYS['mkt-sign-v1'], /^-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA/);
  });
});

describe('npm and listing helpers', () => {
  test('npm per-version document URL encodes the scope', () => {
    assert.equal(npmVersionDocUrl('1.0.0'), 'https://registry.npmjs.org/@indigoai-us%2fhq-pack-core-skills/1.0.0');
  });
  test('checkNpmVersionDoc', () => {
    assert.deepEqual(checkNpmVersionDoc({ version: '1.0.0', dist: { attestations: { url: 'u' } } }, '1.0.0'), []);
    assert.equal(checkNpmVersionDoc({ version: '1.0.0', dist: { attestations: {} } }, '1.0.0').length, 1);
    assert.equal(checkNpmVersionDoc({ version: '1.0.1', dist: { attestations: { url: 'u' } } }, '1.0.0').length, 1);
  });
  test('checkNpmViewOutput', () => {
    assert.deepEqual(checkNpmViewOutput('{"version":"1.0.0","dist.attestations":{"url":"u"}}', '1.0.0'), []);
    assert.match(checkNpmViewOutput('{"version":"1.0.0"}', '1.0.0')[0], /no dist.attestations/);
    assert.match(checkNpmViewOutput('{"error":{"code":"E404","summary":"Not Found"}}', '1.0.0')[0], /Not Found/);
    assert.match(checkNpmViewOutput('', '1.0.0')[0], /shows no/);
  });
  test('parseSha256Sums', () => {
    const h = 'a'.repeat(64);
    assert.equal(parseSha256Sums(`${h}  hq-pack-core-skills-1.0.0.tar.gz\n`, 'hq-pack-core-skills-1.0.0.tar.gz'), h);
    assert.equal(parseSha256Sums(`${h} *hq-pack-core-skills-1.0.0.tar.gz\n`, 'hq-pack-core-skills-1.0.0.tar.gz'), h);
    assert.equal(parseSha256Sums(`${h}  other.tar.gz\n`, 'hq-pack-core-skills-1.0.0.tar.gz'), undefined);
  });
  test('pickListingId wants the exact slug and version', () => {
    const body = { listings: [{ id: 'a', slug: 'core-skills', version: '1.0.1' }, { id: 'b', slug: 'core', version: '1.0.0' }, { listingId: 'c', slug: 'core-skills', version: '1.0.0' }] };
    assert.equal(pickListingId(body, 'core-skills', '1.0.0'), 'c');
    assert.equal(pickListingId(body, 'core-skills', '2.0.0'), undefined);
    assert.equal(pickListingId({}, 'core-skills', '1.0.0'), undefined);
  });
  test('unwrapListingDetail reads the envelope and the flat shape', () => {
    assert.equal(unwrapListingDetail({ listing: { id: 'a', sha256: 'h' } }).contentHash, 'h');
    assert.equal(unwrapListingDetail({ listingId: 'b', url: 'u' }).downloadUrl, 'u');
  });
});

describe('parseSimpleYaml and comparePackageYaml', () => {
  test('reads the repo package.yaml', () => {
    const y = parseSimpleYaml(fs.readFileSync(path.join(REPO, 'package.yaml'), 'utf8'));
    assert.equal(y.name, 'hq-pack-core-skills');
    assert.equal(y.publisher, '@indigoai-us');
    assert.equal(y.requires.hqCore, '>=16.0.0');
    assert.ok(y.contributes.skills.includes('_shared'));
    assert.deepEqual(y.contributes.workers, []);
  });
  test('quoting, comments, nested sequences of mappings, literal blocks', () => {
    const y = parseSimpleYaml(`a: 'it''s # not a comment'  # a comment
b: "x\\ty"
c:
- one
- 'two'
d:
  - name: p1
    version: '>=1'
  - name: p2
e: [x, 'y z']
f:
g: |-
  line 1
  # still text
h: ~
`);
    assert.deepEqual(y, {
      a: "it's # not a comment",
      b: 'x\ty',
      c: ['one', 'two'],
      d: [{ name: 'p1', version: '>=1' }, { name: 'p2' }],
      e: ['x', 'y z'],
      f: null,
      g: 'line 1\n# still text',
      h: null,
    });
  });
  test('unsupported YAML throws instead of guessing', () => {
    assert.throws(() => parseSimpleYaml('a: &anchor x\n'), /not supported/);
    assert.throws(() => parseSimpleYaml('a: >\n  folded\n'), /not supported/);
    assert.throws(() => parseSimpleYaml("a: 'open\n"), /unterminated/);
    assert.throws(() => parseSimpleYaml('a: 1\na: 2\n'), /duplicate key/);
    assert.throws(() => parseSimpleYaml('a: 1\n   b: 2\n'), /indentation/);
  });
  test('author is ignored; any other change is reported', () => {
    assert.deepEqual(comparePackageYaml(PACKAGE_YAML, PUBLISHED_YAML), []);
    assert.match(comparePackageYaml(PACKAGE_YAML, PUBLISHED_YAML.replace(`version: ${VERSION}`, 'version: 9.9.9'))[0], /package.yaml version differs/);
    assert.match(comparePackageYaml(PACKAGE_YAML, `${PUBLISHED_YAML}surface: unprefixed\n`)[0], /package.yaml surface differs/);
  });
  test('canonicalJson ignores key order', () => {
    assert.equal(canonicalJson({ b: 1, a: [{ d: 1, c: 2 }] }), canonicalJson({ a: [{ c: 2, d: 1 }], b: 1 }));
  });
});

describe('compareTrees', () => {
  test('identical trees have no errors', () => {
    assert.deepEqual(compareTrees(extract(makeTarball(FILES)), extract(makeTarball(FILES))), []);
  });
});
