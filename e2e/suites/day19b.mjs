// Day 19 re-verification: the flows the first E2E never exercised, and every
// fix made after the independent review. Real Edge, isolated stack
// (Vite :5183 → API :4100 → local ems_e2e). Fixture: day19-seed.ts (fresh).
import { chromium } from 'playwright-core'
import { WORK, REPO, STORAGE as STORE, psql } from '../lib/env.mjs'
import { readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync } from 'node:fs'

const BASE = 'http://localhost:5183'
const API = 'http://localhost:4100/api'
const DIR = WORK
const STORAGE = STORE
const fx = JSON.parse(readFileSync(`${DIR}/day19-fixture.json`, 'utf8'))
const SHOTS = `${DIR}/shots/day19b`
const DL = `${DIR}/downloads-day19b`
const FILES = `${DIR}/files-day19`
for (const d of [SHOTS, DL, FILES]) mkdirSync(d, { recursive: true })
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
  const res = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: fx.users[who], password: fx.password }) })
  const body = await res.json()
  if (res.status !== 200) throw new Error(`login ${who}: ${res.status} ${JSON.stringify(body)}`)
  tokens[who] = body.data.accessToken
}
async function api(who, method, path, body) {
  const res = await fetch(`${API}${path}`, { method, headers: { Authorization: `Bearer ${tokens[who]}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { json = text }
  return { status: res.status, body: json, headers: res.headers }
}
async function upload(who, path, fields, file, method = 'POST') {
  const form = new FormData()
  for (const [k, v] of Object.entries(fields)) form.append(k, v)
  if (file) form.append(file.field ?? 'file', new Blob([readFileSync(file.path)], { type: file.type }), file.name)
  const res = await fetch(`${API}${path}`, { method, headers: { Authorization: `Bearer ${tokens[who]}` }, body: form })
  return { status: res.status, body: await res.json() }
}

function pdf(text) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  const stream = `BT /F1 24 Tf 72 760 Td (${text}) Tj ET`
  objects[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
  let out = '%PDF-1.4\n'
  const offsets = []
  objects.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n` })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}
const F = { doc: `${FILES}/b-doc.pdf`, doc2: `${FILES}/b-doc2.pdf`, cheque: `${FILES}/small-cheque.jpg`, utf: `${FILES}/Résumé – मेरा.pdf` }
writeFileSync(F.doc, pdf('A document'))
writeFileSync(F.doc2, pdf('Another document'))
writeFileSync(F.utf, pdf('Resume in Hindi'))
const PDF = (name = 'doc.pdf') => ({ path: F.doc, type: 'application/pdf', name })

const browser = await chromium.launch({ channel: 'msedge', headless: true })
// A small cheque photo for the API calls — the API does not shrink photos; the browser does.
{
  const page = await (await browser.newContext()).newPage()
  const b64 = await page.evaluate(async () => {
    const c = document.createElement('canvas')
    c.width = 900; c.height = 400
    const g = c.getContext('2d')
    g.fillStyle = '#eef3f8'; g.fillRect(0, 0, 900, 400)
    g.fillStyle = '#111'; g.font = 'bold 40px sans-serif'; g.fillText('CANCELLED CHEQUE', 60, 200)
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.8))
    const buf = new Uint8Array(await blob.arrayBuffer())
    let out = ''
    for (let i = 0; i < buf.length; i += 0x8000) out += String.fromCharCode(...buf.subarray(i, i + 0x8000))
    return btoa(out)
  })
  writeFileSync(F.cheque, Buffer.from(b64, 'base64'))
  await page.context().close()
}
const pageErrors = []
const openPages = []
async function newPage(who, viewport = { width: 1366, height: 900 }) {
  const ctx = await browser.newContext({ viewport, acceptDownloads: true })
  const page = await ctx.newPage()
  openPages.push({ who, page })
  page.on('pageerror', (e) => pageErrors.push(`${who}: ${e.message}`))
  return page
}
async function signIn(page, who) {
  await page.goto(`${BASE}/signin`)
  await page.getByPlaceholder('you@careermap.in or EMP001').fill(fx.users[who])
  await page.getByPlaceholder('Enter your password').fill(fx.password)
  await page.getByRole('button', { name: 'Sign In' }).click()
  await page.waitForURL('**/dashboard', { timeout: 20_000 })
}
async function open(who, viewport) {
  const page = await newPage(who, viewport)
  await signIn(page, who)
  return page
}
const waitToast = (page, text) => page.locator('[data-sonner-toast]', { hasText: text }).first().waitFor({ timeout: 20_000 })
const shot = (page, name) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true })
const row = (page, label) => page.locator('div.px-5.py-4').filter({ has: page.getByText(label, { exact: true }) }).first()
const bell = (page) => page.locator('header button[title="Notifications"]')
const panelOf = (page) => page.locator('div.shadow-2xl.rounded-2xl.z-50')

try {
  for (const who of Object.keys(fx.users)) await login(who)

  // ═══════════════════════════════════════════════════════════════════════
  section('Setup through the API')
  const types = Object.fromEntries((await api('hr', 'GET', '/document-types')).body.data.map((t) => [t.code, t.id]))
  // Priya: Aadhaar (to be verified), PAN, Passport; a bank account with its proof.
  const aad = await upload('emp', '/employee-documents', { documentTypeId: types.aadhaar }, PDF('aadhaar.pdf'))
  await upload('emp', '/employee-documents', { documentTypeId: types.pan }, PDF('pan.pdf'))
  const pass = await upload('emp', '/employee-documents', { documentTypeId: types.passport }, PDF('passport.pdf'))
  check('Priya files her Aadhaar, PAN and passport', aad.status === 201 && pass.status === 201)
  const verified = await api('hr', 'POST', `/employee-documents/${aad.body.data.id}/decision`, { decision: 'verified' })
  check('HR verifies her Aadhaar', verified.status === 200)
  const bank = await upload('emp', '/payslips/me/bank-account', { bankName: 'ICICI Bank', accountHolderName: 'PRIYA DESHMUKH', accountNumber: '112233445566', ifsc: 'ICIC0004321', accountType: 'Savings' }, { field: 'proof', path: F.cheque, type: 'image/jpeg', name: 'cancelled-cheque.jpg' }, 'PUT')
  check('Priya sends in her bank account with its proof', bank.status === 200, JSON.stringify(bank.body).slice(0, 160))
  // Thirteen documents filed for Ravi and Neha, waiting for a check.
  let filed = 0
  for (const [who, codes] of [['ravi', ['offer_letter', 'aadhaar', 'pan', 'resume', 'edu_certificate', 'exp_letter', 'other']], ['neha', ['offer_letter', 'aadhaar', 'pan', 'resume', 'edu_certificate', 'exp_letter']]]) {
    for (const code of codes) {
      const r = await upload('hr', '/employee-documents', { employeeId: E[who].id, documentTypeId: types[code] }, PDF(`${who}-${code}.pdf`))
      if (r.status === 201) filed += 1
    }
  }
  check('HR files thirteen documents for Ravi and Neha, unchecked', filed === 13)
  // The passport type is archived after Priya's was filed.
  const archived = await api('sa', 'PATCH', `/document-types/${types.passport}`, { archived: true })
  check('The Super Admin archives the Passport type', archived.status === 200)
  // A paid August payroll, for the print test.
  const run = await api('acc', 'POST', '/payroll-runs', { year: 2026, month: 8 })
  let approve = await api('sa', 'POST', `/payroll-runs/${run.body.data.id}/approve`, {})
  if (approve.status !== 200) approve = await api('sa', 'POST', `/payroll-runs/${run.body.data.id}/approve`, { confirmAssumedDays: true })
  const paid = await api('acc', 'POST', `/payroll-runs/${run.body.data.id}/mark-paid`, { paidOn: '2026-09-01' })
  check('August 2026 payroll is run, approved and paid', run.status === 201 && approve.status === 200 && paid.status === 200)

  // ═══════════════════════════════════════════════════════════════════════
  section('One tab, two people: nothing of the first is shown to the next')
  const shared = await newPage('shared')
  await signIn(shared, 'hr')
  await bell(shared).click()
  await panelOf(shared).getByText('Notifications', { exact: true }).waitFor()
  await shared.waitForTimeout(800)
  const hrPanel = await panelOf(shared).innerText()
  check('HR’s bell has HR’s notices (documents sent in)', /sent in|to check/i.test(hrPanel), hrPanel.replace(/\n/g, ' ').slice(0, 160))
  await shared.goto(`${BASE}/documents?tab=employees`)
  await shared.getByText(/waiting for a check/).first().waitFor()
  await shared.getByRole('button', { name: 'Sign Out' }).click()
  await shared.waitForURL('**/signin')
  await shared.getByPlaceholder('you@careermap.in or EMP001').fill(fx.users.emp)
  await shared.getByPlaceholder('Enter your password').fill(fx.password)
  await shared.getByRole('button', { name: 'Sign In' }).click()
  await shared.waitForURL('**/dashboard')
  await bell(shared).click()
  await panelOf(shared).getByText('Notifications', { exact: true }).waitFor()
  await shared.waitForTimeout(300)
  const empPanel = await panelOf(shared).innerText()
  check('Signed in as Priya on the same tab, the bell shows none of HR’s notices', !/Documents to check|sent in/i.test(empPanel) && !empPanel.includes('Ravi'), empPanel.replace(/\n/g, ' ').slice(0, 200))
  // A second tap on the bell closes it.
  await bell(shared).click()
  await shared.waitForTimeout(300)
  check('Tapping the bell again closes the panel', !(await panelOf(shared).isVisible().catch(() => false)))
  await shared.goto(`${BASE}/documents`)
  await shared.getByText('Required verified', { exact: true }).waitFor()
  check('…and “My documents” is Priya’s own', (await shared.locator('main').innerText()).includes('Priya Deshmukh'))
  // Keyboard: a notice opens with Enter.
  await bell(shared).click()
  const first = panelOf(shared).locator('div[role="button"]').first()
  await first.waitFor()
  await first.focus()
  await shared.keyboard.press('Enter')
  await shared.waitForTimeout(800)
  check('A notice opens from the keyboard (Enter), and the panel closes', !(await panelOf(shared).isVisible().catch(() => false)))

  // ═══════════════════════════════════════════════════════════════════════
  section('Admin (Arjun): documents and settings')
  const admin = await open('admin')
  await admin.goto(`${BASE}/documents`)
  await admin.getByText('Required verified', { exact: true }).waitFor()
  const adminTabs = await admin.locator('main button').allInnerTexts()
  check('Admin has Company, My and Employee documents', ['Company documents', 'My documents', 'Employee documents'].every((t) => adminTabs.some((x) => x.includes(t))), adminTabs.slice(0, 4).join(' / '))
  await admin.getByRole('button', { name: 'Employee documents' }).click()
  await admin.locator('div.max-h-140').getByRole('button', { name: /Ravi Patil/ }).click()
  await admin.getByText('Required verified', { exact: true }).waitFor()
  await row(admin, 'Offer Letter').getByRole('button', { name: 'Verify Offer Letter' }).click()
  await admin.getByRole('dialog', { name: 'Verify Offer Letter — Ravi Patil' }).getByRole('button', { name: 'Verify' }).click()
  await waitToast(admin, 'Offer Letter verified')
  check('Admin verifies somebody else’s document', (await row(admin, 'Offer Letter').innerText()).includes('Verified'))
  await admin.goto(`${BASE}/settings`)
  await admin.getByRole('heading', { name: 'Settings', level: 2 }).waitFor()
  const adminSettings = await admin.locator('main aside nav button').allInnerTexts()
  check('Admin’s Settings: Leave Config and Documents only', adminSettings.length === 2 && adminSettings.some((t) => t.includes('Leave')) && adminSettings.some((t) => t.includes('Documents')), adminSettings.join(' / '))

  // ═══════════════════════════════════════════════════════════════════════
  section('The employee drawer: documents for HR, the bank card for the Super Admin')
  const hr = await open('hr')
  await hr.goto(`${BASE}/employees`)
  await hr.locator('tr', { hasText: 'Priya Deshmukh' }).first().click()
  await hr.getByText('Employee Profile').waitFor()
  await hr.getByText(/of 4 required verified/).waitFor({ timeout: 15_000 })
  const hrDrawer = await hr.locator('div.fixed.right-0.top-0').innerText()
  check('HR sees where Priya stands: 1 of 4 required verified, with what waits', hrDrawer.includes('1 of 4 required verified') && /waiting for a check/.test(hrDrawer), hrDrawer.match(/\d of 4 required verified[^\n]*\n[^\n]*/)?.[0])
  check('…and no bank card (HR holds no bank right)', !hrDrawer.includes('Bank Account for Salary Credit'))
  await shot(hr, '01-hr-drawer-documents')
  await hr.getByRole('button', { name: /Open their documents/ }).click()
  await hr.waitForURL(`**/documents?tab=employees&employee=${E.priya.id}`)
  check('“Open their documents” goes to Priya’s documents', true)

  const sa = await open('sa')
  await sa.goto(`${BASE}/employees`)
  await sa.locator('tr', { hasText: 'Priya Deshmukh' }).first().click()
  await sa.getByText('Bank Account for Salary Credit').waitFor()
  const saDrawer = await sa.locator('div.fixed.right-0.top-0').innerText()
  check('The bank card shows the last four digits only, the app’s own status words, and the proof', saDrawer.includes('•••• 5566') && !saDrawer.includes('112233445566') && saDrawer.includes('Waiting for a check') && saDrawer.includes('Proof on file'), saDrawer.match(/Bank Account[\s\S]{0,220}/)?.[0]?.replace(/\n/g, ' '))
  check('The Access row names the role — “Employee”, not a code', /Can sign in · Employee/.test(saDrawer))
  await shot(sa, '02-sa-drawer-bank')
  await sa.getByRole('button', { name: /under Payroll → Bank accounts/ }).click()
  await sa.waitForURL('**/payroll?tab=bank')
  check('…and its link opens Payroll → Bank accounts', true)

  const mgr = await open('mgr')
  await mgr.goto(`${BASE}/employees`)
  await mgr.locator('tr', { hasText: 'Priya Deshmukh' }).first().click()
  await mgr.getByText('Employee Profile').waitFor()
  await mgr.waitForTimeout(800)
  const mgrDrawer = await mgr.locator('div.fixed.right-0.top-0').innerText()
  check('A manager’s drawer has neither documents nor the bank card', !mgrDrawer.includes('Open their documents') && !mgrDrawer.includes('Bank Account for Salary Credit'))

  // ═══════════════════════════════════════════════════════════════════════
  section('Documents: an archived type, the waiting queue, a missing file, a mistaken copy withdrawn')
  const emp = await open('emp')
  await emp.goto(`${BASE}/documents`)
  await emp.getByText('Required verified', { exact: true }).waitFor()
  const other = emp.locator('div.px-5.py-4', { hasText: 'Filed under types no longer asked for' })
  await other.waitFor()
  check('Her passport, filed under a type since archived, is still listed', (await other.innerText()).includes('Passport: passport.pdf'))
  await other.getByRole('button', { name: 'View' }).click()
  await emp.locator('div[role="dialog"] iframe').waitFor({ timeout: 20_000 })
  check('…and opens', true)
  await emp.keyboard.press('Escape')

  await hr.goto(`${BASE}/documents?tab=employees`)
  const banner = hr.locator('div.bg-amber-50').first()
  await banner.waitFor()
  const bannerText = await banner.innerText()
  const chips = await banner.locator('li button').count()
  check('The waiting list shows twelve and says how many more', chips === 12 && /and \d+ more/.test(bannerText), `${chips} chips · ${bannerText.match(/and \d+ more[^\n]*/)?.[0]}`)
  await hr.getByRole('button', { name: 'Waiting for a check' }).click()
  const waitingList = await hr.locator('div.max-h-140').innerText()
  check('“Waiting for a check” lists Priya, Ravi and Neha — optional documents counted too', ['Priya Deshmukh', 'Ravi Patil', 'Neha Joshi'].every((n) => waitingList.includes(n)), waitingList.replace(/\n/g, ' ').slice(0, 200))

  // A file gone from storage.
  const raviDocs = (await api('hr', 'GET', `/employee-documents?employeeId=${E.ravi.id}`)).body.data
  const raviAadhaar = raviDocs.items.find((i) => i.type.code === 'aadhaar').current
  const path = `${STORAGE}/org/${fx.organizationId}/employee-document/${E.ravi.id}/${raviAadhaar.id}.pdf`
  check('Found Ravi’s Aadhaar file in storage', existsSync(path), path)
  unlinkSync(path)
  await hr.goto(`${BASE}/documents?tab=employees&employee=${E.ravi.id}`)
  await hr.getByText('Required verified', { exact: true }).waitFor()
  await row(hr, 'Aadhaar Card').getByRole('button', { name: 'View' }).click()
  const prev = hr.getByRole('dialog', { name: 'Aadhaar Card — Ravi Patil' })
  await prev.getByText(/missing or has been altered/).waitFor({ timeout: 20_000 })
  const prevText = await prev.innerText()
  check('A file gone from storage says so plainly — no “download it instead”', !prevText.includes('Download it instead'), prevText.match(/This file[^\n]*/)?.[0])
  await prev.getByRole('button', { name: 'Download' }).click()
  await waitToast(hr, 'missing or has been altered')
  check('…and the download says the same, instead of “Something went wrong”', true)
  check('The preview offers no Verify for a file it could not open — only Reject, saying why',
    !(await prev.getByRole('button', { name: 'Verify' }).count()) && await prev.getByRole('button', { name: 'Reject' }).isVisible() && (await prev.innerText()).includes('This file cannot be checked'))
  await shot(hr, '03-missing-file')
  await hr.keyboard.press('Escape')
  // Verifying it straight from the list is refused by the server, in words.
  await row(hr, 'Aadhaar Card').getByRole('button', { name: 'Verify Aadhaar Card' }).click()
  const vd = hr.getByRole('dialog', { name: 'Verify Aadhaar Card — Ravi Patil' })
  await vd.getByRole('button', { name: 'Verify' }).click()
  await waitToast(hr, 'cannot be verified')
  await hr.keyboard.press('Escape')
  check('Verifying it from the list is refused, and it stays waiting', (await row(hr, 'Aadhaar Card').innerText()).includes('Waiting for a check'))

  // A mistaken second copy, withdrawn: the verified one comes back.
  await emp.reload()
  await emp.getByText('Required verified', { exact: true }).waitFor()
  await row(emp, 'Aadhaar Card').getByRole('button', { name: 'Replace' }).click()
  let dlg = emp.getByRole('dialog', { name: 'Upload a document' })
  await dlg.locator('input[type=file]').setInputFiles(F.doc2)
  await dlg.getByRole('button', { name: 'Upload' }).click()
  await waitToast(emp, 'Aadhaar Card uploaded')
  check('A second Aadhaar goes up by mistake — waiting, the verified one under “Earlier”', (await row(emp, 'Aadhaar Card').innerText()).includes('Waiting for a check'))
  await row(emp, 'Aadhaar Card').getByRole('button', { name: 'Remove Aadhaar Card' }).click()
  const rm = emp.getByRole('dialog', { name: 'Remove Aadhaar Card?' })
  check('The remove dialog says the replaced copy comes back', (await rm.innerText()).includes('If it replaced an earlier upload, that one is current again.'))
  await rm.getByRole('button', { name: 'Remove' }).click()
  await waitToast(emp, 'Document removed')
  const aRow = await row(emp, 'Aadhaar Card').innerText()
  check('Withdrawn — and her Aadhaar reads Verified again, not “Not uploaded”', aRow.includes('Verified') && !aRow.includes('Not uploaded'), aRow.replace(/\n/g, ' '))

  // A name in Hindi, with accents.
  await row(emp, 'Resume / CV').getByRole('button', { name: 'Upload' }).click()
  dlg = emp.getByRole('dialog', { name: 'Upload a document' })
  await dlg.locator('input[type=file]').setInputFiles(F.utf)
  await dlg.getByRole('button', { name: 'Upload' }).click()
  await waitToast(emp, 'Resume / CV uploaded')
  check('A file named “Résumé – मेरा.pdf” keeps its name', (await row(emp, 'Resume / CV').innerText()).includes('Résumé – मेरा.pdf'))

  // ═══════════════════════════════════════════════════════════════════════
  section('A bank account sent in again while Accounts is checking it')
  const acc = await open('acc')
  await acc.goto(`${BASE}/payroll?tab=bank`)
  const pRow = acc.locator('tr', { hasText: 'Priya Deshmukh' })
  await pRow.waitFor()
  await pRow.getByRole('button', { name: 'Check' }).click()
  const review = acc.getByRole('dialog', { name: 'Check bank account — Priya Deshmukh' })
  await review.waitFor()
  check('Accounts has Priya’s account (ending 5566) open to check', (await review.innerText()).includes('112233445566'))
  const again = await upload('emp', '/payslips/me/bank-account', { bankName: 'ICICI Bank', accountHolderName: 'PRIYA DESHMUKH', accountNumber: '998877665544', ifsc: 'ICIC0004321', accountType: 'Savings' }, { field: 'proof', path: F.cheque, type: 'image/jpeg', name: 'new-cheque.jpg' }, 'PUT')
  check('…meanwhile Priya sends in a different account', again.status === 200)
  await review.getByRole('button', { name: 'Verify' }).click()
  await waitToast(acc, 'changed while you were checking it — it now ends 5544')
  await acc.waitForTimeout(800)
  check('Verify is refused, and says the account changed and how it ends now', !(await review.isVisible()))
  const nowRow = await pRow.innerText()
  check('The list shows the new account, still waiting — nothing was verified unseen', nowRow.includes('5544') && nowRow.includes('Waiting for a check'), nowRow.replace(/\n/g, ' '))
  const stored = (await api('acc', 'GET', '/payroll/bank-accounts')).body.data.find((r) => r.employee_id === E.priya.id).bank_account
  check('…and the server agrees', stored.verification_status === 'pending' && stored.account_number === '998877665544')

  // ═══════════════════════════════════════════════════════════════════════
  section('Printing the payroll report on A4')
  await sa.goto(`${BASE}/reports`)
  await sa.locator('div.rounded-xl.p-5', { hasText: 'Monthly Payroll' }).getByRole('button', { name: 'Open & export' }).click()
  const panel = sa.getByRole('dialog', { name: 'Monthly Payroll' })
  await panel.getByLabel('Month').selectOption({ label: 'August 2026' })
  await panel.locator('table').waitFor()
  await sa.waitForTimeout(800)
  const pdfPath = `${DL}/payroll-report.pdf`
  await sa.emulateMedia({ media: 'print' })
  await sa.pdf({ path: pdfPath, preferCSSPageSize: true, printBackground: true })
  const text = readFileSync(pdfPath).toString('latin1')
  const box = text.match(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/)
  check('The PDF is A4 landscape (842 × 595 points)', box && Number(box[1]) > Number(box[2]) && Math.round(Number(box[1])) === 842, box?.[0])
  // At the printed width, nothing is cut off at the right.
  await sa.setViewportSize({ width: 1047, height: 740 })
  await sa.waitForTimeout(800)
  const fit = await sa.evaluate(() => {
    const area = document.querySelector('.print-area')
    const table = area?.querySelector('table')
    return table ? { table: table.scrollWidth, area: area.clientWidth } : null
  })
  check('At A4 landscape width the thirteen columns fit — net pay is not cut off', fit && fit.table <= fit.area + 1, JSON.stringify(fit))
  await sa.setViewportSize({ width: 718, height: 1000 })
  await sa.waitForTimeout(800)
  const portrait = await sa.evaluate(() => {
    const area = document.querySelector('.print-area')
    const table = area?.querySelector('table')
    return table ? { table: table.scrollWidth, area: area.clientWidth } : null
  })
  console.log('INFO  on portrait A4 width the table would be', JSON.stringify(portrait), '(why the page is set to landscape)')
  await sa.emulateMedia({ media: 'screen' })
  await sa.setViewportSize({ width: 1366, height: 900 })

  // ═══════════════════════════════════════════════════════════════════════
  section('HR on a phone: choosing a person brings their documents into view')
  const phone = await open('hr', { width: 390, height: 844 })
  await phone.goto(`${BASE}/documents?tab=employees`)
  await phone.locator('div.max-h-140').getByRole('button', { name: /Neha Joshi/ }).click()
  await phone.getByText('Required verified', { exact: true }).waitFor()
  await phone.waitForTimeout(1200)
  const head = await phone.locator('p.text-sm.font-bold', { hasText: 'Neha Joshi' }).first().boundingBox()
  check('Tapping Neha brings her checklist up to the top of the screen', head && head.y >= 0 && head.y < 300, JSON.stringify(head))
  check('No sideways scroll on the phone', await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1))
  await shot(phone, '04-phone-hr-checklist')
} catch (err) {
  console.error('\n' + err.message)
  process.exitCode = 1
  for (const { who, page } of openPages) {
    if (page.isClosed()) continue
    await page.screenshot({ path: `${SHOTS}/FAILED-${who}.png`, fullPage: true }).catch(() => undefined)
    console.error(`  [${who}] ${page.url()}`)
  }
} finally {
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed`)
  console.log('page errors:', pageErrors.length ? pageErrors : 'none')
  await browser.close()
}
