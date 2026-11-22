# OpenAnalytics on Coolify

A step-by-step install, written from one that was done rather than from the
compose file. Coolify 4.3.2, a 4 GB Hetzner box, four real hostnames and real
Let's Encrypt certificates.

**Not a supported path yet.** One install on one platform is a demonstration,
not a promise. What it is no longer is a file nobody has run.

## Before you start

- A Coolify install you are an admin of, and a server it can deploy to.
- **Four DNS records**, all pointing at that server. The dashboard, the api, the
  collector and the realtime stream are four hostnames, not four paths. See
  [SELF-HOSTING.md](../../SELF-HOSTING.md#four-names-and-why-it-is-four) for why.
- About 4 GB of RAM for the stack, on top of whatever Coolify itself uses.
- **25 GB of free disk**, or 15 GB and one command before each upgrade. A release
  is about 13 GB of images, and Coolify pulls the new set before it releases the
  old one, so an upgrade holds two generations at once. Measured on a 38 GB box:
  it installed cleanly, upgraded once, and ran out during the second, part-way
  through extracting a layer. The error names a file inside `node_modules` and
  never names the disk.

  On the smaller box, clear the previous release first:

  ```sh
  docker image prune -a -f      # keeps whatever the running containers use
  ```

## 1. Create the resource

**+ New**, then **Public Repository**. Not "Docker Compose": that one gives you
an empty editor to paste a file into. The repository flow is the one that clones
this tree, and it asks for the build pack afterwards.

Paste the repository, continue, and Coolify shows a configuration screen with
its own guesses. Three of them are wrong for this stack:

| Field          | Coolify's guess | Set it to             |
| -------------- | --------------- | --------------------- |
| Build Pack     | `railpack`      | **Docker Compose**    |
| Base Directory | `/`             | **`/infra/selfhost`** |
| Branch         | `main`          | leave it, see below   |

Changing the build pack replaces "output type" and "port" with **Docker Compose
Location**. That field defaults to `/docker-compose.yaml` and must become:

```
/docker-compose.coolify.yml
```

Type it carefully. Every character is load-bearing and the error it produces is
the same one for all of them: `Docker Compose file not found at ...`. The name
has one dot before `coolify`, the extension is `.yml` and not `.yaml`.

**The branch is `main` and there is nowhere to change it.** Coolify says as much
on the create screen, and on 4.3.2 the field does not appear afterwards either.
It does not matter, and the reason is worth knowing rather than working around:
**the images are pinned in the compose file, not by the checkout.** Every
`image:` line here reads `${OA_IMAGE_TAG:-v0.10.1}`, so a clone of `main` runs
the release named in the file it just cloned. What a tag would add is that the
env templates and the migrations come from the same commit as well; `main`
carries them too, right up until the next change lands on it.

If you want the tree pinned as well, set `OA_IMAGE_TAG` in the environment
variables to the release you mean and redeploy after each release rather than on
every push.

## 2. Domains, one per service

**Domains** in the left menu, then a row per service. Four of them:

| Service     | Domain         |
| ----------- | -------------- |
| `web`       | `app.<domain>` |
| `api`       | `api.<domain>` |
| `collector` | `c.<domain>`   |
| `realtime`  | `rt.<domain>`  |

Three things to check on each, because each has been got wrong on a real install:

**The protocol must be `https`.** A row left on `http` is served without a
certificate and no certificate is ever requested for it, because Coolify only
asks for one for an `https` domain. The container is healthy the whole time,
which is what makes it hard to see.

**The port should fill itself in. If it does not, type it.** Coolify reads it
from the `expose:` lines in the compose file, so `web` gets 3000, `api` 8082,
`collector` 8083 and `realtime` 8084 without help. It has been observed not to
for the collector. If a port box is empty, fill it: an empty one means Traefik
has nowhere to send the request, so the router is dropped and, again, no
certificate is requested and nothing is logged.

| Service     | Port   |
| ----------- | ------ |
| `web`       | `3000` |
| `api`       | `8082` |
| `collector` | `8083` |
| `realtime`  | `8084` |

**Ignore "DNS is not pointing to the right IP" if your records are correct.**
Coolify's check resolves from inside its own container and has been wrong on
records that were right. Verify it yourself and continue:

```sh
dig +short app.<domain> A
```

## 3. Environment variables

**Environment Variables** in the left menu. Most of them are already filled:
every password, every base64 secret, every FQDN. Do not touch those.

**Two things are deliberately not there.** The two signing key pairs, and the
credential keyring that encrypts connected provider credentials. A one-shot step
inside the stack makes both and hands them over as files, because no generator
on this platform can produce either: a keypair whose halves must match across two
services is not a random string, and the keyring needs exactly 32 bytes while
`SERVICE_BASE64_` gives 32 base64 _characters_, which is 24. That last one is
not hypothetical. It is what shipped through v0.4.0, and it left every install
without an **Account → Deployment** tab.

**Coolify keeps two copies of every variable: `Production` and `Preview`.** They
are two rows with the same name, and the list does not make the difference
obvious. A normal deploy reads **Production**. `Preview` is for preview
deployments, which this stack does not use. Editing the wrong one is silent: the
value you typed is stored, and the deploy reads the empty one beside it.

Nothing here is required any more, since the compose file carries a default for
the one variable that used to be. If you want your own sender address, set
`OA_EMAIL_FROM` on the **Production** row. Setting it on both costs nothing and
saves you checking which is which.

`OA_EMAIL_FROM` is a from-address and not a lock: mail is configured later from
the dashboard under **Account** then **Deployment**, and a relay stored there
wins over anything in the environment. Magic links work regardless of what is
set here.

## 4. Deploy

The first deploy pulls nine images, about 2 GB, and downloads a 60 MB geo
database. Nothing is built.

When it finishes there are **thirteen containers, and three of them have
exited**. That is success, not failure: `migrate`, `keygen` and `geoip` are
one-shot steps that do their work and stop. The other ten stay up and go
healthy, `web` last.

Then open `https://app.<domain>`. A deployment nobody has signed into offers to
create the first account rather than asking you to sign in. **Do that
immediately.** The offer is open to whoever asks first and your DNS records are
public. It closes permanently the moment one account exists.

## Things that are true here and nowhere else

**The geo database is fetched for you, and it comes with a licence condition.**
Through v0.4.1 this install reported a null country for every visitor: the volume
started empty and there is no checkout here to fill it from. The `geoip` one-shot
now downloads **DB-IP City Lite** on the first deploy and never again, so the
network is a first-install dependency and later deploys skip it entirely.

DB-IP and not MaxMind because of the licence, and it is the whole reason a
download on your behalf is possible at all: GeoLite2 needs an account and a
licence key and forbids redistribution, while DB-IP City Lite is
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). **That licence asks
for credit wherever you show the data:**

> IP Geolocation by DB-IP, [https://db-ip.com](https://db-ip.com), used under
> CC BY 4.0.

The databases go stale within a month or two. To refresh, delete
`dbip-city-lite.mmdb` from the `geoip` volume and redeploy. To use MaxMind
instead, copy your own file in and point `GEOIP_DB_PATH` at it.

**A failed download fails the deploy.** The collector reads `GEOIP_DB_PATH` at
boot and refuses to start on a path that names no file, so the alternative is a
crash loop one step further from its cause. Redeploy to retry. To install with no
geo at all, delete the `geoip` service, its `depends_on` entry and the
collector's `GEOIP_DB_PATH`. See
[SELF-HOSTING.md](../../SELF-HOSTING.md#geoip) for the manual path.

**The proxy is Coolify's, so the header rules are Traefik labels.** The stock
install runs Caddy, which strips the headers a fronting proxy is supposed to own
(`CF-Connecting-IP` and its family). Without that, any visitor can pick their own
rate-limit bucket or write their own country into your analytics. This file
rebuilds those rules as a Traefik middleware and attaches it with
`coolify.traefik.middlewares`, which is Coolify's own directive. **Do not rewrite
that as a `traefik.http.routers.<name>.middlewares` label**: Coolify renames the
routers it generates on every redeploy, so a hand-written router name attaches
the middleware to nothing and fails silently, leaving the headers through.

**Every public service declares `expose:`.** That is what fills the port boxes in
step 2. If you fork this file, keep those lines.

## Three Coolify behaviours worth knowing before you blame yourself

None of them is caused by this stack. All three cost real time.

**A deployment can die silently and still read "in progress".** Twice, the job
ended after the git checkout: the helper container went idle, Coolify's queue
emptied, nothing was written to `laravel.log`, and the deployment record stayed
`in_progress` forever. The way out is to delete the helper container and deploy
again.

**The git clone and the image pull can crawl.** On the box used here,
`github.com` served 1.8 KB/s while a Cloudflare speed test on the same host at
the same moment served 248 MB/s, so a 20 MB shallow clone took over half an hour
and one 200 MB image layer stalled near the end. That is a network path to
GitHub's infrastructure, not Coolify and not this file, but it looks exactly like
a hung deploy. Measure before you conclude:

```sh
curl -o /dev/null -w '%{speed_download} B/s\n' \
  'https://github.com/perierhq/openanalytics.git/info/refs?service=git-upload-pack'
```

Pulling the stuck image by hand on the host often gets a better connection, and
the deploy then finds it already there:

```sh
docker pull ghcr.io/perierhq/openanalytics/collector:<version>
```

**A visitor on IPv6 reaches the collector as `172.18.0.1`, and gets no
country.** The `coolify` network has no IPv6, so a connection that arrives over
IPv6 comes through Docker's userland proxy and Traefik sees the bridge gateway
rather than the visitor. It asserts that address in `X-Real-Ip`, the collector
looks it up, and a private address has no country: one tester on an IPv6
network sees every row of the countries card as Unknown while the database is
loaded and fine. That is
[coollabsio/coolify#3436](https://github.com/coollabsio/coolify/issues/3436),
still open. Turn on Traefik's access log in Coolify's proxy configuration
(`--accesslog=true`) and those requests show the gateway as `ClientHost`. The
fix is on the platform: give the `coolify` network IPv6 the way that issue
describes, or drop the domain's `AAAA` records so every visitor arrives over
IPv4. A visit from your own LAN or VPN, or a CDN in front of Coolify, are the
other ways the collector is handed an address that is not the visitor's; see
[Troubleshooting](../../SELF-HOSTING.md#troubleshooting).

## What was verified, and how

So that "this has been run" is checkable rather than a summary of good
intentions. Every line below was measured on a live install, and the last three
were repeated on a second one built from a zero-state Coolify by hand.

| Claim                             | How it was checked                                                                                                            |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Twelve containers correct         | `docker ps`: ten healthy, two `Exited (0)`                                                                                    |
| Four hostnames on HTTPS           | `200` on each, `ssl_verify_result=0`, Let's Encrypt issuer                                                                    |
| Secrets generated by the platform | twenty-one variables filled from the compose file, none typed                                                                 |
| Signing loop closed               | a read from the api accepted by the gateway; a request correct in every header but its signature refused with `BAD_SIGNATURE` |
| Forged headers stripped           | all eight deleted at an echo service behind the same middleware, `X-Forwarded-For` intact                                     |
| The stripping reaches the product | a page view sent with `CF-IPCountry: XX` stored with its country **empty**                                                    |
| Ingest end to end                 | page views accepted, queued, drained by the worker, and read back out of ClickHouse                                           |

## If something is wrong

`docker logs` on the service that is unhealthy, first. The services say why they
refuse to start, on one line, on purpose: a missing variable, a path that names
no file, a secret a service is not allowed to hold. That last one is the
least-privilege boundary doing its job rather than a bug.
