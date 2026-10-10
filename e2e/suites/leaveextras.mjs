// Leave seen and used day to day (client, 10 Oct 2026), in the browser:
//   A  Priya's Attendance names each leave day by its type ("Loss of Pay" in
//      amber) and gives her days paid and unpaid, as payroll will count them;
//   D  an absent day is told to her, and offers "Apply leave" — the form opens
//      on that day; once her manager approves, the day says Casual Leave;
//   B  Leave Balance → Statement: every movement of a type, like a passbook —
//      and HR sees the same on her profile;
//   E  Manoj, deciding her next request, sees who else of his team is away;
//   C  Leave Config → Year-end Reminder, and both notices in Settings → Notifications.
// Computer and phone. Production build on :5183 → compiled API on :4100 → local ems_e2e, Day 20 seed.
import { chromium } from 'playwright-core'
import { mkdirSync, readFileSync } from 'node:fs'
import { WORK } from '../lib/env.mjs'

const BASE = 'http://localhost:5183'
const API = `${BASE}/api`
const fx = JSON.parse(readFileSync(`${WORK}/day20-fixture.json`, 'utf8'))
const SHOTS = `${WORK}/shots/leaveextras`
mkdirSync(SHOTS, { recursive: true })
const PHONE = { width: 390, height: 844 }
const DESKTOP = { width: 1366, height: 900 }
const PRIYA = fx.employees.priya
const NEHA = fx.employees.neha
const MANOJ = fx.employees.manoj

let passed = 0
const failures = []
function check(name, ok, detail = '') {
  if (ok) { passed++; console.log(`PASS  ${name}`) } else { failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`FAIL  ${name}${detail ? `  — ${detail}` : ''}`) }
}
const section = (name) => console.log(`\n── ${name}`)

const tokens = {}
for (const who of ['sa', 'hr', 'mgr', 'emp']) {
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

// ── The days: the last three working days before today, in one month, after the seed's days ──
const todayIST = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10)
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)
const working = (d) => new Date(`${d}T00:00:00Z`).getUTCDay() !== 0
function lastWorkingDays(before, n) {
  const out = []
  let d = addDays(before, -1)
  while (out.length < n) { if (working(d)) out.unshift(d); d = addDays(d, -1) }
  return out
}
let days = lastWorkingDays(todayIST, 3)
if (days[0].slice(0, 7) !== days[2].slice(0, 7)) days = lastWorkingDays(`${days[2].slice(0, 7)}-01`, 3)
const [D1, D2, D3] = days
const inThisMonth = D3.slice(0, 7) === todayIST.slice(0, 7)
const [YEAR, MONTH] = D3.split('-').map(Number)
let NEXT = addDays(todayIST, 14)
while (new Date(`${NEXT}T00:00:00Z`).getUTCDay() !== 1) NEXT = addDays(NEXT, 1)

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
const waitToast = (page, text) => page.locator('[data-sonner-toast]', { hasText: text }).first().waitFor({ timeout: 20_000 }).then(() => true, () => false)
const flat = (s) => s.replace(/\s+/g, ' ').trim()
/** "Wed 7 Oct", as the log writes a day. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WEEK = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const logDay = (d) => `${WEEK[new Date(`${d}T00:00:00Z`).getUTCDay()]}, ${Number(d.slice(8))} ${MONTHS[Number(d.slice(5, 7)) - 1]}`
async function openAttendance(page) {
  await page.goto(`${BASE}/attendance`)
  if (!inThisMonth) await page.getByRole('button', { name: 'Previous month' }).first().click()
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined)
}

const balances = async () => (await api('emp', 'GET', '/leave-requests/balances')).body.data.balances
let reminderBefore = null

try {
  const types = await balances()
  const CL = types.find((b) => b.code === 'CL')?.leave_type_id
  const LOP = types.find((b) => b.code === 'LOP')?.leave_type_id
  if (!CL || !LOP) throw new Error('the seed has no CL or LOP')

  // ── Set-up through the API: an absent day, and two days of Loss of Pay before it ──
  section('Set-up: an absent day, and two days of Loss of Pay')
  const marked = await api('hr', 'POST', '/attendance/mark', { employeeId: PRIYA.id, date: D3, status: 'absent' })
  check(`(set-up) HR marks Priya absent on ${D3}`, marked.status === 201, JSON.stringify(marked.body).slice(0, 200))
  const lop = await api('emp', 'POST', '/leave-requests', { leaveTypeId: LOP, fromDate: D1, toDate: D2, reason: 'Unpaid days' })
  check('(set-up) Priya asks for two days of Loss of Pay', lop.status === 201, JSON.stringify(lop.body).slice(0, 200))
  const approvedLop = await api('mgr', 'POST', `/leave-requests/${lop.body.data.id}/approve`, {})
  check('(set-up) Manoj approves them', approvedLop.status === 200, JSON.stringify(approvedLop.body).slice(0, 200))

  // ═══════════════════════════════════════════════════════════════════════
  section('D — the absent day is told, with the way to apply leave for it')
  const notes = (await api('emp', 'GET', '/notifications')).body.data
  const absentNote = notes.find((n) => n.title?.startsWith('Marked absent on'))
  check('Priya’s bell: “Marked absent on …”, pointing to the leave form on that day', Boolean(absentNote) && absentNote.link === `/leave?apply=1&from=${D3}&to=${D3}`, JSON.stringify(absentNote ?? notes.slice(0, 2)).slice(0, 300))

  // ═══════════════════════════════════════════════════════════════════════
  section('A — Priya’s Attendance: leave by its type, days paid and unpaid')
  const pay = (await api('emp', 'GET', `/attendance/me/pay-days?year=${YEAR}&month=${MONTH}`)).body.data
  check('The server counts two days of Loss of Pay and the absent day as unpaid', pay.unpaid_days >= 3 && pay.leave_days.filter((l) => l.code === 'LOP').length === 2, JSON.stringify(pay).slice(0, 300))
  const priya = await open('emp', DESKTOP)
  await openAttendance(priya)
  const stats = priya.getByRole('region', { name: 'Attendance stats' }).or(priya.locator('section', { hasText: 'Attendance stats' })).first()
  await shown(stats.getByText('Unpaid days (loss of pay)'))
  const statsText = flat(await stats.innerText())
  check('Month figures: Paid days, of the days employed', statsText.includes(`Paid days ${pay.paid_days} of ${pay.employment_days}`), statsText)
  check('Month figures: Unpaid days (loss of pay), as the server counts them', statsText.includes(`Unpaid days (loss of pay) ${pay.unpaid_days}`), statsText)
  const logRow = (d) => priya.locator('table tr', { hasText: logDay(d) }).first()
  await shown(logRow(D3))
  check('The log names a Loss of Pay day', flat(await logRow(D1).innerText()).includes('Loss of Pay'), flat(await logRow(D1).innerText()))
  check('The absent day offers “Apply leave”', await shown(logRow(D3).getByRole('button', { name: 'Apply leave' })))
  await priya.getByRole('tab', { name: 'Calendar' }).click()
  const cell = priya.getByRole('button', { name: new RegExp(`apply leave for this day`) })
  check('The calendar: the absent day is a button to apply leave for it', await shown(cell))
  check('…and a Loss of Pay day says so, in the unpaid colour', await shown(priya.locator('[aria-label*="Loss of Pay, unpaid"]')))
  await priya.screenshot({ path: `${SHOTS}/priya-calendar.png` })
  await priya.getByRole('tab', { name: 'Attendance log' }).click()

  // Apply leave from the absent day: the form opens on it, with what it costs.
  await logRow(D3).getByRole('button', { name: 'Apply leave' }).click()
  await priya.waitForURL(/\/leave/, { timeout: 20_000 })
  const form = priya.getByRole('dialog', { name: 'Apply for Leave' })
  await form.waitFor({ timeout: 20_000 })
  const dates = await form.locator('input[type=date]').evaluateAll((els) => els.map((e) => e.value))
  check('The leave form opens on the absent day', dates[0] === D3 && dates[1] === D3, dates.join(' → '))
  check('…and says what it costs at once', await shown(form.getByText(/1 day of leave · Casual Leave/)))
  await priya.screenshot({ path: `${SHOTS}/priya-apply-from-absent.png` })
  await form.getByPlaceholder('Briefly describe the reason for your leave…').fill('Was unwell that day')
  await form.getByRole('button', { name: 'Submit Request' }).click()
  await form.waitFor({ state: 'detached', timeout: 20_000 })
  await openAttendance(priya)
  check('Back on Attendance, the day says “Leave applied”', await shown(logRow(D3).getByText('Leave applied')))

  const mine = (await api('emp', 'GET', '/leave-requests')).body.data.find((r) => r.from_date === D3 && r.status === 'pending')
  const approvedCl = await api('mgr', 'POST', `/leave-requests/${mine.id}/approve`, {})
  check('(set-up) Manoj approves it', approvedCl.status === 200, JSON.stringify(approvedCl.body).slice(0, 200))
  await openAttendance(priya)
  if (!(await shown(logRow(D3)))) await priya.screenshot({ path: `${SHOTS}/debug-after-approve.png`, fullPage: true })
  await shown(logRow(D3).getByText('Casual Leave'))
  check('Approved: the absent day now says Casual Leave', flat(await logRow(D3).innerText()).includes('Casual Leave') && !flat(await logRow(D3).innerText()).includes('Absent'), flat(await logRow(D3).innerText()))
  const after = (await api('emp', 'GET', `/attendance/me/pay-days?year=${YEAR}&month=${MONTH}`)).body.data
  check('…and it is no longer cut from pay', after.unpaid_days === pay.unpaid_days - 1, `${pay.unpaid_days} → ${after.unpaid_days}`)

  // ═══════════════════════════════════════════════════════════════════════
  section('B — Leave Balance → Statement, like a passbook')
  await priya.goto(`${BASE}/leave?tab=balance`)
  await priya.getByRole('button', { name: 'Casual Leave statement' }).click()
  const statement = priya.getByRole('dialog', { name: 'Casual Leave — statement' })
  await statement.waitFor({ timeout: 20_000 })
  await shown(statement.getByRole('list', { name: 'Statement' }))
  const stText = flat(await statement.innerText())
  check('It lists what was given and what was taken, with the balance after each', stText.includes('Given for the year') && /Leave taken \(/.test(stText) && stText.includes('left'), stText.slice(0, 300))
  await priya.screenshot({ path: `${SHOTS}/priya-statement.png` })
  await statement.getByRole('button', { name: 'Close' }).click()
  await priya.context().close()

  // ═══════════════════════════════════════════════════════════════════════
  section('E — Manoj sees who else of his team is away')
  const moved = await api('sa', 'PATCH', `/employees/${NEHA.id}`, { reportingManagerId: MANOJ.id })
  check('(set-up) Neha now reports to Manoj too', moved.status === 200, JSON.stringify(moved.body).slice(0, 200))
  const nehaLeave = await api('mgr', 'POST', '/leave-requests', { employeeId: NEHA.id, leaveTypeId: LOP, fromDate: NEXT, toDate: addDays(NEXT, 1), reason: 'Family' })
  check('(set-up) Neha is away on those days', nehaLeave.status === 201, JSON.stringify(nehaLeave.body).slice(0, 200))
  const asked = await api('emp', 'POST', '/leave-requests', { leaveTypeId: CL, fromDate: NEXT, toDate: NEXT, reason: 'Wedding' })
  check('(set-up) Priya asks for the same Monday', asked.status === 201, JSON.stringify(asked.body).slice(0, 200))
  const manoj = await open('mgr', DESKTOP)
  await manoj.goto(`${BASE}/leave?tab=decide`)
  const row = manoj.locator('tr', { hasText: PRIYA.name }).filter({ hasText: 'Also away' }).first()
  check('Beside her request: “Also away: Neha Joshi (Loss of Pay, waiting …)”', await shown(row) && flat(await row.innerText()).includes(`Also away: ${NEHA.name} (Loss of Pay, waiting`), await row.count() ? flat(await row.innerText()) : 'no row')
  await manoj.screenshot({ path: `${SHOTS}/manoj-team-away.png` })
  await manoj.goto(`${BASE}/dashboard`)
  check('…and on his Home, in what waits for him', await shown(manoj.getByText(`Also away:`)))
  await manoj.context().close()

  // ═══════════════════════════════════════════════════════════════════════
  section('B for HR, and C — Leave Config → Year-end Reminder')
  const hr = await open('hr', DESKTOP)
  await hr.goto(`${BASE}/employees/${PRIYA.id}?tab=leave`)
  await hr.getByRole('button', { name: 'Casual Leave statement' }).first().click()
  const hrStatement = hr.getByRole('dialog', { name: `Casual Leave — ${PRIYA.name}` })
  check('HR sees her statement on her profile', await shown(hrStatement.getByText('Given for the year')))
  await hrStatement.getByRole('button', { name: 'Close' }).click()

  reminderBefore = (await api('hr', 'GET', '/leave-balances/reminder')).body.data.days
  await hr.goto(`${BASE}/settings?tab=leave`)
  const reminder = hr.getByLabel('Days before the year ends')
  check('Leave Config has the year-end reminder, 30 days to start', await shown(reminder) && (await reminder.inputValue()) === String(reminderBefore), String(reminderBefore))
  await reminder.fill('0')
  check('…which refuses a number out of 1 to 90', await shown(hr.getByText('Whole days, from 1 to 90.')))
  await reminder.fill('45')
  await hr.locator('section', { hasText: 'Year-end Reminder' }).getByRole('button', { name: 'Save' }).click()
  check('…and saves 45', await shown(hr.locator('section', { hasText: 'Year-end Reminder' }).getByText('Saved')) && (await api('hr', 'GET', '/leave-balances/reminder')).body.data.days === 45)
  await hr.screenshot({ path: `${SHOTS}/hr-year-end-reminder.png` })
  await hr.context().close()

  const sa = await open('sa', DESKTOP)
  await sa.goto(`${BASE}/settings?tab=notifications`)
  check('Settings → Notifications: “A day is recorded as absent”', await shown(sa.getByText('A day is recorded as absent')))
  check('…and “The leave year is about to end with days that will lapse”', await shown(sa.getByText('The leave year is about to end with days that will lapse')))
  await sa.context().close()

  // ═══════════════════════════════════════════════════════════════════════
  section('On a phone')
  const phone = await open('emp', PHONE)
  await openAttendance(phone)
  const phoneStats = phone.locator('section', { hasText: 'Attendance stats' }).first()
  check('Paid and unpaid days on a phone', await shown(phoneStats.getByText('Unpaid days (loss of pay)')))
  check('The log fits a phone', (await sideways(phone)) <= 1, `${await sideways(phone)}px`)
  await phone.screenshot({ path: `${SHOTS}/priya-attendance-phone.png`, fullPage: true })
  await phone.goto(`${BASE}/leave?tab=balance`)
  await phone.getByRole('button', { name: 'Loss of Pay statement' }).click()
  const lopStatement = phone.getByRole('dialog', { name: 'Loss of Pay — statement' })
  check('The Loss of Pay statement says days taken, not a balance', await shown(lopStatement.getByText(/2 days taken — unpaid, cut from pay/)))
  check('…and fits a phone', (await sideways(phone)) <= 1)
  await phone.screenshot({ path: `${SHOTS}/priya-lop-statement-phone.png` })
  await phone.context().close()

  section('Nothing broke along the way')
  check('no page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
  check('no server errors', serverErrors.length === 0, serverErrors.slice(0, 3).join(' | '))
} catch (err) {
  failures.push(`stopped: ${err.message}`)
  console.log(`FAIL  stopped: ${err.message}`)
} finally {
  if (reminderBefore !== null) await api('hr', 'PUT', '/leave-balances/reminder', { days: reminderBefore }).catch(() => undefined)
  await browser.close()
  console.log(`\n${passed} passed, ${failures.length} failed`)
  if (failures.length) {
    console.log(failures.map((f) => `  ✗ ${f}`).join('\n'))
    process.exitCode = 1
  }
}
