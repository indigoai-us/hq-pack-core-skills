# Source of skills/

`skills/` is a copy of `.claude/skills/` from hq-core-staging at one commit.
The content was copied, not rewritten: every file is byte-identical to that
commit and keeps its file mode.

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

## Re-verify

From the root of this repo, with a local hq-core-staging clone that has the
source commit:

```bash
bash scripts/verify-source.sh /path/to/hq-core-staging
```

The script runs the `diff -r` below and also compares the executable bit of
every file. The `diff -r` by itself:

```bash
tmp="$(mktemp -d)"
git -C /path/to/hq-core-staging archive 04e2312b4b878857e6df10dbef6ba64209d78d55 .claude/skills | tar -x -C "$tmp"
for s in hq-checkup hq-heal hq-login recover-session setup update-hq; do rm -rf "$tmp/.claude/skills/$s"; done
diff -r "$tmp/.claude/skills" skills && echo "no difference"
```

Empty `diff -r` output (and "no difference") means `skills/` matches the
source commit minus the six core-resident skills.

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
