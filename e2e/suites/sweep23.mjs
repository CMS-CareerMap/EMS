// Days 21–23 wrap-up: every role × every page and tab × desktop and phone.
// Production build on :5183 → compiled API on :4100 → local ems_e2e, Day 20 seed (reset20.sh).
//
// For each login it opens every page the menu offers it — and every tab on
// those pages — at 1366px and at 390px, and records:
//   · page errors and 5xx answers,
//   · a 403 on any call the page makes (a page drawn that the server refuses),
//   · an error state on screen ("Try again"),
//   · sideways scrolling on a phone,
// and opens every page the menu does NOT offer, expecting to be sent to the
// dashboard. A screenshot of every page and tab goes to shots/sweep/.
import { chromium } from 'playwright-core'
import { WORK, REPO, STORAGE as STORE, psql } from '../lib/env.mjs'
import { openMyProfile, openEmployeeProfile, signOutVia, menuLinks, menuLink } from '../lib/ui.mjs'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'

const BASE = 'http://localhost:5183'
const API = `${BASE}/api`
const DIR = WORK
const fx = JSON.parse(readFileSync(`${DIR}/day20-fixture.json`, 'utf8'))
const SHOTS = `${DIR}/shots/sweep`
mkdirSync(SHOTS, { recursive: true })
const E = fx.employees
const HEMA_SELF = `d20-${fx.stamp}-hema.self@example.com`

const PAGES = ['/dashboard', '/employees', '/attendance', '/leave', '/requests', '/payroll', '/payslips', '/documents', '/reports', '/settings']
const TABS = {
  '/requests': [/^My requests/, /^To decide/, /^All requests/],
  '/settings': ['Company', 'Users & Roles', 'Roles & Permissions', 'Company Tree', 'Approvals', 'Organisation', 'Leave Config', 'Payroll Config', 'Documents', 'Employee Lifecycle', 'Notifications', 'Audit Log'],
  '/payroll': ['Payroll runs', 'Salary structure', 'Incentives', 'Income tax (TDS)', 'Loans & advances', 'Components', 'Bank accounts', 'Bank file format'],
  '/leave': [/^Leave Requests/, /^Team Requests/, /^Team Balances/, /^Leave Balance/, /^Holiday Calendar/],
  '/documents': ['Company documents', 'My documents', 'Employee documents'],
}

// ── The API, for the setup ──────────────────────────────────────────────────
const tokens = {}
async function signIn(identifier, password = fx.password) {
  const res = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier, password }) })
  return { status: res.status, body: await res.json() }
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
const issues = []
const visited = []
const note = (who, where, what) => { issues.push({ who, where, what }); console.log(`ISSUE  ${who} ${where}: ${what}`) }

async function settle(page) {
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined)
  await page.getByText('Loading…', { exact: true }).first().waitFor({ state: 'detached', timeout: 20_000 }).catch(() => undefined)
  await page.waitForTimeout(300)
}
/** Moves inside the app without a reload: no new session read, no sign-in limit spent. */
async function nav(page, path) {
  await page.evaluate((to) => { window.history.pushState({}, '', to); window.dispatchEvent(new PopStateEvent('popstate')) }, path)
  await settle(page)
}
/**
 * How far the page scrolls sideways — the window, or <main>, which scrolls on
 * its own (overflow-y-auto makes it scroll sideways too). A table inside its
 * own overflow-x box does not count: that box is meant to scroll.
 */
const sideways = (page) => page.evaluate(() => {
  const main = document.querySelector('main')
  return Math.max(document.documentElement.scrollWidth - window.innerWidth, main ? main.scrollWidth - main.clientWidth : 0)
})
/** What sticks out of <main> on the right, by its text — to say which part overflows. */
const overflowing = (page) => page.evaluate(() => {
  const main = document.querySelector('main')
  if (!main) return []
  const edge = main.getBoundingClientRect().right
  const out = []
  for (const el of main.querySelectorAll('*')) {
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.right <= edge + 1) continue
    // Inside a box that scrolls sideways on purpose: fine.
    let p = el.parentElement, boxed = false
    while (p && p !== main) { const s = getComputedStyle(p); if (/(auto|scroll)/.test(s.overflowX) || s.overflowX === 'hidden') { boxed = true; break } p = p.parentElement }
    if (!boxed && el.children.length === 0) out.push((el.textContent || el.tagName).trim().slice(0, 40))
  }
  return [...new Set(out)].slice(0, 6)
})
/** A visible tab of the page — a tab since the new look; the Settings menu on a computer is buttons. */
async function visibleButton(page, name) {
  const exact = typeof name === 'string'
  const all = page.locator('main').getByRole('tab', { name, exact }).or(page.locator('main').getByRole('button', { name, exact }))
  for (let i = 0; i < (await all.count()); i++) if (await all.nth(i).isVisible()) return all.nth(i)
  return null
}

async function sweep(who, email, viewportName, viewport) {
  const label = `${who}@${viewportName}`
  const ctx = await browser.newContext({ viewport })
  const page = await ctx.newPage()
  let where = 'sign-in'
  page.on('pageerror', (e) => note(label, where, `page error: ${e.message}`))
  page.on('response', (r) => {
    if (!r.url().includes('/api/')) return
    const path = r.url().split('/api')[1]
    if (r.status() >= 500) note(label, where, `${r.status()} ${r.request().method()} ${path}`)
    if (r.status() === 403) note(label, where, `403 ${r.request().method()} ${path}`)
  })
  await page.goto(`${BASE}/signin`)
  await page.getByLabel('Work Email or Employee ID').fill(email)
  await page.getByPlaceholder('Enter your password').fill(fx.password)
  await page.getByRole('button', { name: 'Sign In' }).click()
  await page.waitForURL((url) => !url.pathname.startsWith('/signin'), { timeout: 20_000 })
  await settle(page)

  // What the menu offers: read from the session's permissions the way the sidebar does — by its links.
  const menu = await ctx.newPage()
  await menu.close()
  const offered = viewportName === 'desktop'
    ? await page.locator('aside a[href], nav a[href]').evaluateAll((as) => [...new Set(as.map((a) => new URL(a.href).pathname))])
    : null
  const pages = offered ? PAGES.filter((p) => offered.includes(p) || p === '/dashboard') : sweep.offered.get(who)
  if (offered) sweep.offered.set(who, pages)

  for (const path of PAGES) {
    where = path
    await nav(page, path)
    const now = new URL(page.url()).pathname
    if (!pages.includes(path)) {
      // Not offered: the guard sends them to the dashboard, showing nothing of the page.
      if (now === path) note(label, path, `not in the menu, yet the page opened`)
      continue
    }
    if (now !== path) {
      note(label, path, `in the menu, but opening it went to ${now}`)
      continue
    }
    // A page with one tab draws no tab strip (Payroll for HR is Incentives
    // alone): it is checked as it stands.
    let tabs = [null]
    if (TABS[path]) {
      const drawn = []
      for (const tab of TABS[path]) if (await visibleButton(page, tab)) drawn.push(tab)
      if (drawn.length) tabs = drawn
    }
    for (const tab of tabs) {
      if (tab) {
        const button = await visibleButton(page, tab)
        if (!button) { note(label, path, `tab ${tab} went away`); continue }
        where = `${path} › ${tab}`
        await button.click()
        await settle(page)
      }
      const name = `${who}-${viewportName}-${path.slice(1)}${tab ? '-' + String(tab).replace(/[^a-z]+/gi, '_') : ''}`
      if (await page.locator('main').getByRole('button', { name: /^(Try again|Trying again…)$/ }).count()) note(label, where, 'shows an error state ("Try again")')
      if (viewportName === 'phone') {
        const over = await sideways(page)
        if (over > 1) note(label, where, `scrolls ${over}px sideways on a phone — ${(await overflowing(page)).join(' | ')}`)
      }
      await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true })
      visited.push(`${label} ${where}`)
    }
  }
  await ctx.close()
}
sweep.offered = new Map()

try {
  // ── Setup: the company tree, and a two-login person ─────────────────────
  for (const who of Object.keys(fx.users)) {
    const res = await signIn(fx.users[who])
    if (res.status !== 200) throw new Error(`login ${who}: ${res.status}`)
    tokens[who] = res.body.data.accessToken
  }
  const version = (await api('sa', 'GET', '/company-tree')).body.data.version
  console.log('owner', (await api('sa', 'PUT', '/company-tree/owner', { employeeId: E.sunita.id, version })).status)
  for (const [who, above] of [[E.hema, E.sunita], [E.anil, E.sunita], [E.manoj, E.sunita], [E.rekha, E.manoj]]) {
    const res = await api('sa', 'PATCH', `/employees/${who.id}`, { reportingManagerId: above.id })
    console.log(`${who.name} under ${above.name}`, res.status)
  }
  // Hema, HR, gets her employee login beside it (Day 23).
  const added = await api('sa', 'POST', `/employees/${E.hema.id}/logins`, { email: HEMA_SELF, role: 'employee' })
  console.log('Hema employee login', added.status)
  const redeemed = await fetch(`${API}/auth/password-link/redeem`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: added.body.data.invite.token, password: fx.password }) })
  console.log('…password set', redeemed.status)

  const logins = { ...fx.users, hemaSelf: HEMA_SELF }
  for (const [who, email] of Object.entries(logins)) {
    console.log(`\n── ${who} (${email}) ──`)
    await sweep(who, email, 'desktop', { width: 1366, height: 900 })
    await sweep(who, email, 'phone', { width: 390, height: 844 })
    console.log(`   menu: ${sweep.offered.get(who).join(' ')}`)
  }
} catch (err) {
  console.error(err.message)
  process.exitCode = 1
} finally {
  await browser.close()
  writeFileSync(`${DIR}/sweep23-issues.json`, JSON.stringify({ issues, visited }, null, 1))
  console.log(`\n${visited.length} page views checked · ${issues.length} issues`)
  if (issues.length) process.exitCode = 1
}
