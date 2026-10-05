// Labour Codes wages rule E2E — Settings → Payroll Config, and the payslip
// that follows, on a desktop and on a 390px phone.
// Production build on :5183 → compiled API on :4100 → local ems_e2e.
// Fixture: the Day 20 seed (reset20.sh), fresh. Priya earns ₹17,000 a month,
// Basic ₹12,000 (70%), so at 80% her PF wages are raised.
import { chromium } from 'playwright-core'
import { WORK, REPO, STORAGE as STORE, psql } from '../lib/env.mjs'
import { openMyProfile, openEmployeeProfile, signOutVia, menuLinks, menuLink } from '../lib/ui.mjs'
import { readFileSync, mkdirSync } from 'node:fs'

const BASE = 'http://localhost:5183'
const API = `${BASE}/api`
const DIR = WORK
const fx = JSON.parse(readFileSync(`${DIR}/day20-fixture.json`, 'utf8'))
const SHOTS = `${DIR}/shots/wages-share`
mkdirSync(SHOTS, { recursive: true })
const E = fx.employees

const results = []
function check(label, ok, detail = '') {
  results.push({ label, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`)
  if (!ok) throw new Error(`FAILED: ${label} ${detail}`)
}
const section = (name) => console.log(`\n── ${name} ──`)

const tokens = {}
async function login(who) {
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: fx.users[who], password: fx.password }),
  })
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
const sideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)

let runId = null
try {
  for (const who of ['sa', 'acc', 'hr']) await login(who)

  section('Settings → Payroll Config')
  const sa = await open('sa')
  await sa.goto(`${BASE}/settings?tab=payroll`)
  await settle(sa)
  await sa.getByText('Labour Codes: Wages Rule').waitFor({ timeout: 20_000 })
  const toggle = sa.getByRole('switch', { name: 'Apply the Labour Codes wages rule' })
  const percent = sa.getByLabel('Minimum share of wages in percent')
  check('the rule starts off, at one half', !(await toggle.isChecked()) && (await percent.inputValue()) === '50')
  await toggle.click()
  await percent.fill('80')
  check('the hint works its example out at the share typed', await sa.getByText('pays PF on ₹24,000').isVisible())
  await shot(sa, '01-settings-on-80')
  await sa.getByRole('button', { name: 'Save Changes' }).first().click()
  await sa.getByRole('button', { name: 'Saved' }).first().waitFor({ timeout: 20_000 })
  const policy = (await api('sa', 'GET', '/settings/payroll')).body.data
  check('saved: on, at 80%', policy.wages_share_enabled === true && policy.wages_share_percent === 80, JSON.stringify(policy).slice(0, 200))
  check('HR cannot change it', (await api('hr', 'PUT', '/settings/payroll', { wagesShareEnabled: false })).status === 403)
  check('nor can anybody set no share at all', (await api('sa', 'PUT', '/settings/payroll', { wagesSharePercent: 0 })).status === 422)

  check('the screen says from which month it applies', await sa.getByText('a change applies from the next month’s payroll').isVisible())
  // A month is worked out on the rules in force on its first day: saved today,
  // the rule reaches next month. Here it is moved back to 1 September, as if
  // the Super Admin had turned it on before September began.
  psql(`UPDATE "OrganizationPolicy" SET "effectiveTo" = DATE '2026-08-31' WHERE "organizationId" = '${fx.organizationId}' AND "effectiveTo" IS NOT NULL;
        UPDATE "OrganizationPolicy" SET "effectiveFrom" = DATE '2026-09-01' WHERE "organizationId" = '${fx.organizationId}' AND "effectiveTo" IS NULL;`)

  section('September’s payroll')
  const created = await api('acc', 'POST', '/payroll-runs', { year: 2026, month: 9 })
  check('Accounts runs September', created.status === 201, JSON.stringify(created.body).slice(0, 200))
  runId = created.body.data.id
  const acc = await open('acc')
  await acc.goto(`${BASE}/payroll?tab=runs`)
  await settle(acc)
  await acc.getByText('September 2026 payroll').waitFor({ timeout: 20_000 })
  await acc.locator('tr', { hasText: 'Priya Deshmukh' }).getByRole('button', { name: 'View' }).click()
  const modal = acc.getByRole('dialog', { name: 'Payslip' })
  await modal.getByText('Net pay').waitFor({ timeout: 20_000 })
  const text = await modal.innerText()
  check('her payslip says PF wages were raised, from what, and to which share',
    /PF wages ₹[\d,.]+: raised from ₹[\d,.]+ to 80% of gross earned, under the Labour Codes wages rule\./.test(text), text.replace(/\s+/g, ' ').slice(-400))
  await shot(acc, '02-payslip-raised')
  await modal.getByRole('button', { name: 'Close' }).click()

  const run = (await api('acc', 'GET', `/payroll-runs/${runId}`)).body.data
  const slip = run.payslips.find((p) => p.employee_id === E.priya.id)
  const detail = (await api('acc', 'GET', `/payroll-runs/${runId}/payslips/${slip.id}`)).body.data
  const share = detail.basis.wagesShare
  check('PF is worked out on 80% of what she earned', Math.abs(share.raisedTo - detail.gross_earnings * 0.8) < 0.01 && detail.pf_wages === share.raisedTo && share.wages < share.raisedTo, JSON.stringify(share))
  const pfLine = detail.deductions.find((l) => l.code === 'PF')
  check('…and her PF line is 12% of that', pfLine.amount === Math.round(share.raisedTo * 0.12), `${pfLine.amount} vs ${share.raisedTo}`)
  // Sunita's Basic is above the ceiling already: the rule changes her PF wages on paper, not her PF.
  const sunita = run.payslips.find((p) => p.employee_id === E.sunita.id)
  const sunitaDetail = (await api('acc', 'GET', `/payroll-runs/${runId}/payslips/${sunita.id}`)).body.data
  check('the wage ceiling still holds', sunitaDetail.pf_wages <= 25_000, String(sunitaDetail.pf_wages))

  section('On a phone')
  const saPhone = await open('sa', PHONE)
  await saPhone.goto(`${BASE}/settings?tab=payroll`)
  await settle(saPhone)
  await saPhone.getByText('Labour Codes: Wages Rule').waitFor({ timeout: 20_000 })
  await saPhone.getByText('Labour Codes: Wages Rule').scrollIntoViewIfNeeded()
  check('Payroll Config with the rule fits the phone', (await sideways(saPhone)) <= 0, `${await sideways(saPhone)}px`)
  await shot(saPhone, '03-phone-settings')
  const accPhone = await open('acc', PHONE)
  await accPhone.goto(`${BASE}/payroll?tab=runs`)
  await settle(accPhone)
  // On a phone the run's payslips are a list, a card each, not the table.
  await accPhone.getByRole('list', { name: 'Payslips' }).getByRole('listitem').filter({ hasText: 'Priya Deshmukh' }).getByRole('button', { name: 'View' }).click()
  const phoneModal = accPhone.getByRole('dialog', { name: 'Payslip' })
  await phoneModal.getByText('raised from').waitFor({ timeout: 20_000 })
  check('the payslip with the line fits the phone', (await sideways(accPhone)) <= 0, `${await sideways(accPhone)}px`)
  await shot(accPhone, '04-phone-payslip')

  section('Turned off again')
  check('the rule goes off today', (await api('sa', 'PUT', '/settings/payroll', { wagesShareEnabled: false, wagesSharePercent: 50 })).status === 200)
  check('September recalculates', (await api('acc', 'POST', `/payroll-runs/${runId}/recalculate`)).status === 200)
  const again = (await api('acc', 'GET', `/payroll-runs/${runId}`)).body.data.payslips.find((p) => p.employee_id === E.priya.id)
  // Off from today, so from next month: September keeps the rule it began under.
  check('…and keeps the rule: a change reaches the next month, never one already begun',
    (await api('acc', 'GET', `/payroll-runs/${runId}/payslips/${again.id}`)).body.data.basis.wagesShare?.percent === 80)
  const history = (await api('sa', 'GET', '/settings/payroll/history')).body.data
  check('the history shows the period it was on, and that it is off now',
    history.some((p) => p.wages_share_enabled && p.wages_share_percent === 80 && p.effective_to) && history.some((p) => !p.effective_to && !p.wages_share_enabled), JSON.stringify(history.map((p) => [p.effective_from, p.effective_to, p.wages_share_enabled])))

  section('What counts as PF wages')
  // Hema: Basic ₹20,000, HRA ₹8,000, Special Allowance ₹2,000.
  const hemaWages = async () => {
    const slips = (await api('acc', 'GET', `/payroll-runs/${runId}`)).body.data.payslips
    const id = slips.find((p) => p.employee_id === E.hema.id).id
    const d = (await api('acc', 'GET', `/payroll-runs/${runId}/payslips/${id}`)).body.data
    return { wages: d.basis.wagesShare?.wages ?? d.pf_wages, paid: d.paid_days }
  }
  const start = await hemaWages()
  // Her Basic for the days paid (half a day of hers was loss of pay).
  check('her PF wages are her Basic alone, to start', Math.abs(start.wages - (20_000 * start.paid) / 30) < 0.01, JSON.stringify(start))
  await sa.goto(`${BASE}/settings?tab=payroll`)
  await settle(sa)
  const special = sa.getByRole('switch', { name: 'Special Allowance counts as PF wages' })
  await special.waitFor({ timeout: 20_000 })
  check('Payroll Config lists the earnings: Basic counted, Special Allowance not',
    await sa.getByRole('switch', { name: 'Basic counts as PF wages' }).isChecked() && !(await special.isChecked()))
  await special.click()
  await sa.locator('[data-sonner-toast]', { hasText: 'Special Allowance now counts as PF wages' }).first().waitFor({ timeout: 20_000 })
  check('the switch stays on after a reload', await (async () => { await sa.reload(); await settle(sa); return special.isChecked() })())
  await shot(sa, '05-pf-components')
  check('September recalculates', (await api('acc', 'POST', `/payroll-runs/${runId}/recalculate`)).status === 200)
  const now = await hemaWages()
  check('…and her PF wages now include her Special Allowance', Math.abs(now.wages - (22_000 * now.paid) / 30) < 0.01, JSON.stringify(now))
  check('HR cannot change it', (await api('hr', 'PATCH', `/settings/pf-components/${(await api('sa', 'GET', '/settings/pf-components')).body.data.find((c) => c.code === 'SPECIAL').id}`, { countsForPf: false })).status === 403)
  const phone = await open('sa', PHONE)
  await phone.goto(`${BASE}/settings?tab=payroll`)
  await settle(phone)
  await phone.getByRole('switch', { name: 'Special Allowance counts as PF wages' }).scrollIntoViewIfNeeded()
  check('the list fits the phone', (await sideways(phone)) <= 0, `${await sideways(phone)}px`)
  await shot(phone, '06-phone-pf-components')

  section('Pension (EPS) membership, recorded on the person')
  const hrPage = await open('hr')
  // His profile page (a drawer before the new look), on its Statutory tab.
  const drawer = await openEmployeeProfile(hrPage, BASE, 'Ravi Patil', 'Statutory')
  await drawer.getByText('Worked out by payroll from the joining salary').waitFor({ timeout: 20_000 })
  check('left blank, payroll works it out', true)
  await hrPage.getByRole('button', { name: 'Edit', exact: true }).click()
  await hrPage.getByLabel('Pension (EPS) member').selectOption('yes')
  await hrPage.getByRole('button', { name: 'Save Changes' }).click()
  await hrPage.getByText('Edit Employee').waitFor({ state: 'detached', timeout: 20_000 })
  await drawer.getByText('Member', { exact: true }).waitFor({ timeout: 20_000 })
  const ravi = (await api('hr', 'GET', `/employees/${E.ravi.id}`)).body.data
  check('HR records him as an EPS member, from his PF record', ravi.eps_member === true && (await drawer.innerText()).includes('Pension (EPS)'), String(ravi.eps_member))
  await shot(hrPage, '07-eps-recorded')

  section('Nothing broke along the way')
  check('no page errors', pageErrors.length === 0, pageErrors.join(' | '))
  check('no server errors', serverErrors.length === 0, serverErrors.join(' | '))
} catch (err) {
  console.error(err.message)
  process.exitCode = 1
} finally {
  if (runId) await api('acc', 'DELETE', `/payroll-runs/${runId}`).catch(() => undefined)
  await browser.close()
  const passed = results.filter((r) => r.ok).length
  console.log(`\n${passed}/${results.length} checks passed`)
}
