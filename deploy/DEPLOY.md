# Deploying EMS

EMS runs on the client's Hostinger box (`187.77.96.52`, Ubuntu 26.04, 8 GB). The box already runs another project and is already hardened: user `deploy`, keys-only SSH, ufw (22, 80, 443), unattended upgrades, and Docker. One shared **Caddy** container in `/srv/edge` (the *edge*) owns ports 80/443 and every certificate. Apps live in `/srv/<name>`, join the shared Docker network `edge`, and publish no ports, because Docker would open them past ufw.

EMS answers at **https://ems.careermapsolutions.in**. The domain is the client's, at Hostinger, which also holds its DNS; the company website (`careermapsolutions.in`) is elsewhere and is not touched.

EMS is four containers in `/srv/ems`:

```
browser ──https──► edge Caddy (/srv/edge — the box owner's; 80/443, certificates)
                     │ network `edge` — shared with the box's other project
                     ▼
                   ems-web  :8080   the built app, its security headers, /api passed on
                     │ network `ems_default` — EMS's own; the edge cannot reach past ems-web
                     ├── /api ──► api (ems-api) :4000 ──► db  PostgreSQL 17, volume `db-data`
                     │                            └───► Cloudflare R2 (files and backups)
                   jobs  the same image as api, on a schedule (deploy/crontab):
                         02:30 IST backup · 03:00 IST maintenance · 04:00 IST on the 2nd, restore drill
```

On `edge`, EMS answers only to the name `ems-web` (and its container's own name), and finds its API by the name `ems-api`, so nothing of EMS's can be mistaken for a `web` or an `api` of the other project.

Everything below was run end to end on a laptop rehearsal of the box (`deploy/local/`) on 5 Oct 2026, **except** what is marked *not yet run*: Cloudflare R2 (the rehearsal keeps files on a volume), the real box, its edge, its domain, and a reboot of the box. Those are run in step 4.

## Still to build, in this order

| # | What | State |
|---|---|---|
| 1 | **Packaging**: the two images, `compose.yml`, `deploy.sh`, the jobs, the laptop rehearsal | ✅ Built and rehearsed, 5 Oct 2026 |
| 2 | **CI** (GitHub Actions, `.github/workflows/ci.yml`) on pull requests and `main`: the migrations on an empty Postgres 17, server typecheck, the §A5 rules, the field contract and every test (clock in UTC, as the containers run); web lint and build; both images built, not pushed | ✅ Built 7 Oct 2026. No secrets, so it runs on the repository where it is today and moves with it to the CMS-CareerMap organization. After the move: allow Actions in the organization, and require CI on `main` |
| 3 | **The Caddy block** for the EMS domain, handed to the box owner | ✅ Written 7 Oct 2026: `deploy/edge/ems.caddy`, for `ems.careermapsolutions.in` (a subdomain: no `www`). Added at step 4, once the stack is up. Waiting on the client: the DNS A record `ems` → `187.77.96.52` |
| 4 | **First deploy, by hand**: images over SSH, `.env`, the first Super Admin, the Caddy block, R2, the first backup and drill, a reboot, the smoke test, tag `v1.0` | Written in full 8 Oct 2026 (*On the box — the first deploy*). To run, it needs: the DNS record, the R2 keys (Devesh has them), the administrator and owner emails (or one, if the owner is not an employee), a reboot of the box by its owner. SSH as `deploy` works (checked 8 Oct); the owner keeps the backup passphrase |
| 5 | **CD**: on a version tag, build, ship over SSH, `deploy.sh` | ✅ Written 8 Oct 2026: `.github/workflows/deploy.yml`, approved by a person each time (*Automatic deploys*). Its steps were run on the laptop with stand-ins; the first real run is the first version after `v1.0` |
| 6 | **The client's go-live guide** (settings to fill in, first employees, first payroll) | After 4 |

---

## What is in `deploy/`

| File | What it is |
|---|---|
| `api.Dockerfile` | The API image: Node 22 (Debian 13), Prisma, `pg_dump`/`psql`/`pg_restore` 17, supercronic. Runs the API, the jobs, and one-off commands |
| `web.Dockerfile` | The web image: the app built by Vite, served by Caddy 2.11 on port 8080 |
| `*.Dockerfile.dockerignore` | What each build may see: an allow-list, so no `.env`, `node_modules` or `dist` from a laptop ever gets in |
| `web/Caddyfile` | The web container's server: static files, caching, real 404s, `/api` → `ems-api:4000` |
| `web/security-headers.caddy` | The page's security headers (CSP, HSTS …). `e2e/scripts/web.mjs` reads the same file, so the browser tests see what production sends |
| `compose.yml` | The stack: `db`, `api`, `jobs`, `ems-web`. Copied to `/srv/ems/compose.yml` |
| `env.example` | Every setting, explained. Becomes `/srv/ems/.env` |
| `postgres/10-ems-role.sh` | Runs once when the database is first created: the app's own login `ems` (owner of database `ems`, may create databases, not a superuser) |
| `crontab` | The jobs' schedule, in UTC |
| `deploy.sh` | On the box: back up, migrate, switch; `--rollback`; `--status` |
| `build.sh` | On a laptop, in CI and in CD: builds `ems-api:<version>` and `ems-web:<version>` |
| `edge/ems.caddy` | The site block for the box's shared Caddy: `ems.careermapsolutions.in` → `ems-web:8080`. The box owner adds it |
| `local/` | The laptop rehearsal: a stand-in for the box's edge Caddy, and `rehearse.sh` |

The three scripts are committed as executable. A copy that lost the bit (from a Windows folder, say) runs with `bash deploy.sh …`, or after `chmod +x deploy.sh`.

## Settings

All settings live in `/srv/ems/.env`, made from `env.example` on the box itself (`chmod 600`). `docker compose` stops and names any required setting that is missing; the API checks the rest when it starts.

- **An optional setting you do not use: delete its line, or keep it commented out.** Never `NAME=` with nothing after it: the API refuses an empty value.
- **Secrets: generated, never typed** (the commands are in `env.example`). Compose reads `$` in a value as the start of another setting's name, and the database password goes inside an address, where `@ : / ? # %` break it. Generated hex and base64 contain none of these.
- Rehearsed: an optional setting in `.env` reaches the API as written (`SMTP_FROM="CareerMap HR <hr@example.com>"` arrived whole), and one left out is not set at all.
- `POSTGRES_PASSWORD` and `EMS_DB_PASSWORD` are read **once**, when the database volume is first created. To change the app's password later, set it in the database first, typed at a prompt so it is never on a command line: `docker compose exec db psql -U ems -d ems`, then `\password ems`. Then put the same password in `.env`, and `docker compose up -d` (the API and the jobs restart with it).
- The **backup passphrase** has a copy outside the box, kept by the company. Without it, no backup can be opened, by anybody.

## Building the images

From the repository root, with Docker running:

```bash
deploy/build.sh v1.2          # a release: only from a clean checkout, so v1.2 names one commit
deploy/build.sh v1.2-rc1      # a trial build: uncommitted changes allowed
```

Both images are `linux/amd64`, and carry their version and commit as labels. `deploy.sh --status` shows the version.

## Rehearsing on a laptop

The same `compose.yml`, the same `deploy.sh`, the same images, behind a stand-in for the box's edge: `https://localhost:8443`. It touches nothing else (not the development database, not Neon, not ports 4000/5173). It needs Docker Desktop and Git Bash.

```bash
deploy/build.sh v1.2-rc1
deploy/local/rehearse.sh v1.2-rc1          # → https://localhost:8443
```

The first run makes `deploy/local/.box/` (never committed) with an `.env` of fresh random secrets. Files and backups go to a volume instead of R2 (`local/compose.override.yml`). The browser warns once about the certificate (it is Caddy's own); continue to localhost.

The first Super Admin — the password is typed at a prompt, never on the command line:

```bash
cd deploy/local/.box
export BOOTSTRAP_ADMIN_EMAIL=superadmin@example.com
read -rs BOOTSTRAP_ADMIN_PASSWORD && export BOOTSTRAP_ADMIN_PASSWORD
docker compose run --rm -e BOOTSTRAP_ADMIN_EMAIL -e BOOTSTRAP_ADMIN_PASSWORD api npm run bootstrap
```

Then the browser checks, from the same shell. They also need Node 20+, Microsoft Edge, and `npm install` run once in `e2e/`. There are 38: headers, caching, 404s, sign-in and the refresh cookie, every page of the Super Admin's menu, a phone, a file up and back, the upload limits, the visitor's own address in the audit log whatever `X-Forwarded-For` says, no CSP violation. Each run signs in four times; a third run within 15 minutes needs `docker compose restart api` first (the sign-in limit).

```bash
cd ../../../e2e
REHEARSAL_SA_PASSWORD="$BOOTSTRAP_ADMIN_PASSWORD" node suites/rehearsal.mjs
unset BOOTSTRAP_ADMIN_PASSWORD
```

Stop it with `deploy/local/rehearse.sh --down` (the data stays), or remove it all, data included, with `--wipe`.

> **Git Bash** turns arguments that look like Linux paths (`/app/crontab`) into Windows paths. Prefix such commands with `MSYS_NO_PATHCONV=1`.

## On the box — the first deploy

> *Not yet run on the real box.* Every command here was run in the laptop rehearsal; the SSH, the edge, R2, the domain and a reboot are run for the first time here. Go in this order: each step says how to see that it worked. EMS runs under the box's user **`deploy`** (`sudo` and `docker` groups).

**What to have first**

| What | From |
|---|---|
| SSH to the box as `deploy` with the laptop key `~/.ssh/ems_server` (it has a passphrase) — ✅ checked 8 Oct 2026: `deploy` is in `sudo` and `docker`, Docker 29.8.1, the `edge` network is there, 87 GB of disk and 6.8 GB of memory free. The box's ED25519 fingerprint: `SHA256:Se3ytINGkt+lo6fjghhqARwIH8sjzusGQ+vwII0T26o` | the box owner |
| A reboot of the box before the first deploy (it reported *System restart required* on 8 Oct) | the box owner, at a time that suits the other project |
| DNS at Hostinger, careermapsolutions.in → DNS records: type **A**, name **ems**, points to **187.77.96.52** | us, in hPanel |
| R2: a **private** bucket in the company's Cloudflare account, an API token with **Object Read & Write** on that bucket only, and the account ID (*R2 notes*) | the client |
| An administrator email for the first login — a mailbox, not anybody's own login (e.g. `admin@careermapsolutions.in`) — and the owner's own work email | the client |
| Who keeps the backup passphrase (a password manager, off the box) | the client |
| *Optional:* an email account to send notices from, e.g. `noreply@careermapsolutions.in` at Hostinger | the client |

**0. The laptop's SSH.** In `~/.ssh/config`:

```
Host ems-box
  HostName 187.77.96.52
  User deploy
  IdentityFile ~/.ssh/ems_server
  IdentitiesOnly yes
```

The first connection asks whether to trust the box's key: it must be `SHA256:Se3ytINGkt+lo6fjghhqARwIH8sjzusGQ+vwII0T26o` — the one the box owner reads on the box (`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`). Only then answer yes. Then:

```bash
ssh ems-box 'whoami; id -nG; docker version --format "{{.Server.Version}}"; docker network inspect edge --format "{{.Name}}"; ls -ld /srv/ems'
```

→ the user; `docker` among its groups; a Docker version; `edge`; `/srv/ems` owned by the user.

**1. DNS.** `nslookup ems.careermapsolutions.in 1.1.1.1` answers `187.77.96.52`. The record is **DNS only**: never proxied (Hostinger's DNS does not proxy; if the domain ever moves to Cloudflare, keep the cloud grey). Proxied, every visitor would arrive from a proxy's address, and the whole company would share one sign-in limit. An **A record only**: no AAAA (IPv6) record unless the box owner confirms the edge sees IPv6 visitors' own addresses — otherwise every phone on IPv6 (most of Jio) would share one.

**2. The files**, from the laptop, at the repository root:

```bash
ssh -t ems-box 'sudo install -d -o deploy -g deploy /srv/ems && mkdir -p /srv/ems/postgres'   # /srv is root's: sudo asks deploy's password, if it has one
scp deploy/compose.yml deploy/deploy.sh deploy/env.example ems-box:/srv/ems/
scp deploy/postgres/10-ems-role.sh ems-box:/srv/ems/postgres/
ssh ems-box 'chmod 755 /srv/ems/deploy.sh /srv/ems/postgres/10-ems-role.sh'
```

The database container must be able to read and run `10-ems-role.sh`, hence 755.

**3. The settings**, on the box (`ssh ems-box`, then `cd /srv/ems`). Generated there, never typed or pasted from a chat:

```bash
cp env.example .env && chmod 600 .env
openssl rand -hex 24      # → POSTGRES_PASSWORD
openssl rand -hex 24      # → EMS_DB_PASSWORD
openssl rand -hex 48      # → JWT_ACCESS_SECRET
openssl rand -hex 48      # → JWT_REFRESH_SECRET (run it again: the two must differ)
openssl rand -base64 24   # → BACKUP_PASSPHRASE
nano .env
```

`EMS_DOMAIN` is already `ems.careermapsolutions.in`. The four `R2_` values come from the client. The **backup passphrase** goes to the company's keeper the same day, through a safe channel — not chat, not email: without it, no backup opens. The `SMTP_` lines only if the client gave an account; otherwise they stay commented out. Then `docker compose config -q` prints nothing when every required setting is there.

**4. The images**, from the laptop, with Docker running, on a clean `main`:

```bash
git checkout main && git pull
deploy/build.sh v1.0
docker save ems-api:v1.0 ems-web:v1.0 | gzip | ssh ems-box 'gunzip | docker load'
```

→ `Loaded image: ems-api:v1.0` and `Loaded image: ems-web:v1.0` (about 300 MB sent).

**5. Start it**, on the box: `cd /srv/ems && ./deploy.sh v1.0`. It starts the database, creates the tables and starts everything. If it stops saying it could not ask the database, the database's first start went wrong (`docker compose logs db`; most often `postgres/10-ems-role.sh` was unreadable) and the app's login was never made. On this **first** deploy only, with nothing in it yet, start the database afresh: `docker compose down --volumes`, fix the cause, run `./deploy.sh v1.0` again. Never `--volumes` once there is data.

**6. The first Super Admin**, on the box: the **administrator** login, with the administrator email — not the owner's. It belongs to no employee record, like an outside administrator. The owner gets a Super Admin login of their own on their employee page, and is marked as the owner (the go-live guide, step 3); that is what lets their own leave and work go up the company tree. The password is typed at a prompt (at least 12 characters), never on a command line:

```bash
cd /srv/ems
export BOOTSTRAP_ADMIN_EMAIL=<the administrator email>
read -rs BOOTSTRAP_ADMIN_PASSWORD && export BOOTSTRAP_ADMIN_PASSWORD
docker compose run --rm -e BOOTSTRAP_ADMIN_EMAIL -e BOOTSTRAP_ADMIN_PASSWORD api npm run bootstrap
unset BOOTSTRAP_ADMIN_PASSWORD
```

The company is named "CareerMap Solutions" (changed in Settings → Company). The client changes this first password on My Profile once signed in, and keeps the administrator login for emergencies.

**7. The Caddy block.** Send `deploy/edge/ems.caddy` to the box owner; they add it to the edge and run `caddy reload` (never `restart`). Caddy gets the certificate by itself. Then `curl -sI https://ems.careermapsolutions.in` → `200`, with a `strict-transport-security` header; a browser shows the sign-in page with a valid certificate.

**8. Checks before anyone else uses it**, on the box from `/srv/ems` unless said:

- **R2:** `docker compose run --rm --no-deps api npm run storage:check` → `Storage works: write, read, list and delete all succeeded`.
- **The first backup, by hand, and a drill:** `docker compose run --rm --no-deps api npm run backup`, then `… npm run backup -- --list` (it is there), then `… npm run backup:drill -- --latest` (every table matches).
- **Sign in** as the Super Admin on a computer and on a phone; go through the testing checklist (`Role_Permission_Documentation.md` §12) with a test employee, then remove the test employee.
- **The visitor's own address:** a wrong password from a phone on mobile data; Settings → Audit Log must show that phone's public address — not a `172.x` or the box's own.
- **A reboot:** the box owner reboots the box; about two minutes later `./deploy.sh --status` shows every container healthy, and the site opens.
- **The version:** on the laptop, `git tag v1.0 && git push origin v1.0`. This also starts the *Deploy* workflow; until *Automatic deploys* is set up, it stops at "Reach the box", naming the missing secrets. That is expected.

**9. Hand over** to the client: `docs/client/EMS-Go-Live-Guide.pdf`.

## Updating to a new version

Load the new images onto the box, then from `/srv/ems`:

```bash
./deploy.sh v1.3
```

In order, it:

1. checks that both images are on the box and that `compose.yml` and `.env` are valid, and that no other deploy is running;
2. starts the database if it is not running, and asks it whether it holds data. If it cannot answer, everything stops here, with the site still running;
3. stops `api` and `jobs`, so nothing writes between the backup and the switch, nor while the database changes. The site still opens, but its data does not load until step 7 — under a minute in the rehearsal;
4. **backs up**, with the version running now, unless the database is still empty. If the backup fails, the running version is started again and nothing has changed;
5. points `previous` at the last version that came up healthy, and `current` at the new one;
6. runs the migrations;
7. starts everything and waits until each container is healthy (`jobs`, which has no health check, until it is running). The API is healthy only when it can reach the database (`/health`);
8. remembers the new version as the last healthy one, and keeps the images of the three highest versions (a release counts above its `-rc` builds) and of the versions still in use.

Deploying the version that already runs again is harmless: it backs up, finds no migration, and restarts. One stopped half-way (a dropped SSH session) is finished by running the same command again. A deploy that was killed can leave `.deploy.lock` behind; if no deploy is running, remove it.

All of this was rehearsed, each with the outcome above: a first deploy, a new version, the same version again, a deploy while another held the lock, a failing migration, a version that never came up healthy followed by a fix, a failing backup, a database that refused to answer.

## Automatic deploys (CD)

Once `v1.0` runs, every later version goes out from GitHub (`.github/workflows/deploy.yml`):

```bash
git checkout main && git pull
git tag v1.1 && git push origin v1.1
```

On GitHub, *Actions → Deploy* waits for a person: **Review deployments → production → Approve**. Then it:

1. checks the tag is a release (`v1.1`, `v1.1.2` — never a trial `-rc`) on a commit already on `main`, where branch protection made CI pass before it got there;
2. reaches the box over SSH, before building anything;
3. builds both images with `deploy/build.sh`, from that commit;
4. sends them into the box's Docker (`docker save | ssh docker load`) — no registry;
5. runs `./deploy.sh <tag>`: back up, migrate, switch, wait until healthy — everything in *Updating to a new version*;
6. asks the public address: the page, and `/api/auth/session` (401, signed out) for the API behind both proxies.

One deploy runs at a time; a second waits. **A rollback stays by hand**: `./deploy.sh --rollback` on the box. To send the same version again, *Re-run* its workflow.

This repository is public, so anybody can read its Actions logs. The deploy's whole output therefore stays on the box, in `/srv/ems/deploy-<time>-<version>.log`; the workflow shows only `deploy.sh`'s step lines (`== …`, `STOPPED: …`).

**When the Deploy run goes red**, first `ssh ems-box 'cd /srv/ems && ./deploy.sh --status'`, and read the newest `deploy-*.log` there. Then, by the step that failed:

| Failed at | The box | What to do |
|---|---|---|
| The tag check, *Reach the box*, the build, or sending the images | Unchanged: the version before runs | Fix the cause; *Re-run* |
| *Switch* — the backup | `deploy.sh` started the version before again | Read the log; fix; *Re-run* |
| *Switch* — a migration | `deploy.sh` put the version before back on; the failed migration's record blocks the next deploy | *A migration failed* |
| *Switch* — the new version never came up healthy | The new version is `current`, and unhealthy | `./deploy.sh --rollback` |
| *Switch* — cancelled, timed out, or the SSH connection dropped | Possibly stopped half-way: the site opens but its data may not load | If no deploy is running and `.deploy.lock` is left, remove it; then run `./deploy.sh <version>` by hand (*Updating to a new version*) |
| *The public address answers* only | The new version is live and remembered as healthy | Look at the edge and DNS; if the version is at fault, `./deploy.sh --rollback` |

### Setting it up, once, after the first deploy

1. **A key for GitHub alone**, made on the laptop. It has no passphrase, as GitHub uses it unattended:
   ```bash
   ssh-keygen -t ed25519 -N "" -C "github-actions-ems-deploy" -f ems_ci
   ```
   Send `ems_ci.pub` to the box owner, for `deploy`'s `authorized_keys`, as one line starting with `restrict ` (`restrict ssh-ed25519 AAAA… github-actions-ems-deploy`): no forwarding and no terminal, which the workflow never needs. Tell the box owner plainly what it is: a key with no passphrase, kept in GitHub, for a user in the `docker` group — and on a box, the `docker` group is as good as root. Keep it to this one user, and swap it if anybody leaves who could approve deploys.
2. **The box's host key**, so the workflow trusts only the real box:
   ```bash
   ssh-keyscan -t ed25519 187.77.96.52 > box_known_hosts
   ssh-keygen -lf box_known_hosts
   ```
   The fingerprint must match the one the box owner reads on the box (`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`).
3. **GitHub → the repository's Settings → Environments → New environment `production`:**
   - *Required reviewers:* Devesh and Priyanshu.
   - *Deployment branches and tags:* Selected branches and tags → add a **tag** rule `v*`.
   - *Approve only a version you made yourself:* a tag on a commit already merged to `main`. The workflow checks that too, but it is the tagged commit's own copy of the workflow that runs, so a tag on an unmerged change could carry a weakened check.
   - *Environment secrets:* `EMS_SSH_HOST` = `187.77.96.52`; `EMS_SSH_USER` = `deploy`; `EMS_SSH_KEY` = the whole of the file `ems_ci`; `EMS_SSH_KNOWN_HOSTS` = the line in `box_known_hosts`.
4. **Who may make a release tag:** Settings → Rules → Rulesets → *New tag ruleset*, target `v*`, *Restrict creations, updates and deletions*, bypass: repository admins. Then nobody else can start a deploy by pushing a tag.
5. **Delete `ems_ci` and `box_known_hosts` from the laptop.** The key now lives only in GitHub. If it is ever lost or leaked: make a new pair, swap the `.pub` on the box, and replace the secret.
6. The next version is the first automatic deploy. Watch it to the end.

**These protections rely on the repository being public.** On GitHub's Free plan, branch protection, required reviewers on an environment and rulesets work in public repositories only. If the repository is made private, check all three straight away: without them, a `v*` tag would deploy with nobody's approval, and "on `main`" would no longer mean CI passed. Keeping them in a private repository needs a paid plan.

## Rolling back

```bash
./deploy.sh --rollback        # back to the version that ran before the last switch
./deploy.sh --rollback        # a second time returns to where the first started
./deploy.sh --status
```

`previous` is always a version that came up healthy: after a version that failed and a fix for it, `--rollback` goes back past both, to the version before them.

A rollback puts the **code** back, never the database. If the version being left had run a migration, the old code may not understand the database. Then restore the backup that `deploy.sh` took just before the switch (see *Restoring*).

## A migration failed

`deploy.sh` stops, puts the previous version back on (and `previous` as it was), and says so. PostgreSQL runs a migration file as one transaction, so a file that fails is undone whole: the rehearsal's broken migration (a good statement, then a bad one) left nothing behind but its record. The exception is a migration that manages its own transactions or uses a statement that cannot run inside one (such as `CREATE INDEX CONCURRENTLY`); none of EMS's do.

That record blocks every later deploy (Prisma error **P3009**) until it is resolved. Once the cause is understood:

```bash
docker compose run --rm --no-deps api npx --no-install prisma migrate resolve --rolled-back <migration_name>
./deploy.sh v1.3              # or the fixed version
```

## Backups

The `jobs` container backs up every night at 02:30 IST: one `pg_dump`, sealed with the passphrase (AES-256-GCM) and stored under `backups/db/` (in R2 on the box — *not yet run*; on a volume in the rehearsal). Then old ones are pruned. Pruning counts **backups, not days**: it keeps the newest 30 backups, whenever they were taken, and the first backup of each of the last 12 months. A deploy and a hand backup each add one, so 30 backups can cover a little less than 30 days.

The restore drill runs at 04:00 IST on the 2nd of each month: the newest backup is restored into a scratch database, every table's rows are counted against the backup, and the scratch database is dropped. Both jobs report to **Settings → Audit Log → System jobs**, where somebody sees a failure.

A job that never runs writes nothing there: the `jobs` container stopped (a deploy cut off half-way leaves it so until the deploy is run again), or a backup killed for want of memory. So **look for last night's backup**, not only for a failure: in System jobs, or `docker compose run --rm --no-deps api npm run backup -- --list`. A backup's dump is held in a 256 MB in-memory folder while it is sealed; one larger than that fails, and says so, rather than being killed silently. EMS's dump is about 160 KB today.

By hand, from `/srv/ems`:

```bash
docker compose run --rm --no-deps api npm run backup
docker compose run --rm --no-deps api npm run backup -- --list
docker compose run --rm --no-deps api npm run backup:drill -- --latest
docker compose logs jobs                          # what the scheduled runs said
```

## Restoring

Every restore goes into a **new, empty** database. The script refuses the database the app runs on, and any database that already has tables.

**Some data went wrong** (a bad import, a mistaken change), and you want the database as it was at a backup:

```bash
cd /srv/ems
docker compose run --rm --no-deps api npm run backup -- --list           # pick the moment
docker compose exec db createdb -U ems ems_restored
docker compose run --rm --no-deps api npm run restore -- --from 2026-10-14T21-00-00Z --target-db ems_restored
#   → "Restore checked: every table matches the backup"
docker compose stop api jobs
docker compose exec db psql -U ems -d postgres \
  -c 'ALTER DATABASE ems RENAME TO ems_before_restore' \
  -c 'ALTER DATABASE ems_restored RENAME TO ems'
docker compose up -d --wait
# Keep ems_before_restore until you are sure, then:
docker compose exec db dropdb -U ems ems_before_restore
```

Rehearsed: a company's name changed by mistake came back from the backup, and its Super Admin signed in afterwards. The app needs no change of settings: it always uses the database named `ems`.

**The box is lost:** on a new box, set up `/srv/ems` as for the first deploy, with the **same** R2 keys and the **same** backup passphrase (the company's copy), and `./deploy.sh` the same version. That creates an empty `ems` with tables, so restore beside it and swap, exactly as above. Files (documents, payslip PDFs, bank proofs) live in R2, not on the box, so nothing else needs restoring. *Not yet run* (it needs R2).

## Looking at it

```bash
./deploy.sh --status                     # versions, and each container's state
docker compose logs -f --tail 100 api    # the API's log: one JSON line per event
docker compose logs --tail 50 ems-web jobs db
docker stats --no-stream                 # memory against each container's limit
```

Docker keeps at most 5 × 10 MB of log per container. A container that crashes is started again (rehearsed: the API's process killed, back and healthy within seconds), and when Docker itself starts again it starts the stack (rehearsed by restarting Docker; a reboot of the box is *not yet run*).

## R2 notes

*Not yet run* — in step 4, with the company's keys.

- **The bucket** is **private** and belongs to the **company's** Cloudflare account, not a developer's. It holds employees' documents.
- **The API token** has **Object Read & Write** on that one bucket only.
- **Backups** are kept in the same bucket, under `backups/db/`. The orphan-file sweeper only ever looks under `org/`, so it never touches them.
- **Optional extra safety:** a bucket lock rule on the `backups/` prefix, so not even the app's own key can delete a recent backup. Keep it to **7 days**: pruning counts backups, not days (see *Backups*), and a lock longer than the newest backup it prunes would make the nightly job fail.

## What protects what

| Layer | Setting |
|---|---|
| Network | No EMS container publishes a port. The edge reaches only `ems-web`; `api` and `db` are on EMS's own network (rehearsed: `api:4000` and `db:5432` are not reachable from the edge's network). On the shared network EMS uses only `ems-` names |
| Containers | `api`, `jobs` and `ems-web` run as non-root users, with a read-only file system and every Linux capability dropped, and may not gain privileges |
| HTTPS | The edge's certificate. HSTS for a year, including subdomains — which reaches only names under `ems.careermapsolutions.in`, never the company's website or email on `careermapsolutions.in`. No `preload` |
| Changes | `main` takes changes only through a pull request whose three CI checks passed (branch protection, owners included). A version reaches the box only from a release tag on `main`, after a person approves it (*Automatic deploys*) |
| Visitor's address | The edge passes it on; `ems-web` trusts only private addresses; the API counts back two hops (`TRUST_PROXY_HOPS=2`). Rehearsed: a forged `X-Forwarded-For` is ignored, and the sign-in limits and the audit log see the real address. Private addresses include the box owner's other containers on `edge`, which could therefore name an address too: the box and its owner are trusted |
| Browser | CSP, X-Frame-Options, nosniff, Referrer-Policy, Permissions-Policy and Cross-Origin-Opener-Policy on the page (`web/security-headers.caddy`); the API sets its own through helmet |
| Uploads | Over 12 MB, `ems-web` refuses before the API reads it; over the company's limit (Settings → Documents), the API refuses |
| Database | The app's login is not a superuser: it owns the `ems` database, and the scratch and restore databases it creates |
| Secrets | `.env` is chmod 600 on the box, never in git, never in an image. The two JWT secrets differ. The backup passphrase also has a copy off the box. Anyone in the box's `docker` group can read a running container's settings (`docker inspect`): that group is the box owner and the user EMS runs under — whose keys are the laptop's and, with CD, GitHub's (*Automatic deploys*) |
| Backups | Nightly and sealed, off the box: the newest 30 and the first of each of 12 months. **Restored and checked every month** by the drill |
