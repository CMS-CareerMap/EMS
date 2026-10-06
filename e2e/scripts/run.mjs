// Runs the browser suites on the isolated stack, each on a fresh seed with a
// fresh API, and prints one line per suite.
//
//   node scripts/run.mjs                    every suite except golden
//   node scripts/run.mjs day20 v1gaps       just these
//   node scripts/run.mjs --reset            empty ems_e2e first (migrating it from nothing), then golden first
//   node scripts/run.mjs --build            build the server and the web app first
//
// Logs: e2e/.work/logs/<suite>.log (the suite) and <suite>.api.log (its API).
// Only ever a LOCAL database; never :4000/:5173.
import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DB, E2E, WORK } from '../lib/env.mjs'
import { LOGS, build, resetDatabase, migrate, seed, startApi, startWeb, stop } from '../lib/stack.mjs'

// The Day 18/19 suites were written on 30 Sep 2026 against "this month" and
// run as on that afternoon: the API by fake-now.cjs, the browser by its clock.
const SEP30 = '2026-09-30T13:00:00+05:30'

/** Each suite: the seed it needs (name, variant, the fixture it writes) and the clock it runs at. */
const SUITES = {
  golden: { empty: true },
  day18: { seed: ['day18', 'base', 'day18-fixture.json'], fakeNow: SEP30 },
  day18b: { seed: ['day18', 'review', 'day18-review-fixture.json'], fakeNow: SEP30 },
  'day18-tds': { seed: ['day18', 'tds', 'day18-tds-fixture.json'], fakeNow: SEP30 },
  day19: { seed: ['day19', null, 'day19-fixture.json'], fakeNow: SEP30 },
  day19b: { seed: ['day19', null, 'day19-fixture.json'] },
  day20: { seed: ['day20', null, 'day20-fixture.json'] },
  day21: { seed: ['day20', null, 'day20-fixture.json'] },
  day22: { seed: ['day20', null, 'day20-fixture.json'] },
  day23: { seed: ['day20', null, 'day20-fixture.json'] },
  lifecycle: { seed: ['day20', null, 'day20-fixture.json'] },
  'wages-share': { seed: ['day20', null, 'day20-fixture.json'] },
  v1gaps: { seed: ['day20', null, 'day20-fixture.json'] },
  v1gaps2: { seed: ['day20', null, 'day20-fixture.json'] },
  sweep23: { seed: ['day20', null, 'day20-fixture.json'] },
  newlook: { seed: ['day20', null, 'day20-fixture.json'] },
  holidays: { seed: ['day20', null, 'day20-fixture.json'] },
}

const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith('--')))
const named = process.argv.slice(2).filter((a) => !a.startsWith('--'))
for (const f of flags) if (!['--reset', '--build'].includes(f)) throw new Error(`Unknown option ${f}`)
for (const n of named) if (!SUITES[n]) throw new Error(`Unknown suite "${n}". Suites: ${Object.keys(SUITES).join(', ')}`)

// Golden starts the company from nothing, so it needs a database with no company in it: only after --reset.
const wanted = named.length ? named : Object.keys(SUITES).filter((n) => n !== 'golden' || flags.has('--reset'))
if (flags.has('--reset') && !named.length) console.log('--reset: golden runs first, on the emptied database')

const children = new Set()
async function stopAll() {
  for (const c of children) await stop(c)
  children.clear()
}
process.on('SIGINT', async () => {
  console.log('\nstopping…')
  await stopAll()
  process.exit(130)
})

/** Removes the company a seed left last time (its stamp is in the fixture), so runs do not pile up. */
function cleanupPrevious(name, fixture) {
  const file = join(WORK, fixture)
  if (!existsSync(file)) return
  const { stamp } = JSON.parse(readFileSync(file, 'utf8'))
  try {
    seed(name, 'cleanup', stamp, { quiet: true })
  } catch (err) {
    // Not fatal: the next seed makes a company of its own beside it.
    console.log(`  (could not remove the last ${name} company ${stamp}: ${err.message} — a --reset clears it)`)
  }
}

/** One suite, its output to the console and to its log; resolves with the counts. */
function runSuite(name, fakeNow) {
  return new Promise((resolve) => {
    const log = createWriteStream(join(LOGS, `${name}.log`))
    const env = { ...process.env, E2E_WORK: WORK }
    delete env.FAKE_NOW
    delete env.NODE_OPTIONS
    // The suite's own clock moves with the API's: its "today" is the day it was written for.
    if (fakeNow) {
      env.FAKE_NOW = fakeNow
      env.NODE_OPTIONS = `--require ${join(E2E, 'scripts', 'fake-now.cjs')}`
    }
    const child = spawn('node', [join(E2E, 'suites', `${name}.mjs`)], { cwd: E2E, env, stdio: ['ignore', 'pipe', 'pipe'] })
    children.add(child)
    let pass = 0
    let fail = 0
    let last = ''
    let tail = ''
    const onData = (d) => {
      const text = String(d)
      process.stdout.write(text)
      log.write(text)
      tail += text
      const lines = tail.split(/\r?\n/)
      tail = lines.pop() ?? ''
      for (const line of lines) {
        if (line.startsWith('PASS')) pass += 1
        if (line.startsWith('FAIL')) fail += 1
        if (line.trim()) last = line.trim()
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    // A suite that hangs is a failure, not a run that never ends.
    const timer = setTimeout(() => child.kill(), 40 * 60 * 1000)
    child.on('exit', (code) => {
      clearTimeout(timer)
      children.delete(child)
      if (tail.trim()) last = tail.trim()
      log.end()
      resolve({ name, code: code ?? 1, pass, fail, last })
    })
  })
}

const results = []
try {
  if (flags.has('--build')) build()
  if (flags.has('--reset')) {
    console.log(`emptying ${DB} and migrating it from the first migration…`)
    resetDatabase()
  } else {
    migrate()
  }
  const web = await startWeb()
  children.add(web)

  for (const name of wanted) {
    const suite = SUITES[name]
    console.log(`\n=== ${name} ===`)
    if (suite.seed) {
      const [seedName, variant, fixture] = suite.seed
      cleanupPrevious(seedName, fixture)
      seed(seedName, 'seed', variant, { quiet: true })
    }
    const api = await startApi({ fakeNow: suite.fakeNow ?? null, log: join(LOGS, `${name}.api.log`) })
    children.add(api)
    try {
      results.push(await runSuite(name, suite.fakeNow))
    } finally {
      await stop(api)
      children.delete(api)
    }
  }
} finally {
  await stopAll()
}

console.log('\n=== summary ===')
for (const r of results) {
  const ok = r.code === 0 && r.fail === 0
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${r.name.padEnd(12)} ${String(r.pass).padStart(4)} passed · ${r.fail} failed · ${r.last}`)
}
const bad = results.filter((r) => r.code !== 0 || r.fail > 0)
console.log(bad.length ? `\n${bad.length} suite(s) failed — logs in e2e/.work/logs` : `\nall ${results.length} suite(s) passed`)
process.exitCode = bad.length || results.length !== wanted.length ? 1 : 0
