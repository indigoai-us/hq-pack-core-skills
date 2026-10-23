# Releasing hq-pack-core-skills

A release reaches users through two channels, published from the same tag:

| Channel | What it carries | Who publishes |
| --- | --- | --- |
| npm `@indigoai-us/hq-pack-core-skills` | Version list, `engines`, provenance. hq-cli reads it to pick a version. | `.github/workflows/release.yml`, on a `v*` tag, with OIDC trusted publishing |
| HQ marketplace, slug `core-skills` | The tarball hq-cli installs (`hq install marketplace:core-skills@<version>`) | A verified creator runs `hq publish`; staff approve the listing |

Signing happens in the marketplace channel only. When a listing is
registered, hq-pro hashes the tarball (sha256) and signs the hex hash with the
platform key `mkt-sign-v1`, which is held in AWS Secrets Manager. No GitHub
secret holds a signing key, and the workflow does not sign. At install time
hq-cli checks the sha256 of the downloaded bytes and the Ed25519 signature
against the public key embedded in hq-cli (`src/lib/pack-signing-keys.ts`)
before it extracts anything.

Merging to `main` publishes nothing. Only a pushed annotated `v*` tag runs
the release workflow.

## 1. Bump the version by pull request

1. Pick a version above npm `latest` and above every existing tag:
   `npm view @indigoai-us/hq-pack-core-skills versions --json` and
   `git -C <checkout> tag -l 'v*'`. A version slot that was tagged once is
   never reused (step 3).
2. On a branch, set the same version in `package.json` `version` and
   `package.yaml` `version`. If the `requires` ranges change, edit
   `package.yaml` `requires.hqCore` / `requires.hqCli` and `package.json`
   `engines["hq-core"]` / `engines["hq-cli"]` together. CI fails when they
   differ (`scripts/check-manifest-sync.mjs`).
3. Run `npm run check` and `npm test` locally. `npm test` needs an hq-cli
   build: `bash scripts/install-test-hq-cli.sh /tmp/hq-cli` installs the
   version in `engines["hq-cli"]` and prints the `HQ_CLI_DIR=...` to export.
4. Open the pull request.

## 2. Review and merge

- Get one approving review from the core approvers in the core-pr-reviews
  channel.
- Run `/hq-core-review` on the pull request. It must pass for the current head
  commit; a new push needs a fresh review.
- An approver merges.

## 3. Cut the tag

A person from the approver set cuts the tag on the merged commit. Tags are
annotated; the workflow rejects a lightweight tag.

```bash
git -C <checkout> fetch origin main
git -C <checkout> checkout --detach origin/main     # the merged version bump
git -C <checkout> tag -a vX.Y.Z -m "hq-pack-core-skills X.Y.Z"
git -C <checkout> push origin vX.Y.Z                # push the tag only
```

The tag message becomes the GitHub release notes.

If the workflow fails after the tag is pushed, do not move or re-push the
tag. Fix the cause on `main` and release the next version
(`indigo-release-cut-fresh-tag-not-retag`).

## 4. What release.yml does

On the pushed tag, in one Linux job with `contents: write` and
`id-token: write`:

1. Checks out the tag and force-fetches `refs/tags/<tag>` so the tag object is
   present (actions/checkout can store an annotated tag as a lightweight ref).
2. `scripts/check-release-tag.sh <tag>`: the tag is `vX.Y.Z[-pre]`, annotated,
   equal to `v<package.json version>`, `package.json` and `package.yaml` agree,
   and the tag points at the checked-out commit.
3. Sets up Node 24 and npm 11.5.1 or newer (needed for OIDC publishing).
4. Installs the hq-cli version in `engines["hq-cli"]` for the install tests.
5. `npm run check` and `npm test`. `npm test` includes the tamper test:
   the release tarball installs through hq-cli's marketplace transport, and a
   copy with one changed byte fails before extraction.
6. `scripts/build-tarball.sh` builds `hq-pack-core-skills-X.Y.Z.tar.gz`
   (`tar -C <payload> .`, `package.yaml` at the archive root, git-tracked
   files only, `.gitignore` files included) and `SHA256SUMS`.
7. `scripts/check-npm-contents.mjs` compares the npm package file list with
   the tarball (see below).
8. `npm publish --provenance --access public` (prereleases add
   `--tag next`). No npm token: the trusted publisher binding authorizes the
   run.
9. Creates the GitHub release for the tag with the tarball and `SHA256SUMS`
   as assets.
10. `node scripts/verify-release.mjs X.Y.Z --npm-only --npm-view --wait 600`:
    fails the run unless, within 10 minutes, the npm per-version document and
    `npm view @indigoai-us/hq-pack-core-skills@X.Y.Z version dist.attestations --json`
    both show the version with attestations.

The workflow cannot register the marketplace listing: `POST /v1/listings`
accepts only a verified creator's Cognito session. Steps 5 to 7 below are
done by people after the run is green.

The steps are written inline rather than calling
`indigoai-us/.github/.github/workflows/_npm-publish.yml`. That workflow runs
the publish in its own job and is built around an install step, version
stamping from the tag, Sentry and sync-back. This release needs the tarball
build, the npm-content check, the GitHub release and the attestation poll on
the same checkout as the publish, and it takes its version from the reviewed
`package.json` rather than stamping it.

### npm content and the marketplace tarball

`npm pack` and `npm publish` always leave out files named `.gitignore`, so
the npm package has no `skills/run-project/.gitignore`. The marketplace
tarball keeps it, and that tarball is what hq-cli installs; npm is read only
for versions, `engines` and provenance. The workflow publishes the package
directory with plain `npm publish` so npm's own packer, file list and
provenance stay standard, and `scripts/check-npm-contents.mjs` fails the
release on any difference other than `package.json` (npm only) and
`.gitignore` files (tarball only).

## 5. Register the marketplace listing

A verified marketplace creator, signed in with `hq login`:

```bash
mkdir -p /tmp/core-skills-X.Y.Z && cd /tmp/core-skills-X.Y.Z
gh release download vX.Y.Z -R indigoai-us/hq-pack-core-skills
sha256sum -c SHA256SUMS          # macOS: shasum -a 256 -c SHA256SUMS
mkdir pack && tar -xzf hq-pack-core-skills-X.Y.Z.tar.gz -C pack
hq publish pack
```

`hq publish` derives the slug `core-skills` from the pack name, validates
`package.yaml`, and uploads. The listing lands as `pending_review`; hq-pro
computes the content hash and the `mkt-sign-v1` signature server-side. A
second upload of the same version returns 409. Publishing on behalf of
another creator (`--as <handle>`) is staff-only.

`hq publish` changes bytes. It copies the directory, rewrites `package.yaml`
with an `author` block (re-serialized by js-yaml, so comments are dropped),
and packs a new tarball. The listing's `contentHash` therefore differs from
the sha256 of the GitHub release tarball. `scripts/verify-release.mjs`
handles this by comparing content: every file must be byte-identical and
`package.yaml` must be equal as data apart from `author`.

## 6. Approve the listing

HQ staff (Cognito account on an allowed staff domain) approve the listing in
the moderation console, or with
`POST /v1/moderation/listings/{id}` and body `{"action":"approve"}`.
Approval supersedes older versions from the same creator and slug. The
public site can lag about 20 minutes; check through the API (step 7).

## 7. Verify

```bash
node scripts/verify-release.mjs X.Y.Z
```

It checks:

- npm: the per-version document `https://registry.npmjs.org/@indigoai-us%2fhq-pack-core-skills/X.Y.Z`
  exists and has `dist.attestations`. Add `--npm-view` to also check
  `npm view @indigoai-us/hq-pack-core-skills@X.Y.Z version dist.attestations --json`.
- GitHub: the release tarball's sha256 matches `SHA256SUMS`.
- Marketplace: an approved listing for `core-skills@X.Y.Z` exists
  (`GET /v1/listings?slug=core-skills&version=X.Y.Z`, then
  `GET /v1/listings/{id}`, the calls hq-cli makes), its `signingKeyId` is
  `mkt-sign-v1`, and its signature over the hex `contentHash` verifies with
  the public key pinned in `scripts/lib/release-verify.mjs` (copied from
  hq-cli; the listing's own `publicKey` must match it but is not trusted).
- The listing tarball's sha256 equals `contentHash`, and its content equals
  the GitHub release tarball as described in step 5.

It exits non-zero and names each failed check. Use `--release-tarball` and
`--sums` to check local files instead of the release assets.

Then install into a scratch HQ root:
`hq install marketplace:core-skills@X.Y.Z`.

## One-time bootstrap (first release of the package)

The package does not exist on npm until its first publish, and a trusted
publisher is configured on an existing package. Follow
`indigo-npm-bootstrap-webauthn-oidc`:

1. With explicit approval from the operator or an npm org admin, publish a
   placeholder version by hand as the `hq-agent` account, using the
   short-lived granular access token resolved through HQ secrets into an
   ephemeral npm user configuration (never persisted or printed). Use a
   prerelease such as `0.0.0-bootstrap.0` with `--tag bootstrap`, set only in
   a scratch copy of the repo, so that every real version is published by the
   workflow with provenance. hq-cli's pin range (`^1.0.0`) does not match it.
   Deprecate it afterwards with `npm deprecate`.
2. Bind the trusted publisher on the npm package settings page, with the
   account passkey: organization `indigoai-us`, repository
   `hq-pack-core-skills`, workflow file `release.yml`, environment empty.
3. Cut the first real tag (steps 1 to 4). Confirm the version has
   attestations.
4. After that first OIDC release, set the package's publishing access to
   "Require two-factor authentication and disallow tokens".

## Rollback

To be written (US-013).
