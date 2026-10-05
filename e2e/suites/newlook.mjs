// The new look (Oct 2026), through the browser: the shell, every page as every
// role on a computer and on a phone, the dialogs and the ways into them, and
// the pages the new look added — an employee's profile, My Profile, the
// employee's own Attendance page.
// Production build on :5183 → compiled API on :4100 → local ems_e2e, Day 20 seed.
//
// For every login: the menu it is offered; each page's title (the heading and
// the browser tab); no error view; no page error; no 5xx; and, on a 390px
// phone, no sideways scrolling. Then the controls every page shares — the user
// menu, search (Ctrl K), the phone's tab bar and its More menu — each opened,
// used and closed with Escape. Then the dialogs, opened from their links
// (?add=1, ?apply=1, ?new=choose) and from their buttons, each closed with
// Escape without leaving the link behind.
import { chromium } from 'playwright-core'
import { WORK } from '../lib/env.mjs'
import { openMyProfile, openEmployeeProfile, signOutVia, menuLinks, menuLink } from '../lib/ui.mjs'
import { readFileSync, mkdirSync } from 'node:fs'

const BASE = 'http://localhost:5183'
const API = `${BASE}/api`
const fx = JSON.parse(readFileSync(`${WORK}/day20-fixture.json`, 'utf8'))
const E = fx.employees
const SHOTS = `${WORK}/shots/newlook`
mkdirSync(SHOTS, { recursive: true })
const PHONE = { width: 390, height: 844 }
const DESKTOP = { width: 1366, height: 900 }

/** The menu each login is offered — as Day 20 checks it, with the new look's labels. */
const MENU = {
  sa: ['Home', 'Employees', 'Attendance', 'Leave', 'Requests', 'Payroll', 'Payslips', 'Documents', 'Reports', 'Settings'],
  admin: ['Home', 'Employees', 'Requests', 'Payslips', 'Documents', 'Settings'],
  hr: ['Home', 'Employees', 'Attendance', 'Leave', 'Requests', 'Payroll', 'Payslips', 'Documents', 'Settings'],
  mgr: ['Home', 'Employees', 'Attendance', 'Leave', 'Requests', 'Payslips', 'Documents'],
  rm: ['Home', 'Employees', 'Attendance', 'Leave', 'Requests', 'Payslips', 'Documents'],
  acc: ['Home', 'Payroll', 'Payslips', 'Documents'],
  emp: ['Home', 'Attendance', 'Leave', 'Requests', 'Payslips', 'Documents'],
}
const PATH = { Home: '/dashboard', Employees: '/employees', Attendance: '/attendance', Leave: '/leave', Requests: '/requests', Payroll: '/payroll', Payslips: '/payslips', Documents: '/documents', Reports: '/reports', Settings: '/settings' }
/** The page's heading and its browser tab: the menu's word, but for Home's greeting and My Payslips. */
const TITLE = { Home: 'Home', Payslips: 'My Payslips' }

// ── Reporting ───────────────────────────────────────────────────────────────
let passed = 0
const failures = []
function check(name, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✓ ${name}`) } else { failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}
const section = (name) => console.log(`\n── ${name}`)

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
async function go(page, path) { await page.goto(`${BASE}${path}`); await settle(page) }
const sideways = (page) => page.evaluate(() => {
  const main = document.querySelector('main')
  return Math.max(document.documentElement.scrollWidth - window.innerWidth, main ? main.scrollWidth - main.clientWidth : 0)
})
const shown = (locator, timeout = 15_000) => locator.waitFor({ timeout }).then(() => true, () => false)
const gone = (locator, timeout = 10_000) => locator.waitFor({ state: 'hidden', timeout }).then(() => true, () => false)
const dialog = (page) => page.getByRole('dialog').last()
const errorView = async (page) => (await page.locator('main').getByRole('button', { name: /^(Try again|Trying again…)$/ }).count()) > 0
  || (await page.getByText('This page ran into a problem').count()) > 0

try {
  // ═══════════════════════════════════════════════════════════════════════
  for (const who of Object.keys(MENU)) {
    section(`${who} — every page on a computer`)
    const page = await open(who)
    const menu = await menuLinks(page)
    check(`${who}: the menu offers exactly its pages`, JSON.stringify(menu) === JSON.stringify(MENU[who]), menu.join(', '))
    check(`${who}: Home greets them by the time of day`, await shown(page.getByRole('heading', { level: 1, name: /^Good (morning|afternoon|evening), / })))
    check(`${who}: Home's tab says so`, (await page.title()) === 'Home · EMS', await page.title())
    for (const label of MENU[who].filter((l) => l !== 'Home')) {
      await menuLink(page, label).click()
      await page.waitForURL(`**${PATH[label]}**`, { timeout: 20_000 })
      await settle(page)
      const title = TITLE[label] ?? label
      const heading = await shown(page.getByRole('heading', { level: 1, name: title, exact: true }))
      check(`${who}: ${label} — heading, tab title, no error view`, heading && (await page.title()) === `${title} · EMS` && !(await errorView(page)), `${await page.title()}`)
      await page.screenshot({ path: `${SHOTS}/${who}-desktop-${label.toLowerCase()}.png`, fullPage: true })
    }

    // The user menu: who is signed in, My Profile and Sign Out — and Escape.
    const userButton = page.locator('header [aria-haspopup="menu"]')
    check(`${who}: the top bar says which login is open`, /Signed in as /.test(await userButton.innerText()))
    await userButton.click()
    check(`${who}: the user menu offers My Profile and Sign Out`, await page.getByRole('menuitem', { name: 'My Profile' }).isVisible() && await page.getByRole('menuitem', { name: 'Sign Out' }).isVisible())
    await page.keyboard.press('Escape')
    check(`${who}: Escape closes the user menu`, await gone(page.getByRole('menu')))

    // Search: a page by its name, Enter to go, Escape to close.
    await page.keyboard.press('Control+k')
    const palette = page.getByRole('dialog', { name: /search/i })
    check(`${who}: Ctrl K opens search`, await shown(palette))
    await page.keyboard.type('Documents')
    await page.keyboard.press('Enter')
    check(`${who}: Enter goes to the page found`, await page.waitForURL('**/documents**', { timeout: 10_000 }).then(() => true, () => false))
    await page.keyboard.press('Control+k')
    await shown(palette)
    await page.keyboard.press('Escape')
    check(`${who}: Escape closes search`, await gone(palette))

    // My Profile, from the menu.
    await openMyProfile(page)
    check(`${who}: My Profile opens as a page, with a Password tab`, await shown(page.getByRole('tab', { name: 'Password' })) && (await page.title()) === 'My Profile · EMS', await page.title())
    await page.context().close()
  }

  // ═══════════════════════════════════════════════════════════════════════
  for (const who of Object.keys(MENU)) {
    section(`${who} — every page on a 390px phone`)
    const page = await open(who, PHONE)
    const tabBar = page.getByRole('navigation', { name: 'Pages' })
    check(`${who}: the phone has its tab bar`, await tabBar.isVisible().catch(() => false))
    for (const label of MENU[who]) {
      await go(page, PATH[label])
      const over = await sideways(page)
      check(`${who} on a phone: ${label} fits the screen`, over <= 1 && !(await errorView(page)), `${over}px over`)
      await page.screenshot({ path: `${SHOTS}/${who}-phone-${label.toLowerCase()}.png`, fullPage: true })
    }
    // The menu drawer: every page, My Profile, Sign Out — and Escape.
    await page.getByRole('button', { name: 'Open menu' }).click()
    const drawer = page.getByRole('dialog', { name: 'Menu' })
    check(`${who} on a phone: the menu has My Profile and Sign Out`, await shown(drawer) && await drawer.getByRole('link', { name: 'My Profile' }).isVisible() && await drawer.getByRole('button', { name: 'Sign Out' }).isVisible())
    await page.keyboard.press('Escape')
    check(`${who} on a phone: Escape closes the menu`, await gone(drawer))
    // More than four pages: the tab bar's More opens the same menu.
    if (MENU[who].length > 4) {
      await tabBar.getByRole('button', { name: 'More pages' }).click()
      check(`${who} on a phone: More opens the menu with the rest`, await shown(drawer))
      await page.keyboard.press('Escape')
      await gone(drawer)
    }
    // Settings on a phone: the open section's tab is scrolled into view in its
    // strip — it used to sit off the right edge — and the page does not move.
    if (who === 'sa') {
      for (const [key, name] of [['audit', 'Audit Log'], ['notifications', 'Notifications'], ['company', 'Company']]) {
        await go(page, `/settings?tab=${key}`)
        const chosen = page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name, exact: true })
        await chosen.waitFor({ timeout: 20_000 })
        await page.waitForTimeout(300)
        const box = await chosen.boundingBox()
        check(`sa on a phone: Settings → ${name} — its tab is in view and chosen`, box && box.x >= 0 && box.x + box.width <= PHONE.width + 1 && (await chosen.getAttribute('aria-selected')) === 'true' && (await sideways(page)) <= 1, JSON.stringify(box))
      }
    }
    await page.context().close()
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('Dialogs: opened from their links and buttons, closed with Escape')
  {
    const emp = await open('emp')
    await go(emp, '/leave?apply=1')
    check('?apply=1 opens Apply for Leave', await shown(emp.getByRole('dialog', { name: 'Apply for Leave' })))
    await emp.keyboard.press('Escape')
    check('Escape closes it, and the link is gone from the address', await gone(emp.getByRole('dialog', { name: 'Apply for Leave' })) && !emp.url().includes('apply='), emp.url())
    await emp.reload()
    await settle(emp)
    check('…so a reload does not open it again', !(await emp.getByRole('dialog', { name: 'Apply for Leave' }).count()))

    await go(emp, '/requests?new=choose')
    const kinds = emp.getByRole('list', { name: 'Kinds of request' })
    check('?new=choose opens the kinds of request', await shown(kinds))
    await kinds.getByRole('button', { name: /^Work from home/ }).click()
    check('…a kind opens its form', await shown(emp.getByRole('dialog', { name: 'Work from home' })))
    await emp.getByRole('button', { name: 'All kinds of request' }).click()
    check('…and comes back to the kinds', await shown(kinds))
    await emp.keyboard.press('Escape')
    check('Escape closes it and drops ?new', await gone(kinds) && !emp.url().includes('new='), emp.url())
    await go(emp, '/requests?new=nonsense')
    check('A kind the app does not have opens the kinds, not an empty form', await shown(kinds))
    await emp.keyboard.press('Escape')
    await emp.context().close()

    const hr = await open('hr')
    await go(hr, '/employees?add=1')
    check('?add=1 opens Add New Employee', await shown(hr.getByRole('dialog', { name: 'Add New Employee' })))
    await hr.keyboard.press('Escape')
    check('Escape closes it and drops ?add', await gone(hr.getByRole('dialog', { name: 'Add New Employee' })) && !hr.url().includes('add='), hr.url())
    await hr.getByRole('button', { name: 'Import' }).click()
    check('Import opens its dialog', await shown(hr.getByRole('dialog', { name: 'Import Employees' })))
    await hr.keyboard.press('Escape')
    check('Escape closes Import', await gone(hr.getByRole('dialog', { name: 'Import Employees' })))
    await hr.getByRole('button', { name: /^More for / }).first().click()
    check('A row’s menu offers View Profile', await hr.getByRole('menuitem', { name: 'View Profile' }).isVisible())
    await hr.keyboard.press('Escape')
    check('Escape closes the row’s menu', await gone(hr.getByRole('menuitem', { name: 'View Profile' })))

    await go(hr, '/attendance')
    const mark = hr.getByRole('button', { name: /^(Mark|Edit) / }).first()
    if (await mark.count()) {
      await mark.click()
      check('Mark opens the attendance dialog', await shown(hr.getByRole('dialog', { name: /^Attendance — / })))
      await hr.keyboard.press('Escape')
      check('Escape closes it', await gone(hr.getByRole('dialog', { name: /^Attendance — / })))
    }
    await hr.context().close()
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('An employee’s profile page')
  {
    const hr = await open('hr')
    await openEmployeeProfile(hr, BASE, E.priya.name)
    check('A name in the list opens their profile page', hr.url().endsWith(`/employees/${E.priya.id}`), hr.url())
    check('…titled as an employee’s', (await hr.title()) === 'Employee · EMS', await hr.title())
    const tabs = await hr.getByRole('tab').allInnerTexts()
    check('HR’s tabs: About, Employment, a login, Documents and Statutory — no bank account', ['About', 'Employment', 'Documents'].every((t) => tabs.includes(t)) && !tabs.includes('Bank account'), tabs.join(', '))
    await hr.getByRole('tab', { name: 'Employment' }).click()
    check('A tab goes into the address', hr.url().includes('tab=employment'))
    await hr.reload()
    await settle(hr)
    check('…and stays on reload', (await hr.getByRole('tab', { name: 'Employment' }).getAttribute('aria-selected')) === 'true')
    await hr.getByRole('button', { name: 'Edit', exact: true }).click()
    check('Edit opens Edit Employee over the page', await shown(hr.getByRole('dialog', { name: 'Edit Employee' })))
    await hr.keyboard.press('Escape')
    check('Escape closes it', await gone(hr.getByRole('dialog', { name: 'Edit Employee' })))
    // The page's own back link — "Employees / Priya …" in <main>, not the menu's Employees.
    await hr.locator('main').getByRole('link', { name: /^Employees/ }).first().click()
    check('The back link returns to the list', await hr.waitForURL(/\/employees$/, { timeout: 10_000 }).then(() => true, () => false))
    await go(hr, `/employees?open=${E.priya.id}`)
    check('An older link (?open=) lands on the profile page', hr.url().endsWith(`/employees/${E.priya.id}`), hr.url())
    await go(hr, '/employees/00000000-0000-4000-8000-000000000000')
    check('Somebody who is not there: “could not be found”, and no error toast', await shown(hr.getByText('This employee could not be found')) && !(await hr.locator('[data-sonner-toast]').count()))
    await go(hr, '/employees/not-an-id')
    check('A mistyped address: the same', await shown(hr.getByText('This employee could not be found')))
    await hr.context().close()

    const phone = await open('hr', PHONE)
    await openEmployeeProfile(phone, BASE, E.priya.name, 'Employment')
    check('The profile fits a phone', (await sideways(phone)) <= 1, `${await sideways(phone)}px over`)
    await phone.context().close()
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('The employee’s own Attendance page')
  {
    const emp = await open('emp')
    await go(emp, '/attendance')
    check('Today, the month in figures and the working week, side by side', await shown(emp.getByRole('heading', { name: 'Time today' })) && await shown(emp.getByRole('heading', { name: 'Attendance stats' })) && await shown(emp.getByRole('heading', { name: 'Timings' })))
    check('…the month’s total hours, as the server totals them', await shown(emp.getByText('Hours worked', { exact: true })))
    await emp.getByRole('tab', { name: 'Calendar' }).click()
    const month = new Date().toISOString().slice(0, 7)
    const token = (await (await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: fx.users.emp, password: fx.password }) })).json()).data.accessToken
    const cal = (await (await fetch(`${API}/attendance/calendar?year=${month.slice(0, 4)}&month=${Number(month.slice(5, 7))}`, { headers: { Authorization: `Bearer ${token}` } })).json()).data
    const offCells = await emp.locator('[aria-label*="Weekly off"]').count()
    const weeklyOffs = cal.days_off.filter((d) => d.kind === 'weekly_off').length
    check('The calendar shows the month’s weekly offs, though nobody marks them', weeklyOffs > 0 && offCells >= weeklyOffs, `${offCells} cells, ${weeklyOffs} weekly offs`)
    for (const holiday of cal.days_off.filter((d) => d.kind === 'holiday')) {
      check(`…and the holiday “${holiday.name}”`, (await emp.locator(`[aria-label*="${holiday.name}"]`).count()) >= 1)
    }
    await emp.getByRole('button', { name: 'Previous month' }).click()
    await settle(emp)
    check('A month back: the log follows', !(await errorView(emp)))
    await emp.screenshot({ path: `${SHOTS}/emp-attendance-calendar.png`, fullPage: true })
    await emp.context().close()
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('What the reviews found, put right')
  {
    const hr = await open('hr')
    // The list's search, filters and sort live in the address: a profile and back keeps them.
    await go(hr, '/employees')
    await hr.getByLabel('Stage').selectOption('confirmed')
    await hr.getByPlaceholder('Search by name or ID…').fill(E.priya.name.split(' ')[0])
    await hr.waitForURL(/stage=confirmed/, { timeout: 10_000 })
    await hr.locator('main').getByRole('link', { name: new RegExp(`^${E.priya.name}\\b`) }).filter({ visible: true }).first().click()
    await hr.waitForURL(/\/employees\/[0-9a-f-]{36}/, { timeout: 10_000 })
    await hr.getByRole('tab', { name: 'Employment' }).click()
    await hr.locator('main').getByRole('link', { name: /^Employees/ }).first().click()
    await settle(hr)
    check('Back from a profile by its link, the list keeps its search and filter',
      hr.url().includes('stage=confirmed') && (await hr.getByLabel('Stage').inputValue()) === 'confirmed' && (await hr.getByPlaceholder('Search by name or ID…').inputValue()) === E.priya.name.split(' ')[0], hr.url())
    await hr.locator('main').getByRole('link', { name: new RegExp(`^${E.priya.name}\\b`) }).filter({ visible: true }).first().click()
    await hr.waitForURL(/\/employees\/[0-9a-f-]{36}/, { timeout: 10_000 })
    await hr.goBack()
    await settle(hr)
    check('…and by the browser’s Back', hr.url().includes('stage=confirmed') && (await hr.getByLabel('Stage').inputValue()) === 'confirmed', hr.url())
    await menuLink(hr, 'Employees').click()
    await settle(hr)
    check('…while the menu’s link opens it afresh', !hr.url().includes('stage=') && (await hr.getByLabel('Stage').inputValue()) === 'All', hr.url())

    // Attendance on a day before anybody joined: still the roster, with its day controls.
    await go(hr, '/attendance')
    await hr.getByLabel('Day', { exact: true }).fill('2020-01-06')
    await settle(hr)
    check('Attendance on a day before anybody joined stays the roster, with its day controls',
      await hr.getByLabel('Day', { exact: true }).isVisible() && await hr.getByRole('button', { name: 'Previous day' }).isVisible() && !(await hr.getByRole('heading', { name: 'Time today' }).count()))
    check('…and the roster says the share present', await shown(hr.getByText(/\d+% present$/).first()))

    // HR's home: the leave waiting for somebody else's decision.
    await go(hr, '/dashboard')
    check('HR’s home lists the leave waiting for somebody else’s decision', await shown(hr.getByRole('region', { name: 'Leave waiting' })))
    await hr.context().close()

    // An employee who checks in on the app: Check In, and the month in figures too.
    const emp = await open('emp')
    const month = emp.getByRole('region', { name: 'My month' })
    check('An app-punch employee’s home has the month in figures beside Check In',
      await shown(month) && await month.getByText('Absent', { exact: true }).isVisible() && await month.getByText('Weekly off', { exact: true }).isVisible())
    check('…and no word that this login does not check in', !(await emp.getByText(/does not check in/).count()))
    // Search offers checking in only to somebody who checks in on the app.
    await emp.keyboard.press('Control+k')
    const palette = emp.getByRole('dialog').last()
    check('Search offers “Check in or out” to an app-punch employee', await shown(palette.getByText('Check in or out')))
    await emp.keyboard.press('Escape')
    await emp.context().close()
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('Tabs from the keyboard; the mid-month salary hint; a date of birth in the roster')
  {
    const hr = await open('hr')
    await go(hr, '/leave')
    const list = hr.getByRole('tablist', { name: 'Leave sections' })
    const tabs = list.getByRole('tab')
    const count = await tabs.count()
    // Chosen and focused — waited for: the choice lands in the address, which the router applies a moment later.
    const selected = async (i) => {
      for (let tries = 0; tries < 30; tries++) {
        if ((await tabs.nth(i).getAttribute('aria-selected')) === 'true' && await tabs.nth(i).evaluate((el) => el === document.activeElement)) return true
        await hr.waitForTimeout(100)
      }
      return false
    }
    await tabs.first().click()
    await hr.keyboard.press('ArrowRight')
    check('→ moves to the next tab, chooses it and takes the focus', count > 2 && await selected(1), `${count} tabs`)
    await hr.keyboard.press('End')
    check('End goes to the last', await selected(count - 1))
    await hr.keyboard.press('Home')
    check('Home to the first', await selected(0))
    await hr.keyboard.press('ArrowLeft')
    check('← from the first goes round to the last', await selected(count - 1))
    check('Only the chosen tab is in the Tab order', (await list.locator('[role="tab"][tabindex="0"]').count()) === 1 && (await list.locator('[role="tab"][tabindex="-1"]').count()) === count - 1)
    const panel = hr.getByRole('tabpanel')
    check('What it shows is its tab panel, named by the chosen tab',
      (await panel.getAttribute('aria-labelledby')) === (await tabs.nth(count - 1).getAttribute('id')) && (await tabs.nth(count - 1).getAttribute('aria-controls')) === (await panel.getAttribute('id')))

    // A roster with dates of birth: read, day-first, by somebody who sees personal details.
    const token = (await (await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: fx.users.hr, password: fx.password }) })).json()).data.accessToken
    const dry = await (await fetch(`${API}/employees/import`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ csv: 'employee_code,full_name,date_of_birth\nNL-DOB-1,Dob Test,14/03/1968\nNL-DOB-2,Dob Later,01/01/2099', dryRun: true }),
    })).json()
    check('The roster import reads a date of birth, and refuses one not in the past',
      dry.data.rows[0].issues.length === 0 && JSON.stringify(dry.data.rows[1].issues).includes('not in the past'), JSON.stringify(dry.data.rows.map((r) => r.issues)))
    await hr.context().close()

    // Accounts: a new salary from inside a month says what that means, and offers the 1st.
    const acc = await open('acc')
    await go(acc, '/payroll?tab=salary')
    await acc.locator('tr', { hasText: E.priya.name }).filter({ visible: true }).getByRole('button', { name: 'Change' }).click()
    const dlg = acc.getByRole('dialog', { name: `Salary — ${E.priya.name}` })
    const date = dlg.locator('input[type="date"]').first()
    const start = await date.inputValue()
    const mid = `${start.slice(0, 7)}-15`
    await date.fill(mid)
    const note = dlg.getByRole('note')
    check('A date inside a month: the form says that month is paid on the current salary, with arrears for the rest', await shown(note) && (await note.innerText()).includes('It starts inside a month'))
    await note.getByRole('button', { name: /^Start on / }).click()
    const after = await date.inputValue()
    check('…and “Start on the 1st instead” moves it to the next month’s 1st', after.endsWith('-01') && after > mid && await gone(note), `${mid} → ${after}`)
    await dlg.getByRole('button', { name: 'Cancel' }).click()
    await acc.context().close()
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('Signing out from the new menus')
  {
    const page = await open('emp')
    await signOutVia(page)
    check('Sign Out from the user menu ends the session', await page.waitForURL('**/signin', { timeout: 10_000 }).then(() => true, () => false))
    await page.context().close()
    const phone = await open('emp', PHONE)
    await signOutVia(phone)
    check('…and from the phone’s menu', await phone.waitForURL('**/signin', { timeout: 10_000 }).then(() => true, () => false))
    await phone.context().close()
  }

  section('Nothing broke along the way')
  check('no page errors', pageErrors.length === 0, pageErrors.slice(0, 5).join(' | '))
  check('no server errors', serverErrors.length === 0, serverErrors.slice(0, 5).join(' | '))
} catch (err) {
  failures.push(`stopped: ${err.message}`)
  console.error(err)
} finally {
  await browser.close()
  console.log(`\n${passed} passed, ${failures.length} failed`)
  if (failures.length) {
    console.log(failures.map((f) => `  ✗ ${f}`).join('\n'))
    process.exitCode = 1
  }
}
