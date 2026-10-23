#!/usr/bin/env node
// Vendored from indigoai-us/hq-core-staging core/scripts/skill-inventory.mjs
// at 04e2312b4b878857e6df10dbef6ba64209d78d55. Changes for the pack layout:
//   - discovery reads only <root>/skills/<dir>/SKILL.md. Every pack skill is
//     surfaced unprefixed, so each entry gets scope "core" and invoke
//     "/<dir>", the same values staging's shipped render gives .claude/skills.
//     There are no slash commands in the pack, so "commands" is always [].
//   - output path is commands.json at the pack root; --check compares only
//     that file. The --markdown mode and --scope flag are not carried; the
//     document's "scope" field stays "shipped" so the JSON shape matches
//     staging's core/docs/hq/commands.json.
// Frontmatter parsing, grouping, duplicate analysis and JSON rendering are
// unchanged from the source.
//
// skill-inventory.mjs — read-only inventory of the pack's skills.
//
// Each JSON skill entry carries the same field names as the desktop
// SkillEntry (name, description, scope, tags, searchTerms, invoke, skillUid)
// plus group, source, hash, and duplicates.
//
// Entry point: scripts/vendor/skill-inventory.sh (see --help there).
// The script only reads the tree. It writes nothing unless --out is given,
// and then only to that one path.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const GENERATED_BY = 'scripts/vendor/skill-inventory.sh';
const JSON_PATH = 'commands.json';
const SCOPE = 'shipped';

// Near-duplicate rule: Jaccard similarity of description token sets.
// Tokens are lowercase [a-z0-9]+ runs of 3+ characters minus STOPWORDS.
// A pair is flagged when both sets have at least NEAR_MIN_TOKENS tokens and
// the similarity is at least NEAR_THRESHOLD.
export const NEAR_THRESHOLD = 0.5;
export const NEAR_MIN_TOKENS = 4;
const STOPWORDS = new Set(
  ('the and for with from into that this then than when use uses using used ' +
    'run runs its are was were will can not any all one per via your you our ' +
    'also only each such over under out off before after through').split(' '),
);

// Job groups. A skill takes the first group whose keywords match a token of
// its name; when no name token matches, the first group whose keywords match
// a description token; otherwise "other". Order matters.
export const GROUPS = [
  ['session state', ['handoff', 'checkpoint', 'resume', 'resumework', 'startwork', 'journal', 'session', 'sessions', 'recover', 'pin', 'compact', 'conduct']],
  ['sync', ['sync', 'conflict', 'conflicts', 'update', 'promote', 'backmerge']],
  ['share', ['share', 'dm', 'broadcast', 'message', 'messages', 'invite', 'delegate', 'publish', 'slack', 'access', 'grant', 'grants']],
  ['ship', ['land', 'ship', 'deploy', 'release', 'execute', 'pipeline', 'review', 'quality', 'tdd', 'test', 'tests', 'merge', 'commit', 'worktree', 'investigate', 'diagnose', 'pr']],
  ['plan', ['plan', 'prd', 'brainstorm', 'strategize', 'ideate', 'idea', 'grill', 'grilling', 'architect', 'design', 'wayfinder', 'estimate', 'goals', 'tickets', 'roadmap']],
  ['capture', ['capture', 'learn', 'meeting', 'notes', 'signals', 'record', 'import', 'discover', 'ontology', 'knowledge', 'interview']],
];

function usage() {
  return `Usage: skill-inventory.sh [--root <pack>] (--json|--findings|--check) [--out <path>]

Read-only inventory of the pack's skills (<root>/skills/<dir>/SKILL.md).

  --root <pack>   pack root to scan (default: current directory)
  --json          command palette data (${JSON_PATH})
  --findings      duplicate report: exact dupes, drifted copies, near-dupes
  --check         exit 1 when the checked-in ${JSON_PATH} under --root
                  differs from a fresh render
  --out <path>    write the output to this one file instead of stdout
`;
}

function parseArgs(argv) {
  const o = { root: process.cwd(), mode: '', out: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const need = () => {
      if (i + 1 >= argv.length) fail(`${a} requires a value`);
      return argv[++i];
    };
    if (a === '--root') o.root = need();
    else if (a === '--out') o.out = need();
    else if (['--json', '--findings', '--check'].includes(a)) {
      if (o.mode) fail('choose one of --json, --findings, --check');
      o.mode = a.slice(2);
    } else if (a === '-h' || a === '--help') {
      process.stdout.write(usage());
      process.exit(0);
    } else fail(`unknown argument: ${a}`);
  }
  if (!o.mode) fail('one of --json, --findings, --check is required');
  if (o.mode === 'check' && o.out) fail('--check does not take --out');
  return o;
}

function fail(msg) {
  process.stderr.write(`skill-inventory: ${msg}\n\n${usage()}`);
  process.exit(64);
}

// ── Frontmatter ───────────────────────────────────────────────────────────

function unquote(v) {
  v = v.trim();
  if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}

function inlineList(v) {
  const inner = v.trim().slice(1, -1).trim();
  if (!inner) return [];
  return inner.split(',').map(unquote).filter(Boolean);
}

// Minimal YAML subset: top-level scalars, quoted scalars, folded (>, >-) and
// literal (|, |-) blocks, inline [a, b] lists, and "- item" block lists.
export function parseFrontmatter(text) {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== '---') return { front: {}, body: text };
  let end = lines.indexOf('---', 1);
  if (end < 0) return { front: {}, body: text };
  const front = {};
  const fm = lines.slice(1, end);
  for (let i = 0; i < fm.length; i++) {
    const m = /^([A-Za-z0-9_-]+):(.*)$/.exec(fm[i]);
    if (!m) continue;
    const key = m[1];
    const rest = m[2].trim();
    if (/^[>|][+-]?$/.test(rest)) {
      const block = [];
      while (i + 1 < fm.length && (/^\s/.test(fm[i + 1]) || fm[i + 1] === '')) block.push(fm[++i].trim());
      front[key] = rest[0] === '>' ? block.filter(Boolean).join(' ') : block.join('\n').trim();
    } else if (rest === '') {
      const items = [];
      while (i + 1 < fm.length && /^\s*-\s+/.test(fm[i + 1])) items.push(unquote(fm[++i].replace(/^\s*-\s+/, '')));
      front[key] = items.length ? items : '';
    } else if (rest.startsWith('[') && rest.endsWith(']')) {
      front[key] = inlineList(rest);
    } else {
      front[key] = unquote(rest);
    }
  }
  return { front, body: lines.slice(end + 1).join('\n') };
}

function firstParagraph(body) {
  const para = [];
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      if (para.length) break;
      continue;
    }
    if (line.startsWith('#')) {
      if (para.length) break;
      continue;
    }
    para.push(line);
  }
  return para.join(' ');
}

const asList = (v) => (Array.isArray(v) ? v : typeof v === 'string' && v ? [v] : []);
const dedupe = (xs) => xs.filter((x, i) => x && xs.indexOf(x) === i);

// ── Discovery ─────────────────────────────────────────────────────────────

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function listDirs(p) {
  if (!isDir(p)) return [];
  return fs
    .readdirSync(p)
    .filter((n) => !n.startsWith('.') && !n.startsWith('_') && !/sync-conflict/i.test(n) && isDir(path.join(p, n)))
    .sort();
}

function makeEntry(root, file, invokeName, scope, kind) {
  const raw = fs.readFileSync(file);
  const { front, body } = parseFrontmatter(raw.toString('utf8'));
  const bare = invokeName.slice(invokeName.lastIndexOf(':') + 1);
  const name = (typeof front.name === 'string' && front.name.trim()) || bare;
  const description = (typeof front.description === 'string' && front.description.trim()) || firstParagraph(body);
  const uid = typeof front.skill_uid === 'string' ? front.skill_uid.trim() : '';
  return {
    name,
    description,
    scope,
    tags: dedupe(asList(front.tags).map(String)),
    searchTerms: dedupe(asList(front.triggers).map(String)),
    invoke: `/${invokeName}`,
    skillUid: uid || null,
    group: groupFor(name, description),
    source: path.relative(root, file).split(path.sep).join('/'),
    hash: `sha256:${createHash('sha256').update(raw).digest('hex')}`,
    kind,
  };
}

// Pack skills are linked unprefixed into .claude/skills/<dir>, so each one
// takes the scope and invoke staging gives an unprefixed .claude/skills dir.
export function discover(root) {
  const skills = [];
  for (const dir of listDirs(path.join(root, 'skills'))) {
    const file = path.join(root, 'skills', dir, 'SKILL.md');
    if (isFile(file)) skills.push(makeEntry(root, file, dir, 'core', 'skill'));
  }
  return { skills, commands: [] };
}

// ── Grouping ──────────────────────────────────────────────────────────────

const words = (s) => (s.toLowerCase().match(/[a-z0-9]+/g) || []);

export function groupFor(name, description) {
  for (const source of [words(name), words(description)]) {
    const set = new Set(source);
    for (const [group, keys] of GROUPS) if (keys.some((k) => set.has(k))) return group;
  }
  return 'other';
}

// ── Duplicates ────────────────────────────────────────────────────────────

export function tokens(s) {
  return new Set(words(s).filter((w) => w.length >= 3 && !STOPWORDS.has(w)));
}

export function jaccard(a, b) {
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union ? inter / union : 0;
}

// Copies of one skill under the same invoke with identical bytes (for example
// a personal/skills source and its .claude/skills/personal:x mirror) collapse
// to one entry before name matching; if the bytes differ they are reported as
// a drifted copy.
export function analyze(entries) {
  const seen = new Set();
  const distinct = [];
  for (const e of entries) {
    const key = `${e.invoke}\0${e.hash}`;
    if (!seen.has(key)) distinct.push(e);
    seen.add(key);
  }
  const logical = [];
  const invokes = new Set();
  for (const e of distinct) {
    if (!invokes.has(e.invoke)) logical.push(e);
    invokes.add(e.invoke);
  }

  const byName = new Map();
  for (const e of distinct) {
    const key = e.name.toLowerCase();
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(e);
  }

  const exactDuplicates = [];
  const driftedCopies = [];
  for (const [name, list] of [...byName].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (list.length < 2) continue;
    const ref = (e) => ({ invoke: e.invoke, source: e.source, hash: e.hash });
    const hashes = new Set(list.map((e) => e.hash));
    if (hashes.size === 1) exactDuplicates.push({ name, hash: list[0].hash, entries: list.map(ref) });
    else driftedCopies.push({ name, entries: list.map(ref) });
  }

  const nearDuplicates = [];
  const tok = logical.map((e) => tokens(e.description));
  for (let i = 0; i < logical.length; i++) {
    for (let j = i + 1; j < logical.length; j++) {
      const a = logical[i];
      const b = logical[j];
      if (a.name.toLowerCase() === b.name.toLowerCase()) continue;
      if (tok[i].size < NEAR_MIN_TOKENS || tok[j].size < NEAR_MIN_TOKENS) continue;
      const score = jaccard(tok[i], tok[j]);
      if (score >= NEAR_THRESHOLD) {
        nearDuplicates.push({ a: a.invoke, b: b.invoke, score: Math.round(score * 1000) / 1000 });
      }
    }
  }
  nearDuplicates.sort((x, y) => y.score - x.score || x.a.localeCompare(y.a) || x.b.localeCompare(y.b));

  for (const e of entries) {
    const same = byName.get(e.name.toLowerCase()).filter((o) => o.invoke !== e.invoke || o.hash !== e.hash);
    e.duplicates = {
      exact: same.filter((o) => o.hash === e.hash).map((o) => o.source),
      drifted: same.filter((o) => o.hash !== e.hash).map((o) => o.source),
      near: nearDuplicates
        .filter((n) => n.a === e.invoke || n.b === e.invoke)
        .map((n) => ({ invoke: n.a === e.invoke ? n.b : n.a, score: n.score })),
    };
  }

  return {
    rule: {
      exactDuplicates: 'same name (case-insensitive), identical SKILL.md bytes, different source path',
      driftedCopies: 'same name (case-insensitive), different SKILL.md bytes',
      nearDuplicates: `different names, description token Jaccard >= ${NEAR_THRESHOLD} (tokens: lowercase [a-z0-9]+ of 3+ chars minus stopwords; both sets >= ${NEAR_MIN_TOKENS} tokens)`,
    },
    counts: {
      exactDuplicates: exactDuplicates.length,
      driftedCopies: driftedCopies.length,
      nearDuplicates: nearDuplicates.length,
    },
    exactDuplicates,
    driftedCopies,
    nearDuplicates,
  };
}

// ── Render ────────────────────────────────────────────────────────────────

export function build(root) {
  const scopeMode = SCOPE;
  const { skills, commands } = discover(root);
  const findings = analyze([...skills, ...commands]);
  const strip = (e) => {
    const { kind, ...rest } = e;
    void kind;
    return rest;
  };
  return {
    version: 1,
    generatedBy: GENERATED_BY,
    scope: scopeMode,
    skills: skills.map(strip),
    commands: commands.map(strip),
    findings,
  };
}

export function renderJson(doc) {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

export function renderFindings(doc) {
  const f = doc.findings;
  const out = [];
  out.push(`Skills: ${doc.skills.length}  Commands: ${doc.commands.length}  Scope: ${doc.scope}`);
  out.push(`Exact duplicates: ${f.counts.exactDuplicates}`);
  for (const d of f.exactDuplicates) out.push(`  ${d.name}: ${d.entries.map((e) => e.source).join(', ')}`);
  out.push(`Drifted copies: ${f.counts.driftedCopies}`);
  for (const d of f.driftedCopies) out.push(`  ${d.name}: ${d.entries.map((e) => e.source).join(', ')}`);
  out.push(`Near-duplicate descriptions: ${f.counts.nearDuplicates}`);
  for (const n of f.nearDuplicates) out.push(`  ${n.a} ~ ${n.b} (${n.score})`);
  return `${out.join('\n')}\n`;
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  if (!isDir(o.root)) fail(`--root is not a directory: ${o.root}`);
  const root = fs.realpathSync(o.root);
  const doc = build(root);

  if (o.mode === 'check') {
    const file = path.join(root, JSON_PATH);
    const have = isFile(file) ? fs.readFileSync(file, 'utf8') : null;
    if (have !== renderJson(doc)) {
      process.stderr.write(
        `skill-inventory: stale generated file: ${JSON_PATH}\n` +
          `Regenerate with: bash scripts/vendor/skill-inventory.sh --json --out ${JSON_PATH}\n`,
      );
      process.exit(1);
    }
    process.stdout.write('skill-inventory: generated files are current\n');
    return;
  }

  const text = o.mode === 'json' ? renderJson(doc) : renderFindings(doc);
  if (o.out) fs.writeFileSync(o.out, text);
  else process.stdout.write(text);
}

main();
