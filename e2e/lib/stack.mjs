// The isolated stack the browser tests run on: the COMPILED API on :4100 and
// the built web app on :5183 (served as production serves it), over a local
// database. Started and stopped by whoever asks — never left running.
import { spawn, spawnSync } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { API_PORT, DB, E2E, SERVER, STORAGE, WEB, WEB_PORT, WORK, localDatabaseUrl } from './env.mjs'

const isWin = process.platform === 'win32'
export const LOGS = join(WORK, 'logs')
mkdirSync(LOGS, { recursive: true })

/** Everything a server-side command needs to talk to a LOCAL database and nothing else. */
function serverEnv(db, extra = {}) {
  const url = localDatabaseUrl(db).toString()
  const env = { ...process.env, DATABASE_URL: url, DIRECT_URL: url, E2E_WORK: WORK, ...extra }
  // A fake clock is only ever handed out on purpose (startApi's fakeNow).
  delete env.FAKE_NOW
  delete env.NODE_OPTIONS
  return env
}

/** A Prisma CLI command against a local database. `migrate reset` only when asked for by name. */
export function prisma(args, { db = DB, allowReset = false } = {}) {
  if (args.includes('reset') && !allowReset) throw new Error('Refusing: a reset must be asked for explicitly (--reset).')
  const r = spawnSync('npx', ['prisma', ...args], { cwd: SERVER, shell: isWin, stdio: 'inherit', env: serverEnv(db) })
  if (r.status !== 0) throw new Error(`prisma ${args.join(' ')} failed (${r.status})`)
}

/** Brings a local database to the latest migration, creating it if it is not there. */
export function migrate(db = DB) {
  prisma(['migrate', 'deploy'], { db })
}

/** The only databases a reset may empty: the browser tests' and the demo's — never the unit tests' or anybody's own. */
const RESETTABLE = new Set(['ems_e2e', 'ems_demo'])

/** Empties a local database and migrates it from nothing — every migration, from the first. */
export function resetDatabase(db = DB) {
  if (!RESETTABLE.has(db)) throw new Error(`Refusing to empty "${db}": only ${[...RESETTABLE].join(' and ')} may be reset from here.`)
  prisma(['migrate', 'reset', '--force', '--skip-seed', '--skip-generate'], { db, allowReset: true })
}

/** A seed in server/scripts/e2e: `seed('day20', 'seed')`, `seed('day18', 'seed', 'review')`, `seed('day20', 'cleanup', stamp)`. */
export function seed(name, mode, arg, { db = DB, quiet = false } = {}) {
  const args = ['tsx', `scripts/e2e/${name}-seed.ts`, mode, ...(arg ? [String(arg)] : [])]
  const r = spawnSync('npx', args, { cwd: SERVER, shell: isWin, stdio: quiet ? 'pipe' : 'inherit', env: serverEnv(db) })
  if (r.status !== 0) {
    if (quiet) process.stderr.write(String(r.stderr ?? ''))
    throw new Error(`seed ${name} ${mode} failed (${r.status})`)
  }
  return quiet ? String(r.stdout ?? '') : ''
}

/** An npm script of the server's (`npm run bootstrap`, `npm run backup:drill`) against a local database. */
export function serverScript(script, args = [], { db = DB, env = {} } = {}) {
  const r = spawnSync('npm', ['run', script, ...(args.length ? ['--', ...args] : [])], {
    cwd: SERVER, shell: isWin, stdio: 'inherit', env: serverEnv(db, { SMTP_HOST: '', ...env }),
  })
  if (r.status !== 0) throw new Error(`npm run ${script} failed (${r.status})`)
}

async function waitFor(url, what, child, ms = 60_000) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new Error(`${what} stopped while starting (exit ${child.exitCode}) — see its log in e2e/.work/logs`)
    try {
      const res = await fetch(url)
      if (res.status < 500) return
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`${what} did not come up on ${url}`)
}

/** Nothing answers on the port: a refused connection. Anything else — an answer, a hang — is somebody there. */
async function portFree(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) })
    return false
  } catch (err) {
    return err?.cause?.code === 'ECONNREFUSED'
  }
}

function needBuild(path, what) {
  if (!existsSync(path)) throw new Error(`${what} is not built (${path} missing). Run with --build, or build it first.`)
}

/** A child's output, into a log file of its own (appended: one file can hold a whole run). */
function logTo(child, file) {
  mkdirSync(dirname(file), { recursive: true })
  const out = createWriteStream(file, { flags: 'a' })
  child.stdout.pipe(out, { end: false })
  child.stderr.pipe(out, { end: false })
  child.once('exit', () => out.end())
}

/** The compiled API on :4100 over a local database — with a fake clock when `fakeNow` is given. */
export async function startApi({ db = DB, fakeNow = null, log = join(LOGS, 'api.log'), storage = STORAGE } = {}) {
  needBuild(join(SERVER, 'dist', 'src', 'main.js'), 'The server')
  if (!(await portFree(API_PORT))) throw new Error(`Port ${API_PORT} is in use. Stop whatever is on it (an earlier run?) and try again.`)
  const env = serverEnv(db, {
    PORT: String(API_PORT),
    NODE_ENV: 'production',
    CORS_ORIGIN: `http://localhost:${WEB_PORT}`,
    STORAGE_DRIVER: 'local',
    STORAGE_PATH: storage,
    // Email stays off: set and empty means off (server/src/config/env.ts), and
    // .env cannot fill it back in — no mail account is ever reached from here.
    SMTP_HOST: '',
    // One proxy in front: scripts/web.mjs. Whatever server/.env says.
    TRUST_PROXY_HOPS: '1',
  })
  if (fakeNow) {
    env.FAKE_NOW = fakeNow
    env.NODE_OPTIONS = `--require ${join(E2E, 'scripts', 'fake-now.cjs')}`
  }
  const child = spawn('node', ['dist/src/main.js'], { cwd: SERVER, env, stdio: ['ignore', 'pipe', 'pipe'] })
  logTo(child, log)
  // A start that never answers is stopped, not left holding the port.
  await waitFor(`http://127.0.0.1:${API_PORT}/health`, 'The API', child).catch(async (err) => { await stop(child); throw err })
  return child
}

/** The built web app on :5183, served with production's headers, /api proxied to :4100. */
export async function startWeb({ log = join(LOGS, 'web.log') } = {}) {
  needBuild(join(WEB, 'dist', 'index.html'), 'The web app')
  if (!(await portFree(WEB_PORT))) throw new Error(`Port ${WEB_PORT} is in use. Stop whatever is on it and try again.`)
  const child = spawn('node', [join(E2E, 'scripts', 'web.mjs')], { cwd: E2E, stdio: ['ignore', 'pipe', 'pipe'] })
  logTo(child, log)
  await waitFor(`http://127.0.0.1:${WEB_PORT}/signin`, 'The web app', child).catch(async (err) => { await stop(child); throw err })
  return child
}

/** Stops a process this stack started, and waits until it has gone. */
export async function stop(child) {
  if (!child || child.exitCode !== null) return
  const gone = new Promise((r) => child.once('exit', r))
  child.kill()
  await Promise.race([gone, new Promise((r) => setTimeout(r, 5000))])
}

/** Builds the server and the web app as production does. Never while the web app is being served. */
export function build() {
  for (const [dir, what] of [[SERVER, 'server'], [WEB, 'web']]) {
    console.log(`building the ${what}…`)
    const r = spawnSync('npm', ['run', 'build'], { cwd: dir, shell: isWin, stdio: 'inherit' })
    if (r.status !== 0) throw new Error(`the ${what} build failed`)
  }
}
