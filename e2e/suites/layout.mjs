// Scrolling on short screens (Devesh, 9 Oct 2026): at 160% zoom — about 1200×516
// of page — the Settings menu was taller than the screen, so scrolling cut it at
// the foot, then at the top; a section chosen from halfway down opened halfway
// down; and the dark side menu cut its last pages off. Checked at that size, a
// laptop and Full HD, as the Super Admin (the longest menus) and HR, and on a phone:
// the Settings menu stays whole on screen and in one place while the page
// scrolls, every section is in reach inside it without moving the page, a
// section opens at its top with its name in view, and every page of the side
// menu fits or is in reach.
// Production build on :5183 → compiled API on :4100 → local ems_e2e, Day 20 seed.
// LAYOUT_BASE / LAYOUT_LOGINS ({"sa","hr","password"}) point it at another build.
import { chromium } from 'playwright-core'
import { mkdirSync, readFileSync } from 'node:fs'
import { WORK } from '../lib/env.mjs'

const BASE = process.env.LAYOUT_BASE || 'http://localhost:5183'
const logins = process.env.LAYOUT_LOGINS ? JSON.parse(process.env.LAYOUT_LOGINS) : (() => {
  const fx = JSON.parse(readFileSync(`${WORK}/day20-fixture.json`, 'utf8'))
  return { sa: fx.users.sa, hr: fx.users.hr, password: fx.password }
})()
const SHOTS = `${WORK}/shots/layout`
mkdirSync(SHOTS, { recursive: true })
const SIZES = { 'at 160% zoom': { width: 1200, height: 516 }, 'on a laptop': { width: 1366, height: 768 }, 'in Full HD': { width: 1920, height: 960 } }
const PHONE = { width: 390, height: 844 }
const MENU = 'nav[aria-label="Settings sections"]'

let passed = 0
const failures = []
function check(name, ok, detail = '') {
  if (ok) { passed++; console.log(`PASS  ${name}`) } else { failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`FAIL  ${name}${detail ? `  — ${detail}` : ''}`) }
}
const section = (name) => console.log(`\n── ${name}`)

const browser = await chromium.launch({ channel: 'msedge', headless: true })
const pageErrors = []
async function open(who, viewport) {
  const ctx = await browser.newContext({ viewport })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => pageErrors.push(`${who}: ${e.message}`))
  await page.goto(`${BASE}/signin`)
  await page.getByLabel('Work Email or Employee ID').fill(logins[who])
  await page.getByPlaceholder('Enter your password').fill(logins.password)
  await page.getByRole('button', { name: 'Sign In' }).click()
  await page.waitForURL((u) => !u.pathname.startsWith('/signin'), { timeout: 20_000 })
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined)
  return page
}
const settle = async (page) => { await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined); await page.waitForTimeout(300) }
const scrollPage = (page, f) => page.evaluate((f) => { const m = document.querySelector('main'); m.scrollTop = (m.scrollHeight - m.clientHeight) * f }, f)
/** Where the menu is, against the part of the page the screen shows. */
const menuBox = (page) => page.evaluate((sel) => {
  const main = document.querySelector('main').getBoundingClientRect()
  const menu = document.querySelector(sel).getBoundingClientRect()
  return { top: Math.round(menu.top), bottom: Math.round(menu.bottom), shownTop: Math.round(main.top), shownBottom: Math.round(Math.min(window.innerHeight, main.bottom)) }
}, MENU)
/**
 * The dark side menu: every page in reach (it fits, or it scrolls), the open one
 * in view, its items as tall as ever — squeezing them to fit was tried and
 * looked cramped (Devesh, 9 Oct 2026) — and a thin scrollbar when it scrolls.
 */
const sideMenu = (page) => page.evaluate(() => {
  const nav = document.querySelector('nav[aria-label="Main"]')
  const n = nav.getBoundingClientRect()
  const links = [...nav.querySelectorAll('a')]
  const open = nav.querySelector('[aria-current="page"]')
  const o = open?.getBoundingClientRect()
  return {
    count: links.length,
    cut: links.filter((a) => { const r = a.getBoundingClientRect(); return r.bottom > n.bottom + 0.5 || r.top < n.top - 0.5 }).map((a) => a.textContent.trim()),
    scrolls: nav.scrollHeight > nav.clientHeight + 1,
    openInView: !o || (o.top >= n.top - 0.5 && o.bottom <= n.bottom + 0.5),
    itemHeight: Math.round(Math.min(...links.map((a) => a.getBoundingClientRect().height))),
    thin: getComputedStyle(nav).scrollbarWidth === 'thin',
  }
})
/** The side menu at this size, then its item height on a big screen to hold it to. */
async function sideMenuNow(page, viewport) {
  const side = await sideMenu(page)
  await page.setViewportSize(SIZES['in Full HD'])
  await page.waitForTimeout(200)
  const tallest = (await sideMenu(page)).itemHeight
  await page.setViewportSize(viewport)
  await page.waitForTimeout(200)
  return { side, tallest }
}
/** The same checks, for any page and size; `tallest` is the item height on a big screen. */
function checkSideMenu(who, side, tallest) {
  check(`${who}: every one of the ${side.count} pages in the dark side menu is in reach`, side.cut.length === 0 || side.scrolls, side.cut.join(', '))
  check('…the open page in view', side.openInView)
  check('…its items as roomy as on a big screen', side.itemHeight >= tallest - 1, `${side.itemHeight}px, ${tallest}px on a big screen`)
  if (side.scrolls) check('…and where it scrolls, a thin scrollbar', side.thin)
}

try {
  for (const [size, viewport] of Object.entries(SIZES)) {
    // ═══════════════════════════════════════════════════════════════════════
    section(`The Super Admin's Settings, ${size} (${viewport.width}×${viewport.height})`)
    const sa = await open('sa', viewport)
    await sa.goto(`${BASE}/settings?tab=company`)
    await sa.locator(MENU).waitFor({ timeout: 20_000 })
    await settle(sa)

    const at = {}
    for (const [where, f] of [['top', 0], ['middle', 0.5], ['end', 1]]) {
      await scrollPage(sa, f)
      await sa.waitForTimeout(200)
      at[where] = await menuBox(sa)
      const b = at[where]
      check(`at the ${where} of the page the whole menu is on screen`, b.top >= b.shownTop && b.bottom <= b.shownBottom, JSON.stringify(b))
    }
    await sa.screenshot({ path: `${SHOTS}/${viewport.width}x${viewport.height}-end.png` })
    check('…and it does not move while the page scrolls under it', at.middle.top === at.end.top, `${at.middle.top} → ${at.end.top}`)

    // Every section in reach inside the menu, the page left where it was.
    await scrollPage(sa, 0.5)
    const pageAt = await sa.evaluate(() => document.querySelector('main').scrollTop)
    const items = sa.locator(`${MENU} button`)
    const names = await items.allInnerTexts()
    const unreachable = []
    for (let i = 0; i < names.length; i++) {
      await items.nth(i).scrollIntoViewIfNeeded()
      const ok = await sa.evaluate(([sel, i]) => {
        const menu = document.querySelector(sel); const m = menu.getBoundingClientRect()
        const r = menu.querySelectorAll('button')[i].getBoundingClientRect()
        return r.top >= m.top - 0.5 && r.bottom <= m.bottom + 0.5 && r.bottom <= window.innerHeight
      }, [MENU, i])
      if (!ok) unreachable.push(names[i].trim())
    }
    check(`all ${names.length} sections can be reached in the menu`, unreachable.length === 0, unreachable.join(', '))
    check('…without moving the page', Math.abs((await sa.evaluate(() => document.querySelector('main').scrollTop)) - pageAt) < 2)

    // A section chosen from halfway down opens at its top, its name in view in the menu.
    await scrollPage(sa, 0.6)
    await sa.locator(MENU).getByRole('button', { name: 'Audit Log' }).click()
    await settle(sa)
    check('a section chosen from halfway down opens at its top', (await sa.evaluate(() => document.querySelector('main').scrollTop)) === 0)
    const chosen = await sa.evaluate((sel) => {
      const menu = document.querySelector(sel); const m = menu.getBoundingClientRect()
      const r = menu.querySelector('[aria-current="page"]').getBoundingClientRect()
      return { name: menu.querySelector('[aria-current="page"]').textContent.trim(), inView: r.top >= m.top - 0.5 && r.bottom <= m.bottom + 0.5 }
    }, MENU)
    check('…marked in the menu, and in view there', chosen.name === 'Audit Log' && chosen.inView, JSON.stringify(chosen))
    await sa.locator(MENU).getByRole('button', { name: 'Company', exact: true }).click()
    await settle(sa)
    const back = await sa.evaluate((sel) => {
      const menu = document.querySelector(sel); const m = menu.getBoundingClientRect()
      const r = menu.querySelector('[aria-current="page"]').getBoundingClientRect()
      return r.top >= m.top - 0.5 && r.bottom <= m.bottom + 0.5
    }, MENU)
    check('…and back to the first section, it is in view too', back)

    await sa.screenshot({ path: `${SHOTS}/${viewport.width}x${viewport.height}-audit.png` })
    const saSide = await sideMenuNow(sa, viewport)
    checkSideMenu('Super Admin, on Settings', saSide.side, saSide.tallest)
    await sa.context().close()

    section(`HR's side menu, ${size}`)
    const hr = await open('hr', viewport)
    await hr.goto(`${BASE}/settings`)
    await settle(hr)
    const hrSide = await sideMenuNow(hr, viewport)
    checkSideMenu('HR, on Settings', hrSide.side, hrSide.tallest)
    await hr.context().close()
  }

  // ═══════════════════════════════════════════════════════════════════════
  section('On a phone, as before')
  const phone = await open('sa', PHONE)
  await phone.goto(`${BASE}/settings?tab=company`)
  await settle(phone)
  check('the sections are a strip of tabs, the side menu hidden', await phone.getByRole('tablist', { name: 'Settings sections' }).isVisible() && !(await phone.locator(MENU).isVisible()))
  const sideways = await phone.evaluate(() => Math.max(document.documentElement.scrollWidth - innerWidth, document.querySelector('main').scrollWidth - document.querySelector('main').clientWidth))
  check('no sideways scrolling', sideways <= 1, `${sideways}px`)
  await phone.getByRole('tab', { name: 'Audit Log' }).click()
  await settle(phone)
  check('a tab chosen opens its section', await phone.getByRole('heading', { name: /Audit/ }).first().isVisible().catch(() => false))
  await phone.screenshot({ path: `${SHOTS}/phone.png` })
  await phone.context().close()

  section('Nothing broke along the way')
  check('no page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
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
