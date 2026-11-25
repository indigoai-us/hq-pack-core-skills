# Source of skills/

`skills/` started as a copy of `.claude/skills/` from hq-core-staging at one
commit, keeping each file's original file mode. Subsequent changes applied in
this repository are listed under "Changes after the copy" below.

| Field | Value |
| --- | --- |
| Source repo | `indigoai-us/hq-core-staging` (`git@github.com:indigoai-us/hq-core-staging.git`) |
| Source path | `.claude/skills/` |
| Source SHA | `04e2312b4b878857e6df10dbef6ba64209d78d55` |
| Source commit date | 2026-10-23T05:09:34Z |
| Copied on | 2026-10-23 |
| Copy method | `git archive 04e2312b4b878857e6df10dbef6ba64209d78d55 .claude/skills`, extracted, then the six core-resident directories removed |
| Pack version | 1.0.0 |
| Directories copied | 109 (108 skills plus `_shared`) |

## Excluded: core-resident skills

These six skills stay in hq-core `.claude/skills/` and are not in this pack.
The list is in `core-resident-skills.txt`; `scripts/check-frontmatter.sh`
fails if any of them appears under `skills/`.

- `hq-checkup`
- `hq-heal`
- `hq-login`
- `recover-session`
- `setup`
- `update-hq`

Why (open question 3 of the skills-cli-pack PRD, decided as its default):
they are the bootstrap and recovery set. A host whose CLI is broken, whose
pack install failed, or that has not installed the pack yet still needs to
sign in, check and repair HQ, recover a session, and update HQ. Keeping them in
core means recovery never depends on the pack being present.

`_shared` is not excluded. It holds helpers that skills reference by path
(`journal.sh`, `questions/`, `prd-finalize.md` and others) and moves with
the skills as a contributed item.

## Changes after the copy

- **2026-11-24 — Rename `hq lanes` to `hq runners` (hq-core-rust US-035):**
  replaced literal `hq lanes` with `hq runners` in every regular file under
  `skills/` that contains it, keeping original bytes elsewhere and original
  file modes (172 lines across 14 files under `skills/`, plus `commands.json`
  regenerated with `npm run commands`). The `hq lanes` alias is deprecated.
  Raised the `hq-cli` floor in `package.json` (`engines["hq-cli"]`) and
  `package.yaml` (`requires.hqCli`) from `>=5.345.161` to `>=5.345.210`,
  because `5.345.210` is the first `hq-cli` release with `hq runners`.
  `scripts/verify-source.sh` applies this same transform to the extracted
  staging tree before comparing against `skills/`.
- **2026-11-15 — Call-meter `displayText` pricing (`920f1e7`):** updated
  `skills/hq-cost/SKILL.md` and `skills/hq-integrations/SKILL.md` to quote
  `displayText` from the usage card. `scripts/verify-source.sh` leaves those
  two files unmodified and still reports diffs on them against `04e2312b`.

## Re-verify

`scripts/verify-source.sh` is the supported way to re-verify `skills/`. From
the root of this repo, with a local hq-core-staging clone that has the source
commit:

```bash
bash scripts/verify-source.sh /path/to/hq-core-staging
```

The script extracts the source tree, removes the six core-resident skills,
runs `apply_recorded_transforms`, and compares file contents (`diff -r`) and
executable bits against `skills/`. To run the `diff -r` comparison by hand:

```bash
tmp="$(mktemp -d)"
git -C /path/to/hq-core-staging archive 04e2312b4b878857e6df10dbef6ba64209d78d55 .claude/skills | tar -x -C "$tmp"
for s in hq-checkup hq-heal hq-login recover-session setup update-hq; do rm -rf "$tmp/.claude/skills/$s"; done
node -e 'const fs=require("node:fs"),p=require("node:path");function w(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const f=p.join(d,e.name);if(e.isDirectory())w(f);else if(e.isFile()){const b=fs.readFileSync(f,"latin1");if(b.includes("hq lanes"))fs.writeFileSync(f,b.replaceAll("hq lanes","hq runners"),"latin1");}}}w(process.argv[1])' "$tmp/.claude/skills"
diff -r "$tmp/.claude/skills" skills && echo "no difference"
```

Empty `diff -r` output (and "no difference") means `skills/` matches the
source commit minus the six core-resident skills after applying the recorded
transforms.

## Known gap in `npm pack`

`npm pack` always leaves `.gitignore` files out of the tarball, even when
`files` names them. The only one under `skills/` is
`skills/run-project/.gitignore` (it ignores `.claude-plugin/types/`, which
Claude Code writes when it loads the mod). A tarball made with `npm pack`
therefore has 318 of the 319 files under `skills/`. The publish pipeline
must build a tarball that includes it (for example with `tar`, then
`npm publish <tarball>`) or record the omission.

## After 1.0.0

From 1.0.0 on, this repo is the only copy of these skills. Changes land here
by pull request, not in hq-core-staging. This file records where the content
started; it is not updated for later edits.
