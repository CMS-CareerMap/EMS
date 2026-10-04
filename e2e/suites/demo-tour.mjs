// The demo, toured as each of its logins — READ-ONLY, so the demo is the same
// afterwards. Checks that what e2e/DEMO.md promises is on the screen: the
// sidebar each role gets, every page it opens (desktop and phone), and the
// story's own items (what waits for whom, the payroll months, the handbook).
//
// Needs the demo running: `npm run demo` in another terminal, then
// `node suites/demo-tour.mjs`. Screenshots: e2e/.work/shots/demo-tour.
import { chromium } from 'playwright-core'
import { readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { BASE, WORK } from '../lib/env.mjs'

const fx = JSON.parse(readFileSync(join(WORK, 'demo-fixture.json'), 'utf8'))
const SHOTS = join(WORK, 'shots', 'demo-tour')
mkdirSync(SHOTS, { recursive: true })
const monthName = (key) => new Date(`${key}T00:00:00Z`).toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })
const PAID = monthName(fx.months.m2)
const WAITING = monthName(fx.months.m1)

const results = []
function check(label, ok, detail = '') {
  results.push({ label, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? '  — ' + detail : ''}`)
}
const section = (name) => console.log(`\n── ${name} ──`)

const browser = await chromium.launch({ channel: 'msedge', headless: true })
const problems = []
async function open(login, viewport = { width: 1366, height: 900 }) {
  const ctx = await browser.newContext({ viewport })
  await ctx.addInitScript(() => {
    window.__csp = []
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`))
  })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => problems.push(`${login}: ${e.message}`))
  page.on('response', (r) => { if (r.status() >= 500 && r.url().includes('/api/')) problems.push(`${login}: ${r.request().method()} ${r.url().split('/api')[1]} ${r.status()}`) })
  await page.goto(`${BASE}/signin`)
  await page.getByPlaceholder('you@careermap.in or EMP001').fill(login)
  await page.getByPlaceholder('Enter your password').fill(fx.password)
  await page.getByRole('button', { name: 'Sign In' }).click()
  await page.waitForURL((url) => !url.pathname.startsWith('/signin'), { timeout: 20_000 })
  return page
}
async function settle(page) {
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined)
  await page.getByText('Loading…', { exact: true }).first().waitFor({ state: 'detached', timeout: 20_000 }).catch(() => undefined)
}
async function go(page, path) {
  await page.goto(`${BASE}${path}`)
  await settle(page)
}
const main = (page) => page.locator('main').innerText()
// Visible only: a page may hold a phone layout and a desktop one, one of them hidden.
const sees = (page, text) => page.locator('main').getByText(text).filter({ visible: true }).first().waitFor({ timeout: 15_000 }).then(() => true, () => false)
const sidebar = (page) => page.locator('aside nav a').allInnerTexts().then((t) => t.map((s) => s.trim()).filter(Boolean))
const fits = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)

const PAGES = { Dashboard: '/dashboard', Employees: '/employees', Attendance: '/attendance', Leave: '/leave', Requests: '/requests', Payroll: '/payroll', 'My Payslips': '/payslips', Documents: '/documents', Reports: '/reports', Settings: '/settings' }

const ROLES = [
  { who: 'Super Admin', login: 'superadmin@example.com', menu: ['Dashboard', 'Employees', 'Attendance', 'Leave', 'Requests', 'Payroll', 'My Payslips', 'Documents', 'Reports', 'Settings'] },
  // Sunil reports to Arjun, so Leave and Requests come with deciding them.
  { who: 'Admin', login: 'admin@example.com', menu: ['Dashboard', 'Employees', 'Leave', 'Requests', 'My Payslips', 'Documents', 'Settings'] },
  { who: 'HR', login: 'hr@example.com', menu: ['Dashboard', 'Employees', 'Attendance', 'Leave', 'Requests', 'Payroll', 'My Payslips', 'Documents', 'Settings'] },
  { who: 'Accounts', login: 'accounts@example.com', menu: ['Dashboard', 'Payroll', 'My Payslips', 'Documents'] },
  { who: 'Manager', login: 'manager@example.com', menu: ['Dashboard', 'Employees', 'Attendance', 'Leave', 'Requests', 'My Payslips', 'Documents'] },
  { who: 'Reporting Manager', login: 'rm@example.com', menu: ['Dashboard', 'Employees', 'Attendance', 'Leave', 'Requests', 'My Payslips', 'Documents'] },
  { who: 'Employee', login: 'employee@example.com', menu: ['Dashboard', 'Attendance', 'Leave', 'Requests', 'My Payslips', 'Documents'] },
]

try {
  for (const role of ROLES) {
    section(`${role.who} — ${role.login}`)
    const page = await open(role.login)
    await settle(page)
    const menu = await sidebar(page)
    check(`${role.who}: the sidebar shows exactly its modules`, JSON.stringify(menu) === JSON.stringify(role.menu), menu.join(', '))
    for (const label of role.menu) {
      await go(page, PAGES[label])
      const text = await main(page)
      const csp = await page.evaluate(() => window.__csp)
      check(`${role.who}: ${label} opens — no crash, no error view`, !text.includes('This page ran into a problem') && !text.includes('This could not be loaded') && csp.length === 0, csp.join('; '))
      await page.screenshot({ path: join(SHOTS, `${role.who.replace(/\s+/g, '-').toLowerCase()}-${label.replace(/\s+/g, '-').toLowerCase()}.png`), fullPage: true })
    }
    // Pages outside the role are not reachable by address either.
    for (const [label, path] of Object.entries(PAGES).filter(([l]) => !role.menu.includes(l))) {
      await go(page, path)
      check(`${role.who}: ${label} is not theirs — sent elsewhere`, !page.url().endsWith(path), page.url())
    }
    await page.context().close()

    const phone = await open(role.login, { width: 390, height: 844 })
    let fitting = true
    for (const label of role.menu) {
      await go(phone, PAGES[label])
      if (!(await fits(phone))) { fitting = false; console.log(`   ${label} is wider than a phone`) }
    }
    check(`${role.who}: every page fits a phone`, fitting)
    await phone.context().close()
  }

  section('The story, as each person sees it')
  const priya = await open('employee@example.com')
  await go(priya, '/dashboard')
  check('Priya has not checked in yet: Check In is offered', await priya.getByRole('button', { name: /Check In/ }).first().isVisible().catch(() => false))
  await go(priya, '/payslips')
  check(`Priya has her ${PAID} payslip`, await sees(priya, PAID))
  check(`…and not ${WAITING}'s, which is not paid yet`, !(await main(priya)).includes(WAITING))
  await go(priya, '/documents')
  // Her own files open first; the company's are the other tab.
  await priya.getByRole('tab', { name: 'Company documents' }).or(priya.getByRole('button', { name: 'Company documents' })).first().click()
  check('Priya finds the Employee Handbook under Company documents', await sees(priya, 'Employee Handbook'))
  await go(priya, '/requests')
  check('Priya’s attendance correction is in her requests', await sees(priya, /correction/i))
  await priya.context().close()

  const byCode = await open('CMS007')
  check('Priya signs in with her employee code CMS007', !byCode.url().includes('/signin'))
  await byCode.context().close()

  const rekha = await open('rm@example.com')
  await go(rekha, '/requests?tab=decide')
  check('Rekha decides Priya’s correction', await sees(rekha, 'Priya Deshmukh'))
  check('…and Ravi’s work from home', await sees(rekha, 'Ravi Patil'))
  await go(rekha, '/leave?tab=decide')
  check('Rekha decides Sneha’s leave', await sees(rekha, 'Sneha Kulkarni'))
  await rekha.context().close()

  const manoj = await open('manager@example.com')
  await go(manoj, '/dashboard')
  check('Manoj’s dashboard shows Amit’s resignation waiting', await sees(manoj, /resignation.* waiting for you/))
  check('…by name', await sees(manoj, 'Amit Verma'))
  await go(manoj, '/leave?tab=decide')
  check('Manoj decides Vikram’s leave', await sees(manoj, 'Vikram Singh'))
  check('…and Rekha’s', await sees(manoj, 'Rekha Rao'))
  await go(manoj, '/requests?tab=decide')
  check('Manoj decides Vikram’s on-duty day', await sees(manoj, 'Vikram Singh'))
  await manoj.context().close()

  const hema = await open('hr@example.com')
  await go(hema, '/requests?tab=decide')
  check('HR decides Sneha’s change of details', await sees(hema, 'Sneha Kulkarni'))
  await go(hema, '/employees')
  check('HR sees Neha, who joined this month', await sees(hema, 'Neha Gupta'))
  await hema.context().close()

  const anil = await open('accounts@example.com')
  await go(anil, '/payroll')
  const runs = await main(anil)
  check(`Accounts sees ${PAID} paid`, runs.includes(PAID) && runs.includes('Paid'))
  check(`…and ${WAITING} calculated, waiting`, runs.includes(WAITING) && runs.includes('Draft'))
  await anil.context().close()

  const rahul = await open('superadmin@example.com')
  await go(rahul, '/leave?tab=decide')
  check('Rahul decides Manoj’s leave', await sees(rahul, 'Manoj Sharma'))
  await rahul.context().close()

  const arjunSelf = await open('arjun@example.com')
  const own = await sidebar(arjunSelf)
  check('Arjun’s own login is for his own things: no Employees', !own.includes('Employees'), own.join(', '))
  await arjunSelf.context().close()

  section('Nothing went wrong underneath')
  check('no page error and no server error on the whole tour', problems.length === 0, problems.slice(0, 5).join(' | '))
} finally {
  await browser.close()
}

const failed = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failed}/${results.length} passed`)
if (failed) process.exitCode = 1
