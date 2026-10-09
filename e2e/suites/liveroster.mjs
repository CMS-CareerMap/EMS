// Whoever watches attendance sees the time at work run (client, 9 Oct 2026):
// the employee's own card counted it from Check In, but the roster's Hours said
// "—" until Check Out. Now the roster (computer and phone), a manager's "My team
// today" and the employee's "My last 7 days" run it from check-in, on the
// server's clock; the roster finds a new check-in or check-out on its own within
// a minute; after Check Out the stored hours show; a day never checked out of
// says "No check-out" instead of counting on.
// Production build on :5183 → compiled API on :4100 → local ems_e2e, Day 20 seed.
import { chromium } from 'playwright-core'
import { mkdirSync, readFileSync } from 'node:fs'
import { WORK, psql } from '../lib/env.mjs'

const BASE = 'http://localhost:5183'
const API = `${BASE}/api`
const fx = JSON.parse(readFileSync(`${WORK}/day20-fixture.json`, 'utf8'))
const SHOTS = `${WORK}/shots/liveroster`
mkdirSync(SHOTS, { recursive: true })
const PHONE = { width: 390, height: 844 }
const DESKTOP = { width: 1440, height: 900 }
const PRIYA = 'Priya Deshmukh'

let passed = 0
const failures = []
function check(name, ok, detail = '') {
  if (ok) { passed++; console.log(`PASS  ${name}`) } else { failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`FAIL  ${name}${detail ? `  — ${detail}` : ''}`) }
}
const section = (name) => console.log(`\n── ${name}`)

// ── The API, as HR ──────────────────────────────────────────────────────────
const hrLogin = await (await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: fx.users.hr, password: fx.password }) })).json()
const hrToken = hrLogin.data?.accessToken
if (!hrToken) throw new Error(`HR sign-in failed: ${JSON.stringify(hrLogin).slice(0, 200)}`)
async function api(method, path, body) {
  const res = await fetch(`${API}${path}`, { method, headers: { Authorization: `Bearer ${hrToken}`, 'X-Requested-With': 'ems', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { json = text }
  return { status: res.status, body: json }
}

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
const rosterRow = (page) => page.locator('table tr', { hasText: PRIYA }).first()
const SO_FAR = /^(\d+)h (\d+)m\s*so far$/
const hoursCell = async (page) => (await rosterRow(page).locator('td').nth(4).innerText()).replace(/\s+/g, ' ').trim()

try {
  // ═══════════════════════════════════════════════════════════════════════
  section('HR has today’s roster open; Priya checks in')
  const hema = await open('hr', DESKTOP)
  await hema.goto(`${BASE}/attendance`)
  await rosterRow(hema).waitFor({ timeout: 20_000 })
  check('before Check In, Priya’s hours say nothing', (await hoursCell(hema)).startsWith('—'), await hoursCell(hema))

  const priya = await open('emp', DESKTOP)
  await priya.getByRole('button', { name: /Check In/ }).first().click()
  await priya.getByRole('button', { name: /Check Out/ }).first().waitFor({ timeout: 20_000 })
  const checkedInAt = Date.now()

  // No reload: the roster asks again within a minute.
  check('within a minute, HR’s roster shows her at work — no reload', await shown(rosterRow(hema).getByText(/so far/), 75_000))
  const first = await hoursCell(hema)
  check('…her time so far, from 0h 0m', /^0h [01]m so far$/.test(first), first)
  check('…marked as running', (await rosterRow(hema).locator('.animate-pulse, [class*="animate-pulse"]').count()) >= 1)
  check('…and the time she came in, beside it', (await rosterRow(hema).locator('td').nth(2).innerText()).trim().match(/^\d\d:\d\d/) !== null)
  await hema.screenshot({ path: `${SHOTS}/roster-at-work.png` })

  // A minute on, the minutes move.
  const wait = Math.max(0, 62_000 - (Date.now() - checkedInAt))
  await hema.waitForTimeout(wait)
  let moved = ''
  for (let i = 0; i < 40; i++) {
    moved = await hoursCell(hema)
    const m = moved.match(SO_FAR)
    if (m && Number(m[1]) * 60 + Number(m[2]) >= 1) break
    await hema.waitForTimeout(1000)
  }
  check('a minute on, the roster says 0h 1m so far', /^0h [12]m so far$/.test(moved), moved)

  section('On a phone, the roster’s line runs too')
  const hemaPhone = await open('hr', PHONE)
  await hemaPhone.goto(`${BASE}/attendance`)
  const line = hemaPhone.locator('ul[aria-label="Attendance"] li', { hasText: PRIYA }).first()
  await line.waitFor({ timeout: 20_000 })
  check('“In HH:MM · 0h 1m so far”', /In \d\d:\d\d · \d+h \d+m so far/.test(await line.innerText()), (await line.innerText()).replace(/\s+/g, ' '))
  const sideways = await hemaPhone.evaluate(() => Math.max(document.documentElement.scrollWidth - innerWidth, document.querySelector('main').scrollWidth - document.querySelector('main').clientWidth))
  check('…with no sideways scrolling', sideways <= 1, `${sideways}px`)
  await hemaPhone.screenshot({ path: `${SHOTS}/roster-phone.png` })
  await hemaPhone.context().close()

  section('Her manager’s Home: My team today')
  const manoj = await open('mgr', DESKTOP)
  const team = manoj.getByRole('region', { name: 'My team today' })
  await team.waitFor({ timeout: 20_000 })
  const her = team.locator('li', { hasText: PRIYA }).first()
  check('Priya: “in HH:MM · 1m so far”', /in \d\d:\d\d · \d+m so far/.test(await her.innerText()), (await her.innerText()).replace(/\s+/g, ' '))
  await manoj.screenshot({ path: `${SHOTS}/manager-team.png` })

  // On a phone the time goes under her name, which keeps its room.
  const manojPhone = await open('mgr', PHONE)
  const teamPhone = manojPhone.getByRole('region', { name: 'My team today' })
  await teamPhone.waitFor({ timeout: 20_000 })
  await teamPhone.scrollIntoViewIfNeeded()
  const herPhone = teamPhone.locator('li', { hasText: PRIYA }).first()
  const fits = await herPhone.evaluate((li) => {
    const name = [...li.querySelectorAll('p')].find((p) => p.textContent.trim() === 'Priya Deshmukh')
    const under = [...li.querySelectorAll('p')].find((p) => /so far/.test(p.textContent) && getComputedStyle(p).display !== 'none')
    return { whole: name ? name.scrollWidth <= name.clientWidth + 1 : false, under: Boolean(under) }
  })
  check('on a phone her name is whole, the time under it', fits.whole && fits.under, JSON.stringify(fits))
  const phoneSideways = await manojPhone.evaluate(() => Math.max(document.documentElement.scrollWidth - innerWidth, document.querySelector('main').scrollWidth - document.querySelector('main').clientWidth))
  check('…with no sideways scrolling', phoneSideways <= 1, `${phoneSideways}px`)
  await herPhone.screenshot({ path: `${SHOTS}/manager-team-phone.png` })
  await manojPhone.context().close()

  section('Her own Home: My last 7 days')
  await priya.goto(`${BASE}/dashboard`)
  const week = priya.getByRole('list', { name: 'Hours worked, last seven days' })
  await week.waitFor({ timeout: 20_000 })
  const todayBar = (await week.getByRole('listitem').last().innerText()).replace(/\s+/g, ' ').trim()
  check('today’s bar says her time so far, not just “In”', /^\d+m Today$|^\d+h( \d+m)? Today$/.test(todayBar), todayBar)
  await priya.screenshot({ path: `${SHOTS}/own-week.png` })

  // ═══════════════════════════════════════════════════════════════════════
  section('Priya checks out: the stored hours, the count stopped')
  await priya.goto(`${BASE}/dashboard`)
  await priya.getByRole('button', { name: /Check Out/ }).first().click()
  await priya.getByText(/^Worked( today)? · at work/).first().waitFor({ timeout: 20_000 })
  let stored = ''
  for (let i = 0; i < 75; i++) {
    stored = await hoursCell(hema).catch(() => '')
    if (/^\d+h \d+m/.test(stored) && !/so far/.test(stored)) break
    await hema.waitForTimeout(1000)
  }
  // Her stored hours lead the cell (a shift's "left early" may follow them).
  check('within a minute, HR’s roster shows her hours, no longer “so far”', /^\d+h \d+m/.test(stored) && !/so far/.test(stored), stored)
  check('…with her check-out time', (await rosterRow(hema).locator('td').nth(3).innerText()).trim().match(/^\d\d:\d\d/) !== null)
  await manoj.reload()
  await team.waitFor({ timeout: 20_000 })
  const after = (await team.locator('li', { hasText: PRIYA }).first().innerText()).replace(/\s+/g, ' ')
  check('…and her manager’s list no longer runs her time', /in \d\d:\d\d/.test(after) && !/so far/.test(after), after)
  await manoj.context().close()

  // ═══════════════════════════════════════════════════════════════════════
  section('A day never checked out of')
  // Ravi checked in on the app at 09:15 on 21 Sep and never out (written as the app writes it).
  psql(`INSERT INTO "Attendance" (id, "organizationId", "employeeId", date, "checkIn", status, source, "workMode", "updatedAt")
        VALUES (gen_random_uuid()::text, '${fx.organizationId}', '${fx.employees.ravi.id}', '2026-09-21', '2026-09-21T03:45:00Z', 'present', 'punch', 'office', now())`)
  const roster = await api('GET', '/attendance/day?date=2026-09-21')
  const ravi = roster.body.data.employees.find((e) => e.employee_id === fx.employees.ravi.id)
  check('the roster does not call him at work', ravi?.at_work === false && ravi?.attendance?.check_out === null, JSON.stringify({ at_work: ravi?.at_work, check_out: ravi?.attendance?.check_out }))
  await hema.locator('input[type="date"]').first().fill('2026-09-21')
  await hema.waitForLoadState('networkidle').catch(() => undefined)
  const raviRow = hema.locator('table tr', { hasText: 'Ravi Patil' }).first()
  check('…it says “No check-out”, not a time running', await shown(raviRow.getByText('No check-out', { exact: true })))
  await hema.screenshot({ path: `${SHOTS}/roster-no-check-out.png` })

  // A day HR typed with a check-in only — the form fills one in by itself — is left as HR left it.
  const marked = await api('POST', '/attendance/mark', { employeeId: fx.employees.ravi.id, date: '2026-09-22', status: 'present', checkIn: '09:30' })
  check('HR records Ravi’s 22 Sep with a check-in only', marked.status === 201, `${marked.status} ${JSON.stringify(marked.body).slice(0, 160)}`)
  await hema.locator('input[type="date"]').first().fill('2026-09-22')
  await hema.waitForLoadState('networkidle').catch(() => undefined)
  // The 22nd's row, not the 21st's still on screen: only the 22nd says 09:30 (the 21st, 09:15).
  const onThe22nd = await shown(raviRow.locator('td').nth(2).getByText('09:30', { exact: true }))
  const typed = (await raviRow.locator('td').nth(4).innerText()).replace(/\s+/g, ' ').trim()
  check('…shows no hours and no warning', onThe22nd && typed === '—', `${onThe22nd ? '' : '(the 22nd never showed) '}${typed}`)
  await hema.context().close()
  await priya.context().close()

  section('Nothing broke along the way')
  check('no page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
  check('no server errors', serverErrors.length === 0, serverErrors.slice(0, 3).join(' | '))
} catch (err) {
  failures.push(`stopped: ${err.message}`)
  console.log(`FAIL  stopped: ${err.message}`)
} finally {
  await browser.close()
  console.log(`\n${passed} passed, ${failures.length} failed`)
  if (failures.length) {
    console.log(failures.map((f) => `  ✗ ${f}`).join('\n'))
    process.exitCode = 1
  }
}
