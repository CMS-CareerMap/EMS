// The demo: CareerMap Solutions with sixteen people in all seven roles, to
// click through by hand at http://localhost:5183.
//
//   npm run demo                 build it the first time, then just start it
//   npm run demo -- --fresh      throw the demo away and build it again (today's dates)
//   npm run demo -- --build      build the server and the web app first
//
// Its own LOCAL database, ems_demo — never Neon, never the test databases.
// It uses the same ports as the browser tests (:4100, :5183), so run one or
// the other. Ctrl+C stops it; the data stays for next time.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { API, BASE, WORK, psql } from '../lib/env.mjs'
import { LOGS, build, migrate, resetDatabase, seed, startApi, startWeb, stop } from '../lib/stack.mjs'

const DEMO_DB = 'ems_demo'
const flags = new Set(process.argv.slice(2))
for (const f of flags) if (!['--fresh', '--build'].includes(f)) throw new Error(`Unknown option ${f}. Options: --fresh, --build`)

const children = []
process.on('SIGINT', async () => {
  for (const c of children.reverse()) await stop(c)
  process.exit(0)
})

if (flags.has('--build')) build()
if (flags.has('--fresh')) {
  console.log(`emptying ${DEMO_DB} and building the demo again…`)
  resetDatabase(DEMO_DB)
} else {
  migrate(DEMO_DB)
}
const fresh = Number(psql('SELECT count(*) FROM "Organization"', DEMO_DB)) === 0
if (fresh) seed('demo', 'seed', null, { db: DEMO_DB })

const api = await startApi({ db: DEMO_DB, log: join(LOGS, 'demo.api.log'), storage: join(WORK, 'demo-uploads') })
children.push(api)
let fx
try {
  children.push(await startWeb({ log: join(LOGS, 'demo.web.log') }))
  fx = JSON.parse(readFileSync(join(WORK, 'demo-fixture.json'), 'utf8'))
} catch (err) {
  // Nothing is left running when the demo cannot start.
  for (const c of children.reverse()) await stop(c)
  console.error(`\nThe demo could not start: ${err.message}${fx === undefined ? '\n(Its company is in ems_demo but the fixture is missing: npm run demo -- --fresh)' : ''}`)
  process.exit(1)
}
const E = fx.employees
const LOGIN = {
  rahul: 'superadmin@example.com', hema: 'hr@example.com', anil: 'accounts@example.com', arjun: 'admin@example.com',
  manoj: 'manager@example.com', rekha: 'rm@example.com', priya: 'employee@example.com',
  ravi: 'ravi@example.com', sneha: 'sneha@example.com', vikram: 'vikram@example.com', amit: 'amit@example.com',
  karan: 'karan@example.com', pooja: 'pooja@example.com',
}

// ── The API, as each person ─────────────────────────────────────────────────
const tokens = {}
async function as(who) {
  if (tokens[who]) return tokens[who]
  const res = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: LOGIN[who], password: fx.password }) })
  const body = await res.json()
  if (res.status !== 200) throw new Error(`sign-in as ${who}: ${res.status} ${JSON.stringify(body)}`)
  tokens[who] = body.data.accessToken
  return tokens[who]
}
/** One call; anything but a 2xx stops the build with the server's own words. */
async function call(who, method, path, body, { form = null } = {}) {
  const headers = { Authorization: `Bearer ${await as(who)}` }
  if (body) headers['Content-Type'] = 'application/json'
  const res = await fetch(`${API}${path}`, { method, headers, body: form ?? (body ? JSON.stringify(body) : undefined) })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = text }
  if (res.status >= 300) throw new Error(`${who} ${method} ${path} → ${res.status}: ${JSON.stringify(json?.error ?? json)}`)
  return json?.data
}
const step = (text) => console.log(`  · ${text}`)

async function tell() {
  const p = fx.plan
  console.log('\nbuilding the story through the app…')

  // Leave already taken in the last two months, each approved by the person above.
  for (const [who, l] of Object.entries(p.approvedLeave)) {
    const leave = await call(who, 'POST', '/leave-requests', { leaveTypeId: fx.leaveTypes[l.type], fromDate: l.from, toDate: l.to, reason: l.reason })
    await call(l.by, 'POST', `/leave-requests/${leave.id}/approve`, { note: 'Approved — enjoy.' })
    step(`${E[who].name}: ${l.type} ${l.from}${l.to !== l.from ? ` to ${l.to}` : ''}, approved by ${E[l.by].name}`)
  }
  for (const [who, l] of Object.entries(p.rejectedLeave)) {
    const leave = await call(who, 'POST', '/leave-requests', { leaveTypeId: fx.leaveTypes[l.type], fromDate: l.from, toDate: l.to, reason: l.reason })
    await call(l.by, 'POST', `/leave-requests/${leave.id}/reject`, { note: l.note })
    step(`${E[who].name}: ${l.type} on ${l.from}, rejected by ${E[l.by].name}`)
  }
  // Leave waiting for a decision.
  for (const [who, l] of Object.entries(p.pendingLeave)) {
    await call(who, 'POST', '/leave-requests', { leaveTypeId: fx.leaveTypes[l.type], fromDate: l.from, toDate: l.to, reason: l.reason })
    step(`${E[who].name}: ${l.type} ${l.from}${l.to !== l.from ? ` to ${l.to}` : ''}, waiting`)
  }

  // Requests: one approved, the rest waiting for the manager or HR.
  const c = p.correction
  await call(c.who, 'POST', '/requests', { type: 'attendance_correction', date: c.date, checkIn: c.checkIn, checkOut: c.checkOut, reason: c.reason })
  step(`${E[c.who].name}: attendance correction for ${c.date}, waiting`)
  await call(p.wfh.who, 'POST', '/requests', { type: 'work_from_home', fromDate: p.wfh.from, toDate: p.wfh.to, reason: p.wfh.reason })
  step(`${E[p.wfh.who].name}: work from home on ${p.wfh.from}, waiting`)
  await call(p.onDuty.who, 'POST', '/requests', { type: 'on_duty', fromDate: p.onDuty.from, toDate: p.onDuty.to, reason: p.onDuty.reason })
  step(`${E[p.onDuty.who].name}: on duty on ${p.onDuty.from}, waiting`)
  const wfh = await call(p.approvedWfh.who, 'POST', '/requests', { type: 'work_from_home', fromDate: p.approvedWfh.from, toDate: p.approvedWfh.to, reason: p.approvedWfh.reason })
  await call(p.approvedWfh.by, 'POST', `/requests/${wfh.id}/approve`, { note: 'Fine.' })
  step(`${E[p.approvedWfh.who].name}: work from home on ${p.approvedWfh.from}, approved by ${E[p.approvedWfh.by].name}`)
  await call(p.profileChange.who, 'POST', '/requests', { type: 'profile_change', changes: p.profileChange.changes, reason: p.profileChange.reason })
  step(`${E[p.profileChange.who].name}: change of phone and address, waiting for HR`)

  // A resignation waiting for the manager to accept.
  await call(p.resignation.who, 'POST', '/lifecycle/resignations', { reason: p.resignation.reason, requestedLastDay: p.resignation.requestedLastDay })
  step(`${E[p.resignation.who].name}: resigned, waiting for acceptance`)

  // HR publishes the handbook to everybody.
  const form = new FormData()
  form.append('file', new Blob([readFileSync(p.handbook)], { type: 'application/pdf' }), 'Employee-Handbook.pdf')
  form.append('title', 'Employee Handbook')
  form.append('category', 'handbook')
  form.append('description', 'Working hours, leave and payslips')
  await call('hema', 'POST', '/company-documents', null, { form })
  step('HR published the Employee Handbook')

  // Payroll: last month's incentives and an advance, then two runs.
  const { paid, waiting, paidOn } = p.payroll
  for (const i of p.incentives) {
    await call('anil', 'PUT', '/payroll/monthly-entries', { employeeId: E[i.who].id, componentCode: 'INCENTIVE', year: waiting.year, month: waiting.month, amount: i.amount, note: i.note })
  }
  step(`Accounts entered incentives for ${waiting.month}/${waiting.year}`)
  const m0 = { year: Number(fx.months.m0.slice(0, 4)), month: Number(fx.months.m0.slice(5, 7)) }
  await call('anil', 'POST', '/payroll/loans', { employeeId: E[p.advance.who].id, kind: 'advance', amount: p.advance.amount, installment: p.advance.installment, startYear: m0.year, startMonth: m0.month, note: p.advance.note })
  step(`Accounts recorded an advance for ${E[p.advance.who].name}`)

  const first = await call('anil', 'POST', '/payroll-runs', paid)
  await call('rahul', 'POST', `/payroll-runs/${first.id}/approve`, {})
  await call('anil', 'POST', `/payroll-runs/${first.id}/mark-paid`, { paidOn })
  step(`Payroll for ${paid.month}/${paid.year}: calculated by Accounts, approved by the Super Admin, paid on ${paidOn}`)
  await call('anil', 'POST', '/payroll-runs', waiting)
  step(`Payroll for ${waiting.month}/${waiting.year}: calculated by Accounts, waiting for the Super Admin to approve`)
}

if (fresh) {
  try {
    await tell()
  } catch (err) {
    console.error(`\nThe demo could not be built: ${err.message}`)
    console.error('The API log is in e2e/.work/logs/demo.api.log. Fix it, then: npm run demo -- --fresh')
    for (const c of children.reverse()) await stop(c)
    process.exit(1)
  }
}

const rows = [
  ['Super Admin', 'superadmin@example.com', 'Rahul Mehta — the owner: everything, approves payroll'],
  ['Admin', 'admin@example.com', 'Arjun Nair — employee records and documents (own leave: arjun@example.com)'],
  ['HR', 'hr@example.com', 'Hema Iyer — people, attendance, leave balances, documents'],
  ['Accounts', 'accounts@example.com', 'Anil Kapoor — salaries, payroll, bank file (own leave: anil@example.com)'],
  ['Manager', 'manager@example.com', 'Manoj Sharma — head of Sales, decides his team'],
  ['Reporting Manager', 'rm@example.com', 'Rekha Rao — leads Priya, Ravi and Sneha'],
  ['Employee', 'employee@example.com', 'Priya Deshmukh — her own things only (or sign in as CMS007)'],
]
console.log(`
  The demo is running: ${BASE}

  Password for every login: ${fx.password}

  ${'Role'.padEnd(18)} ${'Sign in with'.padEnd(24)} Who
  ${rows.map(([r, e, w]) => `${r.padEnd(18)} ${e.padEnd(24)} ${w}`).join('\n  ')}

  More people: ravi@, sneha@, vikram@, amit@, karan@, pooja@, neha@, sunil@ (all @example.com, Employee role).
  What to try, role by role: e2e/DEMO.md.  Ctrl+C stops it; the data stays for next time.
`)
