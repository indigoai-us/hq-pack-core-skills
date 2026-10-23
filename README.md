# hq-pack-core-skills

HQ core skills, shipped as a signed content pack pinned by hq-cli.

This repo is the single source for the HQ core skills: `/prd`, `/handoff`,
`/checkpoint`, `/execute-task`, `/hq-sync` and the rest of the set that
hq-core used to ship in `.claude/skills/`. A change to a skill is a pull
request here and a pack release, not an hq-core release.

## How it reaches an HQ

You do not install this pack by hand. It is required: hq-cli pins a version
range, resolves and installs the pack into `core/packages/hq-pack-core-skills`
on `hq reindex`, `hq packs update` and `/update-hq`, and refuses
`hq packs uninstall hq-pack-core-skills`.

The npm package is `@indigoai-us/hq-pack-core-skills`. The HQ marketplace
slug is `core-skills`, because hq strips the `hq-pack-` prefix from pack
names (for example `hq install marketplace:core-skills@1.0.0`).

hq-cli reads compatibility from npm metadata, which carries only
`package.json`, so `package.json` `engines["hq-core"]` and
`engines["hq-cli"]` repeat `package.yaml` `requires.hqCore` and
`requires.hqCli`. CI fails when they, or the two `version` fields, differ.

Skills keep their unprefixed names. `package.yaml` sets
`surface: unprefixed`, so each skill is linked at `.claude/skills/<name>`
(for example `.claude/skills/prd`), not `.claude/skills/hq-pack-core-skills:prd`.
`/prd` stays `/prd`, and files that point at `.claude/skills/<name>/...` keep
resolving. `_shared` is linked the same way.

Six bootstrap skills stay in hq-core so a host can recover without the pack:
`hq-checkup`, `hq-heal`, `hq-login`, `recover-session`, `setup`, `update-hq`.
They are listed in `core-resident-skills.txt` and must not be added here.

## Layout

| Path | What it is |
| --- | --- |
| `skills/<name>/` | One directory per skill, plus `_shared/` helpers |
| `package.yaml` | HQ pack manifest; `contributes.skills` lists every directory under `skills/` |
| `package.json` | npm package `@indigoai-us/hq-pack-core-skills` |
| `commands.json` | Command palette data generated from `skills/` |
| `core-resident-skills.txt` | Skills that stay in hq-core |
| `SOURCE.md` | Source commit of the initial copy and how to re-verify it |
| `scripts/` | CI checks and release scripts; `scripts/vendor/` holds scripts copied from hq-core-staging |
| `tests/run.sh` | Fixture tests for the checks; runs `tests/*.test.mjs` for the release pipeline |
| `RELEASING.md` | How a version is tagged, published to npm, listed in the marketplace and verified |
| `CONTRIBUTING.md` | How to promote a company or personal skill into the pack (`scripts/import-skill.sh`) |

## Changing a skill

To promote a company or personal skill into the pack, use
`scripts/import-skill.sh` and follow [CONTRIBUTING.md](CONTRIBUTING.md).

1. Branch, edit `skills/<name>/`, and keep the frontmatter `name` equal to the
   directory name. Do not add a `skill_uid` field.
2. Adding or removing a skill: add or remove its directory and its line under
   `contributes.skills` in `package.yaml` (sorted with `LC_ALL=C`).
3. Regenerate the command palette data:
   `npm run commands` (same as
   `bash scripts/vendor/skill-inventory.sh --json --out commands.json`).
4. Run `npm run check` and `npm test` locally. Both must pass.
5. Open a draft pull request, mark it ready after the local checks pass, and
   get one approving review. `main` accepts changes only through a reviewed
   pull request.

A release is a separate step (version bump by PR, then a tag). A version
bump or a change to the `requires` ranges edits both `package.yaml` and
`package.json`. See `RELEASING.md`.

## Checks

`npm run check` runs what CI runs on every non-draft pull request:

- `scripts/check-manifest-sync.mjs`: `package.json` `version` and
  `engines["hq-core"]` / `engines["hq-cli"]` equal `package.yaml` `version`
  and `requires.hqCore` / `requires.hqCli`.
- `scripts/check-contributes.sh`: `contributes.skills` equals the directories
  under `skills/`, in both directions, sorted, no duplicates.
- `scripts/check-frontmatter.sh`: every `skills/<dir>/SKILL.md` has
  frontmatter `name` equal to `<dir>` and no `skill_uid` field, and no
  directory is a core-resident skill. `_`-prefixed directories hold helpers
  and have no `SKILL.md`.
- `scripts/vendor/lint-skill-company-bind.sh skills`: a skill that anchors a
  company binds the session before it reads a company path.
- `scripts/vendor/skill-inventory.sh --check`: the committed `commands.json`
  equals a fresh render.

`scripts/verify-source.sh <hq-core-staging checkout>` re-checks that
`skills/` matches the source commit in `SOURCE.md`. It needs a staging clone
and is not part of CI.

## Review gate

Pull requests here go through the same review gate as hq-core-staging.
`/hq-core-review` (PII, denylist and domain scans) must pass for the PR's
current head commit before the PR is merged. A new push needs a fresh review.
Merging also needs one approving review from the core approvers, given in the
core-pr-reviews channel.

The maintainers' tooling blocks a merge until the review has passed for the
head commit.

## License

MIT. See `LICENSE`.
