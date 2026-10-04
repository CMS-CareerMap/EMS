// Day 18 review: the screens the first E2E did not exercise. Real Edge against
// the isolated stack (Vite :5183 → API :4100 → local ems_e2e), the "review"
// fixture: everybody paid a salary, bank accounts on record (Hema rejected,
// Anil not checked), and a paid run from June 2025.
import { chromium } from 'playwright-core'
import { WORK, REPO, STORAGE as STORE, psql } from '../lib/env.mjs'
import { readFileSync, mkdirSync } from 'node:fs'

const BASE = 'http://localhost:5183'
const DIR = WORK
const fx = JSON.parse(readFileSync(`${DIR}/day18-review-fixture.json`, 'utf8'))
const SHOTS = `${DIR}/shots/day18b`
const DL = `${DIR}/downloads-day18b`
mkdirSync(SHOTS, { recursive: true })
mkdirSync(DL, { recursive: true })
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

async function open(who, viewport = { width: 1366, height: 900 }) {
  const ctx = await browser.newContext({ viewport, acceptDownloads: true })
  // Written on 30 Sep 2026: run as on that day when FAKE_NOW says so (the API too).
  if (process.env.FAKE_NOW) await ctx.clock.setFixedTime(new Date(process.env.FAKE_NOW))
  const page = await ctx.newPage()
  page.on('pageerror', (e) => pageErrors.push(`${who}: ${e.message}`))
  page.on('response', (r) => {
    if (r.status() >= 400 && r.url().includes('/api/')) failedCalls.push(`${who} ${r.request().method()} ${r.url().split('/api')[1]} ${r.status()}`)
  })
  await page.goto(`${BASE}/signin`)
  await page.getByPlaceholder('you@careermap.in or EMP001').fill(fx.users[who])
  await page.getByPlaceholder('Enter your password').fill(fx.password)
  await page.getByRole('button', { name: 'Sign In' }).click()
  await page.waitForURL('**/dashboard', { timeout: 20_000 })
  return page
}

const waitToast = (page, text) => page.locator('[data-sonner-toast]', { hasText: text }).first().waitFor({ timeout: 20_000 })
const shot = (page, name) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true })
const tab = (page, name) => page.getByRole('button', { name, exact: true }).click()
async function download(page, trigger, name) {
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), trigger()])
  const path = `${DL}/${name}`
  await dl.saveAs(path)
  return { name: dl.suggestedFilename(), bytes: readFileSync(path) }
}

try {
  const acc = await open('acc')
  const hr = await open('hr')
  const admin = await open('admin')

  // ── Older runs stay reachable ─────────────────────────────────────────────
  await acc.goto(`${BASE}/payroll`)
  const june = acc.getByRole('button', { name: /June 2025\s*Paid/ })
  await june.waitFor({ timeout: 20_000 })
  check('A paid run from June 2025 — fifteen months back — is still in the month list', true)
  await june.click()
  await acc.getByText('June 2025 payroll').waitFor()
  check('…and opens', (await acc.locator('main').innerText()).includes('Paid'))
  await acc.getByRole('button', { name: /September 2026\s*No run/ }).click()
  await acc.getByText('September 2026 — no payroll run yet').waitFor()

  // ── A bank account whose number changes is no longer verified ────────────
  await tab(acc, 'Bank accounts')
  await acc.getByRole('button', { name: "Edit Ravi Patil's bank account" }).click()
  const edit = acc.getByRole('dialog', { name: 'Edit bank account — Ravi Patil' })
  await edit.locator('label').filter({ has: acc.getByText('Account number', { exact: true }) }).locator('input').fill('004455667700')
  await edit.locator('label', { hasText: 'Account number again' }).locator('input').fill('004455667700')
  check('Editing a verified account’s number warns it must be checked again', await edit.getByText('Changing the account number or IFSC means it has to be checked again.').isVisible())
  await edit.getByRole('button', { name: 'Save' }).click()
  await waitToast(acc, "Ravi Patil's bank account saved")
  check('…and it is waiting for a check once saved', (await acc.locator('tr', { hasText: 'Ravi Patil' }).innerText()).includes('Waiting for a check'))
  await acc.getByRole('button', { name: "Edit Priya Deshmukh's bank account" }).click()
  await acc.keyboard.press('Escape')
  await acc.getByRole('dialog', { name: 'Edit bank account — Priya Deshmukh' }).waitFor({ state: 'detached', timeout: 5_000 })
  check('Escape closes a dialog', true)

  // ── Incentives: add, change, remove ──────────────────────────────────────
  await hr.goto(`${BASE}/payroll`)
  await hr.getByRole('button', { name: 'Add incentive' }).waitFor()
  for (const [who, amount] of [['Priya Deshmukh', '5000'], ['Neha Joshi', '1000']]) {
    await hr.getByRole('button', { name: 'Add incentive' }).click()
    const d = hr.getByRole('dialog', { name: 'Add incentive — September 2026' })
    const code = who === 'Priya Deshmukh' ? E.priya.code : E.neha.code
    await d.locator('select').first().selectOption({ label: `${who} (${code})` })
    await d.locator('input[type="number"]').fill(amount)
    await d.getByRole('button', { name: 'Save' }).click()
    await waitToast(hr, 'Saved for September 2026')
  }
  await hr.getByRole('button', { name: "Change Priya Deshmukh's Incentive" }).click()
  let change = hr.getByRole('dialog', { name: 'Change incentive — September 2026' })
  check('Changing an incentive opens it with the person fixed and the amount filled in',
    (await change.locator('input[disabled]').first().inputValue()).includes('Priya Deshmukh') && (await change.locator('input[type="number"]').inputValue()) === '5000')
  await change.locator('input[type="number"]').fill('6000')
  await change.getByRole('button', { name: 'Save' }).click()
  await waitToast(hr, 'Saved for September 2026')
  await hr.locator('tr', { hasText: 'Priya Deshmukh' }).getByText('₹6,000.00').waitFor()
  check('…and the new amount replaces the old one', (await hr.locator('tr', { hasText: 'Priya Deshmukh' }).count()) === 1)
  await hr.getByRole('button', { name: "Remove Neha Joshi's Incentive" }).click()
  await hr.getByRole('dialog', { name: "Remove Neha Joshi's incentive?" }).getByRole('button', { name: 'Remove' }).click()
  await waitToast(hr, 'Removed')
  await hr.locator('tr', { hasText: 'Neha Joshi' }).waitFor({ state: 'detached', timeout: 10_000 })
  check('Removing an incentive takes it off the month', true)

  // ── A draft: recalculate, discard, run again ─────────────────────────────
  await tab(acc, 'Payroll runs')
  await acc.getByRole('button', { name: 'Run payroll' }).click()
  await waitToast(acc, 'calculated as a draft')
  await acc.getByRole('button', { name: 'Recalculate' }).click()
  await waitToast(acc, 'September 2026 recalculated from the records as they stand')
  check('A draft recalculates', true)
  await acc.getByRole('button', { name: 'Discard' }).click()
  await acc.getByRole('dialog', { name: 'Discard the September 2026 draft?' }).getByRole('button', { name: 'Discard' }).click()
  await waitToast(acc, 'The September 2026 draft was discarded')
  await acc.getByText('September 2026 — no payroll run yet').waitFor()
  // Held while the month is checked again, then free.
  let enabled = false
  for (let i = 0; i < 50 && !enabled; i++) {
    enabled = await acc.getByRole('button', { name: 'Run payroll' }).isEnabled()
    if (!enabled) await acc.waitForTimeout(200)
  }
  check('A discarded draft is gone, and the month can be run again', enabled)
  await acc.getByRole('button', { name: 'Run payroll' }).click()
  await waitToast(acc, 'calculated as a draft')
  await acc.getByText('September 2026 payroll').waitFor()

  // ── The records change after the draft: approval says so ─────────────────
  await hr.getByRole('button', { name: "Change Priya Deshmukh's Incentive" }).click()
  change = hr.getByRole('dialog', { name: 'Change incentive — September 2026' })
  await change.locator('input[type="number"]').fill('7000')
  await change.getByRole('button', { name: 'Save' }).click()
  await waitToast(hr, 'Saved for September 2026')

  await admin.goto(`${BASE}/payroll`)
  await admin.getByText('September 2026 payroll').waitFor({ timeout: 20_000 })
  await admin.getByRole('button', { name: 'Approve', exact: true }).click()
  let ask = admin.getByRole('dialog', { name: 'Approve September 2026' })
  await ask.getByRole('button', { name: 'Approve', exact: true }).click()
  await ask.getByText('have changed since it was calculated').waitFor({ timeout: 20_000 })
  const changedText = await ask.innerText()
  check('Approving after the records changed names who changed, in words', changedText.includes('Priya Deshmukh: ') && changedText.includes('net pay') && changedText.includes('gross') && changedText.includes('incentive') && !changedText.includes('INCENTIVE'), changedText.replace(/\s+/g, ' ').slice(0, 300))
  await shot(admin, '01-approve-records-changed')
  await ask.getByRole('button', { name: 'Recalculate now' }).click()
  await waitToast(admin, 'recalculated — check the figures, then approve')
  check('"Recalculate now" brings the draft up to date without leaving the dialog', await ask.getByRole('button', { name: 'Approve', exact: true }).isVisible())
  check('…the run now carries the new incentive', (await admin.locator('tr', { hasText: 'Priya Deshmukh' }).innerText()).includes('₹35,000.00'))
  await ask.getByRole('button', { name: 'Approve', exact: true }).click()
  await ask.getByRole('button', { name: /^Approve, accepting \d+ days$/ }).click()
  await waitToast(admin, 'September 2026 approved')
  await admin.getByRole('button', { name: 'Reopen' }).waitFor()
  check('…and then approves', true)

  // ── The bank file with verified-only off, and a payment date column ──────
  // Paying unchecked accounts is the Super Admin's call (final audit, 4 Oct):
  // Accounts, who enters accounts, may not switch the check off.
  await acc.goto(`${BASE}/payroll?tab=bank-format`)
  await acc.getByText('Columns, in order').waitFor()
  await acc.getByRole('checkbox', { name: /Pay verified accounts only/ }).uncheck()
  await acc.getByRole('button', { name: 'Save format' }).click()
  await waitToast(acc, 'Only the Super Admin can let the bank file pay into accounts nobody has checked')
  check('Accounts cannot switch off "verified accounts only" — the Super Admin can', true)
  await admin.goto(`${BASE}/payroll?tab=bank-format`)
  await admin.getByText('Columns, in order').waitFor()
  await admin.getByRole('checkbox', { name: /Pay verified accounts only/ }).uncheck()
  await admin.getByRole('button', { name: 'Add a column' }).click()
  await admin.getByLabel('Column 8 heading').fill('Value Date')
  await admin.getByLabel('Column 8 holds').selectOption('pay_date')
  await admin.getByRole('button', { name: 'Save format' }).click()
  await waitToast(admin, 'Bank file format saved')
  await acc.goto(`${BASE}/payroll?tab=runs`)

  await tab(acc, 'Payroll runs')
  await acc.getByText('September 2026 payroll').waitFor()
  await acc.getByRole('button', { name: 'Bank file', exact: true }).click()
  const bank = acc.getByRole('dialog', { name: 'Bank transfer file' })
  await bank.getByText('3 payments').waitFor({ timeout: 20_000 })
  const bankText = await bank.innerText()
  check('With "verified only" off, unchecked accounts are paid too — a rejected one never is',
    bankText.includes('ANIL A') && bankText.includes('RAVI PATIL') && bankText.includes('Hema Hiremath') && bankText.includes('Bank account was rejected') && bankText.includes('No bank account on record'),
    bankText.replace(/\s+/g, ' ').slice(0, 400))
  await bank.locator('input[type="date"]').fill('2026-09-30')
  await bank.getByText('3 payments').waitFor()
  const csv = await download(acc, () => bank.getByRole('button', { name: 'Download CSV' }).click(), 'bank.csv')
  const lines = csv.bytes.toString('utf8').replace(/^\uFEFF/, '').split('\r\n').filter(Boolean)
  check('The chosen payment date is in the file, in the company’s date format', lines[0].endsWith(',Value Date') && lines.slice(1).every((l) => l.endsWith(',30/09/2026')), lines.join(' | '))
  check('…and Ravi is paid to his new account number', lines.some((l) => l.includes('RAVI PATIL,004455667700,')))
  await acc.keyboard.press('Escape')
  await bank.waitFor({ state: 'detached', timeout: 5_000 })

  await acc.getByRole('button', { name: 'Mark as paid' }).click()
  const paid = acc.getByRole('dialog', { name: 'Mark September 2026 as paid' })
  await paid.locator('input[type="date"]').fill('2026-09-27')
  await paid.getByRole('button', { name: 'Mark as paid' }).click()
  await waitToast(acc, 'marked as paid')
  await acc.getByText('Paid on 27 Sep 2026').waitFor({ timeout: 30_000 })

  // ── Hema: her payslip, and why her account was rejected ──────────────────
  await hr.goto(`${BASE}/payslips`)
  await hr.locator('tr', { hasText: 'September 2026' }).waitFor({ timeout: 20_000 })
  check('HR sees their own September payslip', (await hr.locator('tr', { hasText: 'September 2026' }).innerText()).includes('₹27,400.00'))
  await hr.getByRole('button', { name: /Hema Hiremath/ }).first().click()
  await hr.getByRole('button', { name: 'My Profile' }).click()
  await hr.getByText('Why it was rejected').waitFor({ timeout: 20_000 })
  const hemaCard = await hr.locator('div.space-y-3', { has: hr.getByText('Bank Account for Salary Credit', { exact: true }) }).last().innerText()
  check('…and in her profile, that her account was rejected and why', hemaCard.includes('Rejected') && hemaCard.includes('Name does not match the cheque') && hemaCard.includes('•••• 5544'))

  // ── On a phone ───────────────────────────────────────────────────────────
  const phone = await open('emp', { width: 390, height: 844 })
  await phone.goto(`${BASE}/payslips`)
  await phone.locator('li', { hasText: 'September 2026' }).waitFor({ timeout: 20_000 })
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  check('My Payslips fits a phone: the page itself does not scroll sideways', overflow <= 0, `overflow ${overflow}px`)
  const pdfBox = await phone.locator('li', { hasText: 'September 2026' }).getByRole('button', { name: 'PDF' }).boundingBox()
  const netVisible = await phone.locator('li', { hasText: 'September 2026' }).getByText('₹32,560.00').isVisible()
  check('…with the net pay and the PDF button on screen, not off to the side', netVisible && pdfBox && pdfBox.x + pdfBox.width <= 390, JSON.stringify(pdfBox))
  await shot(phone, '02-my-payslips-phone')
  const own = await download(phone, () => phone.getByRole('button', { name: 'PDF' }).click(), 'phone-payslip.pdf')
  check('…and the PDF downloads there too', own.bytes.subarray(0, 4).toString() === '%PDF')

  const asked = failedCalls.filter((c) => /POST \/payroll-runs\/[^/]+\/approve 422$/.test(c))
  // Accounts switching off "verified accounts only" is refused on purpose (above).
  const refusedOnPurpose = failedCalls.filter((c) => c === 'acc PUT /payroll/bank-file-template 403')
  const unexpected = failedCalls.filter((c) => !asked.includes(c) && !refusedOnPurpose.includes(c) && !/\/auth\/(session|refresh) 401$/.test(c))
  check('No failed API call except the approvals that answered in the dialog, and the refusal asked for',
    unexpected.length === 0 && asked.length === 2 && refusedOnPurpose.length === 1, JSON.stringify(failedCalls))
  check('No page errors', pageErrors.length === 0, JSON.stringify(pageErrors))
} catch (err) {
  console.error(err.message)
  console.log('FAILED CALLS:', JSON.stringify(failedCalls))
  console.log('PAGE ERRORS:', JSON.stringify(pageErrors))
  process.exitCode = 1
} finally {
  await browser.close()
  const failed = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - failed}/${results.length} checks passed`)
}
