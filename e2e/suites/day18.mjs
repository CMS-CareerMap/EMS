// Day 18 end to end in a real browser (system Edge) against the isolated stack:
// Vite :5183 → API :4100 → local ems_e2e. Never :4000/:5173 or Neon.
//
// Accounts sets a salary, records and checks bank accounts and the bank file's
// layout; HR enters an incentive; Accounts runs September; the Super Admin
// approves (confirming the days paid on no record), reopens and approves again;
// Accounts takes the bank file and marks the run paid; the employee downloads
// their payslip and sees where their salary goes.
import { chromium } from 'playwright-core'
import { WORK, REPO, STORAGE as STORE, psql } from '../lib/env.mjs'
// Today on the company's clock, as the app writes a day: "30 Sep 2026".
const todayIso = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date())
const todayLabel = `${Number(todayIso.slice(8, 10))} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][Number(todayIso.slice(5, 7)) - 1]} ${todayIso.slice(0, 4)}`
import { readFileSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'

const BASE = 'http://localhost:5183'
const DIR = WORK
const fx = JSON.parse(readFileSync(`${DIR}/day18-fixture.json`, 'utf8'))
const SHOTS = `${DIR}/shots/day18`
const DL = `${DIR}/downloads-day18`
mkdirSync(SHOTS, { recursive: true })
mkdirSync(DL, { recursive: true })

const E = fx.employees
const results = []
function check(label, ok, detail = '') {
  results.push({ label, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`)
  if (!ok) throw new Error(`FAILED: ${label} ${detail}`)
}
const sha = (b) => createHash('sha256').update(b).digest('hex')

const browser = await chromium.launch({ channel: 'msedge', headless: true })
const pageErrors = []
const failedCalls = []

async function open(who) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, acceptDownloads: true })
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
const errorToasts = (page) => page.locator('[data-sonner-toast][data-type="error"]').allInnerTexts()
const shot = (page, name) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true })
const tab = (page, name) => page.getByRole('button', { name, exact: true }).click()

async function download(page, trigger, name) {
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), trigger()])
  const path = `${DL}/${name}`
  await dl.saveAs(path)
  return { name: dl.suggestedFilename(), bytes: readFileSync(path) }
}

const FAKE = ['Generated', 'GSTIN', 'MH/BOM', 'XXXXXXXX5678', 'CANCELLED CHEQUE', 'estimate']
async function noFabrications(page, where) {
  const text = await page.locator('main').innerText()
  const found = FAKE.filter((f) => text.includes(f))
  check(`${where}: nothing fabricated on screen (no "Generated" badge, GSTIN, made-up PF number)`, found.length === 0, found.join(', '))
}

try {
  // ── 1. Accounts ────────────────────────────────────────────────────────────
  const acc = await open('acc')
  const accNav = await acc.locator('aside').innerText()
  check('Accounts: the sidebar has Payroll and My Payslips, not Employees', accNav.includes('Payroll') && accNav.includes('My Payslips') && !accNav.includes('Employees'), accNav.replace(/\n/g, ' | '))

  await acc.goto(`${BASE}/payroll`)
  await acc.getByRole('button', { name: 'Payroll runs', exact: true }).waitFor({ timeout: 20_000 })
  for (const t of ['Payroll runs', 'Salary structure', 'Incentives', 'Income tax (TDS)', 'Bank accounts', 'Bank file format']) {
    check(`Accounts sees the "${t}" tab`, await acc.getByRole('button', { name: t, exact: true }).isVisible())
  }

  // Readiness: Neha has no salary, so the run cannot start.
  await acc.getByText('September 2026 — no payroll run yet').waitFor({ timeout: 20_000 })
  const blockers = acc.locator('div.border-red-200', { hasText: 'stops' })
  await blockers.waitFor()
  check('Readiness names what stops the run: Neha has no salary', (await blockers.innerText()).includes('No salary is on record for Neha Joshi'))
  check('…and "Run payroll" cannot be pressed until it is fixed', await acc.getByRole('button', { name: 'Run payroll' }).isDisabled())
  await shot(acc, '01-readiness-blocked')
  await noFabrications(acc, 'Readiness')

  // Neha's salary, through the Salary structure screen.
  await tab(acc, 'Salary structure')
  await acc.locator('tr', { hasText: 'Neha Joshi' }).getByRole('button', { name: 'Set salary' }).click()
  const salaryForm = acc.locator('form', { has: acc.getByPlaceholder('e.g. 480000') })
  await salaryForm.locator('input[type="date"]').fill('2026-09-01')
  await salaryForm.getByPlaceholder('e.g. 480000').fill('300000')
  await salaryForm.locator('label', { hasText: 'Basic' }).locator('input').fill('18000')
  await salaryForm.locator('label', { hasText: 'House Rent Allowance' }).locator('input').fill('7000')
  await salaryForm.getByRole('button', { name: 'Save salary' }).click()
  await acc.locator('tr', { hasText: 'Neha Joshi' }).getByRole('button', { name: 'Change' }).waitFor({ timeout: 20_000 })
  check('Accounts sets Neha’s salary from 1 September', true)
  const closeSalary = acc.getByRole('button', { name: 'Cancel' })
  if (await closeSalary.isVisible().catch(() => false)) await closeSalary.click()

  // TDS: off for this company, and said so.
  await tab(acc, 'Income tax (TDS)')
  await acc.getByText('Income tax (TDS) is not deducted through payroll').waitFor()
  check('TDS tab says TDS is not deducted, and offers nothing to enter', (await acc.getByRole('button', { name: 'Set monthly TDS' }).count()) === 0)

  // Bank accounts.
  await tab(acc, 'Bank accounts')
  await acc.locator('tr', { hasText: 'Ravi Patil' }).waitFor()
  check('Bank accounts lists everybody, none with an account yet', (await acc.getByText('No account', { exact: true }).count()) >= 5)

  async function addAccount(name, a) {
    await acc.getByRole('button', { name: `Add ${name}'s bank account` }).click()
    const dlg = acc.getByRole('dialog', { name: `Add bank account — ${name}` })
    await dlg.getByPlaceholder('HDFC Bank').fill(a.bank)
    await dlg.locator('label', { hasText: 'Name on the account' }).locator('input').fill(a.holder)
    await dlg.locator('label').filter({ has: acc.getByText('Account number', { exact: true }) }).locator('input').fill(a.number)
    await dlg.locator('label', { hasText: 'Account number again' }).locator('input').fill(a.again ?? a.number)
    await dlg.locator('label', { hasText: 'IFSC' }).locator('input').fill(a.ifsc)
    return dlg
  }

  // A typo in the second number stops the save.
  let dlg = await addAccount('Ravi Patil', { bank: 'HDFC Bank', holder: 'RAVI PATIL', number: '004455667788', again: '004455667789', ifsc: 'HDFC0001234' })
  check('Two different account numbers are caught before saving', (await dlg.getByText('The two numbers differ').isVisible()) && (await dlg.getByRole('button', { name: 'Save' }).isDisabled()))
  await dlg.locator('label', { hasText: 'Account number again' }).locator('input').fill('004455667788')
  await dlg.getByLabel('I have checked these details against a cancelled cheque or passbook page.').check()
  await dlg.getByRole('button', { name: 'Save' }).click()
  await waitToast(acc, "Ravi Patil's bank account saved")
  check('Ravi’s account, checked against the cheque, is Verified', (await acc.locator('tr', { hasText: 'Ravi Patil' }).innerText()).includes('Verified'))

  dlg = await addAccount('Priya Deshmukh', { bank: 'ICICI Bank', holder: 'PRIYA DESHMUKH', number: '112233445566', ifsc: 'ICIC0004321' })
  await dlg.getByRole('button', { name: 'Save' }).click()
  await waitToast(acc, "Priya Deshmukh's bank account saved")
  const priyaRow = acc.locator('tr', { hasText: 'Priya Deshmukh' })
  check('Priya’s account, saved unchecked, waits for a check', (await priyaRow.innerText()).includes('Waiting for a check'))
  await priyaRow.getByRole('button', { name: 'Check' }).click()
  const review = acc.getByRole('dialog', { name: 'Check bank account — Priya Deshmukh' })
  check('The check shows the whole number to compare with the cheque — and says no proof is uploaded', (await review.innerText()).includes('112233445566') && (await review.innerText()).includes('No proof on file'))
  await review.getByRole('button', { name: 'Verify' }).click()
  await waitToast(acc, "Priya Deshmukh's account verified")
  check('Priya’s account is now Verified', (await priyaRow.innerText()).includes('Verified'))

  dlg = await addAccount('Hema Hiremath', { bank: 'State Bank of India', holder: 'HEMA H', number: '998877665544', ifsc: 'SBIN0001111' })
  await dlg.getByRole('button', { name: 'Save' }).click()
  await waitToast(acc, "Hema Hiremath's bank account saved")
  await acc.locator('tr', { hasText: 'Hema Hiremath' }).getByRole('button', { name: 'Check' }).click()
  const reject = acc.getByRole('dialog', { name: 'Check bank account — Hema Hiremath' })
  await reject.getByRole('button', { name: 'Reject' }).click()
  check('Rejecting without a reason asks for one', await reject.getByText('Say why, so it can be put right.').isVisible())
  await reject.getByPlaceholder('For example: IFSC does not match the cheque').fill('Name does not match the cheque')
  await reject.getByRole('button', { name: 'Reject' }).click()
  await waitToast(acc, "Hema Hiremath's account rejected")
  const hemaRow = await acc.locator('tr', { hasText: 'Hema Hiremath' }).innerText()
  check('Hema’s account shows Rejected, with the reason', hemaRow.includes('Rejected') && hemaRow.includes('Name does not match the cheque'))

  // Where the accountant's own pay goes is entered — and checked — by somebody
  // above them (final audit, 4 Oct): their own row offers neither.
  const anilRow = acc.locator('tr', { hasText: 'Anil Accountant' })
  check('On their own row, the accountant is offered no Add and no Check — it says who does it',
    (await anilRow.getByRole('button', { name: /^(Add|Edit|Check)\b/ }).count()) === 0 && (await anilRow.innerText()).includes('Entered and checked by'))
  // The Super Admin enters it, unchecked.
  const owner = await open('admin')
  await owner.goto(`${BASE}/payroll?tab=bank`)
  await owner.getByRole('button', { name: "Add Anil Accountant's bank account" }).click()
  const anilDlg = owner.getByRole('dialog', { name: 'Add bank account — Anil Accountant' })
  await anilDlg.getByPlaceholder('HDFC Bank').fill('HDFC Bank')
  await anilDlg.locator('label', { hasText: 'Name on the account' }).locator('input').fill('ANIL A')
  await anilDlg.locator('label').filter({ has: owner.getByText('Account number', { exact: true }) }).locator('input').fill('555566667777')
  await anilDlg.locator('label', { hasText: 'Account number again' }).locator('input').fill('555566667777')
  await anilDlg.locator('label', { hasText: 'IFSC' }).locator('input').fill('HDFC0009999')
  await anilDlg.getByRole('button', { name: 'Save' }).click()
  await waitToast(owner, "Anil Accountant's bank account saved")
  await owner.context().close()
  await acc.reload()
  await acc.locator('tr', { hasText: 'Anil Accountant' }).waitFor()
  check('…the Super Admin enters it; it waits for a check, with no Check button on Anil’s own row',
    (await anilRow.innerText()).includes('Waiting for a check') && (await anilRow.getByRole('button', { name: 'Check' }).count()) === 0)
  await shot(acc, '02-bank-accounts')
  await noFabrications(acc, 'Bank accounts')

  // The bank file's layout.
  await tab(acc, 'Bank file format')
  await acc.getByText('This is the standard layout').waitFor()
  await acc.locator('label', { hasText: 'Narration' }).locator('input').fill('Salary {month} {year} {code}')
  await acc.getByRole('button', { name: 'Add a column' }).click()
  await acc.getByLabel('Column 8 heading').fill('Bank Name')
  await acc.getByLabel('Column 8 holds').selectOption('bank_name')
  const sample = await acc.locator('table.font-mono').innerText()
  check('The example line follows the layout as it is edited', sample.includes('Bank Name') && sample.includes('Salary September 2026 EMP001') && sample.includes('HDFC Bank'), sample.replace(/\s+/g, ' '))
  await acc.getByRole('button', { name: 'Save format' }).click()
  await waitToast(acc, 'Bank file format saved')
  await acc.getByText('This is the standard layout').waitFor({ state: 'detached', timeout: 10_000 })
  check('The saved layout is the company’s own now', true)
  await acc.getByText('Columns, in order').scrollIntoViewIfNeeded()
  await shot(acc, '03-bank-file-format')
  const rowBox = await acc.getByLabel('Column 1 heading').boundingBox()
  const selectBox = await acc.getByLabel('Column 1 holds').boundingBox()
  check('Each column sits on one line: heading, what it holds, and its buttons', Math.abs(rowBox.y - selectBox.y) < 8, `${rowBox.y} vs ${selectBox.y}`)

  // ── 2. HR enters the incentive ────────────────────────────────────────────
  const hr = await open('hr')
  const hrNav = await hr.locator('aside').innerText()
  check('HR: the sidebar has Payroll (for incentives) and My Payslips', hrNav.includes('Payroll') && hrNav.includes('My Payslips'))
  await hr.goto(`${BASE}/payroll?tab=runs`)
  await hr.getByText('Amounts entered each month').waitFor()
  check('HR sees only Incentives — no runs, salaries or bank details, even asking for ?tab=runs',
    (await hr.getByRole('button', { name: 'Payroll runs', exact: true }).count()) === 0 &&
    (await hr.getByRole('button', { name: 'Bank accounts', exact: true }).count()) === 0 &&
    (await hr.getByText('no payroll run yet').count()) === 0)
  check('The month starts on September 2026', (await hr.locator('select').first().inputValue()) === '2026-09')
  await hr.getByRole('button', { name: 'Add incentive' }).click()
  let entry = hr.getByRole('dialog', { name: 'Add incentive — September 2026' })
  await entry.locator('select').first().selectOption({ label: `Priya Deshmukh (${E.priya.code})` })
  await entry.locator('input[type="number"]').fill('5000')
  await entry.getByPlaceholder('For example: Q2 sales target').fill('Q2 target')
  await entry.getByRole('button', { name: 'Save' }).click()
  await waitToast(hr, 'Saved for September 2026')
  const incRow = await hr.locator('tr', { hasText: 'Priya Deshmukh' }).innerText()
  check('HR’s incentive is listed for September', incRow.includes('₹5,000.00') && incRow.includes('Q2 target'), incRow.replace(/\s+/g, ' '))
  await hr.getByRole('button', { name: 'Add incentive' }).click()
  entry = hr.getByRole('dialog', { name: 'Add incentive — September 2026' })
  await entry.locator('select').first().selectOption({ label: `Priya Deshmukh (${E.priya.code})` })
  check('Adding another for the same person warns it replaces, not adds', await entry.getByText('Saving replaces it.').isVisible())
  await entry.getByRole('button', { name: 'Cancel' }).click()
  await shot(hr, '04-hr-incentives')

  // ── 3. Accounts runs September ───────────────────────────────────────────
  await acc.goto(`${BASE}/payroll?tab=runs`)
  await acc.getByText('September 2026 — no payroll run yet').waitFor()
  check('With Neha’s salary in, nothing stops the run', (await acc.locator('div.border-red-200', { hasText: 'stops' }).count()) === 0)
  check('Readiness shows HR’s incentive for Priya', (await acc.locator('tr', { hasText: 'Priya Deshmukh' }).innerText()).includes('Incentive ₹5,000.00'))
  await acc.getByRole('button', { name: 'Run payroll' }).click()
  await waitToast(acc, 'calculated as a draft')
  await acc.getByText('September 2026 payroll').waitFor()
  const header = await acc.locator('main').innerText()
  check('The draft is shown with its figures', header.includes('Draft') && /Employees\s*5/.test(header))
  check('Accounts cannot approve their own run', (await acc.getByRole('button', { name: 'Approve', exact: true }).count()) === 0)

  await acc.locator('tr', { hasText: 'Priya Deshmukh' }).getByRole('button', { name: 'View' }).click()
  const modal = acc.getByRole('dialog', { name: 'Payslip' })
  await modal.getByText('Priya Deshmukh — September 2026').waitFor()
  await modal.getByText('Net pay').waitFor()
  const slipText = await modal.innerText()
  check('Payslip modal: the incentive is an earning, two days are loss of pay', slipText.includes('Incentive') && /\b2\s*\n\s*Loss of pay/.test(slipText), slipText.slice(0, 400).replace(/\s+/g, ' '))
  check('…the joining date is the record’s, and UAN/PAN are blank until approval — never guessed', slipText.includes('6 Jan 2025') && slipText.includes('copied onto the payslip when the payroll is approved'))
  const draftPdf = await download(acc, () => modal.getByRole('button', { name: 'PDF' }).click(), 'draft-priya.pdf')
  check('The draft PDF downloads (a preview, before payment)', draftPdf.bytes.subarray(0, 4).toString() === '%PDF', draftPdf.name)
  await shot(acc, '05-payslip-modal-draft')
  await modal.getByRole('button', { name: 'Close' }).click()
  await noFabrications(acc, 'Draft run')

  // ── 4. The Super Admin approves ───────────────────────────────────────────
  const admin = await open('admin')
  await admin.goto(`${BASE}/payroll`)
  await admin.getByText('September 2026 payroll').waitFor({ timeout: 20_000 })
  check('The Super Admin lands on the run still to be finished', true)
  async function approve(page) {
    await page.getByRole('button', { name: 'Approve', exact: true }).click()
    const ask = page.getByRole('dialog', { name: 'Approve September 2026' })
    await ask.getByRole('button', { name: 'Approve', exact: true }).click()
    await ask.getByText('counted as paid with no attendance').waitFor({ timeout: 20_000 })
    return ask
  }
  let ask = await approve(admin)
  const askText = await ask.innerText()
  check('Approval lists the days paid on no record — Ravi’s unmarked days, the days not yet here', askText.includes('Ravi Patil') && askText.includes('No attendance') && askText.includes('Not yet happened'), askText.slice(0, 300).replace(/\s+/g, ' '))
  check('…in the dialog, not as an error toast', (await errorToasts(admin)).length === 0, JSON.stringify(await errorToasts(admin)))
  await shot(admin, '06-approve-confirm-days')
  await ask.getByRole('button', { name: /^Approve, accepting \d+ days$/ }).click()
  await waitToast(admin, 'September 2026 approved')
  await admin.getByRole('button', { name: 'Reopen' }).waitFor()
  check('Approved', (await admin.locator('main').innerText()).includes('Approved'))

  // Reopen, and approve again.
  await admin.getByRole('button', { name: 'Reopen' }).click()
  await admin.getByRole('dialog', { name: 'Reopen September 2026?' }).getByRole('button', { name: 'Reopen' }).click()
  await waitToast(admin, 'September 2026 is a draft again')
  await admin.getByRole('button', { name: 'Approve', exact: true }).waitFor()
  check('Reopened: a draft again, to be approved again', true)
  ask = await approve(admin)
  await ask.getByRole('button', { name: /^Approve, accepting \d+ days$/ }).click()
  await waitToast(admin, 'September 2026 approved')
  await admin.getByRole('button', { name: 'Reopen' }).waitFor()
  check('Approved again', true)

  // Now approved, the modal carries the identifiers copied at approval.
  await admin.locator('tr', { hasText: 'Priya Deshmukh' }).getByRole('button', { name: 'View' }).click()
  const approvedModal = admin.getByRole('dialog', { name: 'Payslip' })
  await approvedModal.getByText('101234567890').waitFor()
  const approvedText = await approvedModal.innerText()
  check('After approval the payslip carries Priya’s UAN and PAN as recorded, and a dash where none is', approvedText.includes('101234567890') && approvedText.includes('AAAPD1234K') && /PF member ID\s*\n?\s*—/.test(approvedText))
  await shot(admin, '05b-payslip-modal-approved')
  await approvedModal.getByRole('button', { name: 'Close' }).click()

  // ── 5. Accounts: the bank file, then paid ────────────────────────────────
  await acc.reload()
  await acc.getByText('September 2026 payroll').waitFor()
  await acc.getByRole('button', { name: 'Bank file', exact: true }).click()
  const bank = acc.getByRole('dialog', { name: 'Bank transfer file' })
  await bank.getByText('2 payments').waitFor({ timeout: 20_000 })
  const bankText = await bank.innerText()
  check('The file pays the two verified accounts, showing only their last four digits', bankText.includes('•••• 7788') && bankText.includes('•••• 5566') && !bankText.includes('004455667788'))
  check('…and names who is left out, and why', bankText.includes('Hema Hiremath') && bankText.includes('Bank account was rejected') &&
    bankText.includes('Anil Accountant') && bankText.includes('Bank account not checked yet') &&
    bankText.includes('Neha Joshi') && bankText.includes('No bank account on record'))
  await shot(acc, '07-bank-file-panel')
  const csv = await download(acc, () => bank.getByRole('button', { name: 'Download CSV' }).click(), 'bank.csv')
  const text = csv.bytes.toString('utf8')
  const lines = text.replace(/^\uFEFF/, '').split('\r\n').filter(Boolean)
  check('The CSV is named for the month, marked UTF-8, one CRLF line each', csv.name === 'bank-transfer-2026-09.csv' && text.startsWith('\uFEFF') && lines.length === 3, `${csv.name} ${lines.length} lines`)
  check('…headed by the company’s layout', lines[0] === 'Beneficiary Name,Account Number,IFSC,Amount,Payment Mode,Narration,Employee Code,Bank Name', lines[0])
  const ravi = lines.find((l) => l.includes('RAVI PATIL'))
  const priya = lines.find((l) => l.includes('PRIYA DESHMUKH'))
  check('…with full account numbers, exact amounts, NEFT and the narration filled in',
    ravi?.includes('004455667788') && priya?.includes('112233445566') &&
    /,\d+\.\d{2},NEFT,/.test(ravi ?? '') && priya?.includes(`Salary September 2026 ${E.priya.code}`) && priya?.endsWith('ICICI Bank'),
    `${ravi} | ${priya}`)
  await bank.getByRole('button', { name: 'Close' }).click()

  // The amounts in the file are the payslips' net pay.
  const netOf = async (name) => {
    const cells = await acc.locator('tr', { hasText: name }).locator('td').allInnerTexts()
    return Number(cells[5].replace(/[₹,\s]/g, ''))
  }
  const [raviNet, priyaNet] = [await netOf('Ravi Patil'), await netOf('Priya Deshmukh')]
  check('…and each amount is that person’s net pay', ravi.includes(`,${raviNet.toFixed(2)},`) && priya.includes(`,${priyaNet.toFixed(2)},`), `${raviNet} ${priyaNet}`)

  await acc.getByRole('button', { name: 'Mark as paid' }).click()
  const paid = acc.getByRole('dialog', { name: 'Mark September 2026 as paid' })
  check('The credited date starts at today', (await paid.locator('input[type="date"]').inputValue()) === new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date()))
  await paid.getByRole('button', { name: 'Mark as paid' }).click()
  await waitToast(acc, 'marked as paid')
  await acc.getByText(`Paid on ${todayLabel}`).waitFor({ timeout: 30_000 })
  check('Paid, on the day recorded', true)
  await shot(acc, '08-run-paid')
  const stored1 = await download(acc, () => acc.locator('tr', { hasText: 'Priya Deshmukh' }).getByRole('button', { name: 'PDF for Priya Deshmukh' }).click(), 'paid-priya-1.pdf')
  const stored2 = await download(acc, () => acc.locator('tr', { hasText: 'Priya Deshmukh' }).getByRole('button', { name: 'PDF for Priya Deshmukh' }).click(), 'paid-priya-2.pdf')
  check('The paid payslip is the stored PDF: the same bytes every time', stored1.bytes.subarray(0, 4).toString() === '%PDF' && sha(stored1.bytes) === sha(stored2.bytes) && sha(stored1.bytes) !== sha(draftPdf.bytes))
  await noFabrications(acc, 'Paid run')

  await tab(acc, 'Incentives')
  await acc.getByText('so its amounts are closed').waitFor()
  check('September’s incentives are closed once paid — no edit or remove', (await acc.getByRole('button', { name: /Change Priya Deshmukh/ }).count()) === 0 && (await acc.getByRole('button', { name: 'Add incentive' }).isDisabled()))

  // ── 6. The employee ──────────────────────────────────────────────────────
  const emp = await open('emp')
  const empNav = await emp.locator('aside').innerText()
  check('Employee: My Payslips in the sidebar, no Payroll', empNav.includes('My Payslips') && !/\bPayroll\b/.test(empNav.replace('My Payslips', '')), empNav.replace(/\n/g, ' | '))
  await emp.goto(`${BASE}/payslips`)
  await emp.locator('tr', { hasText: 'September 2026' }).waitFor({ timeout: 20_000 })
  const mine = await emp.locator('tr', { hasText: 'September 2026' }).innerText()
  check('My Payslips lists September, paid today, with the net pay', mine.includes(todayLabel) && mine.includes(priyaNet.toLocaleString('en-IN', { minimumFractionDigits: 2 })), mine.replace(/\s+/g, ' '))
  const own = await download(emp, () => emp.getByRole('button', { name: 'PDF' }).click(), 'my-payslip.pdf')
  check('The employee downloads exactly the stored PDF', sha(own.bytes) === sha(stored1.bytes), own.name)
  await shot(emp, '09-my-payslips')

  await emp.getByRole('button', { name: /Priya Deshmukh/ }).first().click()
  await emp.getByRole('button', { name: 'My Profile' }).click()
  await emp.getByText('Bank Account for Salary Credit').waitFor()
  await emp.getByText('•••• 5566').waitFor({ timeout: 20_000 })
  const drawer = await emp.locator('div.space-y-3', { has: emp.getByText('Bank Account for Salary Credit', { exact: true }) }).last().innerText()
  check('Their profile shows where the salary goes — last four digits, Verified, how to change it',
    drawer.includes('ICICI Bank') && drawer.includes('Verified') && drawer.includes('photo of a cancelled cheque') && !drawer.includes('112233445566'), drawer.replace(/\s+/g, ' '))
  await shot(emp, '10-profile-bank')

  await emp.goto(`${BASE}/payroll`)
  await emp.waitForURL('**/dashboard', { timeout: 15_000 })
  check('An employee sent to /payroll lands on their dashboard', true)

  // ── 7. A login with no employee record ───────────────────────────────────
  await admin.goto(`${BASE}/payslips`)
  await admin.getByText('No payslips yet').waitFor()
  check('A Super Admin with no employee record is told why there are no payslips', await admin.getByText('not linked to an employee record').isVisible())

  // Signing in starts with no session: the session probe answering 401 is expected.
  const asked = failedCalls.filter((c) => /POST \/payroll-runs\/[^/]+\/approve 422$/.test(c))
  const unexpected = failedCalls.filter((c) => !asked.includes(c) && !/\/auth\/(session|refresh) 401$/.test(c))
  check('No failed API call except the two approvals that asked for confirmation', unexpected.length === 0 && asked.length === 2, JSON.stringify(failedCalls))
  check('No page errors in any browser', pageErrors.length === 0, JSON.stringify(pageErrors))
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
