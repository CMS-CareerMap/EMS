// V1 gaps E2E — requests, shift rules, overtime, leave rules, encashment,
// components, loans, notifications — in the browser, desktop and a 390px phone.
// Production build on :5183 → compiled API on :4100 → local ems_e2e.
// Fixture: the Day 20 seed (reset20.sh), fresh. Priya (emp) reports to Manoj
// (mgr); Hema is HR, Anil Accounts, Sunita the Super Admin.
import { chromium } from 'playwright-core'
import { WORK, REPO, STORAGE as STORE, psql } from '../lib/env.mjs'
import { openMyProfile, openEmployeeProfile, signOutVia, menuLinks, menuLink } from '../lib/ui.mjs'
import { readFileSync, mkdirSync } from 'node:fs'

const BASE = 'http://localhost:5183'
const API = `${BASE}/api`
const DIR = WORK
const fx = JSON.parse(readFileSync(`${DIR}/day20-fixture.json`, 'utf8'))
const SHOTS = `${DIR}/shots/v1gaps`
mkdirSync(SHOTS, { recursive: true })
const E = fx.employees

const results = []
function check(label, ok, detail = '') {
  results.push({ label, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`)
  if (!ok) throw new Error(`FAILED: ${label} ${detail}`)
}
const section = (name) => console.log(`\n── ${name} ──`)

const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
function addDays(day, n) {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
const weekday = (d) => new Date(`${d}T00:00:00Z`).getUTCDay()
/** The latest day before today that is not a Sunday. */
const worked = (() => { let d = addDays(today, -1); while (weekday(d) === 0) d = addDays(d, -1); return d })()
/** A day before that, also not a Sunday — for a correction. */
const corrected = (() => { let d = addDays(worked, -1); while (weekday(d) === 0) d = addDays(d, -1); return d })()
/** A Monday at least two weeks ahead — far enough for any notice. */
const ahead = (() => { let d = addDays(today, 14); while (weekday(d) !== 1) d = addDays(d, 1); return d })()
const thisMonth = { year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) }
const workedMonth = { year: Number(worked.slice(0, 4)), month: Number(worked.slice(5, 7)) }

// ── The API ─────────────────────────────────────────────────────────────────
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

// ── The browser ─────────────────────────────────────────────────────────────
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const pageErrors = []
const serverErrors = []
const PHONE = { width: 390, height: 844 }
async function open(who, viewport = { width: 1366, height: 900 }) {
  const ctx = await browser.newContext({ viewport })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => pageErrors.push(`${who}: ${e.message}`))
  page.on('response', (r) => { if (r.status() >= 500 && r.url().includes('/api/')) serverErrors.push(`${who} ${r.request().method()} ${r.url().split('/api')[1]} ${r.status()}`) })
  await page.goto(`${BASE}/signin`)
  await page.getByLabel('Work Email or Employee ID').fill(fx.users[who])
  await page.getByPlaceholder('Enter your password').fill(fx.password)
  await page.getByRole('button', { name: 'Sign In' }).click()
  await page.waitForURL((url) => !url.pathname.startsWith('/signin'), { timeout: 20_000 })
  return page
}
const shot = (page, name) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true })
async function settle(page) {
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined)
  await page.getByText('Loading…', { exact: true }).first().waitFor({ state: 'detached', timeout: 20_000 }).catch(() => undefined)
}
const toast = (page, text) => page.locator('[data-sonner-toast]', { hasText: text }).first().waitFor({ timeout: 20_000 })
const seen = (locator) => locator.waitFor({ timeout: 20_000 }).then(() => true, () => false)
const sideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
const dialog = (page) => page.getByRole('dialog')
async function go(page, path) {
  await page.goto(`${BASE}${path}`)
  await settle(page)
}
async function decide(page, number, verdict, note = '') {
  await go(page, '/requests?tab=decide')
  const card = page.locator('li', { hasText: number }).first()
  await card.waitFor({ timeout: 20_000 })
  await card.getByRole('button', { name: verdict === 'approve' ? /^Approve/ : 'Reject' }).click()
  const d = dialog(page)
  if (note) await d.locator('input').fill(note)
  await d.getByRole('button', { name: verdict === 'approve' ? 'Approve' : 'Reject', exact: true }).click()
  await toast(page, `${number} is ${verdict === 'approve' ? 'approved' : 'rejected'}`)
}
/** The kinds a new request starts from, as the chooser names them. */
const KIND_LABEL = {
  attendance_correction: 'Attendance correction', work_from_home: 'Work from home', on_duty: 'On duty',
  overtime: 'Overtime', leave_encashment: 'Leave encashment', profile_change: 'Profile change',
}
/** New request → the kinds → the one wanted; the dialog is then its form. */
async function chooseKind(page, kind) {
  await page.getByRole('list', { name: 'Kinds of request' }).getByRole('button', { name: new RegExp(`^${KIND_LABEL[kind]}`) }).click()
  await page.getByRole('dialog', { name: KIND_LABEL[kind] }).waitFor({ timeout: 20_000 })
}
async function newRequest(page, kind) {
  await go(page, '/requests')
  await page.getByRole('button', { name: 'New request' }).click()
  await chooseKind(page, kind)
  return dialog(page)
}
/** Chooses the option whose words match — Playwright wants an exact label. */
async function pick(select, pattern) {
  // The options may still be loading: wait for the one wanted before reading values.
  await select.locator('option', { hasText: pattern }).first().waitFor({ state: 'attached', timeout: 20_000 })
  const value = await select.locator('option').evaluateAll((opts, src) => opts.find((o) => new RegExp(src).test(o.textContent))?.value, pattern.source)
  await select.selectOption(value)
}
const requestNumber = async (page) => {
  const text = await page.locator('[data-sonner-toast]').first().innerText()
  return text.match(/REQ-\d{4}/)?.[0]
}

try {
  for (const who of Object.keys(fx.users)) await login(who)

  section('Setup — Priya on the General shift')
  const shifts = (await api('sa', 'GET', '/master-data')).body.data.shifts
  const general = shifts.find((s) => s.name === 'General')
  check('the General shift is there (09:30–18:30, 9 hours)', general?.start_time === '09:30' && general?.expected_hours === 9)
  const onShift = await api('hr', 'PATCH', `/employees/${E.priya.id}`, { shiftId: general.id })
  check('HR puts Priya on it', onShift.status === 200, JSON.stringify(onShift.body).slice(0, 200))
  check('overtime is off until the company turns it on', (await api('sa', 'GET', '/settings/payroll')).body.data.overtime_enabled === false)

  // ── Personal details and a profile change (client §27, §42) ──────────────
  section('Priya asks HR to change her details')
  const priya = await open('emp')
  await settle(priya)
  await openMyProfile(priya, 'My details')
  const details = priya.getByRole('region', { name: 'My details' })
  await details.waitFor({ timeout: 20_000 })
  check('My Profile shows her details', await details.getByText('Emergency contact').first().waitFor({ timeout: 20_000 }).then(() => true, () => false))
  await details.getByRole('button', { name: 'Request an update' }).click()
  await priya.waitForURL(/\/requests/, { timeout: 20_000 })
  const profileDialog = dialog(priya)
  await profileDialog.getByLabel('Phone', { exact: true }).waitFor({ timeout: 20_000 })
  check('…which opens a profile change', (await profileDialog.getAttribute('aria-label')) === 'Profile change')
  await profileDialog.getByLabel('Phone', { exact: true }).fill('9822012345')
  await profileDialog.getByLabel('Emergency contact', { exact: true }).fill('Suresh Deshmukh')
  await profileDialog.getByLabel('Reason', { exact: true }).fill('New number after moving')
  await profileDialog.getByRole('button', { name: 'Send request' }).click()
  await toast(priya, 'is sent to HR, who keeps employee records')
  const profileReq = await requestNumber(priya)
  check('it goes to HR', Boolean(profileReq), profileReq)

  const hema = await open('hr')
  await settle(hema)
  await decide(hema, profileReq, 'approve')
  const record = (await api('hr', 'GET', `/employees/${E.priya.id}`)).body.data
  check('approved, it changes her record', record.phone === '9822012345' && record.emergency_contact_name === 'Suresh Deshmukh', `${record.phone} ${record.emergency_contact_name}`)

  // ── Work from home, decided by the manager (client §28–29) ───────────────
  section('Work from home goes to Manoj, who sees it on his dashboard')
  const wfh = await newRequest(priya, 'work_from_home')
  await wfh.getByLabel('From', { exact: true }).fill(addDays(today, 1))
  await wfh.getByLabel('To', { exact: true }).fill(addDays(today, 1))
  await wfh.getByLabel('Reason', { exact: true }).fill('Plumber visiting')
  await wfh.getByRole('button', { name: 'Send request' }).click()
  await toast(priya, 'is sent to Manoj Manager')
  const wfhReq = await requestNumber(priya)
  const manoj = await open('mgr')
  await settle(manoj)
  // The home page's "Waiting for you" card lists it, as a Work from home request.
  check('Manoj’s dashboard says a request waits', await seen(manoj.getByRole('region', { name: 'Waiting for you' }).getByRole('listitem').filter({ hasText: 'Priya Deshmukh' }).filter({ hasText: 'Work from home' }).first()))
  await decide(manoj, wfhReq, 'approve')

  section('A correction Manoj rejects, with a reason Priya sees')
  const corr = await newRequest(priya, 'attendance_correction')
  await corr.getByLabel('Day', { exact: true }).fill(corrected)
  await corr.getByLabel('Check-in', { exact: true }).fill('09:35')
  await corr.getByLabel('Check-out', { exact: true }).fill('18:40')
  await corr.getByLabel('Reason', { exact: true }).fill('Forgot to check in')
  await corr.getByRole('button', { name: 'Send request' }).click()
  await toast(priya, 'is sent to Manoj Manager')
  const corrReq = await requestNumber(priya)
  await decide(manoj, corrReq, 'reject', 'You were on leave that morning')
  await go(priya, '/requests')
  const rejected = priya.locator('li', { hasText: corrReq })
  check('Priya sees it rejected, and why', await seen(rejected.getByText('Rejected', { exact: true })) && await seen(rejected.getByText(/on leave that morning/)))

  // ── Shift rules (client §34) ──────────────────────────────────────────────
  section('Sunita sets the General shift’s rules')
  const sunita = await open('sa')
  await go(sunita, '/settings?tab=organisation')
  await sunita.getByRole('button', { name: 'Rules of General' }).click()
  const rules = dialog(sunita)
  await rules.getByLabel('Grace period in minutes', { exact: true }).fill('10')
  await rules.getByLabel('Late threshold in minutes', { exact: true }).fill('120')
  await rules.getByLabel('Overtime after minutes', { exact: true }).fill('30')
  await shot(sunita, 'shift-rules')
  await rules.getByRole('button', { name: 'Save rules' }).click()
  await toast(sunita, 'General: rules saved')
  check('the shift says its rules', await seen(sunita.getByText(/grace 10m · late over 2h → half day · overtime after 30m/).first()))

  // ── Overtime from work to approval (client §35) ───────────────────────────
  section('A long day records overtime; Priya claims it; Manoj approves')
  await go(sunita, '/settings?tab=payroll')
  await sunita.getByRole('switch', { name: 'Pay overtime' }).click()
  await sunita.getByRole('button', { name: 'Save Changes' }).click()
  await sunita.getByRole('button', { name: 'Saved' }).waitFor({ timeout: 20_000 })
  check('Sunita turns overtime pay on', (await api('sa', 'GET', '/settings/payroll')).body.data.overtime_enabled === true)
  const marked = await api('hr', 'POST', '/attendance/mark', { employeeId: E.priya.id, date: worked, status: 'present', checkIn: '09:30', checkOut: '21:00' })
  check(`HR records ${worked}, 09:30 to 21:00`, marked.status === 201, JSON.stringify(marked.body).slice(0, 200))
  await go(hema, `/attendance`)
  await hema.locator('input[type="date"]').first().fill(worked)
  await settle(hema)
  const row = hema.locator('tr', { hasText: 'Priya Deshmukh' })
  check('the roster shows 1h 30m of overtime', await seen(row.getByText('+1h 30m overtime')))
  const ot = await newRequest(priya, 'overtime')
  await ot.getByLabel(/^Day/).selectOption(worked)
  await ot.getByLabel('Reason', { exact: true }).fill('Quarter-end close')
  await shot(priya, 'overtime-request')
  await ot.getByRole('button', { name: 'Send request' }).click()
  await toast(priya, 'is sent to Manoj Manager')
  const otReq = await requestNumber(priya)
  await decide(manoj, otReq, 'approve')
  const calc = await api('acc', 'POST', '/payroll/calculate', { employeeId: E.priya.id, ...workedMonth })
  const otLine = calc.body.data?.earnings?.find((e) => e.code === 'OT')
  check('payroll pays it at twice the hourly rate', otLine?.amount > 0 && calc.body.data.basis.overtime?.minutes === 90, JSON.stringify(calc.body.data?.basis?.overtime))

  // ── Leave rules and half days (client §36–37) ─────────────────────────────
  section('HR gives Casual Leave notice and encashment')
  await go(hema, '/settings?tab=leave')
  await hema.getByRole('button', { name: 'Rules of Casual Leave' }).click()
  const leaveRules = dialog(hema)
  await leaveRules.getByLabel('Notice in days', { exact: true }).fill('3')
  await leaveRules.getByRole('switch', { name: 'Can be encashed' }).click()
  await leaveRules.getByLabel('Most days encashed in a leave year', { exact: true }).fill('5')
  await leaveRules.getByRole('button', { name: 'Save rules' }).click()
  await toast(hema, 'Casual Leave: rules saved')
  check('the type says its rules', await seen(hema.getByText(/3 days’ notice · encashable up to 5 a year/).first()))

  section('Priya: notice is asked; a second half is a half day')
  await go(priya, '/leave')
  await priya.getByRole('button', { name: 'Apply for Leave' }).click()
  const modal = priya.locator('form', { hasText: 'Leave Type' })
  await modal.locator('input[type="date"]').nth(0).fill(addDays(today, 1))
  await modal.locator('input[type="date"]').nth(1).fill(addDays(today, 1))
  await priya.getByText(/needs 3 days’ notice/).waitFor({ timeout: 20_000 })
  check('a day too soon is refused before sending', await priya.getByRole('button', { name: 'Submit Request' }).isDisabled())
  await modal.locator('input[type="date"]').nth(0).fill(ahead)
  await modal.locator('input[type="date"]').nth(1).fill(ahead)
  await modal.locator('select').nth(1).selectOption('second_half')
  await priya.getByText(/0\.5 days? of leave/).waitFor({ timeout: 20_000 })
  await modal.locator('textarea').fill('Parent-teacher meeting')
  await shot(priya, 'half-day')
  await priya.getByRole('button', { name: 'Submit Request' }).click()
  let half = null
  for (let i = 0; i < 20 && !half; i++) {
    const mine = (await api('emp', 'GET', '/leave-requests')).body.data
    half = (Array.isArray(mine) ? mine : mine.requests ?? []).find((r) => r.from_date === ahead)
    if (!half) await new Promise((r) => setTimeout(r, 500))
  }
  check('the second half is recorded', half?.days === 0.5 && half?.half_day_sessions?.[ahead] === 'second_half', String(JSON.stringify(half)).slice(0, 200))

  section('Priya encashes two days; HR approves')
  const enc = await newRequest(priya, 'leave_encashment')
  await pick(enc.getByLabel(/^Leave type/), /Casual Leave/)
  await enc.getByLabel('Days', { exact: true }).fill('2')
  await enc.getByLabel('Reason', { exact: true }).fill('School fees')
  await enc.getByRole('button', { name: 'Send request' }).click()
  await toast(priya, 'is sent to HR, who keeps leave balances')
  const encReq = await requestNumber(priya)
  await decide(hema, encReq, 'approve')
  const encCalc = await api('acc', 'POST', '/payroll/calculate', { employeeId: E.priya.id, ...thisMonth })
  check('it is paid with this month’s salary', encCalc.body.data?.basis?.encashment?.days === 2, JSON.stringify(encCalc.body.data?.basis?.encashment))

  // ── Components and loans (client §40) ─────────────────────────────────────
  section('Anil adds a component, and records an advance')
  const anil = await open('acc')
  await go(anil, '/payroll?tab=components')
  await anil.getByRole('button', { name: 'Add a component' }).click()
  const comp = dialog(anil)
  await comp.getByPlaceholder('SITE_ALLOW').fill('SITE_ALLOW')
  await comp.getByPlaceholder('Site Allowance').fill('Site Allowance')
  await comp.getByRole('button', { name: 'Add' }).click()
  await toast(anil, 'Site Allowance added')
  check('it is listed', await seen(anil.getByText('SITE_ALLOW')))
  await go(anil, '/payroll?tab=loans')
  await anil.getByRole('button', { name: 'Record a loan or advance' }).click()
  const loan = dialog(anil)
  await pick(loan.getByLabel(/^Employee/), /Ravi Patil/)
  await loan.getByLabel('Amount (₹)', { exact: true }).fill('3000')
  await loan.getByLabel('Recovered each month (₹)', { exact: true }).fill('1000')
  await loan.getByRole('button', { name: 'Record' }).click()
  await toast(anil, 'Recorded')
  const ravi = anil.locator('li', { hasText: 'Ravi Patil' }).first()
  check('the advance is being recovered, ₹1,000 a month', await seen(ravi.getByText('Being recovered')) && await seen(ravi.getByText(/₹1,000\.00 a month/)))
  await shot(anil, 'loans')

  // ── Payroll settings and notifications ────────────────────────────────────
  section('Sunita sees the overtime rate and the email switches')
  await go(sunita, '/settings?tab=payroll')
  check('Payroll Config has Overtime and Leave Encashment', await seen(sunita.getByText('Overtime and Leave Encashment')))
  await sunita.getByLabel('Overtime rate, times ordinary pay', { exact: true }).fill('1.5')
  await sunita.getByRole('button', { name: 'Save Changes' }).click()
  await sunita.getByRole('button', { name: 'Saved' }).waitFor({ timeout: 20_000 })
  const policy = (await api('sa', 'GET', '/settings/payroll')).body.data
  check('the rate is saved', policy.overtime_rate === 1.5)
  await api('sa', 'PUT', '/settings/payroll', { overtimeRate: 2 })
  await go(sunita, '/settings?tab=notifications')
  check('email is said to be not set up', await seen(sunita.getByText(/Email is not set up yet/)))
  check('each notice has an email switch', await seen(sunita.getByRole('switch', { name: /^Email — A new employee is added/ })))
  await go(sunita, '/settings?tab=approvals')
  check('Approvals lists leave encashment', await seen(sunita.getByLabel('Who decides leave encashment', { exact: true })))

  section('The reports')
  await go(sunita, '/reports')
  check('Late, Early & Overtime is offered', await seen(sunita.getByText('Late, Early & Overtime')))
  const report = await api('sa', 'GET', `/reports/shift-overtime?year=${workedMonth.year}&month=${workedMonth.month}`)
  const priyaRow = report.body.data.rows.find((r) => r.full_name === 'Priya Deshmukh')
  check('…with Priya’s approved overtime', priyaRow?.overtime_approved === 1.5, JSON.stringify(priyaRow))

  // ── A phone ───────────────────────────────────────────────────────────────
  section('On a 390px phone')
  const phone = await open('emp', PHONE)
  await go(phone, '/requests')
  check('Requests fits a phone', (await sideways(phone)) <= 0)
  await phone.getByRole('button', { name: 'New request' }).click()
  check('the kinds of request fit a phone', (await sideways(phone)) <= 0)
  await chooseKind(phone, 'overtime')
  check('the overtime form fits', (await sideways(phone)) <= 0)
  await shot(phone, 'phone-overtime')
  const phoneAcc = await open('acc', PHONE)
  await go(phoneAcc, '/payroll?tab=loans')
  check('Loans fits a phone', (await sideways(phoneAcc)) <= 0)
  await go(phoneAcc, '/payroll?tab=components')
  check('Components scroll inside their table, not the page', (await sideways(phoneAcc)) <= 0)
  const phoneHr = await open('hr', PHONE)
  await go(phoneHr, '/settings?tab=leave')
  await phoneHr.getByRole('button', { name: 'Rules of Casual Leave' }).click()
  check('the leave rules dialog fits', (await sideways(phoneHr)) <= 0)
  await shot(phoneHr, 'phone-leave-rules')
  const phoneSa = await open('sa', PHONE)
  await go(phoneSa, '/settings?tab=notifications')
  check('Notifications fits a phone', (await sideways(phoneSa)) <= 0)
  await shot(phoneSa, 'phone-notifications')

  section('Nothing broke')
  check('no page errors', pageErrors.length === 0, pageErrors.join(' | '))
  check('no server errors', serverErrors.length === 0, serverErrors.join(' | '))
} catch (err) {
  console.error(err.message)
  process.exitCode = 1
} finally {
  await browser.close()
  const failed = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - failed}/${results.length} passed${process.exitCode ? ' — STOPPED EARLY' : ''}`)
}
