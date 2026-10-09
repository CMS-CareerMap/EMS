// The "Time today" card shows the time at work live (client, 8 Oct 2026: "they
// checked in, waited ten minutes, and saw nothing move"). After Check In its big
// figure is the time at work — h:mm:ss, ticking by the second, the minutes moving
// a minute later — with the shift's unpaid break said up front; after Check Out it
// is the hours worked, as "Xh Ym" like the Attendance page, with the break that came off them. On a
// computer (no shift: no break) and a phone (a shift with a 45-minute break).
// Production build on :5183 → compiled API on :4100 → local ems_e2e, Day 20 seed.
import { chromium } from 'playwright-core'
import { mkdirSync, readFileSync } from 'node:fs'
import { WORK, psql } from '../lib/env.mjs'

const BASE = 'http://localhost:5183'
const API = `${BASE}/api`
const fx = JSON.parse(readFileSync(`${WORK}/day20-fixture.json`, 'utf8'))
const SHOTS = `${WORK}/shots/livetime`
mkdirSync(SHOTS, { recursive: true })
const PHONE = { width: 390, height: 844 }
const DESKTOP = { width: 1366, height: 900 }

let passed = 0
const failures = []
function check(name, ok, detail = '') {
  if (ok) { passed++; console.log(`PASS  ${name}`) } else { failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`FAIL  ${name}${detail ? `  — ${detail}` : ''}`) }
}
const section = (name) => console.log(`\n── ${name}`)

// ── The API, as the Super Admin: a shift with a break, for Ravi ──────────────
const signIn = await (await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: fx.users.sa, password: fx.password }) })).json()
const token = signIn.data?.accessToken
if (!token) throw new Error(`Super Admin sign-in failed: ${JSON.stringify(signIn).slice(0, 200)}`)
async function api(method, path, body) {
  const res = await fetch(`${API}${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'X-Requested-With': 'ems', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { json = text }
  return { status: res.status, body: json }
}

const browser = await chromium.launch({ channel: 'msedge', headless: true })
const pageErrors = []
const serverErrors = []
async function open(email, viewport) {
  const ctx = await browser.newContext({ viewport })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => pageErrors.push(`${email}: ${e.message}`))
  page.on('response', (r) => { if (r.url().includes('/api/') && r.status() >= 500) serverErrors.push(`${r.status()} ${r.url().split('/api')[1]}`) })
  await page.goto(`${BASE}/signin`)
  await page.getByLabel('Work Email or Employee ID').fill(email)
  await page.getByPlaceholder('Enter your password').fill(fx.password)
  await page.getByRole('button', { name: 'Sign In' }).click()
  await page.waitForURL((u) => !u.pathname.startsWith('/signin'), { timeout: 20_000 })
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined)
  return page
}
const shown = (locator, timeout = 20_000) => locator.first().waitFor({ timeout }).then(() => true, () => false)
const big = (page) => page.getByLabel(/^At work for/)
const sideways = (page) => page.evaluate(() => {
  const main = document.querySelector('main')
  return Math.max(document.documentElement.scrollWidth - window.innerWidth, main ? main.scrollWidth - main.clientWidth : 0)
})
const checkOut = (page) => page.getByRole('button', { name: /Check Out/ }).first().click()
// The figure as seen (its spoken form sits beside it for screen readers).
const figure = (page) => page.locator('p.tabular-nums span[aria-hidden="true"]').first().innerText().then((t) => t.trim())
// "Worked today", or "Worked" for a day begun before midnight.
const WORKED = /^Worked( today)? · at work \d\d:\d\d – \d\d:\d\d/

let shiftId = null
try {
  // ═══════════════════════════════════════════════════════════════════════
  section('Priya, on a computer, with no shift (so no break)')
  const priya = await open(fx.users.emp, DESKTOP)
  check('before Check In, the big figure is the time of day', await shown(priya.getByLabel(/^The time is \d\d:\d\d$/)))
  await priya.getByRole('button', { name: /Check In/ }).first().click()
  check('after Check In, the big figure is the time at work', await shown(big(priya)))
  check('…a timer to a screen reader', await shown(priya.getByRole('timer', { name: /^At work for/ })))
  const first = (await big(priya).innerText()).trim()
  check('…as h:mm:ss, from zero', /^0:00:\d\d$/.test(first), first)
  await priya.waitForTimeout(2500)
  const second = (await big(priya).innerText()).trim()
  check('…ticking by the second', second !== first, `${first} → ${second}`)
  check('…with the time checked in, and the time now', await shown(priya.getByText(/^At work since \d\d:\d\d · .+ · now \d\d:\d\d$/)))
  check('…and no break to mention, with no shift', (await priya.getByText(/unpaid break is taken off/).count()) === 0)
  check('…nor a full day to count down to: no shift grades her day', (await priya.getByText(/^Full day/).count()) === 0)
  check('…and no line of the day drawn in colour any more (9 Oct 2026)', (await priya.getByRole('region', { name: 'Time today' }).getByText(/^\d\d:00$/).count()) === 0)
  await priya.screenshot({ path: `${SHOTS}/priya-at-work.png` })
  await priya.waitForTimeout(61_000)
  const later = (await big(priya).innerText()).trim()
  check('a minute later, the minutes have moved', /^0:01:\d\d$/.test(later), later)
  check('…and a screen reader hears "At work for 1 minute"', (await big(priya).getAttribute('aria-label')) === 'At work for 1 minute', await big(priya).getAttribute('aria-label'))
  await checkOut(priya)
  check('after Check Out, the big figure is the hours worked', await shown(priya.getByText(WORKED)))
  const total = await figure(priya)
  check('…read as on the Attendance page (one minute worked: 0h 1m)', total === '0h 1m', total)
  check('…and spoken as "Worked 1 minute"', await shown(priya.getByText('Worked 1 minute', { exact: true })))
  await priya.screenshot({ path: `${SHOTS}/priya-checked-out.png` })
  await priya.context().close()

  // ═══════════════════════════════════════════════════════════════════════
  section('Ravi, on a phone, on a shift with a 45-minute break')
  const made = await api('POST', '/master-data/shifts', { name: `Live time ${fx.stamp}`, startTime: '09:30', endTime: '18:30', breakMinutes: 45, expectedHours: 8 })
  if (made.status !== 201) throw new Error(`shift: ${made.status} ${JSON.stringify(made.body).slice(0, 200)}`)
  shiftId = made.body.data.id
  const moved = await api('PATCH', `/employees/${fx.employees.ravi.id}`, { shiftId })
  if (moved.status !== 200) throw new Error(`Ravi's shift: ${moved.status} ${JSON.stringify(moved.body).slice(0, 200)}`)
  const ravi = await open(fx.users.emp2, PHONE)
  await ravi.getByRole('button', { name: /Check In/ }).first().click()
  check('on a phone, the time at work shows after Check In', await shown(big(ravi)))
  check('…with the break said up front', await shown(ravi.getByText('Your 45m unpaid break is taken off when you check out.')))
  check('…and no sideways scrolling', (await sideways(ravi)) <= 1, `${await sideways(ravi)}px`)
  // How far to a full day, in words (9 Oct 2026): his shift has no minimums of
  // its own, so a full day is three quarters of its 8 hours — 6h — and he must
  // stay 45 minutes longer for the break: 6h 45m to go, falling from the first minute.
  check('…how far to a full day: “Full day at 6h · 6h 45m to go”', await shown(ravi.getByText(/^Full day at 6h · 6h 4[45]m to go$/)), await ravi.getByText(/^Full day/).first().innerText().catch(() => 'none'))
  await ravi.screenshot({ path: `${SHOTS}/ravi-phone-at-work.png` })
  // Seven hours in (six and a quarter worked, after the break): a full day done.
  // Today's open day only: his seeded days have no times at all.
  const openRow = `"employeeId" = '${fx.employees.ravi.id}' AND date = (now() AT TIME ZONE 'Asia/Kolkata')::date AND "checkIn" IS NOT NULL AND "checkOut" IS NULL`
  const realIn = psql(`SELECT "checkIn" FROM "Attendance" WHERE ${openRow}`)
  psql(`UPDATE "Attendance" SET "checkIn" = now() - interval '7 hours' WHERE ${openRow}`)
  await ravi.reload()
  check('…and once it is reached, “Full day done”', await shown(ravi.getByText('Full day done', { exact: true })))
  psql(`UPDATE "Attendance" SET "checkIn" = '${realIn}' WHERE ${openRow}`)
  await ravi.reload()
  await big(ravi).waitFor({ timeout: 20_000 })
  await checkOut(ravi)
  check('after Check Out, it says the break came off the hours', await shown(ravi.getByText(/^Worked( today)? · at work \d\d:\d\d – \d\d:\d\d, less a 45m unpaid break$/)))
  check('…and the hours read as Xh Ym (under the break: 0h 0m)', (await figure(ravi)) === '0h 0m', await figure(ravi))
  await ravi.screenshot({ path: `${SHOTS}/ravi-phone-checked-out.png` })
  // Minutes that round up: 7.18 hours is 7h 11m (10.8 minutes) on the screen and
  // on the Attendance page, so a screen reader hears 11 minutes too, not 10.
  psql(`UPDATE "Attendance" SET "hoursWorked" = 7.18 WHERE "employeeId" = '${fx.employees.ravi.id}' AND "checkOut" IS NOT NULL AND "checkOut" > now() - interval '1 hour'`)
  await ravi.reload()
  const spoken = await shown(ravi.getByText('Worked 7 hours 11 minutes', { exact: true }))
  const seen = await figure(ravi)
  check('7.18 hours worked read as 7h 11m', seen === '7h 11m', seen)
  check('…and spoken the same: "Worked 7 hours 11 minutes"', spoken)
  await ravi.context().close()

  section('Nothing broke along the way')
  check('no page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
  check('no server errors', serverErrors.length === 0, serverErrors.slice(0, 3).join(' | '))
} catch (err) {
  failures.push(`stopped: ${err.message}`)
  console.log(`FAIL  stopped: ${err.message}`)
} finally {
  // Ravi back on no shift; the shift removed.
  if (shiftId) {
    await api('PATCH', `/employees/${fx.employees.ravi.id}`, { shiftId: null }).catch(() => undefined)
    await api('DELETE', `/master-data/shifts/${shiftId}`).catch(() => undefined)
  }
  await browser.close()
  console.log(`\n${passed} passed, ${failures.length} failed`)
  if (failures.length) {
    console.log(failures.map((f) => `  ✗ ${f}`).join('\n'))
    process.exitCode = 1
  }
}
