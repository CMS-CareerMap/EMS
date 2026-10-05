// How long the heavy screens take with a company of 200 people and a year of
// attendance: the payroll run, the reports, the dashboard, the lists. Its own
// LOCAL database, ems_perf (built the first time). Uses :4100 like the browser
// tests, so run one or the other.
//
//   node scripts/perf.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { API_PORT, WORK, psql } from '../lib/env.mjs'
import { LOGS, migrate, seed, startApi, stop } from '../lib/stack.mjs'

const DB = 'ems_perf'
migrate(DB)
if (Number(psql('SELECT count(*) FROM "Organization"', DB)) === 0) seed('perf', 'seed', null, { db: DB })
const fx = JSON.parse(readFileSync(join(WORK, 'perf-fixture.json'), 'utf8'))

const api = await startApi({ db: DB, log: join(LOGS, 'perf.api.log') })
const BASE = `http://127.0.0.1:${API_PORT}/api`
const results = []
try {
  const login = await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: fx.email, password: fx.password }) })
  const token = (await login.json()).data.accessToken
  const call = async (method, path, body) => {
    const started = performance.now()
    const res = await fetch(`${BASE}${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
    const text = await res.text()
    const ms = performance.now() - started
    if (res.status >= 300) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 300)}`)
    return { ms, json: JSON.parse(text) }
  }
  /** Three timed calls after one to warm up; the slowest and the middle one. */
  async function time(label, method, path, body) {
    await call(method, path, body)
    const runs = []
    for (let i = 0; i < 3; i++) runs.push((await call(method, path, body)).ms)
    runs.sort((a, b) => a - b)
    results.push({ label, median: Math.round(runs[1]), worst: Math.round(runs[2]) })
  }

  const now = new Date()
  const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
  const month = { year: last.getUTCFullYear(), month: last.getUTCMonth() + 1 }

  // The payroll run: created once, then recalculated (the same work) for timing.
  const runs = await call('GET', '/payroll-runs')
  let run = (runs.json.data.runs ?? runs.json.data ?? []).find?.((r) => r.year === month.year && r.month === month.month)
  if (!run) {
    const created = await call('POST', '/payroll-runs', month)
    results.push({ label: `Payroll run for ${fx.people} people (create)`, median: Math.round(created.ms), worst: Math.round(created.ms) })
    run = created.json.data
  }
  await time(`Payroll run for ${fx.people} people (recalculate)`, 'POST', `/payroll-runs/${run.id}/recalculate`, {})
  await time('Payroll readiness', 'GET', `/payroll-runs/readiness?year=${month.year}&month=${month.month}`)
  for (const id of ['attendance-summary', 'attendance-by-department', 'shift-overtime', 'leave-balances', 'payroll-summary', 'pf-esi', 'headcount', 'joiners-exits']) {
    await time(`Report: ${id}`, 'GET', `/reports/${id}?year=${month.year}&month=${month.month}`)
  }
  await time('Attendance: month hours per person', 'GET', `/attendance/monthly-summary?year=${month.year}&month=${month.month}`)
  await time('Attendance: one day, everybody', 'GET', `/attendance/day?date=${last.toISOString().slice(0, 10)}`)
  // The home page's company sections (the one /dashboard/summary was split into them).
  await time('Home: today at work, everybody', 'GET', '/dashboard/today')
  await time('Home: people', 'GET', '/dashboard/people')
  await time('Home: payroll', 'GET', '/dashboard/payroll')
  await time('Employees list', 'GET', '/employees')
  await time('Leave balances, everybody', 'GET', '/leave-balances')
} finally {
  await stop(api)
}

console.log(`\n${fx.people} people, ${fx.attendanceDays} attendance days\n`)
console.log(`${'What'.padEnd(46)} ${'median'.padStart(8)} ${'worst'.padStart(8)}`)
for (const r of results) console.log(`${r.label.padEnd(46)} ${String(r.median).padStart(6)}ms ${String(r.worst).padStart(6)}ms`)
writeFileSync(join(WORK, 'perf-results.json'), JSON.stringify({ at: new Date().toISOString(), people: fx.people, attendanceDays: fx.attendanceDays, results }, null, 2))
