# EMS — CareerMap Solutions

An employee management system for one company: people, attendance, leave, payroll with Indian statutory deductions, documents, notifications, reports and an audit log. It has seven roles, from Super Admin to Employee. `Role_Permission_Documentation.md` says what each role may see and do; the code enforces it on the server and checks it against that document in a test.

```
web/      React 19 + Vite + TanStack Query + Tailwind — the screens
server/   Express 5 + Prisma 6 + PostgreSQL + Zod (TypeScript) — the API, and every rule
deploy/   Nginx, PM2, cron and the runbook for the VPS (deploy/DEPLOY.md)
docs/     field-contract.json — every field the web reads, checked against the server
```

The build followed `EMS_BUILD_GUIDE.md` day by day. `.claude/CLAUDE.md` is the working summary: where things are, the conventions, and the commands.

## Running it locally

You need Node 20.19 or later, PostgreSQL, and a `server/.env` made from `server/.env.example`.

```bash
cd server && npm install && npx prisma migrate deploy && npm run bootstrap   # once: the company and its first Super Admin
cd server && npm run dev        # API on :4000
cd web    && npm install && npm run dev        # the app on :5173; /api is proxied to :4000
```

## Checks

```bash
cd server && npm run typecheck && npm run lint && npm test   # types, the architecture rules (§A5), ~1,100 tests
cd web    && npm run lint && npm run build
cd server && npm run field-contract                          # rewrites docs/field-contract.json
```

The server tests run against a local database named in `server/.env.test`. They refuse to run against anything remote.

## Production

The app runs on one VPS: Nginx serves `web/dist` and passes `/api` to Node, on one address. Files and nightly backups go to the company's Cloudflare R2 bucket. `deploy/DEPLOY.md` covers the whole path, including how to restore. The monthly restore drill (`npm run backup:drill`) actually restores a backup and checks every table.
