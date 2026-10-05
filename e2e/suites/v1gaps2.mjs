// V1 gaps E2E, part 2 — the branches part 1 does not click: withdraw, a file
// added later, HR's filters, the Admin's view, closing and removing a loan,
// editing / archiving / restoring a component, an email switch, monthly
// accrual, half days on a range, personal details in the drawer by role, a
// report's CSV, Escape on the new dialogs, and phone widths.
// Production build on :5183 → compiled API on :4100 → local ems_e2e, fresh
// Day 20 seed (reset20.sh). Priya (emp) reports to Manoj (mgr).
import { chromium } from 'playwright-core'
import { WORK, REPO, STORAGE as STORE, psql } from '../lib/env.mjs'
import { openMyProfile, openEmployeeProfile, signOutVia, menuLinks, menuLink } from '../lib/ui.mjs'
import { readFileSync, mkdirSync } from 'node:fs'

const BASE = 'http://localhost:5183'
const API = `${BASE}/api`
const DIR = WORK
const fx = JSON.parse(readFileSync(`${DIR}/day20-fixture.json`, 'utf8'))
const SHOTS = `${DIR}/shots/v1gaps2`
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
const pastDay = (from) => { let d = addDays(from, -1); while (weekday(d) === 0) d = addDays(d, -1); return d }
const worked = pastDay(today)
const corrected = pastDay(worked)
const ahead = (() => { let d = addDays(today, 21); while (weekday(d) !== 1) d = addDays(d, 1); return d })()
const workedMonth = { year: Number(worked.slice(0, 4)), month: Number(worked.slice(5, 7)) }
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n')

const tokens = {}
async function login(who) {
  const res = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: fx.users[who], password: fx.password }) })
  const body = await res.json()
  if (res.status !== 200) throw new Error(`login ${who}: ${res.status} ${JSON.stringify(body)}`)
  tokens[who] = body.data.accessToken
}
async function api(who, method, path, body) {
  const res = await fetch(`${API}${path}`, { method, headers: { Authorization: `Bearer ${tokens[who]}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { json = text }
  return { status: res.status, body: json }
}

const browser = await chromium.launch({ channel: 'msedge', headless: true })
const pageErrors = []
const serverErrors = []
const PHONE = { width: 390, height: 844 }
async function open(who, viewport = { width: 1366, height: 900 }) {
  const ctx = await browser.newContext({ viewport, acceptDownloads: true })
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
const gone = (locator) => locator.waitFor({ state: 'detached', timeout: 20_000 }).then(() => true, () => false)
const sideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
const dialog = (page) => page.getByRole('dialog')
async function go(page, path) { await page.goto(`${BASE}${path}`); await settle(page) }
async function pick(select, pattern) {
  // The options may still be loading: wait for the one wanted before reading values.
  await select.locator('option', { hasText: pattern }).first().waitFor({ state: 'attached', timeout: 20_000 })
  const value = await select.locator('option').evaluateAll((opts, src) => opts.find((o) => new RegExp(src).test(o.textContent))?.value, pattern.source)
  await select.selectOption(value)
}

try {
  for (const who of Object.keys(fx.users)) await login(who)

  section('Setup')
  const general = (await api('sa', 'GET', '/master-data')).body.data.shifts.find((s) => s.name === 'General')
  check('Priya on the General shift', (await api('hr', 'PATCH', `/employees/${E.priya.id}`, { shiftId: general.id })).status === 200)
  check('overtime turned on', (await api('sa', 'PUT', '/settings/payroll', { overtimeEnabled: true })).status === 200)
  check(`HR records a long ${worked}`, (await api('hr', 'POST', '/attendance/mark', { employeeId: E.priya.id, date: worked, status: 'present', checkIn: '09:30', checkOut: '21:00' })).status === 201)
  const ot = await api('emp', 'POST', '/requests', { type: 'overtime', date: worked, reason: 'Release night' })
  check('Priya claims it', ot.status === 201, JSON.stringify(ot.body).slice(0, 160))
  check('Manoj approves it', (await api('mgr', 'POST', `/requests/${ot.body.data.id}/approve`)).status === 200)
  const profile = await api('emp', 'POST', '/requests', { type: 'profile_change', changes: { emergencyContactName: 'Suresh Deshmukh', emergencyContactPhone: '9822000000' }, reason: 'Updated' })
  check('a profile change waits for HR', profile.status === 201)
  const cl = (await api('hr', 'GET', '/settings/leave-types')).body.data.find((t) => t.code === 'CL')
  check('Casual Leave made encashable', (await api('hr', 'PATCH', `/settings/leave-types/${cl.id}`, { encashable: true })).status === 200)
  const encash = await api('emp', 'POST', '/requests', { type: 'leave_encashment', leaveTypeId: cl.id, days: 1, reason: 'Fees' })
  check('an encashment waits for HR', encash.status === 201, JSON.stringify(encash.body).slice(0, 160))

  section('Priya withdraws, and adds a file later')
  const wfh = await api('emp', 'POST', '/requests', { type: 'work_from_home', fromDate: addDays(today, 2), toDate: addDays(today, 2), reason: 'Internet engineer' })
  const corr = await api('emp', 'POST', '/requests', { type: 'attendance_correction', date: corrected, checkIn: '09:35', checkOut: '18:40', reason: 'Machine down' })
  const priya = await open('emp')
  await go(priya, '/requests')
  const wfhCard = priya.locator('li', { hasText: wfh.body.data.number })
  await wfhCard.getByRole('button', { name: 'Withdraw' }).click()
  await dialog(priya).getByRole('button', { name: 'Withdraw it' }).click()
  await toast(priya, `${wfh.body.data.number} is withdrawn`)
  check('withdrawn, it says so', await seen(wfhCard.getByText('Withdrawn', { exact: true })))
  const corrCard = priya.locator('li', { hasText: corr.body.data.number })
  await corrCard.getByLabel(`Add a file to ${corr.body.data.number}`).setInputFiles({ name: 'register.pdf', mimeType: 'application/pdf', buffer: PDF })
  await toast(priya, `File added to ${corr.body.data.number}`)
  check('the file shows on the request', await seen(corrCard.getByRole('button', { name: 'register.pdf' })))
  check('…and no second file can be added', await gone(corrCard.getByText('Add a file')))
  const manoj = await open('mgr')
  await go(manoj, '/requests?tab=decide')
  const [download] = await Promise.all([manoj.waitForEvent('download', { timeout: 30_000 }), manoj.locator('li', { hasText: corr.body.data.number }).getByRole('button', { name: 'register.pdf' }).click()])
  check('Manoj opens the file', download.suggestedFilename() === 'register.pdf', download.suggestedFilename())

  section('HR’s view, filtered; the Admin sees no personal details')
  const hema = await open('hr')
  await go(hema, '/requests?tab=all')
  await hema.getByLabel('Status').selectOption('')
  await hema.getByLabel('Kind').selectOption('leave_encashment')
  check('HR filters to encashments', await seen(hema.locator('li', { hasText: encash.body.data.number })))
  await hema.getByLabel('Kind').selectOption('profile_change')
  check('…and to profile changes, with the values', await seen(hema.locator('li', { hasText: 'Suresh Deshmukh' })))
  const arjun = await open('admin')
  await go(arjun, '/requests')
  check('the Admin reaches Requests, with no All tab', (await arjun.getByRole('tab', { name: 'All requests' }).count()) === 0)
  check('…and sends none from the role login — that is the employee login’s, like leave', (await arjun.getByRole('button', { name: 'New request' }).count()) === 0)
  // "To decide" is the Admin's one section, so no tab strip is drawn for it.
  check('…To decide being the one section, there is no tab strip', (await arjun.getByRole('tab').count()) === 0)
  check('…and is given no profile change to decide', await seen(arjun.getByText('Nothing is waiting for you.')))
  await shot(arjun, 'admin-requests')
  await go(hema, '/requests?tab=decide')
  const card = hema.locator('li', { hasText: profile.body.data.number })
  await card.getByRole('button', { name: /^Approve/ }).click()
  await dialog(hema).getByRole('button', { name: 'Approve', exact: true }).click()
  await toast(hema, `${profile.body.data.number} is approved`)

  section('Personal details on the profile — HR yes, the manager no')
  // An older link to somebody (?open=) goes to their profile page.
  await go(hema, `/employees?open=${E.priya.id}`)
  check('an old “open” link lands on her profile page', hema.url().endsWith(`/employees/${E.priya.id}`), hema.url())
  check('HR sees Priya’s emergency contact', await seen(hema.getByText(/Suresh Deshmukh · 9822000000/)))
  await go(manoj, `/employees/${E.priya.id}`)
  await manoj.getByRole('heading', { name: 'Priya Deshmukh', level: 1 }).waitFor({ timeout: 20_000 })
  await manoj.getByText('Employment details').waitFor({ timeout: 20_000 })
  check('the manager does not', (await manoj.getByText('Personal details', { exact: true }).count()) === 0)

  section('Anil edits, archives and restores a component')
  check('a component to work on', (await api('acc', 'POST', '/payroll/components', { code: 'SITE', label: 'Site Allowance', entry: 'monthly' })).status === 201)
  const anil = await open('acc')
  await go(anil, '/payroll?tab=components')
  await anil.getByRole('button', { name: 'Change Site Allowance' }).click()
  await dialog(anil).getByLabel('Counts for ESI').uncheck()
  await anil.keyboard.press('Escape')
  check('Escape closes the dialog unsaved', await gone(dialog(anil)))
  await anil.getByRole('button', { name: 'Change Site Allowance' }).click()
  await dialog(anil).getByLabel('Counts for ESI').uncheck()
  await dialog(anil).getByRole('button', { name: 'Save' }).click()
  await toast(anil, 'Site Allowance saved')
  const site = (await api('acc', 'GET', '/payroll/components/all')).body.data.find((c) => c.code === 'SITE')
  check('saved: no longer counts for ESI', site.counts_for_esi === false)
  await anil.getByRole('button', { name: 'Archive Site Allowance' }).click()
  await dialog(anil).getByRole('button', { name: 'Archive' }).click()
  await toast(anil, 'Site Allowance archived')
  check('archived, it says so', await seen(anil.getByText('Site Allowance (archived)')))
  await anil.getByRole('button', { name: 'Add a component' }).click()
  await dialog(anil).getByPlaceholder('SITE_ALLOW').fill('SITE')
  await dialog(anil).getByPlaceholder('Site Allowance').fill('Site Allowance')
  await dialog(anil).getByLabel('Entered').selectOption('monthly')
  await dialog(anil).getByRole('button', { name: 'Add' }).click()
  await toast(anil, 'was archived — it is back')
  check('restored', await gone(anil.getByText('Site Allowance (archived)')))
  const busy = await api('acc', 'DELETE', `/payroll/components/${(await api('acc', 'GET', '/payroll/components/all')).body.data.find((c) => c.code === 'HRA').id}`)
  check('HRA, paid to everybody, cannot be archived', busy.status === 409, busy.body?.error?.message)

  section('Anil closes one advance and removes another')
  for (const amount of [2000, 3000]) {
    check(`an advance of ${amount}`, (await api('acc', 'POST', '/payroll/loans', { employeeId: E.ravi.id, kind: 'advance', amount, installment: 1000, startYear: Number(today.slice(0, 4)), startMonth: Number(today.slice(5, 7)) })).status === 201)
  }
  await go(anil, '/payroll?tab=loans')
  const first = anil.locator('li', { hasText: '₹2,000.00' })
  await first.getByRole('button', { name: 'Close' }).click()
  check('closing asks why', await dialog(anil).getByRole('button', { name: 'Close it' }).isDisabled())
  await dialog(anil).getByPlaceholder(/Repaid in cash/).fill('Repaid in cash')
  await dialog(anil).getByRole('button', { name: 'Close it' }).click()
  await toast(anil, 'Closed — nothing more will be recovered')
  check('closed, with why', await seen(first.getByText(/closed: Repaid in cash/)))
  const second = anil.locator('li', { hasText: '₹3,000.00' })
  await second.getByRole('button', { name: /^Remove Ravi Patil/ }).click()
  await dialog(anil).getByRole('button', { name: 'Remove' }).click()
  await toast(anil, 'Removed')
  check('removed', await gone(second))

  section('An email switch')
  const sunita = await open('sa')
  await go(sunita, '/settings?tab=notifications')
  await sunita.getByRole('switch', { name: /^Email — A leave request is submitted/ }).click()
  await toast(sunita, 'A leave request is submitted: in the app only')
  const ns = (await api('sa', 'GET', '/notifications/settings')).body.data.find((e) => e.event === 'leave.submitted')
  check('kept to the app, still sent there', ns.email === false && ns.enabled === true)
  await sunita.getByRole('switch', { name: /^Email — A leave request is submitted/ }).click()
  await toast(sunita, 'A leave request is submitted: emailed too')

  section('Monthly accrual, and halves on a range')
  await go(hema, '/settings?tab=leave')
  await hema.getByRole('button', { name: 'Rules of Casual Leave' }).click()
  await dialog(hema).getByLabel('How it is earned').selectOption('monthly')
  await dialog(hema).getByRole('button', { name: 'Save rules' }).click()
  await toast(hema, 'Casual Leave: rules saved')
  await go(priya, '/leave')
  await priya.getByRole('tab', { name: 'Leave Balance' }).click()
  check('the balance says the rest is earned through the year', await seen(priya.getByText(/earned through the year, a month at a time/).first()))
  await priya.getByRole('button', { name: 'Apply for Leave' }).click()
  const modal = priya.locator('form', { hasText: 'Leave Type' })
  await pick(modal.locator('select').first(), /Casual Leave/)
  await modal.locator('input[type="date"]').nth(0).fill(ahead)
  await modal.locator('input[type="date"]').nth(1).fill(addDays(ahead, 13))
  check('more than is earned is refused, saying why', await seen(priya.getByText(/earned a month at a time/)))
  await modal.locator('input[type="date"]').nth(1).fill(addDays(ahead, 2))
  await modal.locator('select').nth(1).selectOption('second_half')
  await modal.locator('select').nth(2).selectOption('first_half')
  check('Monday’s second half to Wednesday’s first is two days', await seen(priya.getByText(/^2 days of leave/)))
  await modal.locator('textarea').fill('Family wedding')
  await priya.getByRole('button', { name: 'Submit Request' }).click()
  let range = null
  for (let i = 0; i < 20 && !range; i++) {
    range = (await api('emp', 'GET', '/leave-requests')).body.data.find((r) => r.from_date === ahead)
    if (!range) await new Promise((r) => setTimeout(r, 500))
  }
  check('recorded with both halves', range?.days === 2 && range.half_day_sessions?.[ahead] === 'second_half' && range.half_day_sessions?.[addDays(ahead, 2)] === 'first_half', JSON.stringify(range?.half_day_sessions))

  section('A report on screen and as a file')
  await go(sunita, '/reports')
  // The card itself: the nearest rounded box around its title.
  await sunita.getByText('Late, Early & Overtime', { exact: true }).locator('xpath=ancestor::div[contains(@class, "rounded-xl")][1]').getByRole('button', { name: 'Open & export' }).click()
  const panel = sunita.getByRole('dialog', { name: 'Late, Early & Overtime' })
  await panel.getByLabel('Month').selectOption(`${workedMonth.year}-${String(workedMonth.month).padStart(2, '0')}`)
  check('Priya’s overtime is in it', await seen(panel.locator('tr', { hasText: 'Priya Deshmukh' }).getByText('1.5', { exact: false }).first()))
  const [csv] = await Promise.all([sunita.waitForEvent('download', { timeout: 30_000 }), panel.getByRole('button', { name: /Export CSV/ }).click()])
  const path = `${DIR}/shots/v1gaps2/${csv.suggestedFilename()}`
  await csv.saveAs(path)
  check('the CSV has the same columns', readFileSync(path, 'utf8').includes('Overtime approved'), csv.suggestedFilename())

  section('Phones')
  const phone = await open('emp', PHONE)
  await go(phone, '/attendance')
  check('Priya’s attendance fits', (await sideways(phone)) <= 0)
  await shot(phone, 'phone-attendance')
  await go(phone, '/requests')
  check('her requests fit', (await sideways(phone)) <= 0)
  await shot(phone, 'phone-requests')
  const hrPhone = await open('hr', PHONE)
  await go(hrPhone, '/attendance')
  check('the roster, with its badges, scrolls inside its table', (await sideways(hrPhone)) <= 0)
  const accPhone = await open('acc', PHONE)
  await go(accPhone, '/payroll?tab=loans')
  check('Loans fit', (await sideways(accPhone)) <= 0)
  await shot(accPhone, 'phone-loans')

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
