# Releasing OpenAnalytics

What a version number means here, and how one is cut. Read this before tagging;
the policy is what makes the number worth reading, and a number nobody can
predict from is decoration.

## The tag is the product

A release is one commit, named `vX.Y.Z`, and **everything ships from it
together**: the ten images, the compose file, the env templates, the
Caddyfile, the migrations and the documentation. They are one artifact that
happens to be stored in two places — the git tag and the container registry.

So: **do not mix versions.** A `v0.2.0` image against a `v0.1.0` compose file is
not a supported configuration and will not be diagnosed as one. The upgrade path
checks out the tag and pulls the images that were built from it:

```sh
git fetch --tags && git checkout v0.1.0
cd infra/selfhost && ./upgrade.sh
```

This is also why the version does not live in a file that only some services
read. The git tag is the source of truth. The root `package.json` `version`
field is bumped to match in the release commit, and
`.github/workflows/release.yml` refuses to publish a tag that disagrees with
it — the two cannot drift, because the release fails instead.

The workspace packages stay at `0.0.0`. None of them is published to a package
registry; versioning them would be nine more numbers that nothing reads.

## What bumps what

While the major is `0`, the question a self-hoster actually asks is not "is this
compatible" but **"what do I have to do to take it?"** The number answers that.

| Bump                          | Means                                                                                                                                   |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **Patch** — `0.1.0` → `0.1.1` | `./upgrade.sh` and nothing else. Bug fixes, security fixes, additive API fields, documentation, dependency bumps. No new configuration. |
| **Minor** — `0.1.x` → `0.2.0` | Everything else. New features, new migrations, a new service or image, a new or renamed environment variable, any manual step at all.   |
| **Major** — `0.x` → `1.0.0`   | Not yet. See below.                                                                                                                     |

The dividing line is deliberately not "did the API change". It is: **if you have
to read the release notes before upgrading, it is at least a minor.** A patch
that needs a ClickHouse recreate, or a new required variable in
`env/worker.env`, is a minor that was numbered wrong — and the person who finds
out is someone whose deployment is half-upgraded.

Things that are minors even though they sound smaller:

- A new required variable in any `env/*.env` template. A service that must not
  boot without it will not boot without it.
- A migration that adds a table the worker writes to. It also needs a line in
  `infra/selfhost/clickhouse/oa-entrypoint.sh` and a `--force-recreate`, and
  without them inserts into the new table fail while ordinary traffic keeps
  flowing.
- Anything that changes the shape of `docker-compose.yml` an operator may have
  overridden.
- A tracker (`oa.js`) change. It is unversioned and cached for an hour by
  design, so it reaches every visitor of every site within the hour, whether or
  not they wanted it today.

Things that are patches even though they sound bigger:

- A security fix. It goes out as a patch on the current minor, fast, and is
  announced as one. See below for what we do not do.
- A new optional endpoint or response field. Nothing existing is asked to
  change.

## Zero, and what leaves it

`0.x` means one thing: **a minor may remove or rename.** Deprecations get a
release's notice where that is possible and a loud release note where it is not.

`1.0.0` is not a quality claim and will not be cut as a milestone. It is the
release at which the sentence above stops being true — where a rename waits for
a major and the upgrade path is promised, not described. Cut it when the
migration ledger, the env templates and the OpenAPI contract have gone a few
minors without a rename, because that is the evidence that the promise is
keepable. Not before.

## What is not covered

- **Backports.** While `0.x` there is one supported line: the newest minor. A
  security fix is a patch on that, and the answer to "we are on `0.3` and cannot
  take `0.6`" is that we will help, not that a `0.3.4` exists.
- **The hosted service.** getopen.so runs its own deployment on its own
  cadence and does not take these tags. Where its behaviour differs from this
  tree the difference is a bug in one of them.
- **Downgrades.** There are no down migrations, on purpose — see
  [Upgrades and going back](SELF-HOSTING.md#upgrades-and-going-back). Going back
  a version is a **restore from the backup the upgrade took**, which loses the
  events that arrived after the upgrade. That cost is stated at the point where
  somebody decides to upgrade, not at the point where they need it.

## Cutting one

1. `pnpm run verify` and `node scripts/leak-scan.mjs` green on `main`.
2. Bump `version` in the root `package.json` to the release version, and commit.
   That commit is the release. The quickstarts in `README.md` and
   `SELF-HOSTING.md` resolve the newest release themselves and need no bump: the
   checkout line lists the tags, drops every one with a `-` in it, and takes the
   first, because a candidate sorts above the release it is a candidate for and
   `git describe` would hand a self-hoster the candidate. The version numbers
   still spelled out in `SELF-HOSTING.md` are illustrations; refresh them in the
   same commit so nobody compares a stale number against what they just
   installed. The platform blueprints resolve nothing:
   `infra/selfhost/docker-compose.coolify.yml`,
   `infra/selfhost/dokploy/docker-compose.yml` and `dokploy/meta.json` pin the
   release outright, `dokploy/import.base64.txt` embeds that compose, and
   `COOLIFY.md` and `DOKPLOY.md` spell the number. Bump all of them in the same
   commit and regenerate the import blob with the one-liner in `DOKPLOY.md`.
   `v0.6.0` went out without this, and every platform install of it pulled
   `v0.5.0`.
3. `git tag -a v0.1.0 -m "v0.1.0"` and push the tag.
4. `.github/workflows/release.yml` fires on the tag: it checks the version
   agreement, builds the ten images and pushes them to
   `ghcr.io/openlabs-so/openanalytics/*` tagged with the version, and — for a
   final release only — moves `latest`.
5. Watch it. **A release whose workflow failed is a tag pointing at images that
   do not exist**, and the failure mode for whoever tries it is a `docker
compose pull` that cannot find a manifest.
6. Add the entry to `CHANGELOG.md` in the same commit as the version bump. It
   opens with what an upgrading operator has to do by hand, or with
   **Upgrade notes: none** — that line is the first thing somebody looks for
   and the reason the file exists rather than a list of commits.
7. Write the release notes on the GitHub release. They are the CHANGELOG entry
   for this version, pasted: two places that say different things about one
   release is the drift this file exists to prevent.

**Pre-releases** are `vX.Y.Z-rc.N`. They publish the same ten images under the
pre-release tag and deliberately do not move `latest`, so the way to test the
pipeline is to use it rather than to reason about it. A candidate is checked
against the version it is a candidate for — `v0.2.0-rc.1` wants `0.2.0` in
`package.json`, not `0.2.0-rc.1`, so a second attempt is a tag rather than
another commit.

## Releasing from a fork

A fork can run the same workflow and publish its own images. Set the
repository variable `OA_IMAGE_REPO` to the fork's registry path, in lower case
(`ghcr.io/perierhq/openanalytics` for the perierhq fork); the workflow pushes
there instead of `ghcr.io/openlabs-so/openanalytics`. Everything else in this
file applies, including the package visibility check below.

Tag a fork's build as a pre-release (`vX.Y.Z-<fork>.N`), so it never moves
`latest`. The version check compares only the part before the `-`, so the
perierhq build `v0.8.1-perier.1` has `0.8.1` in `package.json`. A deployment
then names the fork's registry when it upgrades, because `upgrade.sh` defaults
to this repository's:

```sh
OA_IMAGE_REPO=ghcr.io/perierhq/openanalytics ./upgrade.sh --to v0.8.1-perier.1
```

## Check that a new package is public. Do not assume either way

A container package can be **private when it is first created**, whatever the
repository's visibility, and there is no API to change it: the fix is a visit to
that package's settings page (`Package settings`, then `Change visibility`, then
`Public`).

That happened on v0.1.0 for the original eight. It did **not** happen on v0.3.0,
which added `clickhouse` and `valkey`: both came out public with nothing clicked.
Two data points and no announcement of a change between them, so the honest rule
is to check rather than to believe either one.

Checking is one command per new image, from a machine that has never logged in
to GHCR, which is the only place the answer is real:

```sh
docker manifest inspect ghcr.io/openlabs-so/openanalytics/<name>:<version>
```

A release that adds no image needs none of this. If a `docker compose pull` from
a clean machine says `denied` or `manifest unknown` for one image and works for
the others, this is why.
