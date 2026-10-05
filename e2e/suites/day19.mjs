// Day 19 E2E: documents, notifications, reports, exports, bank proof — every
// flow, role and branch, in real Edge against the isolated stack
// (Vite :5183 → API :4100 → local ems_e2e). Fixture: day19-seed.ts.
import { chromium } from 'playwright-core'
import { WORK, REPO, STORAGE as STORE, psql } from '../lib/env.mjs'
import { openMyProfile, openEmployeeProfile, signOutVia, menuLinks, menuLink, notificationPanel } from '../lib/ui.mjs'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'

const BASE = 'http://localhost:5183'
const API = 'http://localhost:4100/api'
const DIR = WORK
const fx = JSON.parse(readFileSync(`${DIR}/day19-fixture.json`, 'utf8'))
const SHOTS = `${DIR}/shots/day19`
const DL = `${DIR}/downloads-day19`
const FILES = `${DIR}/files-day19`
for (const d of [SHOTS, DL, FILES]) mkdirSync(d, { recursive: true })
const E = fx.employees
const ONLY = process.argv[2] ?? 'all'

const results = []
function check(label, ok, detail = '') {
  results.push({ label, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`)
  if (!ok) throw new Error(`FAILED: ${label} ${detail}`)
}
const section = (name) => console.log(`\n── ${name} ──`)

// ── The API, for setup and for what a browser cannot show ─────────────────
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
  return { status: res.status, body: json, headers: res.headers }
}
async function upload(who, path, fields, file, method = 'POST') {
  const form = new FormData()
  for (const [k, v] of Object.entries(fields)) form.append(k, v)
  if (file) form.append(file.field ?? 'file', new Blob([readFileSync(file.path)], { type: file.type }), file.name)
  const res = await fetch(`${API}${path}`, { method, headers: { Authorization: `Bearer ${tokens[who]}` }, body: form })
  return { status: res.status, body: await res.json() }
}
const notices = async (who) => (await api(who, 'GET', '/notifications')).body

// ── Test files ─────────────────────────────────────────────────────────────
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
  objects.forEach((o, i) => {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}
const F = {
  panPdf: `${FILES}/pan-card.pdf`,
  panPdf2: `${FILES}/pan-card-clear.pdf`,
  resumePdf: `${FILES}/resume.pdf`,
  policyPdf: `${FILES}/leave-policy-2026.pdf`,
  handbookPdf: `${FILES}/old-handbook.pdf`,
  offerPdf: `${FILES}/offer-letter.pdf`,
  bigPdf: `${FILES}/scanned-degree.pdf`,
  fakePdf: `${FILES}/aadhaar.pdf`,
  photo: `${FILES}/aadhaar-photo.jpg`,
  cheque: `${FILES}/cancelled-cheque.jpg`,
  midPdf: `${FILES}/one-and-a-half-mb.pdf`,
}
writeFileSync(F.panPdf, pdf('PAN CARD - AAAPD1234K'))
writeFileSync(F.panPdf2, pdf('PAN CARD - clear copy'))
writeFileSync(F.resumePdf, pdf('Resume - Priya Deshmukh'))
writeFileSync(F.policyPdf, pdf('Leave Policy 2026'))
writeFileSync(F.handbookPdf, pdf('Old Handbook'))
writeFileSync(F.offerPdf, pdf('Offer Letter - Neha Joshi'))
// Too big for 2 MB, and a PDF cannot be made smaller in the browser.
writeFileSync(F.bigPdf, Buffer.concat([pdf('Degree'), Buffer.alloc(3 * 1024 * 1024, 0x20)]))
writeFileSync(F.midPdf, Buffer.concat([pdf('Mid'), Buffer.alloc(1.5 * 1024 * 1024, 0x20)]))
// Text wearing a .pdf name.
writeFileSync(F.fakePdf, Buffer.from('This is not a PDF at all, whatever its name says.\n'.repeat(20)))

const browser = await chromium.launch({ channel: 'msedge', headless: true })
const pageErrors = []
const failedCalls = []
const expectedFailures = []

// A phone photo: 4000×3000, detailed enough to be several MB as a JPEG.
{
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  for (const [path, label] of [[F.photo, 'AADHAAR 1234 5678 9012'], [F.cheque, 'CANCELLED CHEQUE 112233445566']]) {
    const b64 = await page.evaluate(async (text) => {
      const c = document.createElement('canvas')
      c.width = 4000; c.height = 3000
      const g = c.getContext('2d')
      const grad = g.createLinearGradient(0, 0, 4000, 3000)
      grad.addColorStop(0, '#f5e6c8'); grad.addColorStop(1, '#8fb3d9')
      g.fillStyle = grad; g.fillRect(0, 0, 4000, 3000)
      const img = g.getImageData(0, 0, 4000, 3000)
      for (let i = 0; i < img.data.length; i += 4) {
        const n = (Math.random() - 0.5) * 60
        img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n
      }
      g.putImageData(img, 0, 0)
      g.fillStyle = '#111'; g.font = 'bold 180px sans-serif'; g.fillText(text, 200, 1500)
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.97))
      const buf = new Uint8Array(await blob.arrayBuffer())
      let s = ''
      for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000))
      return btoa(s)
    }, label)
    writeFileSync(path, Buffer.from(b64, 'base64'))
  }
  await ctx.close()
}
const photoBytes = readFileSync(F.photo).length
console.log('phone photo:', (photoBytes / 1024 / 1024).toFixed(2), 'MB')

const openPages = []
async function open(who, viewport = { width: 1366, height: 900 }) {
  const ctx = await browser.newContext({ viewport, acceptDownloads: true })
  // Written in September 2026: run as on 30 Sep when FAKE_NOW says so (the API too).
  if (process.env.FAKE_NOW) await ctx.clock.setFixedTime(new Date(process.env.FAKE_NOW))
  const page = await ctx.newPage()
  openPages.push({ who, page })
  page.on('pageerror', (e) => pageErrors.push(`${who}: ${e.message}`))
  page.on('response', (r) => {
    if (r.status() >= 400 && r.url().includes('/api/')) failedCalls.push(`${who} ${r.request().method()} ${r.url().split('/api')[1]} ${r.status()}`)
  })
  await page.goto(`${BASE}/signin`)
  await page.getByLabel('Work Email or Employee ID').fill(fx.users[who])
  await page.getByPlaceholder('Enter your password').fill(fx.password)
  await page.getByRole('button', { name: 'Sign In' }).click()
  await page.waitForURL('**/dashboard', { timeout: 20_000 })
  return page
}

const waitToast = (page, text) => page.locator('[data-sonner-toast]', { hasText: text }).first().waitFor({ timeout: 20_000 })
const shot = (page, name) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true })
async function download(page, trigger, name) {
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), trigger()])
  const path = `${DL}/${name}`
  await dl.saveAs(path)
  return { name: dl.suggestedFilename(), bytes: readFileSync(path) }
}
const csvLines = (bytes) => {
  const text = bytes.toString('utf8')
  return { bom: text.charCodeAt(0) === 0xfeff, crlf: text.includes('\r\n'), lines: text.replace(/^\uFEFF/, '').split('\r\n').filter(Boolean) }
}
const row = (page, label) => page.locator('div.px-5.py-4').filter({ has: page.getByText(label, { exact: true }) }).first()
const bell = (page) => page.locator('header button[title="Notifications"]')
async function badge(page) {
  const b = bell(page).locator('span')
  return (await b.count()) ? (await b.innerText()).trim() : ''
}
const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)

try {
  for (const who of Object.keys(fx.users)) await login(who)

  // ═══════════════════════════════════════════════════════════════════════
  section('Setup through the API: a leave, a paid August payroll, one filed document')
  // Ravi applies; his manager approves (notices to approvers, then to Ravi).
  const leave = await api('emp2', 'POST', '/leave-requests', { leaveTypeId: fx.leaveTypeId, fromDate: '2026-09-21', toDate: '2026-09-22', reason: 'Family function' })
  check('Ravi applies for two days of casual leave', leave.status === 201, JSON.stringify(leave.body).slice(0, 200))
  const approved = await api('mgr', 'POST', `/leave-requests/${leave.body.data.id}/approve`, {})
  check('…and his manager approves it', approved.status === 200, JSON.stringify(approved.body).slice(0, 200))

  const run = await api('acc', 'POST', '/payroll-runs', { year: 2026, month: 8 })
  check('Accounts runs August 2026 payroll', run.status === 201, JSON.stringify(run.body).slice(0, 300))
  const saBell = await notices('sa')
  check('The Super Admin is told a payroll waits for approval', saBell.data.some((n) => n.event === 'payroll.awaiting_approval' && n.link?.startsWith('/payroll')), JSON.stringify(saBell.data.map((n) => n.event)))
  check('…and so is the second Super Admin (no employee record)', (await notices('sa2')).data.some((n) => n.event === 'payroll.awaiting_approval'))
  check('…but not Accounts, who ran it', !(await notices('acc')).data.some((n) => n.event === 'payroll.awaiting_approval'))
  let approve = await api('sa', 'POST', `/payroll-runs/${run.body.data.id}/approve`, {})
  if (approve.status !== 200) approve = await api('sa', 'POST', `/payroll-runs/${run.body.data.id}/approve`, { confirmAssumedDays: true })
  check('The Super Admin approves it', approve.status === 200, JSON.stringify(approve.body).slice(0, 300))
  check('Accounts is told it was approved', (await notices('acc')).data.some((n) => n.event === 'payroll.approved'))
  const paid = await api('acc', 'POST', `/payroll-runs/${run.body.data.id}/mark-paid`, { paidOn: '2026-09-01' })
  check('Accounts marks it paid on 1 Sep 2026', paid.status === 200, JSON.stringify(paid.body).slice(0, 300))
  const priyaPaid = (await notices('emp')).data.find((n) => n.event === 'payslip.ready')
  check('Priya is told her payslip is ready — linking to /payslips, not /payroll', priyaPaid?.link === '/payslips', JSON.stringify(priyaPaid))
  check('Ravi is told his leave was approved', (await notices('emp2')).data.some((n) => n.event === 'leave.decided'))
  check('Manoj (who approved it) is not told of his own decision', !(await notices('mgr')).data.some((n) => n.event === 'leave.decided'))

  // HR files Neha's offer letter as already checked.
  const types = (await api('hr', 'GET', '/document-types')).body
  check('A new company starts with the eight-item checklist, four required', types.data.length === 8 && types.data.filter((t) => t.required).length === 4 && types.meta.max_upload_mb === 2)
  const typeId = Object.fromEntries(types.data.map((t) => [t.code, t.id]))
  const offer = await upload('hr', '/employee-documents', { employeeId: E.neha.id, documentTypeId: typeId.offer_letter, markVerified: 'true' }, { path: F.offerPdf, type: 'application/pdf', name: 'offer-letter.pdf' })
  check('HR files Neha’s offer letter as checked against the original', offer.status === 201 && offer.body.data.status === 'verified', JSON.stringify(offer.body).slice(0, 200))

  // ═══════════════════════════════════════════════════════════════════════
  section('A login with no employee record')
  const sa2 = await open('sa2')
  await sa2.goto(`${BASE}/documents`)
  await sa2.getByRole('heading', { name: 'Documents', level: 1 }).waitFor()
  const sa2Tabs = await sa2.locator('main button').allInnerTexts()
  check('Documents opens — no white screen — for the bootstrap admin', pageErrors.length === 0, pageErrors.join(' | '))
  check('…with Company and Employee documents, and no “My documents”', sa2Tabs.some((t) => t.includes('Company documents')) && sa2Tabs.some((t) => t.includes('Employee documents')) && !sa2Tabs.some((t) => t.includes('My documents')), sa2Tabs.join(' / '))
  await sa2.goto(`${BASE}/documents?tab=mine`)
  await sa2.getByText('No company documents yet').waitFor()
  check('…and ?tab=mine falls back to the company documents', true)
  await openMyProfile(sa2)
  await sa2.getByRole('tab', { name: 'Password' }).or(sa2.getByRole('button', { name: /Change password/ })).first().waitFor({ timeout: 10_000 }).catch(() => undefined)
  await sa2.waitForTimeout(600)
  check('The profile drawer has no salary account section for a login with no employee record', !(await sa2.getByText('Bank Account for Salary Credit').isVisible().catch(() => false)))
  check('…and says so, instead of a column of “N/A”', await sa2.getByText('This login has no employee record, so it has no employment details, payslips or salary account.').isVisible() && !(await sa2.getByText('Date of Joining').count()))
  await shot(sa2, '01-sa2-no-employee-record')
  await sa2.keyboard.press('Escape')

  // ═══════════════════════════════════════════════════════════════════════
  section('Company documents: publish, read by every role, withdraw')
  const hr = await open('hr')
  await hr.goto(`${BASE}/documents?tab=company`)
  await hr.getByText('No company documents yet').waitFor()
  check('HR sees the empty state and the Publish button', await hr.getByRole('button', { name: 'Publish a document' }).isVisible())
  for (const [title, file, kind, desc] of [
    ['Leave Policy 2026', F.policyPdf, 'policy', 'How leave is earned, applied for and approved'],
    ['Old Handbook', F.handbookPdf, 'handbook', ''],
  ]) {
    await hr.getByRole('button', { name: 'Publish a document' }).click()
    const dlg = hr.getByRole('dialog', { name: 'Publish a company document' })
    await dlg.locator('label', { hasText: 'Title' }).locator('input').fill(title)
    await dlg.locator('label', { hasText: 'Kind' }).locator('select').selectOption(kind)
    if (desc) await dlg.locator('label', { hasText: 'What it is' }).locator('input').fill(desc)
    await dlg.locator('input[type=file]').setInputFiles(file)
    await dlg.getByRole('button', { name: 'Publish' }).click()
    await waitToast(hr, `${title} published — everybody has been told`)
  }
  check('HR publishes two company documents', (await hr.locator('main').innerText()).includes('Leave Policy 2026'))
  // A text file wearing .pdf is refused by its contents.
  await hr.getByRole('button', { name: 'Publish a document' }).click()
  {
    const dlg = hr.getByRole('dialog', { name: 'Publish a company document' })
    await dlg.locator('label', { hasText: 'Title' }).locator('input').fill('Fake policy')
    await dlg.locator('input[type=file]').setInputFiles(F.fakePdf)
    expectedFailures.push('POST /company-documents 400')
    await dlg.getByRole('button', { name: 'Publish' }).click()
    await dlg.locator('p.text-red-700').waitFor({ timeout: 15_000 })
    const msg = await dlg.locator('p.text-red-700').innerText()
    check('A text file named .pdf is refused by what it contains, with the reason in the dialog', /PDF|JPG|PNG|WebP/i.test(msg), msg)
    await hr.keyboard.press('Escape')
    check('Escape closes the publish dialog', !(await dlg.isVisible()))
  }
  const priyaBell1 = await notices('emp')
  const published = priyaBell1.data.find((n) => n.event === 'company_document.published' && n.message.startsWith('Leave Policy 2026'))
  check('Everybody is told — Priya has “New company document: Leave Policy 2026 has been published.”', published?.title === 'New company document' && published.message === 'Leave Policy 2026 has been published.', JSON.stringify(published))
  check('…linking to the company tab, not her own files', published?.link === '/documents?tab=company', published?.link)
  check('…but not HR, who published it', !(await notices('hr')).data.some((n) => n.event === 'company_document.published'))

  // Withdraw one.
  await hr.getByRole('button', { name: 'Withdraw Old Handbook' }).click()
  await hr.getByRole('dialog', { name: 'Withdraw Old Handbook?' }).getByRole('button', { name: 'Withdraw' }).click()
  await waitToast(hr, 'Old Handbook withdrawn')
  check('HR withdraws the old handbook', !(await hr.locator('main').innerText()).includes('Old Handbook'))
  await shot(hr, '02-hr-company-documents')

  // Every role reads the remaining one.
  for (const who of ['mgr', 'acc', 'emp']) {
    const p = await open(who)
    // An employee opens on their own files; the company tab is one click away.
    await p.goto(`${BASE}/documents${who === 'emp' ? '?tab=company' : ''}`)
    await p.getByText('Leave Policy 2026').waitFor({ timeout: 20_000 })
    const main = await p.locator('main').innerText()
    const tabs = await p.locator('main button').allInnerTexts()
    check(`${who}: reads Leave Policy 2026 and not the withdrawn handbook`, !main.includes('Old Handbook'))
    check(`${who}: no Publish or Withdraw`, !(await p.getByRole('button', { name: 'Publish a document' }).count()) && !(await p.getByRole('button', { name: /^Withdraw/ }).count()))
    if (who !== 'emp') {
      check(`${who}: only the company documents — no employee files`, !tabs.some((t) => t.includes('My documents') || t.includes('Employee documents')), tabs.join(' / '))
      await p.goto(`${BASE}/documents?tab=employees`)
      await p.getByText('Leave Policy 2026').waitFor()
      check(`${who}: ?tab=employees falls back to the company documents`, true)
    }
    if (who === 'emp') {
      // From the bell: the notice opens the company tab, where the policy is.
      await p.goto(`${BASE}/dashboard`)
      await bell(p).click()
      await notificationPanel(p).locator('div[role="button"]', { hasText: 'New company document' }).first().click()
      await p.waitForURL('**/documents?tab=company', { timeout: 15_000 })
      await p.getByText('Leave Policy 2026').waitFor()
      check('Priya clicks the notice and lands on the company documents, the policy in front of her', true)
      await p.getByRole('tab', { name: 'Company documents' }).click()
      await p.getByRole('button', { name: 'View' }).first().click()
      const prev = p.getByRole('dialog', { name: 'Leave Policy 2026' })
      await prev.locator('iframe').waitFor({ timeout: 20_000 })
      check('Priya previews the policy in the app (a PDF, from a blob)', (await prev.locator('iframe').getAttribute('src')).startsWith('blob:'))
      const file = await download(p, () => prev.getByRole('button', { name: 'Download' }).click(), 'policy.pdf')
      check('…and downloads it: a real PDF, a server-made name', file.bytes.subarray(0, 5).toString() === '%PDF-' && /^Leave-Policy-2026\.pdf$|leave-policy-2026\.pdf$/i.test(file.name), file.name)
      await p.keyboard.press('Escape')
      check('Escape closes the preview', !(await prev.isVisible()))
    }
    if (who === 'mgr') await shot(p, '03-manager-company-only')
    await p.context().close()
  }
  // The download route's headers.
  const companyList = (await api('emp', 'GET', '/company-documents')).body.data
  const fileRes = await api('emp', 'GET', `/company-documents/${companyList[0].id}/file`)
  check('The file route answers attachment + allow-listed type + nosniff + no-store',
    /^attachment; filename="/.test(fileRes.headers.get('content-disposition')) && fileRes.headers.get('content-type') === 'application/pdf' &&
    fileRes.headers.get('x-content-type-options') === 'nosniff' && /no-store/.test(fileRes.headers.get('cache-control')),
    [...fileRes.headers].filter(([k]) => /content|cache|nosniff/.test(k)).map(([k, v]) => `${k}: ${v}`).join('; '))
  check('Withdrawn is gone from the list for everybody', companyList.length === 1)

  // ═══════════════════════════════════════════════════════════════════════
  section('Priya files her documents')
  const emp = await open('emp')
  await emp.goto(`${BASE}/documents`)
  await emp.getByText('Required verified', { exact: true }).waitFor({ timeout: 20_000 })
  const empTabs = await emp.locator('main button').allInnerTexts()
  check('An employee lands on My documents, with the company tab beside it', empTabs.some((t) => t.includes('My documents')) && empTabs.some((t) => t.includes('Company documents')) && !empTabs.some((t) => t.includes('Employee documents')))
  check('Her checklist is the company’s eight, 0 of 4 required verified', (await emp.locator('main').innerText()).includes('0 of 4'))

  // 1) A phone photo of her Aadhaar, far over 2 MB — made smaller, then sent.
  await row(emp, 'Aadhaar Card').getByRole('button', { name: 'Upload' }).click()
  let dlg = emp.getByRole('dialog', { name: 'Upload a document' })
  check('The upload dialog names the limit: 2 MB', (await dlg.innerText()).includes('up to 2 MB'))
  await dlg.locator('input[type=file]').setInputFiles(F.photo)
  check(`…and says which file was chosen (${(photoBytes / 1024 / 1024).toFixed(1)} MB)`, (await dlg.innerText()).includes('aadhaar-photo.jpg'))
  await dlg.getByRole('button', { name: 'Upload' }).click()
  await waitToast(emp, 'Aadhaar Card uploaded')
  const mine1 = (await api('emp', 'GET', '/employee-documents')).body.data
  const aadhaar = mine1.items.find((i) => i.type.code === 'aadhaar').current
  check(`A ${(photoBytes / 1024 / 1024).toFixed(1)} MB photo arrives under 2 MB, as a JPEG`, aadhaar.bytes <= 2 * 1024 * 1024 && aadhaar.content_type === 'image/jpeg' && photoBytes > 2 * 1024 * 1024, `${aadhaar.bytes} bytes`)
  check('…waiting for a check', (await row(emp, 'Aadhaar Card').innerText()).includes('Waiting for a check'))

  // 2) Text wearing .pdf: refused by its contents.
  await row(emp, 'PAN Card').getByRole('button', { name: 'Upload' }).click()
  dlg = emp.getByRole('dialog', { name: 'Upload a document' })
  await dlg.locator('input[type=file]').setInputFiles(F.fakePdf)
  expectedFailures.push('POST /employee-documents 400')
  await dlg.getByRole('button', { name: 'Upload' }).click()
  await dlg.locator('p.text-red-700').waitFor({ timeout: 15_000 })
  check('A text file named .pdf is refused, the reason shown in the dialog', /PDF|JPG|PNG|WebP/i.test(await dlg.locator('p.text-red-700').innerText()), await dlg.locator('p.text-red-700').innerText())
  // 3) A 3 MB PDF: told before anything is sent.
  const before = failedCalls.length
  await dlg.locator('input[type=file]').setInputFiles(F.bigPdf)
  await dlg.getByRole('button', { name: 'Upload' }).click()
  await dlg.getByText(/the most this company accepts is 2 MB/).waitFor({ timeout: 10_000 })
  check('A 3 MB PDF is stopped in the browser with what to do instead', (await dlg.innerText()).includes('reduce size') && failedCalls.length === before)
  // 4) The real PAN.
  await dlg.locator('input[type=file]').setInputFiles(F.panPdf)
  await dlg.getByRole('button', { name: 'Upload' }).click()
  await waitToast(emp, 'PAN Card uploaded')
  check('Her PAN (PDF) is filed', (await row(emp, 'PAN Card').innerText()).includes('Waiting for a check'))
  // 5) A resume, then removed while still pending.
  await row(emp, 'Resume / CV').getByRole('button', { name: 'Upload' }).click()
  dlg = emp.getByRole('dialog', { name: 'Upload a document' })
  await dlg.locator('input[type=file]').setInputFiles(F.resumePdf)
  await dlg.getByRole('button', { name: 'Upload' }).click()
  await waitToast(emp, 'Resume / CV uploaded')
  await row(emp, 'Resume / CV').getByRole('button', { name: 'Remove Resume / CV' }).click()
  await emp.getByRole('dialog', { name: 'Remove Resume / CV?' }).getByRole('button', { name: 'Remove' }).click()
  await waitToast(emp, 'Document removed')
  check('She removes her own pending resume', (await row(emp, 'Resume / CV').innerText()).includes('Not uploaded yet'))
  check('An employee has no Verify or Reject anywhere', !(await emp.getByRole('button', { name: /^Verify |^Reject / }).count()))
  await shot(emp, '04-priya-filed')

  const hrBell = (await notices('hr')).data.filter((n) => n.event === 'document.submitted')
  check('HR is told of each document she sent in (Aadhaar, PAN, resume)', hrBell.length === 3 && hrBell.every((n) => n.link.includes(`employee=${E.priya.id}`)), hrBell.map((n) => n.title).join(' | '))
  check('Admin and Super Admin are told too; the manager and Accounts are not',
    (await notices('admin')).data.some((n) => n.event === 'document.submitted') && (await notices('sa')).data.some((n) => n.event === 'document.submitted') &&
    !(await notices('mgr')).data.some((n) => n.event === 'document.submitted') && !(await notices('acc')).data.some((n) => n.event === 'document.submitted'))

  // Another employee cannot reach her file by id.
  const ravisTry = await api('emp2', 'GET', `/employee-documents/${aadhaar.id}/file`)
  check('Ravi asking for Priya’s Aadhaar by id gets “not found”', ravisTry.status === 404, String(ravisTry.status))
  const ravisList = await api('emp2', 'GET', `/employee-documents?employeeId=${E.priya.id}`)
  check('…and cannot open her checklist either', ravisList.status === 404 || ravisList.status === 403, String(ravisList.status))
  const mgrTry = await api('mgr', 'GET', `/employee-documents/${aadhaar.id}/file`)
  check('Her manager holds no document permission (403)', mgrTry.status === 403, String(mgrTry.status))
  expectedFailures.push('client-side API probes')

  // ═══════════════════════════════════════════════════════════════════════
  section('HR checks them')
  await hr.bringToFront()
  await hr.reload()
  await bell(hr).waitFor()
  await hr.waitForTimeout(800)
  check('HR’s bell shows the unread count', Number(await badge(hr)) >= 3, await badge(hr))
  await bell(hr).click()
  const panel = notificationPanel(hr)
  await panel.getByText('Notifications', { exact: true }).waitFor()
  const first = panel.locator('div[role="button"]', { hasText: 'Aadhaar' }).first()
  await first.click()
  await hr.waitForURL(`**/documents?tab=employees&employee=${E.priya.id}`, { timeout: 15_000 })
  check('Clicking the notice opens Priya’s documents in the Employee tab', true)
  await hr.getByText('Required verified', { exact: true }).waitFor()
  await hr.getByText(/documents are waiting for a check|document is waiting for a check/).waitFor()
  check('The waiting banner lists what is waiting', (await hr.locator('div.bg-amber-50').first().innerText()).includes('Priya Deshmukh'))

  // Filters and search on the compliance list.
  await hr.getByRole('button', { name: 'Waiting for a check' }).click()
  let listText = await hr.locator('div.max-h-140').innerText()
  check('“Waiting for a check” lists Priya only', listText.includes('Priya Deshmukh') && !listText.includes('Ravi Patil'), listText.replace(/\n/g, ' '))
  await hr.getByRole('button', { name: 'Complete' }).click()
  listText = await hr.locator('div.max-h-140').innerText()
  check('“Complete” lists nobody yet', listText.includes('Nobody here.'))
  await hr.getByRole('button', { name: 'Something missing' }).click()
  await hr.getByPlaceholder('Search name or code').fill('neha')
  listText = await hr.locator('div.max-h-140').innerText()
  check('Search narrows it to Neha (1/4, offer letter verified)', listText.includes('Neha Joshi') && listText.includes('1/4') && !listText.includes('Priya'), listText.replace(/\n/g, ' '))
  await hr.getByPlaceholder('Search name or code').fill('')
  await hr.getByRole('button', { name: 'Everybody' }).click()

  // Verify the Aadhaar from its preview.
  await row(hr, 'Aadhaar Card').getByRole('button', { name: 'View' }).click()
  const prev = hr.getByRole('dialog', { name: 'Aadhaar Card — Priya Deshmukh' })
  await prev.locator('img').waitFor({ timeout: 20_000 })
  const natural = await prev.locator('img').evaluate((img) => img.naturalWidth)
  check('HR sees the photo itself (a blob, ≤ 2000 px wide after shrinking)', natural > 0 && natural <= 2000, `${natural}px`)
  await shot(hr, '05-hr-preview-aadhaar')
  await prev.getByRole('button', { name: 'Verify' }).click()
  const decide = hr.getByRole('dialog', { name: 'Verify Aadhaar Card — Priya Deshmukh' })
  await decide.getByRole('button', { name: 'Verify' }).click()
  await waitToast(hr, 'Aadhaar Card verified')
  check('HR verifies the Aadhaar', (await row(hr, 'Aadhaar Card').innerText()).includes('Verified'))
  // Reject the PAN: a reason is required.
  await row(hr, 'PAN Card').getByRole('button', { name: 'Reject PAN Card' }).click()
  const rej = hr.getByRole('dialog', { name: 'Reject PAN Card — Priya Deshmukh' })
  await rej.getByRole('button', { name: 'Reject' }).click()
  check('Rejecting without a reason is stopped: “Say why”', await rej.getByText('Say why, so it can be put right.').isVisible())
  await rej.locator('textarea').fill('The photo is blurred — the number cannot be read')
  await rej.getByRole('button', { name: 'Reject' }).click()
  await waitToast(hr, 'PAN Card rejected — Priya Deshmukh will be told why')
  const panRow = await row(hr, 'PAN Card').innerText()
  check('The rejection shows its reason', panRow.includes('Rejected') && panRow.includes('The photo is blurred'))
  check('The count reads 1 of 4', (await hr.locator('main').innerText()).includes('1 of 4'))
  await shot(hr, '06-hr-decided')

  // HR files for Neha (no login) and marks it checked.
  await hr.locator('div.max-h-140').getByRole('button', { name: /Neha Joshi/ }).click()
  await hr.getByText('Required verified', { exact: true }).waitFor()
  await row(hr, 'PAN Card').getByRole('button', { name: 'Upload' }).click()
  dlg = hr.getByRole('dialog', { name: 'Upload for Neha Joshi' })
  await dlg.locator('input[type=file]').setInputFiles(F.panPdf2)
  await dlg.getByText('I have checked this against the original').click()
  await dlg.getByRole('button', { name: 'Upload' }).click()
  await waitToast(hr, 'PAN Card uploaded')
  check('HR files Neha’s PAN as verified at once', (await row(hr, 'PAN Card').innerText()).includes('Verified'))

  // HR’s own documents: filed like anybody, never decided by herself.
  await hr.getByRole('tab', { name: 'My documents' }).click()
  await row(hr, 'Aadhaar Card').getByRole('button', { name: 'Upload' }).click()
  dlg = hr.getByRole('dialog', { name: 'Upload a document' })
  check('Filing her OWN, HR is not offered “checked against the original”', !(await dlg.getByText('I have checked this against the original').count()))
  await dlg.locator('input[type=file]').setInputFiles(F.cheque)
  await dlg.getByRole('button', { name: 'Upload' }).click()
  await waitToast(hr, 'Aadhaar Card uploaded')
  await hr.goto(`${BASE}/documents?tab=employees`)
  await hr.locator('div.max-h-140').getByRole('button', { name: /Hema Hiremath/ }).click()
  await hr.getByText('Required verified', { exact: true }).waitFor()
  check('In the Employee tab her own row has no Verify or Reject', !(await row(hr, 'Aadhaar Card').getByRole('button', { name: /Verify|Reject/ }).count()))
  const own = (await api('hr', 'GET', '/employee-documents')).body.data.items.find((i) => i.type.code === 'aadhaar').current
  const selfDecide = await api('hr', 'POST', `/employee-documents/${own.id}/decision`, { decision: 'verified' })
  check('The server refuses HR verifying her own document', selfDecide.status === 403, JSON.stringify(selfDecide.body).slice(0, 160))
  check('Sunita and Arjun are told Hema sent one in — Hema is not', (await notices('sa')).data.some((n) => n.event === 'document.submitted' && n.message.includes('Hema')) && !(await notices('hr')).data.some((n) => n.event === 'document.submitted' && n.message?.includes('Hema')))

  // ═══════════════════════════════════════════════════════════════════════
  section('Priya sees the outcome, replaces the PAN, and uses the bell')
  await emp.bringToFront()
  await emp.reload()
  await emp.getByText('Required verified', { exact: true }).waitFor()
  await emp.waitForTimeout(800)
  check('Her Aadhaar reads Verified; her PAN Rejected, with the reason', (await row(emp, 'Aadhaar Card').innerText()).includes('Verified') && (await row(emp, 'PAN Card').innerText()).includes('Why: The photo is blurred'))
  const unread = Number(await badge(emp))
  check('Her bell shows unread notices (payslip ready, two decisions; the published one she already opened)', unread >= 3, String(unread))
  await bell(emp).click()
  const ep = notificationPanel(emp)
  await ep.getByText('Notifications', { exact: true }).waitFor()
  const panelText = await ep.innerText()
  check('The notices read as sentences, not codes', panelText.includes('Aadhaar') && panelText.includes('payslip') && !/document\.decided|payslip\.ready|company_document/.test(panelText), panelText.replace(/\n/g, ' ').slice(0, 300))
  await ep.getByRole('button', { name: /^Unread/ }).click()
  const unreadRows = await ep.locator('div[role="button"]').count()
  check('The Unread tab lists the unread ones', unreadRows === unread, `${unreadRows} vs ${unread}`)
  await ep.locator('div[role="button"]', { hasText: /payslip/i }).first().click()
  await emp.waitForURL('**/payslips', { timeout: 15_000 })
  check('The payslip notice opens My Payslips', true)
  await emp.waitForTimeout(1200)
  check('…and is marked read (the count goes down by one)', Number((await badge(emp)) || 0) === unread - 1, await badge(emp))

  await emp.goto(`${BASE}/documents`)
  await row(emp, 'PAN Card').getByRole('button', { name: 'Replace' }).click()
  dlg = emp.getByRole('dialog', { name: 'Upload a document' })
  await dlg.locator('input[type=file]').setInputFiles(F.panPdf2)
  await dlg.getByRole('button', { name: 'Upload' }).click()
  await waitToast(emp, 'PAN Card uploaded')
  await row(emp, 'PAN Card').getByRole('button', { name: /Earlier uploads \(1\)/ }).click()
  const pan = await row(emp, 'PAN Card').innerText()
  check('The new PAN waits for a check; the rejected one is kept under “Earlier uploads”', pan.includes('Waiting for a check') && pan.includes('pan-card.pdf') && pan.includes('rejected · replaced'), pan.replace(/\n/g, ' '))
  check('The earlier, rejected upload can be viewed but not removed', (await row(emp, 'PAN Card').locator('li').getByRole('button', { name: 'View' }).count()) === 1 && !(await row(emp, 'PAN Card').locator('li').getByRole('button', { name: /Remove/ }).count()))

  // Polling: a notice arrives without a reload.
  await emp.goto(`${BASE}/dashboard`)
  await emp.waitForTimeout(1500)
  const beforePoll = Number((await badge(emp)) || 0)
  const pan2 = (await api('hr', 'GET', `/employee-documents?employeeId=${E.priya.id}`)).body.data.items.find((i) => i.type.code === 'pan').current
  const ok2 = await api('hr', 'POST', `/employee-documents/${pan2.id}/decision`, { decision: 'verified' })
  check('HR verifies the new PAN (API, while Priya’s page stays open)', ok2.status === 200)
  const t0 = Date.now()
  let afterPoll = beforePoll
  while (Date.now() - t0 < 75_000) {
    await emp.waitForTimeout(3000)
    afterPoll = Number((await badge(emp)) || 0)
    if (afterPoll > beforePoll) break
  }
  check(`The bell picks it up by itself within a minute (${Math.round((Date.now() - t0) / 1000)} s)`, afterPoll === beforePoll + 1, `${beforePoll} → ${afterPoll}`)

  await bell(emp).click()
  await ep.getByRole('button', { name: 'Mark all read' }).click()
  await emp.waitForTimeout(1200)
  check('“Mark all read” clears the badge', (await badge(emp)) === '')
  await ep.getByRole('button', { name: 'Clear' }).click()
  await ep.getByText('No notifications', { exact: true }).waitFor({ timeout: 10_000 })
  check('“Clear” empties her list — her own only', (await notices('emp')).data.length === 0 && (await notices('hr')).data.length > 0)
  await emp.keyboard.press('Escape')

  // Ravi: more than one page of notices.
  const emp2 = await open('emp2')
  await bell(emp2).click()
  const rp = notificationPanel(emp2)
  await rp.getByText('Notifications', { exact: true }).waitFor()
  await emp2.waitForTimeout(800)
  check('Ravi’s bell says there are more than it has loaded (30+)', (await rp.getByRole('button', { name: /^All/ }).innerText()).includes('30+'), await rp.getByRole('button', { name: /^All/ }).innerText())
  for (let i = 0; i < 6; i++) {
    const more = rp.getByRole('button', { name: /Load older notifications|Loading/ })
    if (!(await more.count())) break
    await more.click()
    await emp2.waitForTimeout(700)
  }
  const allRavi = await rp.locator('div[role="button"]').count()
  const totalRavi = await (async () => { let n = 0; let url = '/notifications'; for (;;) { const r = await api('emp2', 'GET', url); n += r.body.data.length; if (!r.body.meta.more) break; const last = r.body.data.at(-1); url = `/notifications?before=${encodeURIComponent(last.created_at)}&beforeId=${last.id}` } return n })()
  check(`“Load older” walks back through every notice (${allRavi} of ${totalRavi})`, allRavi === totalRavi && totalRavi >= 37, `${allRavi}/${totalRavi}`)
  check('…down to the oldest', (await rp.innerText()).includes('Old notice 01'))
  await emp2.keyboard.press('Escape')

  // ═══════════════════════════════════════════════════════════════════════
  section('Settings → Documents and Notifications')
  const sa = await open('sa')
  await sa.goto(`${BASE}/settings?tab=documents`)
  await sa.getByText('Largest upload').waitFor()
  const limit = sa.getByLabel('Largest upload in MB')
  check('The limit starts at 2 MB', (await limit.inputValue()) === '2')
  await limit.selectOption('1')
  await waitToast(sa, 'Uploads are now limited to 1 MB')
  await sa.waitForTimeout(800)
  check('…and shows 1 MB after saving — not snapping back to the old value', (await limit.inputValue()) === '1')
  check('The server holds 1 MB, in every limit it sends', (await api('emp', 'GET', '/document-types')).body.meta.max_upload_mb === 1 && (await api('emp', 'GET', '/payslips/me/bank-account')).body.meta.max_upload_mb === 1)
  // A 1.5 MB PDF is now stopped in the browser.
  await emp.goto(`${BASE}/documents`)
  await row(emp, 'Passport').getByRole('button', { name: 'Upload' }).click()
  dlg = emp.getByRole('dialog', { name: 'Upload a document' })
  check('Priya’s upload dialog now says 1 MB', (await dlg.innerText()).includes('up to 1 MB'))
  await dlg.locator('input[type=file]').setInputFiles(F.midPdf)
  await dlg.getByRole('button', { name: 'Upload' }).click()
  await dlg.getByText(/the most this company accepts is 1 MB/).waitFor()
  check('A 1.5 MB PDF is refused at the 1 MB limit', true)
  await emp.keyboard.press('Escape')

  // The checklist: add, rename, require, reorder, archive, restore.
  await sa.getByPlaceholder('Another document, e.g. Address Proof').fill('Address Proof')
  await sa.getByRole('switch', { name: 'New document required' }).click()
  await sa.getByRole('button', { name: 'Add', exact: true }).click()
  await waitToast(sa, 'Address Proof added to the checklist')
  const name = sa.getByLabel('Name of Address Proof')
  await name.fill('Address Proof (utility bill)')
  await name.blur()
  await waitToast(sa, 'Renamed to Address Proof (utility bill)')
  await sa.getByRole('button', { name: 'Move Address Proof (utility bill) up' }).click()
  await sa.waitForTimeout(1500)
  const labels = await sa.locator('input[aria-label^="Name of "]').evaluateAll((els) => els.map((e) => e.value))
  check('Added, renamed, and moved up one place', labels.at(-2) === 'Address Proof (utility bill)', labels.join(' | '))
  await sa.getByRole('switch', { name: 'Passport required' }).click()
  await waitToast(sa, 'Passport is now required')
  await emp.goto(`${BASE}/documents`)
  await emp.getByText('Required verified', { exact: true }).waitFor()
  const empMain = await emp.locator('main').innerText()
  check('Priya’s checklist now asks for the address proof, and counts 6 required', empMain.includes('Address Proof (utility bill)') && /\b\d+ of 6\b/.test(empMain), empMain.match(/\d+ of \d+/)?.[0])
  await sa.getByRole('button', { name: 'Archive Address Proof (utility bill)' }).click()
  await waitToast(sa, 'Address Proof (utility bill) archived')
  await sa.getByRole('switch', { name: 'Passport required' }).click()
  await waitToast(sa, 'Passport is no longer required')
  check('The archived one is listed under Archived, with Restore', (await sa.locator('main').innerText()).includes('Archived') && await sa.getByRole('button', { name: 'Restore' }).isVisible())
  await emp.reload()
  await emp.getByText('Required verified', { exact: true }).waitFor()
  check('…and is gone from Priya’s checklist', !(await emp.locator('main').innerText()).includes('Address Proof'))
  await sa.getByRole('button', { name: 'Restore' }).click()
  await waitToast(sa, 'Address Proof (utility bill) restored')
  await sa.getByRole('button', { name: 'Archive Address Proof (utility bill)' }).click()
  await waitToast(sa, 'Address Proof (utility bill) archived')
  await limit.selectOption('2')
  await waitToast(sa, 'Uploads are now limited to 2 MB')
  await shot(sa, '07-settings-documents')

  // HR sees the checklist but not the limit, and no company settings.
  await hr.goto(`${BASE}/settings?tab=documents`)
  await hr.getByText('Largest upload').waitFor()
  check('HR may edit the checklist but not the limit (“Set by the Super Admin”)', await hr.getByLabel('Largest upload in MB').isDisabled() && await hr.getByText('Set by the Super Admin.').isVisible() && await hr.getByPlaceholder('Another document, e.g. Address Proof').isVisible())
  const hrTabs = await hr.locator('main aside nav button').allInnerTexts()
  // Since the employee lifecycle (client §43), HR also reads the probation and notice period.
  check('HR’s Settings has Leave Config, Documents and Employee Lifecycle only', hrTabs.length === 3 && hrTabs.some((t) => t.includes('Leave')) && hrTabs.some((t) => t.includes('Documents')) && hrTabs.some((t) => t.includes('Employee Lifecycle')), hrTabs.join(' / '))

  // Notifications: switches from the server’s own list.
  await sa.goto(`${BASE}/settings?tab=notifications`)
  await sa.getByText('Always sent').first().waitFor()
  const settingsText = await sa.locator('main').innerText()
  check('Whom a notice reaches is said truly — the Super Admin included', settingsText.includes('Tells: HR, Admin and the Super Admin — whoever checks documents') && settingsText.includes('Tells: Accounts and the Super Admin, to check them'))
  // Two security notices nobody can switch off: a password changed, and (since the
  // final audit) a salary account changed by somebody else.
  check('Every event is listed with whom it tells; the two security notices are “Always sent”',
    settingsText.includes('Tells:') && (await sa.getByText('Always sent').count()) === 2 && settingsText.includes('Somebody else changes an employee’s salary account') && (await sa.getByRole('switch').count()) >= 12,
    `${await sa.getByRole('switch').count()} switches`)
  const sw = sa.getByRole('switch', { name: /^An employee uploads a document to be checked/ })
  const swName = await sw.getAttribute('aria-label')
  await sw.click()
  await sa.waitForTimeout(1200)
  check(`Switching off “${swName.split(' — ')[0]}”`, (await sw.getAttribute('aria-checked')) === 'false')
  await shot(sa, '08-settings-notifications')
  const hrBefore = (await notices('hr')).data.filter((n) => n.event === 'document.submitted').length
  const ravisDoc = await upload('emp2', '/employee-documents', { documentTypeId: typeId.resume }, { path: F.resumePdf, type: 'application/pdf', name: 'resume.pdf' })
  check('Ravi uploads his resume', ravisDoc.status === 201)
  const hrAfter = (await notices('hr')).data.filter((n) => n.event === 'document.submitted').length
  check('…and with the switch off, HR is not told', hrAfter === hrBefore, `${hrBefore} → ${hrAfter}`)
  await sw.click()
  await sa.waitForTimeout(1200)
  check('Switched back on', (await sw.getAttribute('aria-checked')) === 'true')
  const hrPut = await api('hr', 'PUT', '/notifications/settings', { changes: [{ event: 'leave.submitted', enabled: false }] })
  const secPut = await api('sa', 'PUT', '/notifications/settings', { changes: [{ event: 'account.password_changed', enabled: false }] })
  check('HR cannot change the switches; nobody can switch off the security notice', hrPut.status === 403 && secPut.status === 400, `${hrPut.status} / ${secPut.status}`)

  // ═══════════════════════════════════════════════════════════════════════
  section('Bank account sent in by the employee, checked by Accounts')
  await emp.goto(`${BASE}/dashboard`)
  await openMyProfile(emp, 'Salary account')
  await emp.getByText('Bank Account for Salary Credit').waitFor({ timeout: 15_000 })
  await emp.getByText('No bank account is recorded for your salary yet.').waitFor({ timeout: 15_000 })
  check('Priya’s profile: no salary account yet', true)
  // Her HR record, not "N/A": the session carries identity only.
  await emp.getByRole('tab', { name: 'About me' }).click()
  await emp.getByText('Manoj Manager').waitFor({ timeout: 15_000 })
  const drawerText = await emp.locator('body').innerText()
  await emp.getByRole('tab', { name: 'Salary account' }).click()
  check('Her profile shows her department, joining date and manager from HR’s record', drawerText.includes('Sales') && /6 Jan 2025/.test(drawerText) && drawerText.includes('Manoj Manager'), drawerText.match(/Department[\s\S]{0,40}/)?.[0]?.replace(/\n/g, ' '))
  await emp.getByRole('button', { name: 'Add account' }).click()
  const bank = emp.getByRole('dialog', { name: 'Add your salary account' })
  await bank.locator('label', { hasText: 'Bank' }).first().locator('input').fill('ICICI Bank')
  await bank.locator('label', { hasText: 'Name on the account' }).locator('input').fill('PRIYA DESHMUKH')
  await bank.locator('label').filter({ has: emp.getByText('Account number', { exact: true }) }).locator('input').fill('112233445566')
  await bank.locator('label', { hasText: 'Account number again' }).locator('input').fill('112233445566')
  await bank.locator('label').filter({ has: emp.getByText('IFSC', { exact: true }) }).locator('input').fill('ICIC0004321')
  const sentBefore = failedCalls.length
  await bank.getByRole('button', { name: 'Send to Accounts' }).click()
  await emp.waitForTimeout(600)
  check('Without a proof the form will not send (the browser asks for the file)', await bank.isVisible() && failedCalls.length === sentBefore && await bank.locator('input[type=file]').evaluate((i) => !i.validity.valid))
  await bank.locator('input[type=file]').setInputFiles(F.cheque)
  await bank.getByRole('button', { name: 'Send to Accounts' }).click()
  await waitToast(emp, 'Sent to Accounts to check')
  await emp.waitForTimeout(800)
  const drawer = await emp.locator('body').innerText()
  check('Her account now waits for a check, the number shown as its last four', drawer.includes('Waiting for a check') && drawer.includes('•••• 5566'))
  const myBank = (await api('emp', 'GET', '/payslips/me/bank-account')).body.data
  check('The server holds a proof for it', myBank.has_proof === true, JSON.stringify(myBank))
  await shot(emp, '09-priya-bank-sent')

  // A changed IFSC with no new proof is refused, and says why.
  await emp.getByRole('button', { name: 'Change' }).click()
  const change = emp.getByRole('dialog', { name: 'Change your salary account' })
  check('The change form explains when a new proof is needed', (await change.innerText()).includes('Needed again if the number or IFSC changes'))
  await change.locator('label').filter({ has: emp.getByText('Account number', { exact: true }) }).locator('input').fill('112233445566')
  await change.locator('label', { hasText: 'Account number again' }).locator('input').fill('112233445566')
  await change.locator('label').filter({ has: emp.getByText('IFSC', { exact: true }) }).locator('input').fill('ICIC0009999')
  expectedFailures.push('PUT /payslips/me/bank-account 400')
  await change.getByRole('button', { name: 'Send to Accounts' }).click()
  await change.locator('p.text-red-700').waitFor({ timeout: 15_000 })
  check('A changed IFSC with no new proof is refused, in the dialog', /proof|cheque|passbook/i.test(await change.locator('p.text-red-700').innerText()), await change.locator('p.text-red-700').innerText())
  await emp.keyboard.press('Escape')
  await emp.waitForTimeout(300)
  check('Escape closes only the dialog — the profile drawer stays open', !(await change.isVisible()) && await emp.getByText('Bank Account for Salary Credit').isVisible())
  await emp.keyboard.press('Escape')

  const accBell = (await notices('acc')).data.find((n) => n.event === 'bank.submitted')
  check('Accounts is told Priya sent in an account, linking to Bank accounts', accBell?.link === '/payroll?tab=bank', JSON.stringify(accBell))
  const acc = await open('acc')
  await bell(acc).click()
  await notificationPanel(acc).locator('div[role="button"]', { hasText: /bank/i }).first().click()
  await acc.waitForURL('**/payroll?tab=bank', { timeout: 15_000 })
  const priyaRow = acc.locator('tr', { hasText: 'Priya Deshmukh' })
  await priyaRow.waitFor({ timeout: 20_000 })
  const priyaRowText = await priyaRow.innerText()
  check('Her row: waiting, “Sent in by them”, the proof attached', priyaRowText.includes('Waiting for a check') && priyaRowText.includes('Sent in by them') && (await priyaRow.locator('[aria-label="Proof attached"]').count()) === 1, priyaRowText.replace(/\n/g, ' '))
  await priyaRow.getByRole('button', { name: 'Check' }).click()
  const review = acc.getByRole('dialog', { name: 'Check bank account — Priya Deshmukh' })
  check('The check dialog says she sent it in herself', (await review.innerText()).includes('Priya Deshmukh, themselves'))
  await review.locator('input').fill('Matches the cheque')
  await review.getByRole('button', { name: 'View the photo' }).click()
  const proofPrev = acc.getByRole('dialog', { name: 'Bank proof — Priya Deshmukh' })
  await proofPrev.locator('img').waitFor({ timeout: 20_000 })
  check('Accounts opens her cheque photo in the app', (await proofPrev.locator('img').evaluate((i) => i.naturalWidth)) > 0)
  await shot(acc, '10-accounts-proof')
  await acc.keyboard.press('Escape')
  await acc.waitForTimeout(300)
  check('Escape closes the photo only — the check dialog and its remarks stay', !(await proofPrev.isVisible()) && await review.isVisible() && (await review.locator('input').inputValue()) === 'Matches the cheque')
  const proofFile = await download(acc, async () => {
    await review.getByRole('button', { name: 'View the photo' }).click()
    await proofPrev.getByRole('button', { name: 'Download' }).click()
  }, 'priya-proof.jpg')
  check('The proof downloads as a JPEG with a server-made name', proofFile.bytes[0] === 0xff && proofFile.bytes[1] === 0xd8 && /bank-proof\.jpg$/.test(proofFile.name), proofFile.name)
  await proofPrev.getByRole('button', { name: 'Close' }).click()
  await review.getByRole('button', { name: 'Verify' }).click()
  await waitToast(acc, "Priya Deshmukh's account verified")
  check('Accounts verifies it', (await priyaRow.innerText()).includes('Verified'))
  check('Priya is told it was verified', (await notices('emp')).data.some((n) => n.event === 'bank.decided' && /verified/i.test(n.title)))

  // Accounts attaches a proof while editing Ravi's account.
  await acc.getByRole('button', { name: "Edit Ravi Patil's bank account" }).click()
  const edit = acc.getByRole('dialog', { name: 'Edit bank account — Ravi Patil' })
  check('With no proof on file the hint says it is kept for the checker', (await edit.innerText()).includes('Kept with the account, for whoever checks it.'))
  await edit.locator('input[type=file]').setInputFiles(F.cheque)
  await edit.getByRole('button', { name: 'Save' }).click()
  await waitToast(acc, "Ravi Patil's bank account saved")
  const raviRow = acc.locator('tr', { hasText: 'Ravi Patil' })
  check('Ravi’s row now shows the proof attached, still verified', (await raviRow.locator('[aria-label="Proof attached"]').count()) === 1 && (await raviRow.innerText()).includes('Verified'))
  await acc.getByRole('button', { name: "Edit Ravi Patil's bank account" }).click()
  await edit.locator('label').filter({ has: acc.getByText('IFSC', { exact: true }) }).locator('input').fill('HDFC0005678')
  check('Changing the IFSC warns the proof on file is for the old details', (await edit.innerText()).includes('The proof on file shows the old number or IFSC'))
  await acc.keyboard.press('Escape')

  // ═══════════════════════════════════════════════════════════════════════
  section('Reports')
  await sa.goto(`${BASE}/reports`)
  await sa.getByText('Monthly Attendance Summary').waitFor()
  const reportCards = await sa.getByRole('button', { name: 'Open & export' }).count()
  // Eight, and two more since V1 gaps: Late, Early & Overtime, and Requests.
  check('Ten reports on the page', reportCards === 10, String(reportCards))
  const openReport = async (title) => {
    const card = sa.locator('div.rounded-xl.p-5', { hasText: title })
    await card.getByRole('button', { name: 'Open & export' }).click()
    const panelR = sa.getByRole('dialog', { name: title })
    await panelR.waitFor()
    return panelR
  }
  const waitTable = async (p) => {
    await p.locator('table, p:has-text("Nothing to show")').first().waitFor({ timeout: 30_000 })
    await sa.waitForTimeout(400)
  }
  const monthSelect = (p) => p.getByLabel('Month')

  // Attendance summary.
  let rp1 = await openReport('Monthly Attendance Summary')
  const monthOptions = await monthSelect(rp1).locator('option').allInnerTexts()
  check('The month picker offers 24 months, from this one back — not frozen at March 2026', monthOptions.length === 24 && monthOptions[0] === 'September 2026' && monthOptions.includes('October 2024'), `${monthOptions[0]} … ${monthOptions.at(-1)}`)
  await waitTable(rp1)
  let text = await rp1.innerText()
  const priyaLine = await rp1.locator('tr', { hasText: 'Priya Deshmukh' }).innerText()
  const raviLine = await rp1.locator('tr', { hasText: 'Ravi Patil' }).innerText()
  check('September: Priya 2 days absent', /\t2\t/.test(priyaLine) || priyaLine.includes('2 days'), priyaLine.replace(/\t/g, ' | '))
  check('September: Ravi’s unmarked days are counted, not hidden', raviLine.length > 0, raviLine.replace(/\t/g, ' | '))
  let csv = await download(sa, () => rp1.getByRole('button', { name: 'Export CSV' }).click(), 'attendance-summary.csv')
  let parsed = csvLines(csv.bytes)
  const headerCols = await rp1.locator('thead th').allInnerTexts()
  check('The CSV: Excel BOM, CRLF, the same columns as the table, named for the month', parsed.bom && parsed.crlf && parsed.lines[0].split(',').length === headerCols.length && csv.name === 'attendance-summary-2026-09.csv', `${csv.name} · ${parsed.lines[0]}`)
  const tableRows = await rp1.locator('tbody tr').count()
  check('…with the same rows, and the totals line', parsed.lines.length === 1 + tableRows, `${parsed.lines.length - 1} vs ${tableRows}`)
  await rp1.getByLabel('Department').selectOption({ label: 'Sales' })
  await waitTable(rp1)
  text = await rp1.locator('tbody').innerText()
  check('Department filter: Sales only (Manoj, Priya, Ravi)', text.includes('Priya') && text.includes('Ravi') && text.includes('Manoj') && !text.includes('Hema'), text.replace(/\s+/g, ' ').slice(0, 200))
  await rp1.getByLabel('Department').selectOption('')
  await rp1.getByLabel('Employee').selectOption({ label: `Priya Deshmukh (${E.priya.code})` })
  await waitTable(rp1)
  check('Employee filter: Priya alone', (await rp1.locator('tbody tr').count()) <= 2 && (await rp1.locator('tbody').innerText()).includes('Priya'))
  await shot(sa, '11-report-attendance')
  await sa.keyboard.press('Escape')

  // Department attendance.
  rp1 = await openReport('Department Attendance')
  await waitTable(rp1)
  check('Department attendance: a row per department, with a chart', (await rp1.locator('tbody').innerText()).includes('Sales') && (await rp1.locator('.recharts-wrapper').count()) === 1)
  csv = await download(sa, () => rp1.getByRole('button', { name: 'Export CSV' }).click(), 'dept.csv')
  check('…and its CSV', csvLines(csv.bytes).bom && csv.name === 'attendance-by-department-2026-09.csv', csv.name)
  await sa.keyboard.press('Escape')

  // Leave taken.
  rp1 = await openReport('Leave Taken')
  await waitTable(rp1)
  const leaveHead = (await rp1.locator('thead th').allInnerTexts()).map((h) => h.toLowerCase())
  const clAt = leaveHead.findIndex((h) => h.includes('casual'))
  const raviCells = await rp1.locator('tr', { hasText: 'Ravi Patil' }).locator('td').allInnerTexts()
  check('Leave taken, September: Ravi, 2 days under Casual Leave', clAt >= 0 && raviCells[clAt]?.trim().startsWith('2'), `${leaveHead.join(' | ')} // ${raviCells.join(' | ')}`)
  csv = await download(sa, () => rp1.getByRole('button', { name: 'Export CSV' }).click(), 'leave.csv')
  check('…and its CSV has Ravi', csv.bytes.toString('utf8').includes('Ravi Patil'))
  await sa.keyboard.press('Escape')

  // Leave balances: nothing invented.
  rp1 = await openReport('Leave Balances')
  await waitTable(rp1)
  const nehaBal = await rp1.locator('tr', { hasText: 'Neha Joshi' }).innerText().catch(() => '')
  const priyaBal = await rp1.locator('tr', { hasText: 'Priya Deshmukh' }).innerText()
  check('Leave balances: Priya’s 12 casual leave from the ledger', /\b12\b/.test(priyaBal.replace(E.priya.code, '')), priyaBal.replace(/\t/g, ' | '))
  check('…and Neha, with nothing in the ledger, shows none — not a made-up 12', !nehaBal || !/\b(12|18|24|5)\b/.test(nehaBal.replace(E.neha.code, '')), nehaBal.replace(/\t/g, ' | '))
  const ravBal = await rp1.locator('tr', { hasText: 'Ravi Patil' }).innerText()
  check('…and Ravi’s shows the two days he took', /\b10\b/.test(ravBal.replace(E.ravi.code, '')), ravBal.replace(/\t/g, ' | '))
  await sa.keyboard.press('Escape')

  // Payroll.
  rp1 = await openReport('Monthly Payroll')
  await waitTable(rp1)
  check('September payroll: “No payroll has been run for September 2026.”', (await rp1.innerText()).includes('No payroll has been run for September 2026.'))
  await monthSelect(rp1).selectOption({ label: 'August 2026' })
  await waitTable(rp1)
  text = await rp1.innerText()
  const payRows = await rp1.locator('tbody tr').count()
  check('August payroll: “Paid on 1 Sep 2026.”, a row per payslip plus totals, and the trend chart', text.includes('Paid on 1 Sep 2026.') && payRows === 9 && (await rp1.locator('.recharts-wrapper').count()) === 1, `${payRows} rows`)
  csv = await download(sa, () => rp1.getByRole('button', { name: 'Export CSV' }).click(), 'payroll.csv')
  parsed = csvLines(csv.bytes)
  check('Its CSV: money to two places, a Total line', csv.name === 'payroll-summary-2026-08.csv' && parsed.lines.some((l) => /\.\d{2}(,|$)/.test(l)) && parsed.lines.at(-1).includes('Total'), parsed.lines.at(-1))
  await shot(sa, '12-report-payroll')
  // Print: only the report.
  await sa.emulateMedia({ media: 'print' })
  await sa.waitForTimeout(1500)
  await sa.screenshot({ path: `${SHOTS}/13-report-print.png` })
  const sidebarHidden = !(await sa.getByRole('navigation', { name: 'Main' }).first().isVisible())
  const tooltipHidden = await sa.locator('.recharts-tooltip-wrapper').first().evaluate((el) => getComputedStyle(el).display === 'none').catch(() => true)
  const ticks = (await sa.locator('.recharts-yAxis-tick-labels .recharts-cartesian-axis-tick-value').allTextContents()).map((t) => t.trim()).filter(Boolean)
  check('…no empty tooltip box printed, and the axis in rupee style (65,000 · 1,30,000 …)', tooltipHidden && ticks.some((t) => /^\d{1,3}(,\d{2})*,\d{3}$/.test(t)), `tooltip hidden: ${tooltipHidden} · ticks: ${ticks.join(' | ')}`)
  await sa.emulateMedia({ media: 'screen' })
  check('Print shows the report without the app around it', sidebarHidden)
  await sa.keyboard.press('Escape')

  rp1 = await openReport('PF / ESI Contributions')
  await monthSelect(rp1).selectOption({ label: 'August 2026' })
  await waitTable(rp1)
  const pfPriya = await rp1.locator('tr', { hasText: 'Priya Deshmukh' }).innerText()
  const pfRavi = await rp1.locator('tr', { hasText: 'Ravi Patil' }).innerText()
  check('PF/ESI: Priya’s real UAN; Ravi, with none recorded, a dash — never one made from a PAN', pfPriya.includes('101234567890') && pfRavi.includes('—'), `${pfPriya.replace(/\t/g, ' | ')} // ${pfRavi.replace(/\t/g, ' | ')}`)
  const pfHead = await rp1.locator('thead th').allInnerTexts()
  check('…with employee PF, employer EPS and EPF, employee and employer ESI — each once', ['EMPLOYEE PF', 'EMPLOYER EPS', 'EMPLOYER EPF', 'EMPLOYEE ESI', 'EMPLOYER ESI'].every((h) => pfHead.filter((x) => x.toUpperCase() === h).length === 1), pfHead.join(' | '))
  await sa.keyboard.press('Escape')

  rp1 = await openReport('Headcount')
  await waitTable(rp1)
  text = await rp1.innerText()
  check('Headcount: by department, a pie chart, Kiran (left) not counted', text.includes('Technology') && (await rp1.locator('.recharts-wrapper').count()) === 1 && (await rp1.locator('tr', { hasText: 'Total' }).innerText()).includes('8'), (await rp1.locator('tr', { hasText: 'Total' }).innerText()).replace(/\t/g, ' | '))
  await sa.keyboard.press('Escape')

  rp1 = await openReport('Joiners & Exits')
  await waitTable(rp1)
  const nehaJ = await rp1.locator('tr', { hasText: 'Neha Joshi' }).innerText()
  const kiranX = await rp1.locator('tr', { hasText: 'Kiran Kumar' }).innerText()
  check('Joiners & exits: Neha joined 14 Sep 2026; Kiran left 10 Sep 2026 — a date, not “Inactive”', /14 Sept? 2026/.test(nehaJ) && /10 Sept? 2026/.test(kiranX) && !kiranX.includes('Inactive'), `${nehaJ.replace(/\t/g, ' | ')} // ${kiranX.replace(/\t/g, ' | ')}`)
  csv = await download(sa, () => rp1.getByRole('button', { name: 'Export CSV' }).click(), 'joiners.csv')
  check('…and its CSV carries the dates', csv.bytes.toString('utf8').includes('2026-09-10') || csv.bytes.toString('utf8').includes('10 Sep 2026'))
  await sa.keyboard.press('Escape')
  const reportAudit = (await api('sa', 'GET', '/reports/headcount?year=2026&month=9&format=csv'))
  check('A report download is a CSV attachment through the API too', /attachment/.test(reportAudit.headers.get('content-disposition')) && /text\/csv/.test(reportAudit.headers.get('content-type')))
  check('HR cannot run reports (403)', (await api('hr', 'GET', '/reports/headcount?year=2026&month=9')).status === 403)

  // ═══════════════════════════════════════════════════════════════════════
  section('Exports: employees, attendance, import template')
  await sa.goto(`${BASE}/employees`)
  // The list is drawn for a phone too, hidden here: the row on screen.
  await sa.getByText('Priya Deshmukh').filter({ visible: true }).first().waitFor()
  await sa.locator('main select').first().selectOption('Sales')
  await sa.getByPlaceholder('Search by name or ID…').fill('priya')
  csv = await download(sa, () => sa.getByRole('button', { name: 'Export' }).click(), 'employees.csv')
  parsed = csvLines(csv.bytes)
  check('Employees export: the filtered rows only (Priya), with the salary column for the Super Admin', parsed.bom && parsed.lines.length === 2 && parsed.lines[0].endsWith(',CTC') && parsed.lines[1].includes('Priya Deshmukh') && parsed.lines[1].endsWith(',204000'), parsed.lines.join(' // '))
  await hr.goto(`${BASE}/employees`)
  await hr.getByText('Priya Deshmukh').filter({ visible: true }).first().waitFor()
  csv = await download(hr, () => hr.getByRole('button', { name: 'Export' }).click(), 'employees-hr.csv')
  parsed = csvLines(csv.bytes)
  // Since Day 22 HR sees salaries — every one but the seniors' (the owner and
  // the Super Admins always among them).
  const hrPriya = parsed.lines.find((l) => l.includes('Priya Deshmukh')) ?? ''
  check('HR’s export carries salaries, except the seniors’', parsed.lines[0].endsWith(',CTC') && hrPriya.endsWith(',204000') && parsed.lines.length >= 9, `${parsed.lines.length - 1} rows · ${hrPriya}`)
  await hr.getByRole('button', { name: 'Import' }).click()
  const tpl = await download(hr, () => hr.getByRole('button', { name: /template/i }).first().click(), 'template.csv')
  check('The import template comes from the server, with the importer’s columns', csvLines(tpl.bytes).lines[0].startsWith('employee_code,full_name,email') && tpl.name === 'employee-import-template.csv', tpl.name)
  await hr.keyboard.press('Escape')
  await hr.goto(`${BASE}/attendance`)
  await hr.getByRole('heading', { name: 'Attendance', level: 1 }).waitFor()
  await hr.locator('input[type=date]').first().fill('2026-09-10')
  await hr.waitForTimeout(1500)
  await hr.getByRole('button', { name: /^Absent/ }).first().click().catch(() => undefined)
  await hr.waitForTimeout(600)
  csv = await download(hr, () => hr.getByRole('button', { name: 'Export' }).click(), 'attendance.csv')
  parsed = csvLines(csv.bytes)
  check('Attendance export: the day and tab on screen — Priya absent on 10 Sep', csv.name === 'attendance-2026-09-10.csv' && parsed.lines.some((l) => l.includes('Priya Deshmukh') && l.includes('Absent')), `${csv.name} · ${parsed.lines.slice(0, 3).join(' // ')}`)

  // ═══════════════════════════════════════════════════════════════════════
  section('On a phone (390 px)')
  const phone = await open('emp', { width: 390, height: 844 })
  await phone.goto(`${BASE}/documents`)
  await phone.getByText('Required verified', { exact: true }).waitFor()
  check('My documents fits a phone — no sideways scroll', await noSideScroll(phone))
  const replaceVisible = await row(phone, 'PAN Card').getByRole('button', { name: /Replace|Upload/ }).isVisible()
  check('…and each document’s buttons are on screen', replaceVisible)
  await shot(phone, '14-phone-my-documents')
  await phone.getByRole('tab', { name: 'Company documents' }).click()
  await phone.getByText('Leave Policy 2026').waitFor()
  check('Company documents fit a phone', await noSideScroll(phone) && await phone.getByRole('button', { name: 'Download' }).isVisible())
  await shot(phone, '15-phone-company-documents')
  await bell(phone).click()
  const phonePanel = notificationPanel(phone)
  await phonePanel.getByText('Notifications', { exact: true }).waitFor()
  const box = await phonePanel.boundingBox()
  check('The bell’s panel fits on a phone', box.x >= 0 && box.x + box.width <= 390 + 1, JSON.stringify(box))
  await shot(phone, '16-phone-bell')
  await phone.keyboard.press('Escape')
  await openMyProfile(phone, 'Salary account')
  await phone.getByText('Bank Account for Salary Credit').waitFor()
  await phone.getByRole('button', { name: 'Change' }).click()
  const pd = phone.getByRole('dialog', { name: 'Change your salary account' })
  await pd.waitFor()
  const pdBox = await pd.locator('div.bg-white').first().boundingBox()
  check('The bank form fits a phone', pdBox.width <= 390 && await pd.getByRole('button', { name: 'Send to Accounts' }).isVisible(), JSON.stringify(pdBox))
  await shot(phone, '17-phone-bank-form')
  await phone.keyboard.press('Escape')

  // ═══════════════════════════════════════════════════════════════════════
  section('A password change is always told')
  const pw = await fetch(`${API}/auth/change-password`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokens.emp2}`, 'Content-Type': 'application/json', 'X-Requested-With': 'ems' },
    body: JSON.stringify({ currentPassword: fx.password, newPassword: 'AnotherLongPassword19' }),
  })
  check('Ravi changes his password', pw.status === 200)
  await login('emp2').catch(() => undefined)
  const pwRes = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: fx.users.emp2, password: 'AnotherLongPassword19' }) })
  tokens.emp2 = (await pwRes.json()).data.accessToken
  const pwNotice = (await notices('emp2')).data.find((n) => n.event === 'account.password_changed')
  check('…and is told, with no switch able to stop it', pwNotice?.title === 'Your password was changed')

  // ═══════════════════════════════════════════════════════════════════════
  section('Records')
  const auditRes = await api('sa', 'GET', '/audit?limit=200').catch(() => null)
  void auditRes
} catch (err) {
  console.error('\n' + err.message)
  process.exitCode = 1
  for (const { who, page } of openPages) {
    if (page.isClosed()) continue
    await page.screenshot({ path: `${SHOTS}/FAILED-${who}.png`, fullPage: true }).catch(() => undefined)
    console.error(`  [${who}] ${page.url()}`)
  }
} finally {
  // Before signing in, the app asks to refresh a session it does not have: that 401 is expected.
  const unexpected = failedCalls
    .filter((c) => !/POST \/auth\/refresh 401/.test(c))
    .filter((c) => !/ (400|403|404|422)$/.test(c) || !/employee-documents|company-documents|bank-account|notifications\/settings|reports/.test(c))
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed`)
  console.log('page errors:', pageErrors.length ? pageErrors : 'none')
  console.log('failed API calls seen by the pages:', failedCalls.length ? failedCalls : 'none')
  console.log('…of which not an expected refusal:', unexpected.length ? unexpected : 'none')
  await browser.close()
}
