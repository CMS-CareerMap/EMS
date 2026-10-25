// Somebody's month of attendance (client, 15 Oct 2026): a name on Attendance —
// the day's roster, the month's hours, Suspicious — opens that person's month:
// the month so far in figures, counted to today and live while they are in,
// their calendar and their days. For whoever's attendance reach takes them in
// (HR and the Super Admin, anybody; a manager, their team; an employee,
// themselves); outside it, "not yours to see". The same count is one's own
// "Attendance stats" and the home page's "My month"; the profile has the tab.
// Production build on :5183 → compiled API on :4100 → local ems_e2e, Day 20 seed (with its office).
import { chromium } from 'playwright-core'
import { mkdirSync, readFileSync } from 'node:fs'
import { WORK, psql } from '../lib/env.mjs'

const BASE = 'http://localhost:5183'
const fx = JSON.parse(readFileSync(`${WORK}/day20-fixture.json`, 'utf8'))
const SHOTS = `${WORK}/shots/personmonth`
mkdirSync(SHOTS, { recursive: true })
const PHONE = { width: 390, height: 844 }
const DESKTOP = { width: 1366, height: 900 }
const PHONE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36'
const AT_OFFICE = { latitude: fx.office.latitude, longitude: fx.office.longitude, accuracy: 8 }

let passed = 0
const failures = []
function check(name, ok, detail = '') {
  if (ok) { passed++; console.log(`PASS  ${name}`) } else { failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`FAIL  ${name}${detail ? `  — ${detail}` : ''}`) }
}
const section = (name) => console.log(`\n── ${name}`)

const today = psql(`SELECT to_char(now() AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD')`)
const thisMonth = today.slice(0, 7)
const emp = fx.employees
const personUrl = (id, month = null) => `${BASE}/attendance/people/${id}${month ? `?month=${month}` : ''}`

const browser = await chromium.launch({ channel: 'msedge', headless: true })
const pageErrors = []
const serverErrors = []
async function open(who, { viewport = DESKTOP, phone = false, at = null, permissions = [], clockAhead = 0 } = {}) {
  const ctx = await browser.newContext({ viewport, ...(phone ? { userAgent: PHONE_UA } : {}), ...(at ? { geolocation: at } : {}), permissions })
  const page = await ctx.newPage()
  // A device whose clock is wrong: the page's time runs from there.
  if (clockAhead) await page.clock.install({ time: new Date(Date.now() + clockAhead) })
  page.on('pageerror', (e) => pageErrors.push(`${who}: ${e.message}`))
  page.on('response', (r) => { if (r.url().includes('/api/') && r.status() >= 500) serverErrors.push(`${r.status()} ${r.url().split('/api')[1]}`) })
  await page.goto(`${BASE}/signin`)
  await page.getByLabel('Work Email or Employee ID').fill(fx.users[who])
  await page.getByPlaceholder('Enter your password').fill(fx.password)
  await page.getByRole('button', { name: 'Sign In' }).click()
  await page.waitForURL((url) => !url.pathname.startsWith('/signin'), { timeout: 20_000 })
  return page
}
const shown = (locator, timeout = 20_000) => locator.first().waitFor({ timeout }).then(() => true, () => false)
const sideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
const errorToasts = (page) => page.locator('[data-sonner-toast][data-type="error"]').count()
async function until(fn, want, ms = 30_000) {
  const end = Date.now() + ms
  let got
  while (Date.now() < end) { got = fn(); if (got === want) return true; await new Promise((r) => setTimeout(r, 300)) }
  return got
}

/** "1h 36m", "45m", "2h" → minutes. */
function minutesOf(label) {
  const m = /^(?:(\d+)h)?\s*(?:(\d+)m)?$/.exec(label.trim())
  return m && (m[1] || m[2]) ? Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0) : null
}
/** Whether a "… so far" in `text` is the time since `since` by THIS machine's clock (the server's), give or take two minutes. */
function liveOk(text, pattern, since) {
  const found = pattern.exec(text ?? '')
  const shownMinutes = found ? minutesOf(found[1]) : null
  if (shownMinutes === null || !since) return false
  return Math.abs(shownMinutes - Math.floor((Date.now() - Date.parse(since)) / 60_000)) <= 2
}

/** The next answer for somebody's month, as the page receives it: { status, body }. */
function nextMonthAnswer(page, id) {
  return page.waitForResponse((r) => r.url().includes(`/attendance/people/${id}/month`) && r.request().method() === 'GET', { timeout: 30_000 })
    .then(async (r) => ({ status: r.status(), body: await r.json().catch(() => null) }), () => ({ status: 0, body: null }))
}
/** A line of the month in figures — its value, then its hint. */
async function figure(page, region, name) {
  const dd = page.getByRole('region', { name: region }).getByText(name, { exact: true }).locator('xpath=following-sibling::dd[1]')
  const text = await dd.innerText({ timeout: 20_000 }).catch(() => '')
  const [value = '', hint = ''] = text.split('\n').map((s) => s.trim())
  return { value, hint }
}
/** Each figure on the page against the server's answer — the one count. */
async function figuresMatch(page, region, t, label) {
  await page.getByRole('region', { name: region }).locator('dl').waitFor({ timeout: 20_000 })
  const working = await figure(page, region, 'Working days')
  const present = await figure(page, region, 'Days present')
  const leaveAbsent = await figure(page, region, 'Leave · Absent')
  const ok = working.value === String(t.working_days)
    && working.hint === `${t.weekly_offs} weekly off · ${t.holidays} holiday${t.holidays === 1 ? '' : 's'}`
    && present.value === String(t.present + t.half_days)
    && leaveAbsent.value === `${t.on_leave} · ${t.absent}`
    && (t.not_marked ? leaveAbsent.hint === `${t.not_marked} day${t.not_marked === 1 ? '' : 's'} not marked yet` : leaveAbsent.hint === '')
  check(`${label}: working days, present, leave · absent — as the server counts them`, ok,
    JSON.stringify({ working, present, leaveAbsent, t: { w: t.working_days, p: t.present, h: t.half_days, l: t.on_leave, a: t.absent, n: t.not_marked } }))
}

try {
  section('Priya checks in at the office this morning — and is still in')
  const priyaPhone = await open('emp', { viewport: PHONE, phone: true, at: AT_OFFICE, permissions: ['geolocation'] })
  await priyaPhone.goto(`${BASE}/dashboard`)
  await priyaPhone.getByRole('button', { name: /Check In/ }).click()
  check('Priya checked in', await until(() => psql(`SELECT count(*) FROM "Attendance" WHERE "employeeId" = '${emp.priya.id}' AND date = '${today}' AND "checkIn" IS NOT NULL AND "checkOut" IS NULL`), '1') === true)
  // An hour and a half ago, so the live time has something to show.
  psql(`UPDATE "Attendance" SET "checkIn" = now() - interval '95 minutes' WHERE "employeeId" = '${emp.priya.id}' AND date = '${today}'`)
  await priyaPhone.context().close()

  section('HR: Priya’s name on today’s roster opens her month')
  const hr = await open('hr')
  await hr.goto(`${BASE}/attendance`)
  const priyaLink = hr.locator('main').getByRole('link', { name: emp.priya.name, exact: true }).filter({ visible: true }).first()
  check('her name on the roster is a link', await shown(priyaLink))
  let answer = nextMonthAnswer(hr, emp.priya.id)
  await priyaLink.click()
  await hr.waitForURL((url) => url.pathname === `/attendance/people/${emp.priya.id}`, { timeout: 20_000 }).catch(() => {})
  check('…to her page, on this month', new URL(hr.url()).pathname === `/attendance/people/${emp.priya.id}` && new URL(hr.url()).searchParams.get('month') === thisMonth, hr.url())
  let got = await answer
  check('…the server answers', got.status === 200 && got.body?.data?.person?.id === emp.priya.id, String(got.status))
  let d = got.body?.data
  check('her name is the page’s heading, with her code and department', await shown(hr.getByRole('heading', { name: emp.priya.name, level: 1 }))
    && (await hr.locator('main').innerText()).includes(`${emp.priya.code} · Sales`))
  check('“Month so far”: counted from the 1st till today', await shown(hr.getByRole('region', { name: 'Month so far' }).getByText('· till today', { exact: false })))
  await figuresMatch(hr, 'Month so far', d.totals, 'This month')
  check('…the open day from her check-in, kept as a time', typeof d.totals.open_since === 'string' && d.totals.open_since.length > 0 && d.totals.open_day === today)
  const hours = await figure(hr, 'Month so far', 'Hours worked')
  check('…today’s time at work runs live: + 1h 35m or so', liveOk(hours.hint, /\+ (.+) today so far/, d.totals.open_since), hours.hint)
  // Not "Paid days 31 of 31" any more (client, 25 Oct 2026): the month shows what is cut.
  check('…no "Paid days" line — the days cut are what the month shows', d.pay_days?.employed && !(await hr.getByRole('region', { name: 'Month so far' }).innerText().catch(() => (hr.locator('main').innerText()))).includes('Paid days'))
  const unpaid = await figure(hr, 'Month so far', 'Unpaid days (loss of pay)')
  check('…and unpaid (loss of pay) — shown to whoever sees her attendance', unpaid.value === String(d.pay_days.unpaid_days), unpaid.value)
  check('the calendar is open first', (await hr.getByRole('tab', { name: 'Calendar' }).getAttribute('aria-selected')) === 'true')
  await hr.getByRole('tab', { name: 'Day by day' }).click()
  const log = hr.getByRole('table', { name: `${emp.priya.name}’s days in ${new Date(`${today}T00:00:00Z`).toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })}` })
  check('Day by day: her days, a line a day', await shown(log))
  const todayLine = await log.getByRole('row').nth(1).innerText().catch(() => '')
  check('…today’s line: still in, the same time so far', liveOk(todayLine, /(\d+h(?: \d+m)?|\d+m) so far/, d.totals.open_since), todayLine)
  const evidenceToday = log.getByRole('button', { name: /^Evidence of the punches on / })
  check('…HR may open the evidence of her punches', (await evidenceToday.count()) >= 1)
  await evidenceToday.first().click()
  check('…which opens', await shown(hr.getByRole('dialog', { name: new RegExp(`^${emp.priya.name} — `) })))
  await hr.keyboard.press('Escape')
  await hr.screenshot({ path: `${SHOTS}/hr-priya-month.png`, fullPage: true })

  section('HR on a computer whose clock is 10 minutes fast: the time so far is the server’s')
  const fast = await open('hr', { clockAhead: 10 * 60_000 })
  answer = nextMonthAnswer(fast, emp.priya.id)
  await fast.goto(personUrl(emp.priya.id))
  const fastData = (await answer).body?.data
  const fastHours = await figure(fast, 'Month so far', 'Hours worked')
  check('the figures count from the server’s clock, not the computer’s', liveOk(fastHours.hint, /\+ (.+) today so far/, fastData?.totals?.open_since), fastHours.hint)
  await fast.getByRole('tab', { name: 'Day by day' }).click()
  const fastLine = await fast.getByRole('table', { name: /’s days in / }).getByRole('row').nth(1).innerText().catch(() => '')
  check('…and Day by day says the same time', liveOk(fastLine, /(\d+h(?: \d+m)?|\d+m) so far/, fastData?.totals?.open_since), fastLine)
  await fast.context().close()

  section('HR: the month before — a whole month, counted to its end')
  answer = nextMonthAnswer(hr, emp.priya.id)
  await hr.getByRole('button', { name: 'Previous month' }).click()
  got = await answer
  d = got.body?.data
  const prev = d ? `${d.year}-${String(d.month).padStart(2, '0')}` : ''
  check('Previous month: the address follows', new URL(hr.url()).searchParams.get('month') === prev && prev < thisMonth, hr.url())
  check('…counted over the whole month', await shown(hr.getByRole('region', { name: 'Month so far' }).getByText('· the whole month', { exact: false })) && d.totals.ongoing === false)
  await figuresMatch(hr, 'Month so far', d.totals, 'Last month')
  const monthFigures = d.totals

  section('HR: September, as the seed made it — whatever month the suite runs in')
  answer = nextMonthAnswer(hr, emp.priya.id)
  await hr.goto(personUrl(emp.priya.id, '2026-09'))
  const september = (await answer).body?.data
  // The seed: Priya absent on 10 and 11 September, present on the other working days to the 26th.
  check('Priya’s two absences in September', september?.totals?.absent === 2 && psql(`SELECT count(*) FROM "Attendance" WHERE "employeeId" = '${emp.priya.id}' AND status = 'absent' AND date BETWEEN '2026-09-01' AND '2026-09-30'`) === '2',
    JSON.stringify(september?.totals ?? {}))
  await figuresMatch(hr, 'Month so far', september.totals, 'September')
  await hr.getByRole('tab', { name: 'Day by day' }).click()
  const septemberLog = hr.getByRole('table', { name: /’s days in September 2026$/ })
  check('…its Day by day is there', await shown(septemberLog))
  const tenth = septemberLog.getByRole('row').filter({ hasText: /Thu,? 10 Sept?/ })
  check('…the 10th says Absent', /Absent/.test(await tenth.first().innerText().catch(() => '')), await tenth.first().innerText().catch(() => 'no row'))

  section('HR: Attendance → Monthly — the same month in the hours table, names linked, and back again')
  await hr.goto(`${BASE}/attendance?view=monthly&month=${prev}`)
  const monthLong = new Date(`${prev}-01T00:00:00Z`).toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })
  const table = hr.getByRole('table', { name: `Hours worked in ${monthLong}` })
  check('the hours table, last month', await shown(table))
  const priyaRow = table.getByRole('row').filter({ hasText: emp.priya.name })
  const cells = (await priyaRow.first().getByRole('cell').allInnerTexts().catch(() => [])).map((s) => s.trim())
  check('…Priya’s present, half, absent and leave agree with her page', cells.length === 7
    && cells[3] === String(monthFigures.present) && cells[4] === String(monthFigures.half_days) && cells[5] === String(monthFigures.absent) && cells[6] === String(monthFigures.on_leave), JSON.stringify(cells))
  await priyaRow.first().getByRole('link', { name: emp.priya.name }).click()
  await hr.waitForURL((url) => url.pathname === `/attendance/people/${emp.priya.id}`, { timeout: 20_000 }).catch(() => {})
  check('…her name opens her page, on that month', new URL(hr.url()).searchParams.get('month') === prev, hr.url())
  await hr.locator('main').getByRole('link', { name: 'Attendance', exact: true }).first().click()
  await hr.waitForURL((url) => url.pathname === '/attendance', { timeout: 20_000 }).catch(() => {})
  check('…and “Attendance” goes back to that month’s hours, not to today', new URL(hr.url()).searchParams.get('month') === prev && await shown(table), hr.url())

  section('HR: Kiran, last day 10 September; Neha, joined 14 September')
  answer = nextMonthAnswer(hr, emp.kiran.id)
  await hr.goto(personUrl(emp.kiran.id, '2026-09'))
  got = await answer
  check('Kiran’s page opens — somebody leaving is still history to read', got.status === 200, String(got.status))
  check('…his last working day, said by his name', await shown(hr.getByText(/^Last working day /)))
  check('…counted to his last day, not to today', got.body?.data?.totals?.to === '2026-09-10' && got.body?.data?.totals?.ongoing === false, JSON.stringify(got.body?.data?.totals ?? {}))
  check('…and says so: “to the last working day”', await shown(hr.getByRole('region', { name: 'Month so far' }).getByText('· to the last working day', { exact: false })))
  await hr.getByRole('tab', { name: 'Day by day' }).click()
  const kiranLog = await hr.getByRole('table', { name: /’s days in September 2026$/ }).innerText().catch(() => '')
  check('…Day by day ends on his last day — nothing after it “not marked”', /10 Sept?/.test(kiranLog) && !/11 Sept?/.test(kiranLog), kiranLog.slice(0, 120))
  await hr.getByRole('button', { name: 'Next month' }).click()
  check('…the month after: not employed, in words', await shown(hr.getByText(/^Not employed in this month — the last working day was /)))
  await hr.goto(personUrl(emp.neha.id, '2026-08'))
  check('Neha in August, before she joined: not employed, joined on…', await shown(hr.getByText(/^Not employed in this month — joined on /)))
  answer = nextMonthAnswer(hr, emp.neha.id)
  await hr.getByRole('button', { name: 'Next month' }).click()
  got = await answer
  check('…September counted from the day she joined', got.body?.data?.totals?.from === '2026-09-14', JSON.stringify(got.body?.data?.totals ?? {}))

  section('Suspicious: a refused punch, and the name on it opens the month')
  const raviFar = await open('emp2', { viewport: PHONE, phone: true, at: { latitude: fx.office.latitude + 0.027, longitude: fx.office.longitude, accuracy: 10 }, permissions: ['geolocation'] })
  await raviFar.goto(`${BASE}/dashboard`)
  await raviFar.getByRole('button', { name: /Check In/ }).click()
  check('Ravi, 3 km away: refused at the office radius', await until(() => psql(`SELECT count(*) FROM "PunchEvidence" WHERE "employeeId" = '${emp.ravi.id}' AND "refusedFor" IS NOT NULL`), '1') === true)
  await raviFar.context().close()
  await hr.goto(`${BASE}/attendance?view=suspicious`)
  const suspicious = hr.getByRole('list', { name: 'Suspicious punches' })
  const raviLink = suspicious.getByRole('link', { name: emp.ravi.name, exact: true })
  check('his name on Suspicious is a link', await shown(raviLink))
  await raviLink.first().click()
  await hr.waitForURL((url) => url.pathname === `/attendance/people/${emp.ravi.id}`, { timeout: 20_000 }).catch(() => {})
  check('…to his month', new URL(hr.url()).pathname === `/attendance/people/${emp.ravi.id}` && await shown(hr.getByRole('heading', { name: emp.ravi.name, level: 1 })), hr.url())

  section('HR: the profile’s Attendance tab')
  await hr.goto(`${BASE}/employees/${emp.priya.id}?tab=attendance`)
  check('the tab is there, and open', (await hr.getByRole('tab', { name: 'Attendance' }).getAttribute('aria-selected').catch(() => null)) === 'true')
  check('…her month so far in it', await shown(hr.getByRole('region', { name: 'Month so far' }).locator('dl')))
  await hr.getByRole('link', { name: 'Open on Attendance' }).click()
  await hr.waitForURL((url) => url.pathname === `/attendance/people/${emp.priya.id}`, { timeout: 20_000 }).catch(() => {})
  check('…and opens on Attendance', new URL(hr.url()).pathname === `/attendance/people/${emp.priya.id}`, hr.url())
  check('no error toast anywhere for HR', (await errorToasts(hr)) === 0)
  await hr.context().close()

  section('HR on a phone: the roster’s name, the page at 390 px')
  const hrPhone = await open('hr', { viewport: PHONE, phone: true })
  await hrPhone.goto(`${BASE}/attendance`)
  const phoneLink = hrPhone.locator('main').getByRole('link', { name: emp.priya.name, exact: true }).filter({ visible: true }).first()
  check('the name is a link on the phone’s roster too', await shown(phoneLink))
  await phoneLink.click()
  await hrPhone.waitForURL((url) => url.pathname === `/attendance/people/${emp.priya.id}`, { timeout: 20_000 }).catch(() => {})
  await hrPhone.getByRole('region', { name: 'Month so far' }).locator('dl').waitFor({ timeout: 20_000 }).catch(() => {})
  check('her page fits 390 px', (await sideways(hrPhone)) <= 1, `${await sideways(hrPhone)}px`)
  await hrPhone.getByRole('tab', { name: 'Day by day' }).click()
  check('…Day by day is a list on a phone', await shown(hrPhone.getByRole('list', { name: /’s days in / })))
  check('…still fits', (await sideways(hrPhone)) <= 1, `${await sideways(hrPhone)}px`)
  await hrPhone.screenshot({ path: `${SHOTS}/hr-phone-priya.png`, fullPage: true })
  await hrPhone.context().close()

  section('Manoj (manager): his team, and nobody else')
  const manoj = await open('mgr')
  await manoj.goto(`${BASE}/attendance`)
  const teamLink = manoj.locator('main').getByRole('link', { name: emp.priya.name, exact: true }).filter({ visible: true }).first()
  check('Priya, who reports to him, is a link on his roster', await shown(teamLink))
  await teamLink.click()
  check('…her month opens for him', await shown(manoj.getByRole('region', { name: 'Month so far' }).locator('dl')))
  check('…with her paid and unpaid days (agreed with the client)', await shown(manoj.getByText('Unpaid days (loss of pay)', { exact: true })))
  answer = nextMonthAnswer(manoj, emp.ravi.id)
  await manoj.goto(personUrl(emp.ravi.id))
  got = await answer
  check('Ravi, not in his team: the server says no', got.status === 404, String(got.status))
  check('…“Not yours to see”, in words', await shown(manoj.getByText('Not yours to see', { exact: true })) && await shown(manoj.getByText('That person’s attendance is not one you see.')))
  check('…and no error toast besides', (await errorToasts(manoj)) === 0)
  // His Employees reach is the company, his attendance reach his team: the tab is there, and says so.
  await manoj.goto(`${BASE}/employees/${emp.ravi.id}?tab=attendance`)
  check('Ravi’s profile → Attendance: not his to see, said in the tab', await shown(manoj.getByText('Not yours to see', { exact: true })))
  check('…no “Open on Attendance” for a month he cannot see', (await manoj.getByRole('link', { name: 'Open on Attendance' }).count()) === 0)
  await manoj.context().close()

  section('Admin (no Attendance): no tab, no page')
  const admin = await open('admin')
  await admin.goto(`${BASE}/employees/${emp.priya.id}`)
  await admin.getByRole('heading', { name: emp.priya.name, level: 1 }).waitFor({ timeout: 20_000 }).catch(() => {})
  check('no Attendance tab on a profile', (await admin.getByRole('tab', { name: 'About' }).count()) === 1 && (await admin.getByRole('tab', { name: 'Attendance' }).count()) === 0)
  let asked = false
  admin.on('request', (r) => { if (r.url().includes('/api/attendance/people/')) asked = true })
  await admin.goto(personUrl(emp.priya.id))
  await admin.waitForTimeout(1500)
  check('the page’s address goes home, and asks the server nothing', !asked && new URL(admin.url()).pathname === '/dashboard' && (await admin.getByRole('region', { name: 'Month so far' }).count()) === 0, `asked=${asked} at ${admin.url()}`)
  await admin.context().close()

  section('Priya, on her phone: her own figures are the same count')
  const priya = await open('emp', { viewport: PHONE, phone: true })
  answer = nextMonthAnswer(priya, emp.priya.id)
  await priya.goto(`${BASE}/attendance`)
  got = await answer
  d = got.body?.data
  check('her Attendance page reads her month from the same place', got.status === 200 && d?.person?.id === emp.priya.id, String(got.status))
  await figuresMatch(priya, 'Attendance stats', d.totals, 'Her own page')
  check('…her page fits 390 px', (await sideways(priya)) <= 1, `${await sideways(priya)}px`)
  await priya.goto(`${BASE}/dashboard`)
  const myMonth = priya.getByRole('region', { name: 'My month' })
  const fig = async (label) => myMonth.getByText(label, { exact: true }).locator('xpath=preceding-sibling::p[1]').innerText({ timeout: 20_000 }).catch(() => '?')
  const home = { present: await fig('Present'), absent: await fig('Absent'), leave: await fig('Leave'), off: await fig('Weekly off'), half: await fig('Half days') }
  check('home’s “My month” agrees: present, absent, leave, weekly off, half days',
    home.present === String(d.totals.present) && home.absent === String(d.totals.absent) && home.leave === String(d.totals.on_leave)
    && home.off === String(d.totals.weekly_offs) && home.half === String(d.totals.half_days), JSON.stringify({ home, t: d.totals }))
  answer = nextMonthAnswer(priya, emp.ravi.id)
  await priya.goto(personUrl(emp.ravi.id))
  check('Ravi’s page, by its address: not hers to see', (await answer).status === 404 && await shown(priya.getByText('Not yours to see', { exact: true })))
  answer = nextMonthAnswer(priya, emp.priya.id)
  await priya.goto(personUrl(emp.priya.id))
  check('her own, by its address: hers', (await answer).status === 200 && await shown(priya.getByRole('region', { name: 'Month so far' }).locator('dl')))
  await priya.getByRole('tab', { name: 'Day by day' }).click()
  const ownList = priya.getByRole('list', { name: /’s days in / })
  // Her days are on screen — today's app punch among them — and still no Evidence.
  check('…no Evidence of her own punches: that is for those above her', await shown(ownList) && /so far|In \d/.test(await ownList.innerText())
    && (await priya.getByRole('button', { name: /^Evidence of the punches on / }).count()) === 0)
  check('…fits 390 px', (await sideways(priya)) <= 1, `${await sideways(priya)}px`)
  await priya.screenshot({ path: `${SHOTS}/priya-own-page.png`, fullPage: true })
  await priya.context().close()

  section('Super Admin: anybody’s month, evidence included')
  const sa = await open('sa')
  await sa.goto(personUrl(emp.priya.id))
  await sa.getByRole('tab', { name: 'Day by day' }).click()
  const saEvidence = sa.getByRole('button', { name: /^Evidence of the punches on / })
  check('the Super Admin sees Priya’s days with their evidence', await shown(saEvidence))
  await sa.context().close()

  check('no page errors', pageErrors.length === 0, pageErrors.join(' | '))
  check('no server errors', serverErrors.length === 0, serverErrors.join(' | '))
} catch (err) {
  failures.push(`crashed: ${err.stack ?? err.message}`)
  console.log(`FAIL  crashed — ${err.stack ?? err.message}`)
} finally {
  await browser.close()
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) {
  for (const f of failures) console.log(`  ✗ ${f}`)
  process.exit(1)
}
