// No check-in means Absent, the dated working week, marking the people ticked,
// "No out" and the person's month in plain words (client, 25 Oct 2026). Every
// screen in the browser, each role that sees it, and a phone.
// Production build on :5183 → compiled API on :4100 → local ems_e2e, Day 20 seed.
import { chromium } from 'playwright-core'
import { mkdirSync, readFileSync } from 'node:fs'
import { WORK, psql } from '../lib/env.mjs'

const BASE = 'http://localhost:5183'
const API = 'http://localhost:4100/api'
const fx = JSON.parse(readFileSync(`${WORK}/day20-fixture.json`, 'utf8'))
const SHOTS = `${WORK}/shots/absentrule`
mkdirSync(SHOTS, { recursive: true })
const PHONE = { width: 390, height: 844 }
const DESKTOP = { width: 1366, height: 900 }

let passed = 0
const failures = []
function check(name, ok, detail = '') {
  if (ok) { passed++; console.log(`PASS  ${name}`) } else { failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`FAIL  ${name}${detail ? `  — ${detail}` : ''}`) }
}
const section = (name) => console.log(`\n── ${name}`)

const tokens = {}
async function login(who) {
  const res = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: fx.users[who], password: fx.password }) })
  const body = await res.json()
  if (res.status !== 200) throw new Error(`login ${who}: ${res.status} ${JSON.stringify(body)}`)
  tokens[who] = body.data.accessToken
}
async function api(who, method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${tokens[who]}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { json = text }
  return { status: res.status, body: json }
}

const today = psql(`SELECT to_char(now() AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD')`)
const addDays = (day, n) => { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toJSON().slice(0, 10) }
const weekday = (day) => new Date(`${day}T00:00:00Z`).getUTCDay()
const yesterday = addDays(today, -1)
const emp = fx.employees
const org = fx.organizationId
const systemRows = () => Number(psql(`SELECT count(*) FROM "Attendance" WHERE "organizationId" = '${org}' AND source = 'system'`))
const rowOf = (id, day) => psql(`SELECT status || '|' || source || '|' || coalesce(note, '') FROM "Attendance" WHERE "employeeId" = '${id}' AND date = '${day}'`)

const browser = await chromium.launch({ channel: 'msedge', headless: true })
const pageErrors = []
const serverErrors = []
async function open(who, viewport = DESKTOP) {
  const ctx = await browser.newContext({ viewport })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => pageErrors.push(`${who}: ${e.message}`))
  page.on('response', (r) => { if (r.url().includes('/api/') && r.status() >= 500) serverErrors.push(`${r.status()} ${r.url().split('/api')[1]}`) })
  await page.goto(`${BASE}/signin`)
  await page.getByLabel('Work Email or Employee ID').fill(fx.users[who])
  await page.getByPlaceholder('Enter your password').fill(fx.password)
  await page.getByRole('button', { name: 'Sign In' }).click()
  await page.waitForURL((u) => !u.pathname.startsWith('/signin'), { timeout: 20_000 })
  return page
}
const shown = (locator, timeout = 20_000) => locator.first().waitFor({ timeout }).then(() => true, () => false)
const sideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
const settled = (page) => page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined)

try {
  // The seed made everybody today; a company's people were added, logins and all, long before
  // (the no-check-in rule judges nobody's day before their record and login were made).
  psql(`UPDATE "Employee" SET "createdAt" = "dateOfJoining" WHERE "organizationId" = '${org}' AND "dateOfJoining" IS NOT NULL`)
  psql(`UPDATE "Membership" SET "createdAt" = '2025-01-06T04:30:00Z' WHERE "organizationId" = '${org}'`)
  for (const who of ['sa', 'hr', 'mgr', 'emp', 'emp2']) await login(who)

  // ═══════════════════════════════════════════════════════════════════════
  section('The working week, dated — Settings → Leave Config')
  const sa = await open('sa')
  await sa.goto(`${BASE}/settings?tab=leave`)
  await settled(sa)
  check('the week in force today, and since when', await shown(sa.getByText(/Closed on/)) && await shown(sa.getByText(/In force since/)))
  await sa.getByRole('button', { name: 'Change weekly offs' }).click()
  const dialog = sa.getByRole('dialog', { name: 'Change weekly offs' })
  check('Change opens the choice of days and of when', await shown(dialog.getByText('Starting')))
  const starts = await dialog.locator('input[type="radio"]').count()
  check('…from today, the 1st of next month, or the 1st of this one', starts === (today.endsWith('-01') ? 2 : 3), `${starts} choices`)
  await dialog.getByRole('button', { name: 'Sat', exact: true }).click()
  await dialog.getByText('From the 1st of next month').click()
  await sa.screenshot({ path: `${SHOTS}/change-week.png` })
  await dialog.getByRole('button', { name: 'Save' }).click()
  check('saved for later, and said so', await shown(sa.getByText(/From .*: Saturday and Sunday\./)))
  const view = await api('sa', 'GET', '/settings/work-week')
  check('…the week today is unchanged', JSON.stringify(view.body.data.current.weekly_off_days) === '[0]', JSON.stringify(view.body.data.current))
  const next = view.body.data.starts.next_month

  // The employee sees what is coming, on their own Timings.
  const priya = await open('emp')
  await priya.goto(`${BASE}/attendance`)
  await settled(priya)
  check('the employee’s Timings say what is coming', await shown(priya.getByText(new RegExp(`^From `)).filter({ hasText: /\d/ })), 'no "From …" row')
  await priya.screenshot({ path: `${SHOTS}/timings-next-week.png` })

  await sa.getByRole('button', { name: 'Cancel this change' }).click()
  await sa.getByRole('dialog').getByRole('button', { name: 'Cancel the change' }).click()
  check('a change not started yet can be cancelled', await sa.getByText(/From .*: Saturday and Sunday\./).count().then((n) => n === 0) || await until0(sa))
  check('…and is gone from the server', (await api('sa', 'GET', '/settings/work-week')).body.data.scheduled.length === 0)

  // From today: the coming Saturday is off, the last one stays a working day.
  const fromToday = await api('sa', 'PUT', '/settings/work-week', { weeklyOffDays: [0, 6], from: today })
  check('Saturday and Sunday from today', fromToday.status === 200, JSON.stringify(fromToday.body).slice(0, 200))
  let nextSat = today
  while (weekday(nextSat) !== 6) nextSat = addDays(nextSat, 1)
  let lastSat = yesterday
  while (weekday(lastSat) !== 6) lastSat = addDays(lastSat, -1)
  const daysOff = async (day) => (await api('hr', 'GET', `/attendance/calendar?year=${day.slice(0, 4)}&month=${Number(day.slice(5, 7))}`)).body.data.days_off.map((d) => d.date)
  check('the coming Saturday is off on the calendar', (await daysOff(nextSat)).includes(nextSat), nextSat)
  check('the Saturday gone by stays a working day', !(await daysOff(lastSat)).includes(lastSat), lastSat)
  const leaveOver = await api('emp', 'POST', '/leave-requests/preview', { leaveTypeId: fx.leaveTypeId, fromDate: nextSat, toDate: nextSat })
  check('leave is not charged for the coming Saturday — the same answer as the calendar', leaveOver.status !== 200 || leaveOver.body.data.days === 0, JSON.stringify(leaveOver.body).slice(0, 160))
  // Back to Sundays, from today: the same day's change is a correction.
  check('back to Sundays from today', (await api('sa', 'PUT', '/settings/work-week', { weeklyOffDays: [0], from: today })).status === 200)
  check('HR cannot change the week', (await api('hr', 'PUT', '/settings/work-week', { weeklyOffDays: [0, 6], from: next })).status === 403)

  // ═══════════════════════════════════════════════════════════════════════
  section('No check-in means Absent — Settings → Attendance Security')
  const rule = (await api('sa', 'GET', '/settings/absent-rule')).body.data
  check('off to begin with', rule.on === false, JSON.stringify(rule))
  await sa.goto(`${BASE}/settings?tab=attendance-security`)
  await settled(sa)
  const ruleSection = sa.getByRole('region', { name: 'No Check-in Means Absent' })
  check('the section is there', await shown(ruleSection))
  await ruleSection.getByRole('switch', { name: 'No check-in means absent' }).click()
  await ruleSection.getByLabel('The first day the rule applies to').fill(rule.earliest_from)
  check('before saving, it says what saving will do', await shown(ruleSection.getByText(/Saving will mark \d+ days? absent/), 30_000))
  await sa.screenshot({ path: `${SHOTS}/rule-preview.png`, fullPage: true })
  check('nothing written by the preview', systemRows() === 0)
  await ruleSection.getByRole('button', { name: 'Save rule' }).click()
  check('saved, with what it did', await shown(sa.locator('[data-sonner-toast]').filter({ hasText: /days? marked absent/ })))
  const marked = systemRows()
  check('days with nothing in them are Absent now', marked > 0, `${marked}`)
  check('…“No check-in”, written by the system', rowOf(emp.ravi.id, yesterday).startsWith('absent|system|No check-in') || weekday(yesterday) === 0, rowOf(emp.ravi.id, yesterday))
  check('…never a day somebody recorded', rowOf(emp.priya.id, '2026-09-10') === 'absent|manual|')
  check('…never a Sunday', psql(`SELECT count(*) FROM "Attendance" WHERE "organizationId" = '${org}' AND source = 'system' AND extract(dow FROM date) = 0`) === '0')

  // ═══════════════════════════════════════════════════════════════════════
  section('The person’s month says why')
  const hema = await open('hr')
  const monthKey = yesterday.slice(0, 7)
  await hema.goto(`${BASE}/attendance/people/${emp.ravi.id}?month=${monthKey}`)
  await settled(hema)
  check('the calendar says “No check-in”', await shown(hema.getByText('No check-in')))
  check('the month says what is cut — his absent days — and no "Paid days 31 of 31"', await shown(hema.getByText(/cut from pay: absent/)) && (await hema.getByText('Paid days', { exact: true }).count()) === 0)
  await hema.getByRole('tab', { name: 'Day by day' }).click().catch(() => undefined)
  check('the day log says “Absent · no check-in”', await shown(hema.getByText('Absent · no check-in')))
  await hema.screenshot({ path: `${SHOTS}/person-month.png`, fullPage: true })
  const told = Number(psql(`SELECT count(*) FROM "Notification" n JOIN "User" u ON u.id = n."userId" WHERE u.email = '${fx.users.emp2}' AND n.event = 'attendance.absent'`))
  check('Ravi was told, with the way to undo it', told >= 1, `${told}`)

  // ═══════════════════════════════════════════════════════════════════════
  section('The roster: ticked people marked, "No out"')
  // Priya checked in on the app yesterday and never out — just after yesterday's midnight, so her
  // day is over whenever this runs: one checked in at ten could still be closed until six this
  // morning (a long day runs past midnight, never past twenty hours), and is not "No Out" before then.
  psql(`DELETE FROM "Attendance" WHERE "employeeId" = '${emp.priya.id}' AND date = '${yesterday}'`)
  psql(`INSERT INTO "Attendance" (id, "organizationId", "employeeId", date, "checkIn", status, source, "updatedAt") VALUES (gen_random_uuid()::text, '${org}', '${emp.priya.id}', '${yesterday}', '${yesterday}T00:30:00+05:30', 'present', 'punch', now())`)
  await hema.goto(`${BASE}/attendance?view=daily&date=${yesterday}`)
  await settled(hema)
  const noOut = hema.getByRole('button', { name: /^No Out/ })
  check('“No Out” counts the day checked into and never out', (await noOut.innerText()).includes('1'), await noOut.innerText())
  await noOut.click()
  check('…and filters to it', await shown(hema.locator('table tr', { hasText: 'Priya Deshmukh' })) && (await hema.locator('table tbody tr').count()) === 1)
  await hema.getByRole('button', { name: /^All/ }).click()

  check('a day with a check-in cannot be ticked — its times are its evidence', await hema.getByLabel('Priya Deshmukh cannot be ticked').first().isDisabled())
  await hema.getByLabel('Tick Ravi Patil').first().check()
  await hema.getByLabel('Tick Neha Joshi').first().check()
  check('ticking shows how many, and only they are marked', await shown(hema.getByText(/\d+ ticked/)))
  await hema.getByRole('button', { name: 'Mark the ticked…' }).click()
  const mark = hema.getByRole('dialog')
  check('the dialog lists each person, as they are and as they will be', await shown(mark.getByRole('list', { name: 'The people to mark' }).getByText('Ravi Patil')))
  await hema.screenshot({ path: `${SHOTS}/mark-ticked.png` })
  check('…and wants a reason first', await mark.getByRole('button', { name: /^Mark \d/ }).isDisabled())
  await mark.getByPlaceholder('The app was down this morning').fill('The app was down')
  await mark.getByRole('button', { name: /^Mark \d/ }).click()
  check('marked, and said so', await shown(hema.locator('[data-sonner-toast]').filter({ hasText: /marked/ })))
  check('Ravi’s day is present now, with the reason kept', rowOf(emp.ravi.id, yesterday) === 'present|manual|The app was down', rowOf(emp.ravi.id, yesterday))
  check('Priya’s punch is as it was', rowOf(emp.priya.id, yesterday).startsWith('present|punch'))

  // A manager without the power to mark sees no ticks.
  const manoj = await open('mgr')
  await manoj.goto(`${BASE}/attendance?view=daily&date=${yesterday}`)
  await settled(manoj)
  check('a manager who does not mark has nothing to tick', (await manoj.locator('input[type="checkbox"]').count()) === 0)
  check('the API agrees', (await api('mgr', 'POST', '/attendance/mark-many', { date: yesterday, employeeIds: [emp.priya.id], status: 'present', note: 'Me' })).status === 403)

  // ═══════════════════════════════════════════════════════════════════════
  section('A phone')
  const hemaPhone = await open('hr', PHONE)
  await hemaPhone.goto(`${BASE}/attendance?view=daily&date=${yesterday}`)
  await settled(hemaPhone)
  check('the roster with its ticks fits a phone', (await sideways(hemaPhone)) <= 1, `${await sideways(hemaPhone)}px sideways`)
  // On a phone the roster is the list, not the table.
  await hemaPhone.locator('ul[aria-label="Attendance"]').getByLabel(/^Tick /).first().check()
  await hemaPhone.getByRole('button', { name: 'Mark the ticked…' }).click()
  check('…and so does the dialog', (await sideways(hemaPhone)) <= 1)
  await hemaPhone.screenshot({ path: `${SHOTS}/phone-mark.png` })
  await hemaPhone.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click()
  const saPhone = await open('sa', PHONE)
  await saPhone.goto(`${BASE}/settings?tab=attendance-security`)
  await settled(saPhone)
  check('the rule’s settings fit a phone', (await sideways(saPhone)) <= 1)
  await saPhone.goto(`${BASE}/settings?tab=leave`)
  await settled(saPhone)
  check('the working week fits a phone', (await sideways(saPhone)) <= 1)

  // ═══════════════════════════════════════════════════════════════════════
  section('Switched off, it gives back what it wrote')
  const off = await api('sa', 'PUT', '/settings/absent-rule', { on: false, from: rule.earliest_from, waitDays: 3 })
  check('switched off', off.status === 200 && off.body.data.run.removed > 0, JSON.stringify(off.body).slice(0, 200))
  check('no Absent of the system’s is left', systemRows() === 0)
  check('what HR marked stays', rowOf(emp.ravi.id, yesterday) === 'present|manual|The app was down')
  check('an employee cannot change the rule', (await api('emp', 'PUT', '/settings/absent-rule', { on: true, from: today, waitDays: 3 })).status === 403)

  section('Nothing broke along the way')
  check('no page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
  check('no server errors', serverErrors.length === 0, serverErrors.slice(0, 3).join(' | '))
} catch (err) {
  failures.push(`crashed: ${err.stack ?? err}`)
  console.log(`CRASH ${err.stack ?? err}`)
} finally {
  await browser.close()
}

/** The scheduled line goes once the list is read again. */
async function until0(page) {
  return page.getByText(/From .*: Saturday and Sunday\./).waitFor({ state: 'detached', timeout: 10_000 }).then(() => true, () => false)
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) {
  for (const f of failures) console.log(`  ✗ ${f}`)
  process.exitCode = 1
}
