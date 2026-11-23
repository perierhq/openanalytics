# hermes

The deployment profile for **hermes**, the perierhq fork's production host: a
2 vCPU / 3.7 GiB VPS running `infra/selfhost` from `/opt/openanalytics`, behind
Cloudflare Tunnel. It serves `analytics.perier.pl` (dashboard),
`oa-api.perier.pl` (api, MCP at `/mcp`), `oa.perier.pl` (collector and `oa.js`)
and `oa-rt.perier.pl` (realtime).

These files used to be hand-edited on the server, and every upgrade could
overwrite them. Here they ship with the tree. Nothing in `infra/selfhost` changes
for anyone else: this directory only takes effect where `.env` names the overlay.

**No secrets here.** They stay on the server, in files git ignores:
`infra/selfhost/.env`, `infra/selfhost/env/*.env` and
`infra/selfhost/docker-compose.override.yml` (the three signing key pairs).

## What is here

| File                        | Mounted as                                       | What and why                                                                                                                                                                                                                                                                                      |
| --------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docker-compose.hermes.yml` | an overlay after `docker-compose.override.yml`   | The non-secret part of the old hand-edited override: Caddy's port and the three mounts below.                                                                                                                                                                                                     |
| `Caddyfile`                 | `/etc/caddy/Caddyfile` in `caddy`                | HTTP only (`auto_https off`): Cloudflare Tunnel terminates TLS. `client_identity_hygiene` keeps `CF-Connecting-IP`, `CF-IPCountry` and `CF-IPCity`, which Cloudflare overwrites at the edge, strips the other platform headers, and does not set `X-Real-IP` from the peer, which is cloudflared. |
| `clickhouse-hermes.xml`     | `/etc/clickhouse-server/config.d/zz-hermes.xml`  | Server memory capped at 1.5 GiB (the default is 90 % of the box), caches sized for MiB of data, the per-second and profiler logs removed (they took most of the idle CPU and filled the disk with 11 GiB), 7-day TTLs on the logs that stay.                                                      |
| `valkey-queue-hermes.conf`  | `/usr/local/etc/valkey/valkey-queue-hermes.conf` | The image's own queue policy (included, so a release that changes it reaches hermes) plus `save ""`: AOF is the durable copy, and the periodic RDB snapshots rewrote the whole dataset every few minutes (about 450 GB in six weeks) for no durability gain.                                      |

Caddy is published on `127.0.0.1:8080` only. cloudflared runs on the host and
forwards each hostname to `http://127.0.0.1:8080`. Nothing listens on a public
interface, and there is no 443.

The Caddyfile no longer hand-serves `/.well-known/oauth-protected-resource`.
That was a hotfix for v0.8.0, which advertised `<origin>/api/auth` as the
authorization server while Better Auth issues as the bare origin, so MCP and
OAuth clients stopped at "issuer mismatch". The api now advertises the issuer
Better Auth uses (`fix(api): advertise the issuer …`), so the hotfix must go
together with an upgrade to a build that has the fix. Running this Caddyfile
with v0.8.0 images brings the mismatch back.

## How compose picks it up

Through one line in `infra/selfhost/.env`, the way `NEON.md` adds its overlay:

```sh
COMPOSE_FILE=docker-compose.yml:docker-compose.override.yml:../hermes/docker-compose.hermes.yml
```

Not `-f` on the command line: passing `-f` turns off compose's automatic pickup
of `docker-compose.override.yml`, where the key pairs are, and `upgrade.sh`,
`snapshot.sh` and `rollback.sh` run plain `docker compose` commands that would
not know about the overlay. `.env` is read by all of them. The overlay's `!override`
on Caddy's ports needs Docker Compose 2.24.4 or newer.

## Images

The fork publishes its own images to `ghcr.io/perierhq/openanalytics`
(`release.yml` with the repository variable `OA_IMAGE_REPO` set). Fork releases
are tagged `vX.Y.Z-perier.N`.

`upgrade.sh` takes the registry from the **shell** environment, not from `.env`,
and defaults to `ghcr.io/openlabs-so/openanalytics`. Run it with
`OA_IMAGE_REPO=ghcr.io/perierhq/openanalytics` every time, or it rewrites `.env`
to the upstream registry, where a `-perier` tag does not exist, and the pull
fails with the stack stopped.

A GHCR package is private when it is first created. Either make each of the ten
`perierhq/openanalytics/*` packages public, or log hermes in once with a token
that has `read:packages`:

```sh
echo "$GHCR_TOKEN" | docker login ghcr.io -u <github-user> --password-stdin
```

## Moving hermes onto this profile (once)

Read the release's `CHANGELOG.md` entry first. `v0.8.1-perier.1` also carries
upstream's unreleased changes since 0.8.0; the one with a manual step is the
RustFS swap, which matters only if hermes runs the `object-storage` profile.

From `/opt/openanalytics`, as the user that owns the checkout:

```sh
# 1. The fork's tags. Skip if `origin` already is perierhq/openanalytics.
git remote add perier https://github.com/perierhq/openanalytics.git
git fetch perier --tags

# 2. Keep a copy of what is there now, then take the non-secret parts out of the
#    override: caddy's `ports`, the clickhouse `zz-hermes.xml` mount, and the
#    valkey-queue config (its OA_VALKEY_CONF and volume). Leave the key pairs.
cp infra/selfhost/docker-compose.override.yml ~/override.before-hermes-profile.yml
cp infra/selfhost/.env ~/env.before-hermes-profile
"${EDITOR:-vi}" infra/selfhost/docker-compose.override.yml

# 3. Name the overlay.
echo 'COMPOSE_FILE=docker-compose.yml:docker-compose.override.yml:../hermes/docker-compose.hermes.yml' >> infra/selfhost/.env

# 4. The release, from its own tree, with the fork's images.
git checkout v0.8.1-perier.1
cd infra/selfhost
docker compose config --quiet          # the three files merge; prints nothing when they do
OA_IMAGE_REPO=ghcr.io/perierhq/openanalytics ./upgrade.sh
```

Leaving a duplicate in the override is harmless (the overlay comes last, and
the same mount target or environment key is replaced, not added), but the
override is meant to hold only secrets.

## Later upgrades

Two things to do every time, both learned the hard way on 2026-11-23:

- **Free the disk first.** Every release's images are about 6–8 GB here, and the
  disk is 38 GB. With the previous release's images still on it, the pull runs
  out of space after `upgrade.sh` has already stopped the stack. Remove the
  images of every release except the one running now; any of them can be pulled
  again if `rollback.sh` needs it.
- **Run `upgrade.sh` on the server, detached.** It stops the stack before it
  takes its snapshot. Started over an SSH session that then drops, it dies
  halfway and leaves Caddy and the worker stopped, which loses every visit until
  someone notices. Start it with `nohup setsid` and read its log.

```sh
cd /opt/openanalytics
git fetch origin --tags
git checkout v0.11.1                   # whichever release
git describe --tags --exact-match HEAD # must print the release before going on

# Images of anything but the running release (its tag is OA_IMAGE_TAG in .env).
RUNNING="$(grep '^OA_IMAGE_TAG=' infra/selfhost/.env | cut -d= -f2)"
docker images --format '{{.Repository}}:{{.Tag}}' \
  | grep '^ghcr.io/perierhq/openanalytics/' | grep -v ":$RUNNING$" \
  | xargs -r docker rmi
docker image prune -f
df -h /                                # leave at least 10 GB free

cd infra/selfhost
OA_IMAGE_REPO=ghcr.io/perierhq/openanalytics \
  nohup setsid ./upgrade.sh --yes > /root/oa-upgrade.log 2>&1 < /dev/null &
tail -f /root/oa-upgrade.log           # ends with "upgrade: done. <old> -> <new>"
```

After a good upgrade, delete the images of the release you came from the same
way, so the next one starts with room. Snapshots in `backups/` are about 260 MB
each and nothing removes them; keep the newest two and delete older directories
by hand (`./snapshot.sh list` shows them).

If an upgrade dies with the stack stopped and nothing migrated, start what was
there: put the old tag back in `.env` (`OA_IMAGE_TAG`), check out that release,
and run `docker compose up -d --pull never`.

## Checks after an upgrade

```sh
cd /opt/openanalytics/infra/selfhost
docker compose ps
docker compose port caddy 80           # 127.0.0.1:8080
docker compose exec clickhouse clickhouse-client --query \
  "SELECT value FROM system.server_settings WHERE name = 'max_server_memory_usage'"   # 1610612736
docker compose exec valkey-queue sh -c 'REDISCLI_AUTH="$VALKEY_PASSWORD" valkey-cli CONFIG GET save'  # save, then an empty line
curl -s https://oa-api.perier.pl/.well-known/oauth-protected-resource       # authorization_servers: the issuer below
curl -s https://oa-api.perier.pl/.well-known/oauth-authorization-server | grep -o '"issuer":"[^"]*"'
```

The `authorization_servers` entry and the `issuer` must be the same string.
