import dotenv from 'dotenv'
import { z } from 'zod'

/**
 * .env holds everything. .env.test then overrides just the database, so the
 * test suite runs against local Postgres instead of Neon.
 *
 * That split matters more than it looks. Tests create and delete rows with
 * abandon; pointing them at the development database would be merely rude, but
 * pointing them at production would be a disaster, and the only thing standing
 * between those two is which URL happens to be loaded. Making the test database
 * a separate, explicit file means a test run cannot silently inherit whatever
 * .env was set to.
 *
 * It is also the difference between a suite that takes seconds and one that
 * takes minutes — Neon answers in seconds per query from here, local Postgres
 * in single-digit milliseconds.
 */
dotenv.config()

if (process.env.NODE_ENV === 'test') {
  dotenv.config({ path: '.env.test', override: true })
}

/**
 * The ONLY file in this codebase that reads process.env.
 *
 * It validates shape, not just presence — a PORT that is not a number and a
 * CORS_ORIGIN that is not a URL both fail here, at boot, with a readable
 * message. Nothing downstream ever has to wonder whether config is sane.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  /// The address to listen on. Production defaults to 127.0.0.1, so a Node
  /// started by hand on a server is reachable only from that machine — its
  /// trust in X-Forwarded-For would otherwise let anybody choose their own IP.
  /// The Docker image sets 0.0.0.0: there the API container publishes no port,
  /// and only the web container, on the stack's own network, can reach it.
  HOST: z.string().min(1).optional(),
  /// How many proxies stand in front of the API in production, each adding to
  /// X-Forwarded-For. One behind a single proxy (the E2E stack's web server);
  /// two on the client's box — their shared Caddy, then EMS's own web
  /// container (deploy/compose.yml). The visitor's address, which the sign-in
  /// limits count by and the audit log records, is the one that many hops
  /// back. Set higher than the real number of proxies, it would let a visitor
  /// choose their own. Empty means the default — never 0, which a bare number
  /// coercion would make of it, silently turning the trust off.
  TRUST_PROXY_HOPS: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().int().min(0).max(5).default(1)),
  CORS_ORIGIN: z.url(),

  /// Pooled endpoint — what the running app uses.
  DATABASE_URL: z.string().startsWith('postgresql://'),
  /// Unpooled endpoint — Prisma Migrate needs session-level advisory locks,
  /// which PgBouncer cannot provide.
  DIRECT_URL: z.string().startsWith('postgresql://'),

  /// Access tokens are short-lived and never leave memory, so this key signs
  /// something that is replaced every 15 minutes.
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  /// Refresh tokens sit in a cookie for a week, so they are signed with a
  /// DIFFERENT key. Sharing one key would let a refresh token be presented as
  /// an access token, and the 15-minute access window would mean nothing.
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
  JWT_ACCESS_EXPIRY: z.string().default('15m'),
  JWT_REFRESH_EXPIRY: z.string().default('7d'),

  /// 'local' in development; 'r2' in production.
  /// Production never uses the VPS disk — see platform/storage/index.ts.
  STORAGE_DRIVER: z.enum(['local', 'r2']).default('local'),
  STORAGE_PATH: z.string().default('./uploads'),

  /// Cloudflare R2, required when STORAGE_DRIVER is r2. The account belongs to
  /// the company, not to a developer: it holds their employees' documents.
  R2_ACCOUNT_ID: z.string().min(1).optional(),
  R2_ACCESS_KEY_ID: z.string().min(1).optional(),
  R2_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  R2_BUCKET: z.string().min(1).optional(),
  R2_ENDPOINT: z.url().optional(),

  /// Backups (npm run backup / restore / backup:drill). PG_BIN is the folder
  /// holding pg_dump, pg_restore and psql when they are not on the PATH — on
  /// Windows, C:\Program Files\PostgreSQL\17\bin.
  PG_BIN: z.string().min(1).optional(),
  /// Seals each dump (AES-256-GCM). Kept by the company OUTSIDE the server: a
  /// backup cannot be restored without it, by anybody.
  BACKUP_PASSPHRASE: z.string().min(16, 'BACKUP_PASSPHRASE must be at least 16 characters').optional(),
  /// How many daily backups to keep, and how many months' first backups.
  BACKUP_KEEP_DAILY: z.coerce.number().int().min(1).max(365).default(30),
  BACKUP_KEEP_MONTHLY: z.coerce.number().int().min(0).max(120).default(12),

  // Email (client §45). All optional: without SMTP_HOST and SMTP_FROM nothing
  // is emailed, and every notice still appears in the app. Set but EMPTY means
  // off too — how a test stack keeps a developer's mail account out of reach
  // (an empty variable is not replaced by the one in .env).
  SMTP_HOST: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(1).optional()),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  /** True for port 465 (TLS from the start); 587 upgrades with STARTTLS. */
  SMTP_SECURE: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  SMTP_USER: z.string().min(1).optional(),
  SMTP_PASS: z.string().min(1).optional(),
  /** Who the mail is from: "CareerMap HR <hr@example.com>". */
  SMTP_FROM: z.string().min(3).optional(),
  /** Where the app is, for links in emails. Defaults to CORS_ORIGIN. */
  APP_URL: z.url().optional(),
}).refine((c) => c.JWT_ACCESS_SECRET !== c.JWT_REFRESH_SECRET, {
  path: ['JWT_REFRESH_SECRET'],
  message: 'JWT_REFRESH_SECRET must differ from JWT_ACCESS_SECRET',
}).superRefine((c, ctx) => {
  if (c.STORAGE_DRIVER !== 'r2') return
  for (const key of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'] as const) {
    if (!c[key]) ctx.addIssue({ code: 'custom', path: [key], message: `${key} is required when STORAGE_DRIVER is r2` })
  }
})

const parsed = schema.safeParse(process.env)

if (!parsed.success) {
  console.error('\n  Invalid environment configuration:\n')
  for (const issue of parsed.error.issues) {
    console.error(`    ${issue.path.join('.') || '(root)'}: ${issue.message}`)
  }
  console.error('\n  Check server/.env against server/.env.example\n')
  process.exit(1)
}

export const env = Object.freeze(parsed.data)
export type Env = typeof env
