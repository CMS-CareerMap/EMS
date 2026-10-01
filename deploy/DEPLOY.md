# Deploying EMS to the Hostinger VPS

> ⚠️ **Do not follow this runbook as it stands — the target changed on 30 Sep 2026.**
> EMS goes onto the client's existing Hostinger box (`187.77.96.52`, Ubuntu 26.04), which already runs another project. That box uses **Docker**, and one shared **Caddy** container owns ports 80/443 and the certificates. There is no Nginx, no PM2 and no Postgres installed on the host. Instead:
> - EMS lives in `/srv/ems` as its own containers: API, web and PostgreSQL. It publishes no ports and joins the shared `edge` network.
> - The box owner adds one site block to the shared Caddyfile, pointing the EMS domain at our web container.
> - The box is already hardened (the `deploy` user, keys-only SSH, ufw, updates), so steps 1–2 below are done.
>
> This file will be rewritten for that setup together with the Dockerfile and compose files. What still applies unchanged: the backup, restore and drill scripts, the R2 notes, and the security headers (they move into our web container).

## Still to build, in this order

> **Days 21–23 come first** (the Super Admin's Roles & Permissions screen; the company tree with approvals that follow it; two logins per person; see `.claude/CLAUDE.md`). They change the database schema, so they are done before the first deploy. That way the production database starts with the final shape.

| # | What | Needs |
|---|---|---|
| 1 | **Docker packaging:** an API image (Node 22, Prisma, `pg_dump` for backups), a web container (serves the built app with the security headers, passes `/api` on), and `/srv/ems/compose.yml` (api + web + postgres, `name: ems`, no `ports:`, memory limits, networks `default` + `edge`). Inside the API container, `HOST=0.0.0.0`, and `trust proxy` set for two hops. | Docker Desktop on the laptop, to test it before the server |
| 2 | **CI** (GitHub Actions) on every push and pull request: server typecheck, §A5 lint and the full test suite against a Postgres service; web lint and build; the field-contract check. A red check blocks the merge. | Admin access to the GitHub repo |
| 3 | **The Caddy site block** for the EMS domain (root + `www` redirect), handed to the box owner to add and `caddy reload` | The domain name |
| 4 | **First deploy, by hand:** images streamed over SSH (`docker save \| ssh \| docker load`), `.env`, migrations, the first Super Admin, cron jobs, then the first backup and restore drill, a reboot test, and the §10 smoke test. Then tag `v1.0`. | SSH access as `deploy`, R2 keys, the backup passphrase kept by the client |
| 5 | **CD** (GitHub Actions), triggered by a version tag (`v*`), never by an ordinary push, optionally behind a GitHub "production" approval. Steps: build the images and push them to GHCR (private); SSH to the box; **back up first**; pull; run the migrations; switch the containers; health check. Rollback means pointing `.env.tag` back at the previous tag. | Repo secrets `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY` (a separate deploy key, held only by GitHub), and a `read:packages` token on the box for GHCR |
| 6 | **Rewrite this file** for the Docker + Caddy setup, including updates, rollback and restores | — |

This runbook covers putting EMS on the client's server, updating it, backing it up and restoring it. The commands are for **Ubuntu 24.04** on a **VPS with root access**. Shared hosting cannot run this app: it needs Node, PostgreSQL and scheduled jobs.

The target, as the build guide sets it (§A7), is **one address**. Nginx serves the React build and passes `/api` to Node on the same machine. Because everything is on one origin, there is no CORS, and the refresh cookie works as designed.

```
browser ──https──► Nginx :443 ──┬── /            web/dist (static files)
                                └── /api/  ──►  Node (PM2) 127.0.0.1:4000 ──► PostgreSQL (localhost)
                                                                          └──► Cloudflare R2 (files + backups)
```

Replace `hr.example.com` below with the real domain. Every block says who runs it: **root**, or the **ems** user.

---

## 0. Before you start

Have all of these in hand:

| What | Where it comes from |
|---|---|
| The VPS IP and root login | Hostinger panel |
| A **subdomain** such as `hr.company.com`, with an **A record** to the VPS IP | The client's DNS. If that DNS is on Cloudflare, set the record to **DNS only (grey cloud)**. Proxied, every visitor would arrive from a Cloudflare address, and the sign-in limits would count the whole company as one person. |
| The R2 bucket and an API token for it: Account ID, Access Key ID, Secret Access Key, bucket name | The company's Cloudflare account (see [R2 notes](#r2-notes)) |
| A **backup passphrase**, at least 16 characters (`openssl rand -base64 24`) | Generate it once. It goes into the server's `.env`, and a **copy goes into the company's password manager, off the server**. If the server is lost, that copy is the only way to open the backups. |
| A database password (`openssl rand -hex 24`: hex, so it is safe inside a URL) | Generate it here |
| The first Super Admin's email and a strong password | The client |

---

## 1. The server itself (root)

```bash
apt update && apt -y upgrade
timedatectl set-timezone UTC            # the cron times in deploy/crontab assume UTC
apt -y install unattended-upgrades && dpkg-reconfigure -plow unattended-upgrades

# A user to own and run the app — never root
adduser --disabled-password --gecos "" ems
mkdir -p /home/ems/.ssh && cp ~/.ssh/authorized_keys /home/ems/.ssh/ && chown -R ems:ems /home/ems/.ssh

# Firewall: SSH and web only. PostgreSQL and Node are never reachable from outside.
ufw allow OpenSSH
ufw allow 80,443/tcp
ufw enable
```

**SSH: keys only.** On Ubuntu 24.04, settings in `/etc/ssh/sshd_config.d/` take precedence over `sshd_config` itself. Cloud images ship a file there that turns passwords back on, so put yours first:

```bash
cat > /etc/ssh/sshd_config.d/00-ems.conf <<'EOF'
PasswordAuthentication no
PermitRootLogin prohibit-password
EOF
sshd -T | grep -iE 'passwordauthentication|permitrootlogin'   # both must show the values above
systemctl reload ssh
```

Before you close this terminal, **open a second one and log in with a key**.

## 2. Software (root)

```bash
# Node 22 LTS (Node 20 stopped receiving security fixes in April 2026)
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt -y install nodejs
# PostgreSQL: the server, plus the client tools (pg_dump, pg_restore, psql) that backups use
apt -y install postgresql postgresql-client
# Nginx and Certbot
apt -y install nginx certbot
# PM2, which keeps the API running
npm install -g pm2
node -v && psql --version && nginx -v
```

## 3. The database (root)

```bash
sudo -u postgres psql <<'SQL'
CREATE ROLE ems LOGIN PASSWORD 'THE-HEX-PASSWORD' CREATEDB;
CREATE DATABASE ems_prod OWNER ems;
SQL
```

- `CREATEDB` is there for two things: the monthly restore drill, which restores into a scratch database of its own, and restores in general (`createdb` as ems).
- PostgreSQL listens on localhost only by default, and it accepts a password there. **Keep both as they are.**

## 4. The code

As **root**:

```bash
mkdir -p /srv/ems /var/log/ems && chown ems:ems /srv/ems /var/log/ems
```

As **ems** (`su - ems`):

```bash
git clone https://github.com/priyanshu3372/EMS.git /srv/ems
cd /srv/ems && git checkout v1.0
```

## 5. The server's settings (ems)

Create `/srv/ems/server/.env`, then `chmod 600 .env` so only ems can read it. The API checks every key when it starts. If one is missing or malformed, it stops and says which.

```bash
NODE_ENV=production
PORT=4000
CORS_ORIGIN=https://hr.example.com

DATABASE_URL="postgresql://ems:THE-HEX-PASSWORD@localhost:5432/ems_prod"
DIRECT_URL="postgresql://ems:THE-HEX-PASSWORD@localhost:5432/ems_prod"

# Two different values: openssl rand -hex 48 (run it twice)
JWT_ACCESS_SECRET=...
JWT_REFRESH_SECRET=...

STORAGE_DRIVER=r2
R2_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET=...

BACKUP_PASSPHRASE=...          # the same one as in the company's password manager

# Only for step 6's bootstrap. Delete these two lines afterwards.
BOOTSTRAP_ADMIN_EMAIL=...
BOOTSTRAP_ADMIN_PASSWORD=...
```

In production the API listens on `127.0.0.1` only (set `HOST` to change that). Nginx is the only way in.

## 6. Build, migrate, first admin (ems)

```bash
cd /srv/ems/server
npm ci                           # all dependencies — the build and the jobs need the dev ones too; never --omit=dev
npx prisma migrate deploy        # creates every table
npm run build                    # TypeScript → dist/
npm run storage:check            # proves the R2 keys: write, read, list, delete
npm run bootstrap                # the company, its reference data, and the first Super Admin

cd /srv/ems/web
npm ci
npm run build                    # → web/dist, which Nginx serves
```

Then delete the two `BOOTSTRAP_*` lines from `.env`.

## 7. Keep the API running (ems)

```bash
cd /srv/ems
pm2 start deploy/ecosystem.config.cjs
pm2 save
pm2 startup          # prints one command — run THAT as root, so the API starts on boot
pm2 install pm2-logrotate
curl -s localhost:4000/health        # {"data":{"status":"ok","env":"production"},...}
```

## 8. Nginx and the certificate (root)

nginx refuses to load an HTTPS server that has no certificate yet. So the certificate comes first, served by a small file that only answers Let's Encrypt:

```bash
DOMAIN=hr.example.com                          # the real one
mkdir -p /var/www/certbot
cp /srv/ems/deploy/nginx/ems-security-headers.conf /etc/nginx/snippets/
sed "s/hr.example.com/$DOMAIN/g" /srv/ems/deploy/nginx/ems-acme.conf > /etc/nginx/sites-available/ems-acme
sed "s/hr.example.com/$DOMAIN/g" /srv/ems/deploy/nginx/ems.conf > /etc/nginx/sites-available/ems
rm -f /etc/nginx/sites-enabled/default
ln -sf /etc/nginx/sites-available/ems-acme /etc/nginx/sites-enabled/ems-acme
nginx -t && systemctl reload nginx

# The certificate. Renewals reuse the same folder, which ems.conf keeps serving on port 80.
certbot certonly --webroot -w /var/www/certbot -d "$DOMAIN" --deploy-hook "systemctl reload nginx"

# Now the real site
rm /etc/nginx/sites-enabled/ems-acme
ln -sf /etc/nginx/sites-available/ems /etc/nginx/sites-enabled/ems
nginx -t && systemctl reload nginx
certbot renew --dry-run                        # renewal works
```

Check the site and its headers:

```bash
curl -sI https://$DOMAIN/ | grep -iE 'strict-transport|content-security|x-frame|x-content-type|referrer|permissions'
curl -sI https://$DOMAIN/assets/nothing.js | head -1     # a real 404, not the app
curl -s  https://$DOMAIN/api/auth/session | head -c 200  # 401 in the API's own JSON
```

About HSTS: the site tells browsers to use HTTPS for a year, **including subdomains**. On a subdomain like `hr.company.com` that covers only `*.hr.company.com`. Don't serve EMS from the company's bare domain unless every other site under it is on HTTPS as well.

## 9. Scheduled jobs (ems)

```bash
crontab /srv/ems/deploy/crontab && crontab -l
```

As **root**, rotate the jobs' logs:

```bash
cat > /etc/logrotate.d/ems <<'EOF'
/var/log/ems/*.log {
  weekly
  rotate 12
  compress
  missingok
  notifempty
}
EOF
```

## 10. The first backup, and a real restore — before anybody uses it (ems)

Don't wait for the cron. Run both by hand now:

```bash
cd /srv/ems/server
npm run backup                       # "Backup stored … sealed: true"
npm run backup -- --list
npm run backup:drill -- --latest     # "Restore drill passed: the backup came back whole"
```

Then sign in as Super Admin and open **Settings → Audit Log**, area **System jobs**. Both jobs should be listed there. From now on, a failed backup or a failed drill also shows up there.

## 11. Smoke test

In a browser, work through `Role_Permission_Documentation.md §10`, signed in as one person of each role.

---

## Updating to a new version (ems)

Pick a quiet moment: the API is stopped for a minute or two. `npm ci` replaces the files the running API reads, and migrations change the database under it, so the old version must not keep serving while that happens.

```bash
cd /srv/ems/server && npm run backup            # the way back, if a migration goes wrong
pm2 stop ems-api
cd /srv/ems && git fetch --tags && git checkout vX.Y
cd server && npm ci && npx prisma migrate deploy && npm run build
pm2 start ems-api
# The web build goes to a new folder and is swapped in whole, so nobody is
# served half an old version and half a new one:
cd ../web && npm ci && npx vite build --outDir dist-next && rm -rf dist-prev && mv dist dist-prev && mv dist-next dist
```

Then, as **root**, pick up any change to the web's security headers:

```bash
cp /srv/ems/deploy/nginx/ems-security-headers.conf /etc/nginx/snippets/ && nginx -t && systemctl reload nginx
```

Anyone who had a tab open, and then opens a page they had not visited yet, sees *"A new version of EMS is available — Reload"*. That is expected.

## Restoring (ems)

Every restore goes into an **empty** database. The script refuses to restore over the database the app is running on, or over one that already has tables. That rule keeps a recovery from becoming a second disaster. The ems user creates the empty database itself (it has `CREATEDB`); `createdb` asks for the database password.

**Some data went wrong** (a bad import, a mistaken change), and you want the database as it was last night:

```bash
cd /srv/ems/server
npm run backup -- --list                               # pick the moment
createdb -h localhost -U ems ems_restored
npm run restore -- --from 2026-10-14T21-00-00Z --target-db ems_restored
#   → "Restore checked: every table matches the backup"
# Point the app at it: in .env, change ems_prod to ems_restored in both URLs, then
pm2 restart ems-api
# Keep ems_prod until you are sure, then drop it.
```

**The server is lost:** build a new VPS with steps 1–5, using the same R2 keys and the same backup passphrase (the copy from the password manager). Then:

```bash
cd /srv/ems/server && npm ci && npm run build
npm run backup -- --list
createdb -h localhost -U ems ems_prod_restored
npm run restore -- --target-db ems_prod_restored        # the newest backup
# set both URLs in .env to ems_prod_restored, then carry on from step 7
```

The files (documents, payslip PDFs, bank proofs) live in R2, not on the server, so nothing else needs restoring.

## R2 notes

- **The bucket** is **private** and belongs to the **company's** Cloudflare account, not a developer's. It holds employees' documents.
- **The API token** should have **Object Read & Write** on that one bucket only.
- **Backups** are kept in the same bucket, under `backups/db/`. The orphan-file sweeper only ever looks under `org/`, so it never touches them.
- **Optional extra safety:** add a bucket lock rule on the `backups/` prefix for **28 days**. Then not even the app's own key can delete a recent backup. Keep the lock shorter than the 30 daily backups the job keeps: the job deletes each backup once it is 30 days old, and a longer lock would make that delete fail and the job report itself failed.

## What protects what

| Layer | Setting |
|---|---|
| Network | `ufw`: 22, 80 and 443 only. Node listens on 127.0.0.1 and PostgreSQL on localhost. |
| SSH | Keys only (`sshd_config.d/00-ems.conf`) |
| HTTPS | Let's Encrypt, renewed by Certbot. HSTS for a year. TLS 1.2 and 1.3. |
| Browser | CSP, X-Frame-Options, nosniff, Referrer-Policy and Permissions-Policy (`deploy/nginx/ems-security-headers.conf`). The API adds its own through helmet. |
| Secrets | `.env` is chmod 600 and owned by ems. The two JWT secrets differ. The backup passphrase also has a copy off the server. |
| Backups | Nightly and sealed (AES-256-GCM), stored off the server in R2: 30 daily and 12 monthly, counted by the company's own month. **Restored and checked every month** by the drill. |
