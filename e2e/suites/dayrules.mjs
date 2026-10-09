// The client's day (8 Oct 2026): on their nine-hour shift, eight hours worked is
// a full day (Present), from four and a half a Half day, under that Absent — and
// no break comes off, as lunch is whenever a person likes. All of it sits in
// Settings → Organisation → Shifts, for the Super Admin to change. Checked: the
// table shows it, HR's typed hours are graded by it, a change in the table
// grades the next day by the new figure, and the employee's Timings card says
// the rule. Computer and phone.
// Production build on :5183 → compiled API on :4100 → local ems_e2e, Day 20 seed.
import { chromium } from 'playwright-core'
import { mkdirSync, readFileSync } from 'node:fs'
import { WORK } from '../lib/env.mjs'

const BASE = 'http://localhost:5183'
const API = `${BASE}/api`
const fx = JSON.parse(readFileSync(`${WORK}/day20-fixture.json`, 'utf8'))
const SHOTS = `${WORK}/shots/dayrules`
mkdirSync(SHOTS, { recursive: true })
const PHONE = { width: 390, height: 844 }
const DESKTOP = { width: 1366, height: 900 }
const RAVI = fx.employees.ravi.id

let passed = 0
const failures = []
function check(name, ok, detail = '') {
  if (ok) { passed++; console.log(`PASS  ${name}`) } else { failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`FAIL  ${name}${detail ? `  — ${detail}` : ''}`) }
}
const section = (name) => console.log(`\n── ${name}`)

// ── The API, as the Super Admin and as HR ───────────────────────────────────
const tokens = {}
for (const who of ['sa', 'hr']) {
  const res = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: fx.users[who], password: fx.password }) })
  const body = await res.json()
  if (res.status !== 200) throw new Error(`login ${who}: ${res.status} ${JSON.stringify(body).slice(0, 200)}`)
  tokens[who] = body.data.accessToken
}
async function api(who, method, path, body) {
  const res = await fetch(`${API}${path}`, { method, headers: { Authorization: `Bearer ${tokens[who]}`, 'X-Requested-With': 'ems', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { json = text }
  return { status: res.status, body: json }
}
const general = async () => (await api('sa', 'GET', '/master-data')).body.data.shifts.find((s) => s.name === 'General')
/** HR records Ravi's day with the two times; the hours worked decide the status. */
const mark = (date, checkIn, checkOut) => api('hr', 'POST', '/attendance/mark', { employeeId: RAVI, date, status: 'present', checkIn, checkOut })

const browser = await chromium.launch({ channel: 'msedge', headless: true })
const pageErrors = []
const serverErrors = []
async function open(who, viewport) {
  const ctx = await browser.newContext({ viewport })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => pageErrors.push(`${who}: ${e.message}`))
  page.on('response', (r) => { if (r.url().includes('/api/') && r.status() >= 500) serverErrors.push(`${r.status()} ${r.url().split('/api')[1]}`) })
  await page.goto(`${BASE}/signin`)
  await page.getByLabel('Work Email or Employee ID').fill(fx.users[who])
  await page.getByPlaceholder('Enter your password').fill(fx.password)
  await page.getByRole('button', { name: 'Sign In' }).click()
  await page.waitForURL((u) => !u.pathname.startsWith('/signin'), { timeout: 20_000 })
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined)
  return page
}
const shown = (locator, timeout = 20_000) => locator.first().waitFor({ timeout }).then(() => true, () => false)
const sideways = (page) => page.evaluate(() => {
  const main = document.querySelector('main')
  return Math.max(document.documentElement.scrollWidth - window.innerWidth, main ? main.scrollWidth - main.clientWidth : 0)
})
const cellsOf = async (row) => (await row.locator('td').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim())

let shiftId = null
try {
  const g = await general()
  shiftId = g?.id
  if (!shiftId) throw new Error('no General shift in the seed')

  // ═══════════════════════════════════════════════════════════════════════
  section('Settings → Organisation → Shifts: the day, in the table')
  check('a new company’s General shift carries the client’s day: 9 h, full from 8 h, half from 4.5 h, no break',
    g.expected_hours === 9 && g.min_full_day_hours === 8 && g.min_half_day_hours === 4.5 && g.break_minutes === 0, JSON.stringify(g))
  const sunita = await open('sa', DESKTOP)
  await sunita.goto(`${BASE}/settings?tab=organisation`)
  const row = sunita.locator('tr', { hasText: 'General' }).first()
  await row.waitFor({ timeout: 20_000 })
  for (const h of ['Shift hours', 'Full day from (h)', 'Half day from (h)', 'Unpaid break (min)']) {
    check(`the table has “${h}”`, await shown(sunita.getByRole('columnheader', { name: h, exact: true })))
  }
  const cells = await cellsOf(row)
  check('General reads 9h · 8h · 4h 30m · no break', cells[3] === '9h' && cells[4] === '8h' && cells[5] === '4h 30m' && cells[6] === 'None', JSON.stringify(cells))
  await sunita.getByRole('button', { name: 'Rules of General' }).click()
  const rules = sunita.getByRole('dialog')
  await rules.waitFor({ timeout: 20_000 })
  check('the rules dialog keeps grace, lateness and overtime', await shown(rules.getByLabel('Grace period in minutes', { exact: true })))
  check('…and no longer asks the hours a day needs (they are in the table)', (await rules.getByLabel(/Minimum hours/).count()) === 0)
  await rules.getByRole('button', { name: 'Cancel' }).click()
  await sunita.screenshot({ path: `${SHOTS}/settings-shifts.png`, fullPage: true })

  // ═══════════════════════════════════════════════════════════════════════
  section('HR records Ravi’s days: the hours worked decide')
  const put = await api('sa', 'PATCH', `/employees/${RAVI}`, { shiftId })
  if (put.status !== 200) throw new Error(`Ravi's shift: ${put.status} ${JSON.stringify(put.body).slice(0, 200)}`)
  const days = [
    ['2026-09-21', '09:30', '17:30', 'present', 'eight hours, the whole stay counted (no break off): Present'],
    ['2026-09-22', '09:30', '17:29', 'half_day', 'a minute short of eight: Half day'],
    ['2026-09-23', '09:30', '14:00', 'half_day', 'four and a half hours: Half day'],
    ['2026-09-24', '09:30', '13:59', 'absent', 'a minute short of four and a half: Absent'],
  ]
  const marked = []
  for (const [date, from, to, want, words] of days) {
    const res = await mark(date, from, to)
    marked.push(res)
    check(`${from}–${to}, ${words}`, res.status === 201 && res.body.data.status === want, `${res.status} ${res.body?.data?.status ?? JSON.stringify(res.body).slice(0, 160)} · ${res.body?.data?.hours_worked}h`)
  }
  check('…and 09:30–17:30 is stored as 8 hours worked', Number(marked[0].body?.data?.hours_worked) === 8, String(marked[0].body?.data?.hours_worked))

  // ═══════════════════════════════════════════════════════════════════════
  section('Sunita makes a full day 7.5 hours, in the table')
  // The row being edited is the one with a Save button; the add row's fields say "New shift".
  const editing = () => sunita.locator('tr').filter({ has: sunita.getByTitle('Save', { exact: true }) })
  await row.getByRole('button', { name: 'Edit', exact: true }).click()
  const fullInput = editing().getByLabel('Full day from (hours worked)', { exact: true })
  check('the edit row offers the full-day hours', (await fullInput.inputValue()) === '8', await fullInput.inputValue())
  await fullInput.fill('7.5')
  await sunita.getByTitle('Save', { exact: true }).click()
  const saved = sunita.locator('tr', { hasText: 'General' }).first()
  check('the row now reads 7h 30m', await shown(saved.getByText('7h 30m', { exact: true })))
  check('…and the shift holds it', (await general()).min_full_day_hours === 7.5)
  const after = await mark('2026-09-25', '09:30', '17:00')
  check('the next day HR records, 09:30–17:00, is Present by the new figure', after.body?.data?.status === 'present', after.body?.data?.status)

  await saved.getByRole('button', { name: 'Edit', exact: true }).click()
  await editing().getByLabel('Full day from (hours worked)', { exact: true }).fill('')
  await sunita.getByTitle('Save', { exact: true }).click()
  check('emptied, the figure falls back on three quarters of the shift, marked “auto”', await shown(sunita.locator('tr', { hasText: 'General' }).first().getByText(/6h 45m\s*\(auto\)/)))
  await sunita.locator('tr', { hasText: 'General' }).first().getByRole('button', { name: 'Edit', exact: true }).click()
  await editing().getByLabel('Full day from (hours worked)', { exact: true }).fill('8')
  await sunita.getByTitle('Save', { exact: true }).click()
  check('…and set back to 8h', await shown(sunita.locator('tr', { hasText: 'General' }).first().getByText('8h', { exact: true })))

  // A new shift starts on the client's day, and its minimums follow its hours until typed.
  const newFull = sunita.getByLabel('New shift: Full day from (hours worked)', { exact: true })
  const newHalf = sunita.getByLabel('New shift: Half day from (hours worked)', { exact: true })
  check('a new shift starts at 9 h, full from 8, half from 4.5, no break',
    (await sunita.getByLabel('New shift: Shift hours', { exact: true }).inputValue()) === '9' && (await newFull.inputValue()) === '8' && (await newHalf.inputValue()) === '4.5' && (await sunita.getByLabel('New shift: Unpaid break in minutes', { exact: true }).inputValue()) === '0')
  await sunita.getByLabel('New shift: Shift hours', { exact: true }).fill('12')
  check('…a 12-hour shift drops the nine-hour figures to “auto” (9h and 6h shown as hints)',
    (await newFull.inputValue()) === '' && (await newHalf.inputValue()) === '' && (await newFull.getAttribute('placeholder')) === '9' && (await newHalf.getAttribute('placeholder')) === '6')
  await sunita.getByLabel('New shift: Shift hours', { exact: true }).fill('9')
  check('…and back on nine hours, 8 and 4.5 again', (await newFull.inputValue()) === '8' && (await newHalf.inputValue()) === '4.5')

  const bad = await api('sa', 'PATCH', `/master-data/shifts/${shiftId}`, { minFullDayHours: 4, minHalfDayHours: 4.5 })
  check('a half day needing more than a full day is refused', bad.status === 422 || bad.status === 400, `${bad.status}`)
  await sunita.context().close()

  // ═══════════════════════════════════════════════════════════════════════
  section('Ravi sees the rule his day is marked by')
  const ravi = await open('emp2', PHONE)
  await ravi.goto(`${BASE}/attendance`)
  const timings = ravi.getByRole('region', { name: 'Timings' })
  await timings.waitFor({ timeout: 20_000 })
  check('Timings: Full day — 8h worked', await shown(timings.getByText('8h worked', { exact: true })))
  check('Timings: Half day — 4h 30m worked', await shown(timings.getByText('4h 30m worked', { exact: true })))
  check('…and no unpaid break, with none taken off', (await timings.getByText('Unpaid break').count()) === 0)
  check('…on a phone, without sideways scrolling', (await sideways(ravi)) <= 1, `${await sideways(ravi)}px`)
  await timings.scrollIntoViewIfNeeded()
  await ravi.screenshot({ path: `${SHOTS}/ravi-timings-phone.png` })
  await ravi.context().close()

  section('Settings on a phone')
  const phone = await open('sa', PHONE)
  await phone.goto(`${BASE}/settings?tab=organisation`)
  await phone.locator('tr', { hasText: 'General' }).first().waitFor({ timeout: 20_000 })
  check('the shifts table scrolls in its own box, not the page', (await sideways(phone)) <= 1, `${await sideways(phone)}px`)
  await phone.context().close()

  section('Nothing broke along the way')
  check('no page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
  check('no server errors', serverErrors.length === 0, serverErrors.slice(0, 3).join(' | '))
} catch (err) {
  failures.push(`stopped: ${err.message}`)
  console.log(`FAIL  stopped: ${err.message}`)
} finally {
  // Ravi back on no shift; General as the seed made it.
  await api('sa', 'PATCH', `/employees/${RAVI}`, { shiftId: null }).catch(() => undefined)
  if (shiftId) await api('sa', 'PATCH', `/master-data/shifts/${shiftId}`, { minFullDayHours: 8, minHalfDayHours: 4.5, breakMinutes: 0 }).catch(() => undefined)
  await browser.close()
  console.log(`\n${passed} passed, ${failures.length} failed`)
  if (failures.length) {
    console.log(failures.map((f) => `  ✗ ${f}`).join('\n'))
    process.exitCode = 1
  }
}
