# Contributing to hq-pack-core-skills

Changes to an existing skill follow "Changing a skill" in `README.md`. This
file covers promoting a company or personal skill into the pack, so that it
ships to every HQ as a core skill.

## Promote a company or personal skill

### 1. Import

On a branch of this repo:

```bash
bash scripts/import-skill.sh <hq-root>/companies/<co>/skills/<name>
# or a personal skill
bash scripts/import-skill.sh <hq-root>/personal/skills/<name>
```

The script:

1. Reads the frontmatter `name`, which must equal the directory name and
   must not start with `_`.
2. Refuses the import when the name is already a directory under `skills/`,
   is already listed in `package.yaml` `contributes.skills`, or is in
   `core-resident-skills.txt`. It also refuses a skill with `private: true`
   and a source directory that contains a symlink.
3. Copies the directory to `skills/<name>/`.
4. Removes these company-only frontmatter keys from `skills/<name>/SKILL.md`,
   together with any indented or `- item` lines under them:

   | Key | Why it is company-only |
   | --- | --- |
   | `skill_uid` | Registry identity of the company skill (`hq skill create`). A nested `skill_uid` line is removed too. |
   | `company` | The owning company slug |
   | `title` | Display title for HQ Console (`hq skill create`) |
   | `tags` | HQ Console tags (`hq skill create`) |
   | `status` | Free-form build status of a company skill |
   | `sandbox` | Hosted-runtime command, secrets and egress for the company |

   Other keys (`name`, `description`, `allowed-tools`, `argument-hint`,
   `metadata` and the rest) and the body are copied unchanged.
5. Adds the name to `contributes.skills` in `LC_ALL=C` order and regenerates
   `commands.json`.
6. Runs these checks. Any finding fails the import:
   - `company-bind`: `scripts/vendor/lint-skill-company-bind.sh` on the
     imported skill.
   - `path-filter`: `scripts/vendor/skill-has-unshipped-hq-path.sh`, the
     filter hq-core's Claude plugin and Codex pack builds use. A match means
     `SKILL.md` names a `core/` or `.claude/` path rooted in the HQ checkout,
     so those builds leave the skill out. Rewrite the path, or pass
     `--allow-hq-paths` to import the skill as HQ-only (most existing pack
     skills are).
   - `company-slug`: a company slug hard-coded in any file of the skill. The
     source company (from the path or the `company` key) is matched as a
     whole word; every slug in the source HQ's `companies/manifest.yaml` is
     matched as `companies/<slug>` or `--company <slug>`. Use a placeholder
     such as `{co}` and bind the session before reading company paths.
   - `pack-check`: `scripts/check.sh`, the same checks as `npm run check`.

On a refusal or a finding the script exits 1 and puts the pack back as it
was: `skills/<name>/` is removed and `package.yaml` and `commands.json` are
restored. It never commits and never changes the source skill.

Fix findings in the source skill (through the company's own `hq skill`
flow) or in the imported copy after a successful import, then rerun the
checks.

### 2. Open a pull request

Review the diff, run `npm run check` and `npm test`, commit, and open a draft
pull request. Mark it ready after the local checks pass.

### 3. Run `/hq-core-review`

`/hq-core-review` (PII, denylist and domain scans) must pass for the PR's
current head commit. A new push needs a fresh review.

### 4. Get approval in core-pr-reviews

One core approver approves the pull request in the core-pr-reviews channel.
An approver merges.

### 5. Bump the version

A separate pull request sets the same version in `package.json` `version`
and `package.yaml` `version`. If the `requires` ranges change, edit
`package.yaml` `requires.hqCore` / `requires.hqCli` and `package.json`
`engines["hq-core"]` / `engines["hq-cli"]` together; CI fails when they
differ. See `RELEASING.md` step 1. The bump goes through the same review
(steps 3 and 4).

### 6. Cut the tag

A person from the approver set cuts the annotated `v<version>` tag on the
merged bump commit. No automation tags. `RELEASING.md` steps 3 to 7 cover
the tag, the npm publish, the marketplace listing and its approval.

## The source company skill

The import copies the skill; it does not move it. The source skill stays in
`companies/<co>/skills/<name>/` until its company owner retires it through
the `hq skill` lifecycle (`hq skill delete <skl_uid | SKILL.md path | slug>`).
Until then, members of that company see two commands for the same skill,
`/<name>` from the pack and `/<co>:<name>` from the company. The owner
should retire the company skill once the pack version that carries it has
reached their hosts, so the two names do not stay side by side for long.
Personal skills are removed by their owner from `personal/skills/`.
