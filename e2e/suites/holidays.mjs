// The Home page's holiday card, through the browser: what it says when this
// year's entered holidays are all behind us (the next one is in January), when
// some are still to come, and when none are ahead at all; the way to add them,
// offered to whoever keeps the calendar (HR, the Super Admin) and to nobody
// else; that way opening Settings → Leave Config at its Holidays section; and a
// holiday added there showing on Home straight away — on a computer and a phone.
// Production build on :5183 → compiled API on :4100 → local ems_e2e, Day 20 seed.
//
// The holidays are arranged through the API for each case, and put back as
// they were at the end.
import { chromium } from 'playwright-core'
import { mkdirSync, readFileSync } from 'node:fs'
import { WORK } from '../lib/env.mjs'
import { menuLink } from '../lib/ui.mjs'

const BASE = 'http://localhost:5183'
const API = `${BASE}/api`
const fx = JSON.parse(readFileSync(`${WORK}/day20-fixture.json`, 'utf8'))
const SHOTS = `${WORK}/shots/holidays`
mkdirSync(SHOTS, { recursive: true })
const PHONE = { width: 390, height: 844 }
const DESKTOP = { width: 1366, height: 900 }

// ── Reporting ───────────────────────────────────────────────────────────────
let passed = 0
const failures = []
function check(name, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✓ ${name}`) } else { failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}
const section = (name) => console.log(`\n── ${name}`)

// ── The API, as the Super Admin ─────────────────────────────────────────────
const signIn = await (await fetch(`${API}/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ identifier: fx.users.sa, password: fx.password }),
})).json()
const token = signIn.data?.accessToken
const timezone = signIn.data?.user?.organizationTimezone
if (!token || !timezone) throw new Error(`Super Admin sign-in did not give a token and the company's time zone: ${JSON.stringify(signIn).slice(0, 200)}`)
async function api(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { json = text }
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 200)}`)
  return json
}

// "Today" on the company's clock, as the card reads it.
const today = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
const year = Number(today.slice(0, 4))
const holidaysOf = async (y) => (await api('GET', `/holidays?year=${y}`)).data
const original = [...(await holidaysOf(year)), ...(await holidaysOf(year + 1))]
const removed = []
const added = []
async function remove(h) { await api('DELETE', `/holidays/${h.id}`); removed.push(h) }
async function add(date, name) { const row = (await api('POST', '/holidays', { date, name, type: 'public' })).data; added.push(row); return row }
const ahead = async () => [...(await holidaysOf(year)), ...(await holidaysOf(year + 1))].filter((h) => h.date >= today && h.type !== 'weekly_off')

// ── The browser ─────────────────────────────────────────────────────────────
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const pageErrors = []
const serverErrors = []

async function open(who, viewport = DESKTOP) {
  const ctx = await browser.newContext({ viewport })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => pageErrors.push(`${who}: ${e.message}`))
  page.on('response', (r) => { if (r.url().includes('/api/') && r.status() >= 500) serverErrors.push(`${who}: ${r.status()} ${r.url().split('/api')[1]}`) })
  await page.goto(`${BASE}/signin`)
  await page.getByLabel('Work Email or Employee ID').fill(fx.users[who])
  await page.getByPlaceholder('Enter your password').fill(fx.password)
  await page.getByRole('button', { name: 'Sign In' }).click()
  await page.waitForURL((url) => !url.pathname.startsWith('/signin'), { timeout: 20_000 })
  await settle(page)
  return page
}
async function settle(page) {
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined)
  await page.getByText(/^Loading/).first().waitFor({ state: 'detached', timeout: 20_000 }).catch(() => undefined)
  await page.waitForTimeout(250)
}
async function home(page) { await page.goto(`${BASE}/dashboard`); await settle(page) }
const card = (page) => page.getByRole('region', { name: 'Upcoming holidays' })
const shown = (locator, timeout = 10_000) => locator.waitFor({ timeout }).then(() => true, () => false)
const sideways = (page) => page.evaluate(() => {
  const main = document.querySelector('main')
  return Math.max(document.documentElement.scrollWidth - window.innerWidth, main ? main.scrollWidth - main.clientWidth : 0)
})
/**
 * Whether Settings opened at its Holidays section: the section's top in the
 * window, and as high as the page goes — at the top of the scrolling area, or
 * that area scrolled to its end (Holidays is the page's last section).
 */
const holidaysInView = (page) => page.evaluate(() => {
  const el = document.getElementById('holidays')
  const main = document.querySelector('main')
  if (!el || !main) return false
  const top = el.getBoundingClientRect().top - main.getBoundingClientRect().top
  const scrollable = main.scrollHeight > main.clientHeight + 2
  const atEnd = main.scrollTop >= main.scrollHeight - main.clientHeight - 2
  // A page that can scroll must have: "at the end" proves nothing at the top.
  const moved = !scrollable || main.scrollTop > 0
  return el.getBoundingClientRect().top >= 0 && el.getBoundingClientRect().top < window.innerHeight && (top <= 24 || atEnd) && moved
})
/** Whether the focus went to the Holidays section, so the next Tab goes into it. */
const focusOnHolidays = (page) => page.evaluate(() => document.activeElement?.id === 'holidays')
const DATE_LINE = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{1,2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4}$/

try {
  // ═══════════════════════════════════════════════════════════════════════
  section(`Every holiday of ${year} already behind us (as on 5 Oct 2026 with only the national ones)`)
  for (const h of (await holidaysOf(year)).filter((x) => x.date >= today && x.type !== 'weekly_off')) await remove(h)
  const nextYearAhead = (await ahead()).filter((h) => h.date.startsWith(String(year + 1)))
  if (nextYearAhead.length < 2) {
    if (!nextYearAhead.some((h) => h.date === `${year + 1}-01-26`)) await add(`${year + 1}-01-26`, 'Republic Day')
    if (!nextYearAhead.some((h) => h.date === `${year + 1}-08-15`)) await add(`${year + 1}-08-15`, 'Independence Day')
  }
  const firstNext = (await ahead()).sort((a, b) => a.date.localeCompare(b.date))[0]

  for (const who of ['hr', 'sa']) {
    const page = await open(who)
    const c = card(page)
    check(`${who}: the card names the next holiday, in ${year + 1}`, await shown(c.getByText(firstNext.name).first()), firstNext.name)
    check(`${who}: …and says there are no more entered for ${year}`, await shown(c.getByText(`No more holidays entered for ${year}.`)))
    check(`${who}: …with the way to add them`, await shown(c.getByRole('link', { name: 'Add holidays' })))
    const lines = await c.locator('li span.block.text-xs').allTextContents()
    check(`${who}: the holidays after it carry their whole date, not "Sunday, ${year + 1}"`, lines.length > 0 && lines.every((t) => DATE_LINE.test(t.trim())), lines.join(' | '))
    await c.screenshot({ path: `${SHOTS}/${who}-none-left-this-year.png` })
    if (who === 'hr') {
      await c.getByRole('link', { name: 'Add holidays' }).click()
      await page.waitForURL('**/settings?tab=leave#holidays', { timeout: 10_000 }).catch(() => undefined)
      await settle(page)
      check('hr: the link opens Settings → Leave Config', new URL(page.url()).searchParams.get('tab') === 'leave' && page.url().endsWith('#holidays'), page.url())
      check('hr: …at the Holidays section, in view (below the leave types)', await holidaysInView(page))
      check('hr: …with the focus there, for the keyboard', await focusOnHolidays(page))
      check('hr: …where a holiday can be added', await page.locator('#holidays').getByRole('button', { name: /Add holiday/ }).isVisible())
    }
    await page.context().close()
  }

  for (const who of ['emp', 'mgr']) {
    const page = await open(who)
    const c = card(page)
    check(`${who}: the card says there are no more entered for ${year}`, await shown(c.getByText(`No more holidays entered for ${year}.`)))
    check(`${who}: …and offers no way to add any (it is not theirs to keep)`, (await c.getByRole('link', { name: /Add/ }).count()) === 0)
    await c.screenshot({ path: `${SHOTS}/${who}-none-left-this-year.png` })
    await page.context().close()
  }

  {
    const page = await open('hr', PHONE)
    const c = card(page)
    await c.scrollIntoViewIfNeeded().catch(() => undefined)
    check('hr on a phone: the note and the link are there', await shown(c.getByText(`No more holidays entered for ${year}.`)) && await c.getByRole('link', { name: 'Add holidays' }).isVisible())
    check('hr on a phone: no sideways scrolling on Home', (await sideways(page)) <= 1, `${await sideways(page)}px`)
    await c.screenshot({ path: `${SHOTS}/hr-phone-none-left-this-year.png` })
    await c.getByRole('link', { name: 'Add holidays' }).click()
    await page.waitForURL('**/settings?tab=leave#holidays', { timeout: 10_000 }).catch(() => undefined)
    await settle(page)
    check('hr on a phone: the link opens at the Holidays section', await holidaysInView(page))
    await page.context().close()
  }

  // ═══════════════════════════════════════════════════════════════════════
  section(`A holiday of ${year} added in Settings shows on Home at once`)
  const christmas = `${year}-12-25`
  if (christmas <= today) {
    check(`(skipped: ${christmas} is not ahead of today, ${today})`, true)
  } else {
    const page = await open('hr')
    await page.goto(`${BASE}/settings?tab=leave#holidays`)
    await settle(page)
    const form = page.locator('#holidays')
    await form.getByLabel('Date').fill(christmas)
    await form.getByLabel('Name').fill('Christmas')
    await form.getByRole('button', { name: /Add holiday/ }).click()
    check('hr: Christmas is added', await shown(form.getByText('Christmas').first()))
    const row = (await holidaysOf(year)).find((h) => h.date === christmas)
    if (row) added.push(row)
    // By the menu, not a reload: the card must not show what it held before.
    await menuLink(page, 'Home').click()
    await settle(page)
    const c = card(page)
    check('hr: Home now names Christmas as the next holiday', await shown(c.getByText('Christmas').first()))
    check(`hr: …and no longer says there are none left for ${year}`, (await c.getByText(/No more holidays entered/).count()) === 0)
    await c.screenshot({ path: `${SHOTS}/hr-christmas-next.png` })
    await page.context().close()

    const emp = await open('emp')
    check('emp: Christmas is next on their Home too', await shown(card(emp).getByText('Christmas').first()))
    check('emp: …with no note', (await card(emp).getByText(/No more holidays entered/).count()) === 0)
    await emp.context().close()
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('No holiday ahead at all')
  for (const h of await ahead()) {
    const mine = added.findIndex((a) => a.id === h.id)
    if (mine >= 0) { await api('DELETE', `/holidays/${h.id}`); added.splice(mine, 1) } else await remove(h)
  }
  for (const who of ['hr', 'sa']) {
    const page = await open(who)
    const c = page.locator('section', { has: page.getByRole('heading', { name: 'Upcoming holidays' }) })
    check(`${who}: "No holidays ahead"`, await shown(c.getByText('No holidays ahead')))
    check(`${who}: …with the way to add some`, await c.getByRole('link', { name: 'Add holidays' }).isVisible())
    await c.screenshot({ path: `${SHOTS}/${who}-none-ahead.png` })
    await c.getByRole('link', { name: 'Add holidays' }).click()
    await page.waitForURL('**/settings?tab=leave#holidays', { timeout: 10_000 }).catch(() => undefined)
    await settle(page)
    check(`${who}: …which opens at the Holidays section`, await holidaysInView(page))
    await page.context().close()
  }
  {
    const page = await open('emp')
    const c = page.locator('section', { has: page.getByRole('heading', { name: 'Upcoming holidays' }) })
    check('emp: "No holidays ahead", and no way to add any', await shown(c.getByText('No holidays ahead')) && (await c.getByRole('link', { name: /Add/ }).count()) === 0)
    await page.context().close()
  }

  section('Nothing broke along the way')
  check('no page errors', pageErrors.length === 0, pageErrors.slice(0, 5).join(' | '))
  check('no server errors', serverErrors.length === 0, serverErrors.slice(0, 5).join(' | '))
} catch (err) {
  failures.push(`stopped: ${err.message}`)
  console.error(err)
} finally {
  // The calendar as it was: what this suite added goes, what it removed comes back.
  try {
    for (const h of added) await api('DELETE', `/holidays/${h.id}`).catch(() => undefined)
    for (const h of removed) await api('POST', '/holidays', { date: h.date, name: h.name, type: h.type })
    const now = [...(await holidaysOf(year)), ...(await holidaysOf(year + 1))].map((h) => `${h.date} ${h.name}`).sort()
    const before = original.map((h) => `${h.date} ${h.name}`).sort()
    check('the holidays are put back as they were', JSON.stringify(now) === JSON.stringify(before), `${now.length} now, ${before.length} before`)
  } catch (err) {
    failures.push(`putting the holidays back: ${err.message}`)
  }
  await browser.close()
  console.log(`\n${passed} passed, ${failures.length} failed`)
  if (failures.length) {
    console.log(failures.map((f) => `  ✗ ${f}`).join('\n'))
    process.exitCode = 1
  }
}
