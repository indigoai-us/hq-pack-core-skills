// release-verify.mjs — checks behind scripts/verify-release.mjs.
//
// Pure functions plus one orchestrator, `verifyRelease`, that takes its
// network and filesystem access as injected deps so tests run with a
// throwaway key pair and fake listings and never touch the network.
//
// What a published release must satisfy:
//   npm          the per-version document for @indigoai-us/hq-pack-core-skills@<v>
//                exists and has dist.attestations (OIDC trusted publishing
//                with provenance).
//   GitHub       the release tarball's sha256 equals its line in SHA256SUMS.
//   marketplace  an approved listing for slug core-skills at <v> exists; its
//                signingKeyId is mkt-sign-v1; its Ed25519 signature over the
//                UTF-8 bytes of the hex contentHash verifies with the public
//                key pinned below (the listing's own publicKey is checked for
//                equality, never trusted); the listing tarball's sha256 equals
//                contentHash.
//   same content the listing tarball holds the release tarball's files. When
//                the two sha256 values differ (`hq publish` re-packs the
//                directory and rewrites package.yaml to add `author`), every
//                file must be byte-identical except package.yaml, which must be
//                equal as data once `author` is removed.

import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const PACKAGE_NAME = '@indigoai-us/hq-pack-core-skills';
export const MARKETPLACE_SLUG = 'core-skills';
export const SIGNING_KEY_ID = 'mkt-sign-v1';
export const DEFAULT_API_BASE = 'https://hqapi.hq.computer';
export const DEFAULT_REGISTRY = 'https://registry.npmjs.org';
export const GITHUB_REPO = 'indigoai-us/hq-pack-core-skills';

// Copied from hq-cli src/lib/pack-signing-keys.ts (MARKETPLACE_SIGNING_KEYS),
// the key hq-cli pins for marketplace installs. Update both together on a key
// rotation.
export const PINNED_SIGNING_KEYS = Object.freeze({
  'mkt-sign-v1': `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEALmDnMFl0vMytdx/TdP8+SmZjW2oES6B1nOESioUNc6k=
-----END PUBLIC KEY-----`,
});

export function tarballName(version) {
  return `hq-pack-core-skills-${version}.tar.gz`;
}

export function releaseAssetUrl(version, asset) {
  return `https://github.com/${GITHUB_REPO}/releases/download/v${version}/${asset}`;
}

export function npmVersionDocUrl(version, registry = DEFAULT_REGISTRY) {
  return `${registry.replace(/\/$/, '')}/${PACKAGE_NAME.replace('/', '%2f')}/${encodeURIComponent(version)}`;
}

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function normalizedPem(pem) {
  return String(pem).replace(/\r\n/g, '\n').trim();
}

// ---------------------------------------------------------------------------
// npm
// ---------------------------------------------------------------------------

/** Errors for an npm per-version document (`GET <registry>/<pkg>/<version>`). */
export function checkNpmVersionDoc(doc, version) {
  if (!doc || typeof doc !== 'object') return [`npm has no document for ${PACKAGE_NAME}@${version}`];
  const errors = [];
  if (doc.version !== version) {
    errors.push(`npm document version is ${JSON.stringify(doc.version ?? null)}, expected ${version}`);
  }
  const att = doc.dist && doc.dist.attestations;
  const empty =
    att === undefined ||
    att === null ||
    (Array.isArray(att) && att.length === 0) ||
    (typeof att === 'object' && !Array.isArray(att) && Object.keys(att).length === 0);
  if (empty) {
    errors.push(`npm ${PACKAGE_NAME}@${version} has no dist.attestations (publish was not OIDC trusted publishing with provenance)`);
  }
  return errors;
}

/**
 * Errors for `npm view <pkg>@<version> version dist.attestations --json`
 * output. With two fields npm prints an object keyed by field name; on a
 * missing version it prints an `error` object or nothing.
 */
export function checkNpmViewOutput(text, version) {
  let v;
  try {
    v = JSON.parse(String(text).trim() || 'null');
  } catch {
    return [`npm view output is not JSON: ${String(text).slice(0, 200)}`];
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return [`npm view shows no ${PACKAGE_NAME}@${version}`];
  if (v.error) return [`npm view: ${v.error.summary || v.error.code || JSON.stringify(v.error)}`];
  const errors = [];
  if (v.version !== version) errors.push(`npm view version is ${JSON.stringify(v.version ?? null)}, expected ${version}`);
  const att = v['dist.attestations'];
  if (!att || (typeof att === 'object' && Object.keys(att).length === 0)) {
    errors.push(`npm view shows no dist.attestations for ${PACKAGE_NAME}@${version}`);
  }
  return errors;
}

// ---------------------------------------------------------------------------
// SHA256SUMS
// ---------------------------------------------------------------------------

/** The hex digest for `name` in a `sha256sum` style file, or undefined. */
export function parseSha256Sums(text, name) {
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(line.trim());
    if (m && m[2] === name) return m[1];
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Marketplace listing
// ---------------------------------------------------------------------------

/**
 * Pick the listing id for slug@version from a `GET /v1/listings` body. Same
 * rule as hq-cli defaultMarketplaceDeps().resolveListing: exact slug, exact
 * version, never the first result.
 */
export function pickListingId(body, slug, version) {
  const listings = (body && Array.isArray(body.listings) && body.listings) || [];
  const match = listings.find((l) => l && l.slug === slug && (l.version ?? l.latestVersion) === version);
  if (!match) return undefined;
  return match.listingId ?? match.id;
}

/** Unwrap `GET /v1/listings/{id}` (`{ listing: {...} }` or the flat legacy shape). */
export function unwrapListingDetail(body) {
  const d = body && typeof body.listing === 'object' && body.listing ? body.listing : body || {};
  return {
    id: d.id ?? d.listingId,
    slug: d.slug,
    version: d.version ?? d.latestVersion,
    downloadUrl: d.downloadUrl ?? d.url,
    contentHash: d.contentHash ?? d.sha256,
    contentHashAlg: d.contentHashAlg,
    signature: d.signature,
    signingKeyId: d.signingKeyId,
    publicKey: d.publicKey,
  };
}

/**
 * Errors for a listing's signing fields. The signature is verified with the
 * pinned key for SIGNING_KEY_ID; the listing's echoed publicKey must equal it
 * (hq-cli refuses the install otherwise) but is never used to verify.
 */
export function checkListingSignature(listing, { pinnedKeys = PINNED_SIGNING_KEYS, keyId = SIGNING_KEY_ID } = {}) {
  const errors = [];
  if (listing.signingKeyId !== keyId) {
    errors.push(`listing signingKeyId is ${JSON.stringify(listing.signingKeyId ?? null)}, expected ${keyId}`);
  }
  const pinned = Object.hasOwn(pinnedKeys, keyId) ? pinnedKeys[keyId] : undefined;
  if (!pinned) {
    errors.push(`no pinned public key for ${keyId}`);
    return errors;
  }
  if (listing.contentHashAlg !== undefined && listing.contentHashAlg !== 'sha256') {
    errors.push(`listing contentHashAlg is ${JSON.stringify(listing.contentHashAlg)}, expected sha256`);
  }
  if (typeof listing.contentHash !== 'string' || !/^[0-9a-f]{64}$/.test(listing.contentHash)) {
    errors.push(`listing contentHash ${JSON.stringify(listing.contentHash ?? null)} is not a lowercase hex sha256`);
    return errors;
  }
  if (typeof listing.publicKey !== 'string' || !listing.publicKey.trim()) {
    errors.push('listing has no publicKey; hq-cli refuses such listings');
  } else if (normalizedPem(listing.publicKey) !== normalizedPem(pinned)) {
    errors.push(`listing publicKey does not match the pinned ${keyId} key; hq-cli refuses such listings`);
  }
  if (typeof listing.signature !== 'string' || !listing.signature) {
    errors.push('listing has no signature');
    return errors;
  }
  let ok = false;
  try {
    ok = cryptoVerify(
      null,
      Buffer.from(listing.contentHash, 'utf-8'),
      createPublicKey(pinned),
      Buffer.from(listing.signature, 'base64'),
    );
  } catch (e) {
    errors.push(`signature verification errored: ${e.message}`);
    return errors;
  }
  if (!ok) errors.push(`listing signature does not verify with the pinned ${keyId} key`);
  return errors;
}

// ---------------------------------------------------------------------------
// package.yaml as data (no YAML dependency)
// ---------------------------------------------------------------------------

/**
 * Parse the YAML subset used by pack manifests and by js-yaml `dump` output:
 * block mappings, block sequences (indented or not), `- key: value` items,
 * single/double-quoted and plain scalars, `[]`, `{}`, flow sequences of
 * scalars, literal block scalars (`|`, `|-`), and comments. Scalars stay
 * strings (both sides of a comparison go through the same parser), except
 * `null`/`~`/empty, which become null. Anything else throws, so a comparison
 * never passes on input it did not understand.
 */
export function parseSimpleYaml(text) {
  const raw = String(text).split(/\r?\n/);
  const tokens = [];
  for (let n = 0; n < raw.length; n++) {
    const line = raw[n];
    if (/^\s*$/.test(line) || /^\s*#/.test(line)) continue;
    if (n === 0 && line.trim() === '---') continue;
    const indent = line.length - line.trimStart().length;
    // Errors are kept on the token and raised only if the token is parsed as
    // a node, so lines inside a literal block scalar may hold anything.
    let content = line.trim();
    let error;
    if (/^ *\t/.test(line)) error = `YAML line ${n + 1}: tab indentation is not supported`;
    else {
      try {
        content = stripComment(content, n + 1);
      } catch (e) {
        error = e.message;
      }
    }
    tokens.push({ indent, content, error, line: n + 1, rawIndex: n });
  }

  let i = 0;
  const isSeqItem = (t) => t.content === '-' || t.content.startsWith('- ');

  function parseNode(indent) {
    if (i >= tokens.length) return null;
    return isSeqItem(tokens[i]) ? parseSequence(indent) : parseMapping(indent);
  }

  function parseChildOf(parentIndent, allowSameIndentSeq) {
    const next = tokens[i];
    if (!next) return null;
    if (next.indent > parentIndent) return parseNode(next.indent);
    if (allowSameIndentSeq && next.indent === parentIndent && isSeqItem(next)) return parseSequence(parentIndent);
    return null;
  }

  function parseMapping(indent) {
    const obj = {};
    while (i < tokens.length && tokens[i].indent === indent && !isSeqItem(tokens[i])) {
      const t = tokens[i];
      if (t.error) throw new Error(t.error);
      const m = /^((?:'[^']*'|"[^"]*"|[^'":][^:]*?)):(?:\s+(.*))?$/.exec(t.content);
      if (!m) throw new Error(`YAML line ${t.line}: expected "key: value", got ${JSON.stringify(t.content)}`);
      const key = unquoteKey(m[1].trim(), t.line);
      if (Object.hasOwn(obj, key)) throw new Error(`YAML line ${t.line}: duplicate key ${key}`);
      const rest = (m[2] ?? '').trim();
      i++;
      if (rest === '') {
        obj[key] = parseChildOf(indent, true);
      } else if (/^[|>]/.test(rest)) {
        obj[key] = parseBlockScalar(rest, indent, t);
      } else {
        obj[key] = parseScalar(rest, t.line);
      }
    }
    if (i < tokens.length && tokens[i].indent > indent) {
      throw new Error(`YAML line ${tokens[i].line}: unexpected indentation`);
    }
    return obj;
  }

  function parseSequence(indent) {
    const arr = [];
    while (i < tokens.length && tokens[i].indent === indent && isSeqItem(tokens[i])) {
      const t = tokens[i];
      if (t.error) throw new Error(t.error);
      const item = t.content === '-' ? '' : t.content.slice(2).trimStart();
      if (item === '') {
        i++;
        arr.push(parseChildOf(indent, false));
      } else if (/^(?:'[^']*'|"[^"]*"|[^'"[{][^:]*?):(?:\s|$)/.test(item)) {
        // `- key: value` starts a mapping whose keys sit at the item's column.
        const col = indent + (t.content.length - item.length);
        tokens[i] = { ...t, indent: col, content: item };
        arr.push(parseMapping(col));
      } else {
        i++;
        arr.push(parseScalar(item, t.line));
      }
    }
    return arr;
  }

  function parseBlockScalar(header, parentIndent, t) {
    const m = /^\|(-?)$/.exec(header);
    if (!m) throw new Error(`YAML line ${t.line}: block scalar ${JSON.stringify(header)} is not supported`);
    // Block scalar lines are read from the raw text: blank lines and lines
    // starting with # belong to the scalar, so tokens cannot be used.
    const lines = [];
    let r = t.rawIndex + 1;
    let blockIndent;
    for (; r < raw.length; r++) {
      const line = raw[r];
      if (/^\s*$/.test(line)) { lines.push(''); continue; }
      const ind = line.length - line.trimStart().length;
      if (blockIndent === undefined) blockIndent = ind;
      if (ind < blockIndent || ind <= parentIndent) break;
      lines.push(line.slice(blockIndent));
    }
    while (i < tokens.length && tokens[i].rawIndex < r) i++;
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    const body = lines.join('\n');
    return m[1] === '-' ? body : `${body}\n`;
  }

  if (tokens.length && tokens[0].error) throw new Error(tokens[0].error);
  const value = tokens.length ? parseNode(tokens[0].indent) : null;
  if (i < tokens.length) throw new Error(`YAML line ${tokens[i].line}: could not parse ${JSON.stringify(tokens[i].content)}`);
  return value;
}

function stripComment(s, line) {
  let quote = null;
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if (quote) {
      if (quote === '"' && c === '\\') { k++; continue; }
      if (c === quote) {
        if (quote === "'" && s[k + 1] === "'") { k++; continue; }
        quote = null;
      }
      continue;
    }
    if ((c === "'" || c === '"') && (k === 0 || /[\s:[,{-]/.test(s[k - 1]))) { quote = c; continue; }
    if (c === '#' && (k === 0 || /\s/.test(s[k - 1]))) return s.slice(0, k).trimEnd();
  }
  if (quote) throw new Error(`YAML line ${line}: unterminated quoted scalar`);
  return s;
}

function unquoteKey(k, line) {
  if (k.startsWith("'") || k.startsWith('"')) return parseScalar(k, line);
  return k;
}

function parseScalar(s, line) {
  if (s === '' || s === '~' || s === 'null') return null;
  if (s.startsWith("'")) {
    if (!s.endsWith("'") || s.length < 2) throw new Error(`YAML line ${line}: unterminated single-quoted scalar`);
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (s.startsWith('"')) {
    try {
      return JSON.parse(s);
    } catch {
      throw new Error(`YAML line ${line}: unsupported double-quoted scalar ${s}`);
    }
  }
  if (s === '[]') return [];
  if (s === '{}') return {};
  if (s.startsWith('[')) {
    if (!s.endsWith(']')) throw new Error(`YAML line ${line}: unterminated flow sequence`);
    const inner = s.slice(1, -1).trim();
    if (!inner) return [];
    return splitFlow(inner, line).map((x) => parseScalar(x.trim(), line));
  }
  if (s.startsWith('{') || s.startsWith('&') || s.startsWith('*') || s.startsWith('!')) {
    throw new Error(`YAML line ${line}: ${JSON.stringify(s)} is not supported`);
  }
  return s;
}

function splitFlow(s, line) {
  const parts = [];
  let quote = null;
  let start = 0;
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === "'" || c === '"') quote = c;
    else if (c === '[' || c === '{') throw new Error(`YAML line ${line}: nested flow collections are not supported`);
    else if (c === ',') { parts.push(s.slice(start, k)); start = k + 1; }
  }
  parts.push(s.slice(start));
  return parts;
}

/** JSON with sorted object keys, for order-independent equality. */
export function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

/**
 * Errors when two package.yaml texts differ as data, ignoring the top-level
 * `author` key that `hq publish` stamps.
 */
export function comparePackageYaml(releaseText, listingText) {
  let a;
  let b;
  try {
    a = parseSimpleYaml(releaseText);
  } catch (e) {
    return [`release package.yaml: ${e.message}`];
  }
  try {
    b = parseSimpleYaml(listingText);
  } catch (e) {
    return [`listing package.yaml: ${e.message}`];
  }
  if (!a || typeof a !== 'object' || Array.isArray(a)) return ['release package.yaml is not a mapping'];
  if (!b || typeof b !== 'object' || Array.isArray(b)) return ['listing package.yaml is not a mapping'];
  const strip = (o) => {
    const { author: _author, ...rest } = o;
    return rest;
  };
  const errors = [];
  const ra = strip(a);
  const rb = strip(b);
  for (const k of new Set([...Object.keys(ra), ...Object.keys(rb)])) {
    if (canonicalJson(ra[k]) !== canonicalJson(rb[k])) {
      errors.push(`package.yaml ${k} differs: release ${canonicalJson(ra[k] ?? null)} vs listing ${canonicalJson(rb[k] ?? null)}`);
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// File trees
// ---------------------------------------------------------------------------

/** Map of relative POSIX path -> sha256 for every regular file under dir. */
export function fileDigests(dir) {
  const out = new Map();
  const walk = (abs, rel) => {
    for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
      const a = path.join(abs, ent.name);
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isSymbolicLink()) throw new Error(`unexpected symlink in tarball: ${r}`);
      if (ent.isDirectory()) walk(a, r);
      else if (ent.isFile()) out.set(r, sha256Hex(fs.readFileSync(a)));
      else throw new Error(`unexpected file type in tarball: ${r}`);
    }
  };
  walk(dir, '');
  return out;
}

/**
 * Errors when the listing tree is not the release tree. Every file must be
 * byte-identical except package.yaml, which is compared as data minus author.
 */
export function compareTrees(releaseDir, listingDir) {
  const a = fileDigests(releaseDir);
  const b = fileDigests(listingDir);
  const errors = [];
  for (const f of [...a.keys()].sort()) {
    if (!b.has(f)) errors.push(`listing tarball is missing ${f}`);
    else if (f !== 'package.yaml' && a.get(f) !== b.get(f)) errors.push(`listing tarball has different bytes for ${f}`);
  }
  for (const f of [...b.keys()].sort()) {
    if (!a.has(f)) errors.push(`listing tarball has an extra file ${f}`);
  }
  if (a.has('package.yaml') && b.has('package.yaml') && a.get('package.yaml') !== b.get('package.yaml')) {
    errors.push(
      ...comparePackageYaml(
        fs.readFileSync(path.join(releaseDir, 'package.yaml'), 'utf8'),
        fs.readFileSync(path.join(listingDir, 'package.yaml'), 'utf8'),
      ),
    );
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Run every release check. deps:
 *   fetchJson(url)   -> parsed JSON, or null on HTTP 404
 *   fetchBytes(url)  -> Uint8Array
 *   fetchText(url)   -> string
 *   extract(bytes)   -> absolute directory holding the extracted tarball
 *   readFile(path)   -> Buffer (for --release-tarball / --sums)
 *   npmView(version) -> stdout of `npm view <pkg>@<version> version dist.attestations --json`
 *   pinnedKeys       -> { keyId: PEM } (default PINNED_SIGNING_KEYS)
 * opts: { version, apiBase, registry, releaseTarball, sums, npmOnly, skipNpm, npmView }
 * Returns { errors: string[], notes: string[] }.
 */
export async function verifyRelease(opts, deps) {
  const { version } = opts;
  const apiBase = (opts.apiBase ?? DEFAULT_API_BASE).replace(/\/$/, '');
  const errors = [];
  const notes = [];
  const step = async (label, fn) => {
    try {
      await fn();
    } catch (e) {
      errors.push(`${label}: ${e.message}`);
    }
  };

  if (!opts.skipNpm) {
    await step('npm', async () => {
      const doc = await deps.fetchJson(npmVersionDocUrl(version, opts.registry));
      const errs = checkNpmVersionDoc(doc, version);
      errors.push(...errs.map((e) => `npm: ${e}`));
      if (!errs.length) notes.push(`npm: ${PACKAGE_NAME}@${version} is published with attestations`);
    });
    if (opts.npmView) {
      await step('npm view', async () => {
        const errs = checkNpmViewOutput(await deps.npmView(version), version);
        errors.push(...errs.map((e) => `npm view: ${e}`));
        if (!errs.length) notes.push(`npm view: ${PACKAGE_NAME}@${version} shows version and dist.attestations`);
      });
    }
  }
  if (opts.npmOnly) return { errors, notes };

  let releaseBytes;
  await step('github release', async () => {
    const name = tarballName(version);
    releaseBytes = opts.releaseTarball
      ? deps.readFile(opts.releaseTarball)
      : await deps.fetchBytes(releaseAssetUrl(version, name));
    const sums = opts.sums ? deps.readFile(opts.sums).toString('utf8') : await deps.fetchText(releaseAssetUrl(version, 'SHA256SUMS'));
    const want = parseSha256Sums(sums, name);
    const got = sha256Hex(releaseBytes);
    if (!want) errors.push(`github release: SHA256SUMS has no line for ${name}`);
    else if (want !== got) errors.push(`github release: ${name} sha256 is ${got} but SHA256SUMS says ${want}`);
    else notes.push(`github release: ${name} sha256=${got} matches SHA256SUMS`);
  });

  let listing;
  await step('marketplace', async () => {
    const q = new URLSearchParams({ slug: MARKETPLACE_SLUG, q: MARKETPLACE_SLUG, version });
    const search = await deps.fetchJson(`${apiBase}/v1/listings?${q}`);
    const id = pickListingId(search, MARKETPLACE_SLUG, version);
    if (!id) {
      errors.push(`marketplace: no approved listing for ${MARKETPLACE_SLUG}@${version}`);
      return;
    }
    const detail = await deps.fetchJson(`${apiBase}/v1/listings/${encodeURIComponent(id)}`);
    if (!detail) {
      errors.push(`marketplace: listing ${id} detail not found`);
      return;
    }
    listing = unwrapListingDetail(detail);
    if (listing.slug !== MARKETPLACE_SLUG || listing.version !== version) {
      errors.push(`marketplace: listing ${id} is ${listing.slug}@${listing.version}, expected ${MARKETPLACE_SLUG}@${version}`);
    }
    const sigErrors = checkListingSignature(listing, { pinnedKeys: deps.pinnedKeys ?? PINNED_SIGNING_KEYS });
    errors.push(...sigErrors.map((e) => `marketplace: ${e}`));
    if (!sigErrors.length) notes.push(`marketplace: listing ${id} is signed with ${SIGNING_KEY_ID} over contentHash ${listing.contentHash}`);
  });

  if (!listing || !listing.downloadUrl || !releaseBytes) {
    if (listing && !listing.downloadUrl) errors.push('marketplace: listing has no downloadUrl');
    return { errors, notes };
  }

  await step('listing tarball', async () => {
    const listingBytes = await deps.fetchBytes(listing.downloadUrl);
    const got = sha256Hex(listingBytes);
    if (got !== listing.contentHash) {
      errors.push(`listing tarball: sha256 is ${got} but the listing contentHash is ${listing.contentHash}`);
      return;
    }
    const releaseHash = sha256Hex(releaseBytes);
    if (got === releaseHash) {
      notes.push('content: listing contentHash equals the GitHub release tarball sha256');
      return;
    }
    const treeErrors = compareTrees(deps.extract(releaseBytes), deps.extract(listingBytes));
    errors.push(...treeErrors.map((e) => `content: ${e}`));
    if (!treeErrors.length) {
      notes.push(
        'content: listing tarball was re-packed (hq publish); every file matches the GitHub release tarball, ' +
          'package.yaml matches apart from author',
      );
    }
  });

  return { errors, notes };
}
