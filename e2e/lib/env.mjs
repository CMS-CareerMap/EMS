// Where the browser tests live and what they talk to — one place, so no suite
// carries a machine's path. Every database here is LOCAL: the URL is the one
// in server/.env.test with its database name swapped, and anything that is not
// localhost is refused before a single query.
import { readFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const E2E = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const REPO = resolve(E2E, '..')
export const SERVER = join(REPO, 'server')
export const WEB = join(REPO, 'web')

/** Fixtures, screenshots, downloads, generated test files and uploads — never committed. */
export const WORK = process.env.E2E_WORK ? resolve(process.env.E2E_WORK) : join(E2E, '.work')
mkdirSync(WORK, { recursive: true })

export const WEB_PORT = 5183
export const API_PORT = 4100
export const BASE = `http://localhost:${WEB_PORT}`
export const API = `${BASE}/api`
/** The browser-test database. Its own: never the development one, never the unit tests'. */
export const DB = process.env.E2E_DB || 'ems_e2e'
/** Uploaded files the API stores during a run. */
export const STORAGE = join(WORK, 'uploads')

/** server/.env.test's database URL, pointed at `name` — refused unless it is on this machine. */
export function localDatabaseUrl(name = DB) {
  let text
  try {
    text = readFileSync(join(SERVER, '.env.test'), 'utf8')
  } catch {
    throw new Error('server/.env.test is missing. Copy server/.env.test.example and fill in your LOCAL Postgres password.')
  }
  const match = text.match(/^DATABASE_URL="?([^"\r\n]+)"?/m)
  if (!match) throw new Error('server/.env.test has no DATABASE_URL.')
  const url = new URL(match[1])
  if (!/^(localhost|127\.0\.0\.1)$/.test(url.hostname)) {
    throw new Error(`Refusing: server/.env.test points at "${url.hostname}". Browser tests run only against a local database.`)
  }
  url.pathname = `/${name}`
  return url
}

/** Where psql lives: PG_BIN from the environment or server/.env (as backups use it), else the PATH. */
function pgBin() {
  if (process.env.PG_BIN) return process.env.PG_BIN
  try {
    const m = readFileSync(join(SERVER, '.env'), 'utf8').match(/^PG_BIN="?([^"\r\n]+)"?/m)
    if (m) return m[1]
  } catch { /* no server/.env: look further */ }
  // Windows installs Postgres under Program Files, off the PATH: the newest one there.
  if (process.platform === 'win32') {
    const root = 'C:/Program Files/PostgreSQL'
    try {
      const versions = readdirSync(root).filter((v) => existsSync(join(root, v, 'bin', 'psql.exe'))).sort((a, b) => Number(b) - Number(a))
      if (versions[0]) return join(root, versions[0], 'bin')
    } catch { /* not installed there */ }
  }
  return null
}

/** psql against the local test database — for the few checks a suite makes in the database itself. */
export function psql(sql, name = DB) {
  const url = localDatabaseUrl(name)
  const dir = pgBin()
  const bin = dir ? join(dir, 'psql') : 'psql'
  return execFileSync(bin, ['-X', '-At', '-h', url.hostname, '-p', url.port || '5432', '-U', decodeURIComponent(url.username), '-d', name, '-c', sql], {
    env: { ...process.env, PGPASSWORD: decodeURIComponent(url.password), PGCONNECT_TIMEOUT: '10' },
  }).toString().trim()
}
