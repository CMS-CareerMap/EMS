// Day 18 review: a company that DOES deduct TDS. The client does not, but the
// setting exists and the screens must work when it is turned on. Real Edge,
// isolated stack only, the "tds" fixture (three directives already recorded).
import { chromium } from 'playwright-core'
import { WORK, REPO, STORAGE as STORE, psql } from '../lib/env.mjs'
import { readFileSync, mkdirSync } from 'node:fs'

const BASE = 'http://localhost:5183'
const DIR = WORK
const fx = JSON.parse(readFileSync(`${DIR}/day18-tds-fixture.json`, 'utf8'))
const SHOTS = `${DIR}/shots/day18-tds`
mkdirSync(SHOTS, { recursive: true })
const E = fx.employees

const results = []
function check(label, ok, detail = '') {
  results.push({ label, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`)
  if (!ok) throw new Error(`FAILED: ${label} ${detail}`)
}

const browser = await chromium.launch({ channel: 'msedge', headless: true })
const pageErrors = []
const failedCalls = []
const tdsWrites = []

try {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } })
  // Written on 30 Sep 2026: run as on that day when FAKE_NOW says so (the API too).
  if (process.env.FAKE_NOW) await ctx.clock.setFixedTime(new Date(process.env.FAKE_NOW))
  const acc = await ctx.newPage()
  acc.on('pageerror', (e) => pageErrors.push(e.message))
  acc.on('response', (r) => { if (r.status() >= 400 && r.url().includes('/api/')) failedCalls.push(`${r.request().method()} ${r.url().split('/api')[1]} ${r.status()}`) })
  acc.on('request', (r) => { if (r.method() === 'PUT' && r.url().includes('/payroll/tds-directives')) tdsWrites.push(r.postData()) })
  await acc.goto(`${BASE}/signin`)
  await acc.getByPlaceholder('you@careermap.in or EMP001').fill(fx.users.acc)
  await acc.getByPlaceholder('Enter your password').fill(fx.password)
  await acc.getByRole('button', { name: 'Sign In' }).click()
  await acc.waitForURL('**/dashboard', { timeout: 20_000 })
  const waitToast = (text) => acc.locator('[data-sonner-toast]', { hasText: text }).first().waitFor({ timeout: 20_000 })

  // A person with no account recorded is told so, not shown a pretend one.
  await acc.getByRole('button', { name: /Anil Accountant/ }).first().click()
  await acc.getByRole('button', { name: 'My Profile' }).click()
  await acc.getByText('No bank account is recorded for your salary yet.').waitFor({ timeout: 20_000 })
  check('With no bank account on record, the profile says so', true)
  await acc.keyboard.press('Escape')

  await acc.goto(`${BASE}/payroll`)
  await acc.getByText('September 2026 — no payroll run yet').waitFor({ timeout: 20_000 })
  const blockers = await acc.locator('div.border-red-200', { hasText: 'stop' }).innerText()
  check('With TDS on, readiness stops the run for everybody without a TDS amount — and says where to enter it',
    blockers.includes('No TDS directive for Priya Deshmukh') && blockers.includes('No TDS directive for Neha Joshi') && blockers.includes('Payroll → Income tax (TDS)') && !blockers.includes('Anil Accountant'),
    blockers.replace(/\s+/g, ' '))

  await acc.getByRole('button', { name: 'Income tax (TDS)', exact: true }).click()
  await acc.getByRole('button', { name: 'Set monthly TDS' }).waitFor()
  check('The TDS tab starts on this financial year, 2026-27', (await acc.locator('select').first().inputValue()) === '2026')
  const table = await acc.locator('table').innerText()
  check('…and lists what is recorded, a ₹0 with its reason', table.includes('Anil Accountant') && table.includes('₹2,000.00') && table.includes('Below the taxable limit'))

  // Priya: ₹1,500 from September.
  await acc.getByRole('button', { name: 'Set monthly TDS' }).click()
  let d = acc.getByRole('dialog', { name: 'Monthly TDS — 2026-27' })
  await d.locator('select').first().selectOption({ label: `Priya Deshmukh (${E.priya.code})` })
  await d.locator('select').nth(1).selectOption('2026-09')
  await d.locator('input[type="number"]').fill('1500')
  await d.getByRole('button', { name: 'Save' }).click()
  await waitToast('TDS recorded')
  check('Accounts records ₹1,500 a month for Priya from September', (await acc.locator('tr', { hasText: 'Priya Deshmukh' }).innerText()).includes('₹1,500.00'))

  // Neha: ₹0 needs a reason — the form will not send one without it.
  await acc.getByRole('button', { name: 'Set monthly TDS' }).click()
  d = acc.getByRole('dialog', { name: 'Monthly TDS — 2026-27' })
  await d.locator('select').first().selectOption({ label: `Neha Joshi (${E.neha.code})` })
  await d.locator('input[type="number"]').fill('0')
  const before = tdsWrites.length
  await d.getByRole('button', { name: 'Save' }).click()
  await acc.waitForTimeout(800)
  check('A ₹0 amount without a reason is not sent', tdsWrites.length === before && (await d.isVisible()))
  await d.getByPlaceholder('For example: income below the taxable limit').fill('Below the taxable limit')
  await d.getByRole('button', { name: 'Save' }).click()
  await waitToast('TDS recorded')
  check('…with the reason it is recorded', (await acc.locator('tr', { hasText: 'Neha Joshi' }).innerText()).includes('Below the taxable limit'))
  await acc.screenshot({ path: `${SHOTS}/01-tds-tab.png`, fullPage: true })

  await acc.getByRole('button', { name: 'Payroll runs', exact: true }).click()
  await acc.getByText('September 2026 — no payroll run yet').waitFor()
  // The month's readiness is fetched again after the change; wait for it.
  const gone = await acc.locator('div.border-red-200', { hasText: 'stop' }).waitFor({ state: 'detached', timeout: 10_000 }).then(() => true, () => false)
  check('Now nothing stops the run', gone)
  const priyaRow = await acc.locator('tr', { hasText: 'Priya Deshmukh' }).innerText()
  check('Readiness shows each person’s TDS', priyaRow.includes('₹1,500.00') && (await acc.locator('th', { hasText: 'TDS' }).count()) === 1)
  await acc.getByRole('button', { name: 'Run payroll' }).click()
  await waitToast('calculated as a draft')
  await acc.locator('tr', { hasText: 'Priya Deshmukh' }).getByRole('button', { name: 'View' }).click()
  const modal = acc.getByRole('dialog', { name: 'Payslip' })
  await modal.getByText('Net pay').waitFor()
  const slip = await modal.innerText()
  check('Priya’s payslip deducts Income Tax (TDS) of ₹1,500', slip.includes('Income Tax (TDS)') && slip.includes('₹1,500.00') && !slip.includes('no income tax deducted'), slip.replace(/\s+/g, ' ').slice(0, 500))
  await acc.screenshot({ path: `${SHOTS}/02-payslip-with-tds.png`, fullPage: true })

  check('No failed API call', failedCalls.filter((c) => !/\/auth\/(session|refresh) 401$/.test(c)).length === 0, JSON.stringify(failedCalls))
  check('No page errors', pageErrors.length === 0, JSON.stringify(pageErrors))
} catch (err) {
  console.error(err.message)
  console.log('FAILED CALLS:', JSON.stringify(failedCalls))
  process.exitCode = 1
} finally {
  await browser.close()
  const failed = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - failed}/${results.length} checks passed`)
}
