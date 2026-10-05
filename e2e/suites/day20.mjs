// Day 20 E2E — every page as every role (Role_Permission_Documentation §10),
// and everything Day 20 added: DataState errors, error boundaries, the 404
// page, confirm dialogs, the audit log, leave withdraw/reverse, headers/CSP.
//
// Runs against the PRODUCTION build: serve-prod.mjs on :5183 (web/dist with
// the nginx headers) → the compiled API (node dist/src/main.js,
// NODE_ENV=production) on :4100 → local ems_e2e. Fixture: day20-seed.ts.
import { chromium } from 'playwright-core'
import { WORK, REPO, STORAGE as STORE, psql } from '../lib/env.mjs'
import { openMyProfile, openEmployeeProfile, signOutVia, menuLinks, menuLink } from '../lib/ui.mjs'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'

const BASE = 'http://localhost:5183'
const API = `${BASE}/api`
const DIR = WORK
const fx = JSON.parse(readFileSync(`${DIR}/day20-fixture.json`, 'utf8'))
const SHOTS = `${DIR}/shots/day20`
const DL = `${DIR}/downloads-day20`
const FILES = `${DIR}/files-day20`
for (const d of [SHOTS, DL, FILES]) mkdirSync(d, { recursive: true })
const E = fx.employees
const ONLY = process.argv[2] ?? 'all'
const on = (name) => ONLY === 'all' || ONLY.split(',').includes(name)

const results = []
function check(label, ok, detail = '') {
  results.push({ label, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`)
  if (!ok) throw new Error(`FAILED: ${label} ${detail}`)
}
const section = (name) => console.log(`\n── ${name} ──`)

// ── The API, for setup and for what a browser cannot show ─────────────────
const tokens = {}
const signedInAt = {}
const signedInAs = {}
async function login(who, identifier = fx.users[who]) {
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier, password: fx.password }),
  })
  const body = await res.json()
  if (res.status !== 200) throw new Error(`login ${who}: ${res.status} ${JSON.stringify(body)}`)
  tokens[who] = body.data.accessToken
  signedInAt[who] = Date.now()
  signedInAs[who] = identifier
  return res
}
// An access token lasts 15 minutes, and the whole suite can take longer on a
// busy machine. By age, never on a 401: a refusal the suite checks for must
// still show.
async function freshToken(who) {
  if (Date.now() - signedInAt[who] > 12 * 60_000) await login(who, signedInAs[who])
  return tokens[who]
}
async function api(who, method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { ...(who ? { Authorization: `Bearer ${await freshToken(who)}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { json = text }
  return { status: res.status, body: json, headers: res.headers }
}
async function upload(who, path, fields, file) {
  const form = new FormData()
  for (const [k, v] of Object.entries(fields)) form.append(k, v)
  form.append(file.field ?? 'file', new Blob([readFileSync(file.path)], { type: file.type }), file.name)
  const res = await fetch(`${API}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${await freshToken(who)}` }, body: form })
  return { status: res.status, body: await res.json() }
}

/** A setup call that must succeed; otherwise the run stops, saying which. */
function must(res, label) {
  if (res.status >= 300) throw new Error(`setup: ${label} → ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`)
  return res.body?.data
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
const F = { pan: `${FILES}/pan.pdf`, hrPan: `${FILES}/hr-pan.pdf`, fake: `${FILES}/fake.pdf` }
writeFileSync(F.pan, pdf('PAN - Ravi Patil'))
writeFileSync(F.hrPan, pdf('PAN - Hema Hiremath'))
writeFileSync(F.fake, Buffer.from('Just text wearing a .pdf name.\n'.repeat(30)))

// ── The browser ────────────────────────────────────────────────────────────
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const pageErrors = []
const cspViolations = []
const serverErrors = []
const openContexts = []

async function newPage(who, viewport = { width: 1366, height: 900 }) {
  const ctx = await browser.newContext({ viewport, acceptDownloads: true })
  openContexts.push(ctx)
  const page = await ctx.newPage()
  page.on('pageerror', (e) => pageErrors.push(`${who}: ${e.message}`))
  page.on('console', (m) => { if (m.type() === 'error' && /Content Security Policy|Refused to/i.test(m.text())) cspViolations.push(`${who}: ${m.text()}`) })
  await page.addInitScript(() => {
    window.__csp = []
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`))
  })
  page.on('response', (r) => { if (r.status() >= 500 && r.url().includes('/api/') && !page.__expect500) serverErrors.push(`${who} ${r.request().method()} ${r.url().split('/api')[1]} ${r.status()}`) })
  return page
}
async function signIn(page, identifier) {
  await page.goto(`${BASE}/signin`)
  await page.getByLabel('Work Email or Employee ID').fill(identifier)
  await page.getByPlaceholder('Enter your password').fill(fx.password)
  await page.getByRole('button', { name: 'Sign In' }).click()
  await page.waitForURL('**/dashboard', { timeout: 20_000 })
}
async function open(who, viewport) {
  const page = await newPage(who, viewport)
  await signIn(page, fx.users[who])
  return page
}
const shot = (page, name) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true })
const waitToast = (page, text) => page.locator('[data-sonner-toast]', { hasText: text }).first().waitFor({ timeout: 20_000 })
async function settle(page) {
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined)
  await page.getByText('Loading…', { exact: true }).first().waitFor({ state: 'detached', timeout: 20_000 }).catch(() => undefined)
}
async function download(page, trigger, name) {
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), trigger()])
  const path = `${DL}/${name}`
  await dl.saveAs(path)
  return { name: dl.suggestedFilename(), bytes: readFileSync(path) }
}
const bodyText = (page) => page.locator('main').innerText()
const noHorizontalScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)
const sidebarLinks = (page) => menuLinks(page)

// Which pages each role reaches — §9 of the role document, checked against navigation.js.
// "Home" and "Payslips" in the menu since the new look.
const PAGES = [
  ['/dashboard', 'Home'], ['/employees', 'Employees'], ['/attendance', 'Attendance'], ['/leave', 'Leave'],
  ['/requests', 'Requests'], ['/payroll', 'Payroll'], ['/payslips', 'Payslips'], ['/documents', 'Documents'], ['/reports', 'Reports'], ['/settings', 'Settings'],
]
const SIDEBAR = {
  sa: ['Home', 'Employees', 'Attendance', 'Leave', 'Requests', 'Payroll', 'Payslips', 'Documents', 'Reports', 'Settings'],
  sa2: ['Home', 'Employees', 'Attendance', 'Leave', 'Requests', 'Payroll', 'Payslips', 'Documents', 'Reports', 'Settings'],
  admin: ['Home', 'Employees', 'Requests', 'Payslips', 'Documents', 'Settings'],
  hr: ['Home', 'Employees', 'Attendance', 'Leave', 'Requests', 'Payroll', 'Payslips', 'Documents', 'Settings'],
  mgr: ['Home', 'Employees', 'Attendance', 'Leave', 'Requests', 'Payslips', 'Documents'],
  rm: ['Home', 'Employees', 'Attendance', 'Leave', 'Requests', 'Payslips', 'Documents'],
  acc: ['Home', 'Payroll', 'Payslips', 'Documents'],
  emp: ['Home', 'Attendance', 'Leave', 'Requests', 'Payslips', 'Documents'],
}
const SETTINGS_TABS = {
  // In the menu's groups since the new look: Organisation, People & access, Time & pay, Records.
  sa: ['Company', 'Organisation', 'Company Tree', 'Users & Roles', 'Roles & Permissions', 'Approvals', 'Employee Lifecycle', 'Leave Config', 'Payroll Config', 'Documents', 'Notifications', 'Audit Log'],
  admin: ['Leave Config', 'Documents'],
  hr: ['Employee Lifecycle', 'Leave Config', 'Documents'],
}

let lastDocId = null
try {
  // ════════════════════════════════════════════════════════════════════════
  if (on('headers')) {
    section('Security headers, 404s and the production build')
    const html = await fetch(`${BASE}/dashboard`)
    const h = html.headers
    check('The app page is served with a Content-Security-Policy', (h.get('content-security-policy') ?? '').includes("script-src 'self'") && h.get('content-security-policy').includes("frame-ancestors 'none'"))
    check('…and HSTS, nosniff, DENY framing, a referrer policy and a permissions policy',
      h.get('strict-transport-security')?.startsWith('max-age=31536000') && h.get('x-content-type-options') === 'nosniff' && h.get('x-frame-options') === 'DENY'
      && h.get('referrer-policy') === 'strict-origin-when-cross-origin' && (h.get('permissions-policy') ?? '').includes('geolocation=(self)'))
    check('index.html is never cached, so a deploy is picked up on the next load', h.get('cache-control') === 'no-cache')
    const missing = await fetch(`${BASE}/assets/does-not-exist-123.js`)
    check('A missing built file is a real 404, not the app', missing.status === 404)
    const asset = (await (await fetch(`${BASE}/`)).text()).match(/\/assets\/index-[^"]+\.js/)?.[0]
    const a = await fetch(`${BASE}${asset}`)
    check('A built file is cached for a year, immutable', a.status === 200 && a.headers.get('cache-control') === 'public, max-age=31536000, immutable', asset)
    const apiRes = await fetch(`${API}/auth/session`)
    check('The API answers in its own JSON with helmet’s headers, not the page’s CSP', apiRes.status === 401 && apiRes.headers.get('x-content-type-options') === 'nosniff'
      && !(apiRes.headers.get('content-security-policy') ?? '').includes('fonts.googleapis.com'))
    const health = await (await fetch('http://localhost:4100/health')).json()
    check('The API under test is the production build', health.data.env === 'production')
    const signinHtml = await (await fetch(`${BASE}/signin`)).text()
    const entry = readFileSync(`${REPO}/web/dist${signinHtml.match(/\/assets\/index-[^"]+\.js/)[0]}`, 'utf8')
    const preloads = [...signinHtml.matchAll(/modulepreload[^>]+href="([^"]+)"/g)].map((m) => m[1])
    const chartsPreloaded = preloads.some((p) => /ResponsiveContainer/.test(readFileSync(`${REPO}/web/dist${p}`, 'utf8')))
    check('The sign-in screen does not download the charts (pages are split)', !/ResponsiveContainer/.test(entry) && !chartsPreloaded, preloads.join(' '))
  }

  // ════════════════════════════════════════════════════════════════════════
  // Setup through the API: leave in every state, a document each side of the
  // scope line, and a few things to confirm or remove in Settings.
  for (const who of ['sa', 'hr', 'mgr', 'rm', 'emp', 'emp2', 'acc', 'admin']) await login(who)
  const cl = fx.leaveTypeId
  const priyaPending = must(await api('emp', 'POST', '/leave-requests', { leaveTypeId: cl, fromDate: '2026-10-19', toDate: '2026-10-20', reason: 'Family function' }), 'Priya applies')
  const priyaWithdrawn = must(await api('emp', 'POST', '/leave-requests', { leaveTypeId: cl, fromDate: '2026-11-02', toDate: '2026-11-02', reason: 'Changed my mind' }), 'Priya applies again')
  must(await api('emp', 'DELETE', `/leave-requests/${priyaWithdrawn.id}`), 'Priya withdraws')
  const raviApproved = must(await api('emp2', 'POST', '/leave-requests', { leaveTypeId: cl, fromDate: '2026-10-12', toDate: '2026-10-13', reason: 'Trip home' }), 'Ravi applies')
  const approveRavi = await api('rm', 'POST', `/leave-requests/${raviApproved.id}/approve`, {})
  must(approveRavi, 'Rekha approves Ravi')
  const manojOwn = must(await api('mgr', 'POST', '/leave-requests', { leaveTypeId: cl, fromDate: '2026-10-26', toDate: '2026-10-26', reason: 'Own errand' }), 'Manoj applies')
  // Manoj has nobody above him, so the Super Admin decides (Day 22: the company tree).
  const approveManoj = await api('sa', 'POST', `/leave-requests/${manojOwn.id}/approve`, {})
  must(approveManoj, 'The Super Admin approves Manoj')
  const types = must(await api('hr', 'GET', '/document-types'), 'document types')
  const panType = types.find((t) => t.code === 'pan')
  const raviDoc = await upload('hr', '/employee-documents', { employeeId: E.ravi.id, documentTypeId: panType.id }, { path: F.pan, type: 'application/pdf', name: 'pan.pdf' })
  const hemaDoc = await upload('hr', '/employee-documents', { employeeId: E.hema.id, documentTypeId: panType.id }, { path: F.hrPan, type: 'application/pdf', name: 'hr-pan.pdf' })
  lastDocId = must(raviDoc, 'HR uploads Ravi’s PAN').id
  must(hemaDoc, 'HR uploads her own PAN')
  must(await api('sa', 'POST', '/master-data/departments', { name: 'E2E Temp Dept' }), 'department')
  must(await api('sa', 'POST', '/master-data/shifts', { name: 'E2E Night', startTime: '22:00', endTime: '06:00', breakMinutes: 30, expectedHours: 7.5 }), 'shift')
  must(await api('sa', 'POST', '/settings/leave-types', { name: 'E2E Temp Leave', code: 'ETL', annualQuota: 2, isPaid: true }), 'leave type')
  must(await api('sa', 'POST', '/holidays', { name: 'E2E Temp Holiday', date: '2026-12-24', type: 'public' }), 'holiday')
  must(await api('sa', 'POST', '/users/invite', { email: `d20-${fx.stamp}-leaver@example.com`, role: 'employee' }), 'invite leaver')
  console.log('setup:', [approveRavi.status, approveManoj.status, raviDoc.status, hemaDoc.status].join(' '))

  // ════════════════════════════════════════════════════════════════════════
  if (on('roles')) {
    section('Every page as every role (§10 Permissions)')
    for (const who of Object.keys(SIDEBAR)) {
      const page = await open(who)
      await settle(page)
      const links = await sidebarLinks(page)
      check(`${who}: the sidebar shows exactly its modules`, JSON.stringify(links) === JSON.stringify(SIDEBAR[who]), links.join(', '))
      for (const [path, label] of PAGES) {
        if (SIDEBAR[who].includes(label)) {
          await page.goto(`${BASE}${path}`)
          await settle(page)
          const text = await bodyText(page)
          const csp = await page.evaluate(() => window.__csp)
          const fine = !text.includes('This page ran into a problem') && !text.includes('This could not be loaded') && !/\d{4}-\d{2}-\d{2}T\d{2}:/.test(text) && !/\bSept\b/.test(text)
          check(`${who}: ${label} opens and draws — no crash, no error view, no raw timestamps, no "Sept"`, page.url().endsWith(path) && fine && csp.length === 0,
            fine ? (csp.length ? `CSP: ${csp.join(' | ')}` : '') : text.slice(0, 300).replace(/\s+/g, ' '))
          await shot(page, `role-${who}-${label.replace(/\s+/g, '-').toLowerCase()}`)
        } else {
          await page.goto(`${BASE}${path}`)
          await page.waitForURL('**/dashboard', { timeout: 10_000 }).catch(() => undefined)
          check(`${who}: ${label} by address → sent to the dashboard`, page.url().endsWith('/dashboard'), page.url())
        }
      }
      if (SETTINGS_TABS[who]) {
        await page.goto(`${BASE}/settings`)
        await settle(page)
        const tabs = (await page.locator('aside.hidden.lg\\:block nav button').allInnerTexts()).map((s) => s.trim())
        check(`${who}: Settings shows exactly its tabs`, JSON.stringify(tabs) === JSON.stringify(SETTINGS_TABS[who]), tabs.join(', '))
      }
      await page.context().close()
    }

    section('Signing in (§10 Login)')
    {
      const page = await newPage('emp-by-code')
      await signIn(page, E.priya.code)
      check('An employee signs in with their Employee ID', page.url().endsWith('/dashboard'))
      await page.goto(`${BASE}/signin`)
      check('Signed in, the sign-in page goes to the dashboard', await page.waitForURL('**/dashboard', { timeout: 10_000 }).then(() => true, () => false))
      await signOutVia(page)
      await page.waitForURL('**/signin', { timeout: 10_000 })
      await page.goto(`${BASE}/leave`)
      await page.waitForURL('**/signin', { timeout: 10_000 })
      check('Signing out ends the session: a page by address goes to sign-in', page.url().endsWith('/signin'))
      await page.goBack()
      await page.waitForTimeout(800)
      check('…and Back does not bring the last person’s page back', page.url().endsWith('/signin') || !(await page.locator('main').count()))
      await page.getByLabel('Work Email or Employee ID').fill(fx.users.emp)
      await page.getByPlaceholder('Enter your password').fill('WrongPassword123')
      await page.getByRole('button', { name: 'Sign In' }).click()
      check('Wrong credentials say so', await page.getByText('Incorrect email or password').waitFor({ timeout: 10_000 }).then(() => true, () => false))
      await page.context().close()
    }
    {
      const page = await newPage('anon')
      await page.goto(`${BASE}/payroll`)
      await page.waitForURL('**/signin', { timeout: 10_000 })
      check('Signed out, any page goes to sign-in', page.url().endsWith('/signin'))
      await page.goto(`${BASE}/no-such-page`)
      await page.waitForURL('**/signin', { timeout: 10_000 })
      check('Signed out, an unknown address goes to sign-in too', page.url().endsWith('/signin'))
      await page.context().close()
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  if (on('negative')) {
    section('Refusals the server makes (§10 Negative and Security)')
    check('Accounts calling the attendance API → 403', (await api('acc', 'GET', '/attendance/day')).status === 403)
    check('HR inviting a user → 403', (await api('hr', 'POST', '/users/invite', { email: 'x@example.com', role: 'employee' })).status === 403)
    const me = (await api('sa', 'GET', '/users')).body.data.find((u) => u.user_id === fx.userIds.sa)
    const ownRole = await api('sa', 'PUT', `/users/${me.id}/role`, { role: 'hr' })
    const ownStatus = await api('sa', 'PATCH', `/users/${me.id}/status`, { status: 'inactive' })
    check('Super Admin changing their own role or status → refused', ownRole.status >= 400 && ownStatus.status >= 400, `${ownRole.status}/${ownStatus.status}`)
    const hrOwn = await api('hr', 'POST', `/employee-documents/${hemaDoc.body.data.id}/decision`, { decision: 'verified' })
    check('HR verifying their own document → refused', hrOwn.status === 403, `${hrOwn.status}`)
    check('An employee opening another employee’s document by id → not found', (await api('emp', 'GET', `/employee-documents/${lastDocId}/file`)).status === 404)
    check('A manager reaching payroll → 403', (await api('mgr', 'GET', '/payroll-runs')).status === 403)
    check('Unauthenticated API call → 401', (await api(null, 'GET', '/employees')).status === 401)
    const fake = await upload('emp', '/employee-documents', { documentTypeId: panType.id }, { path: F.fake, type: 'application/pdf', name: 'aadhaar.pdf' })
    check('A file that is not really a PDF is refused, whatever its name', [400, 415, 422].includes(fake.status) && /not one of those/.test(fake.body?.error?.message ?? ''), `${fake.status} ${fake.body?.error?.message}`)
    const hashes = psql(`SELECT count(*) FILTER (WHERE "passwordHash" LIKE '$2%$12$%'), count(*) FROM "User" WHERE email LIKE 'd20-${fx.stamp}-%' AND "passwordHash" IS NOT NULL`)
    const [bcrypt12, total] = hashes.split('|').map(Number)
    check('Passwords are stored as bcrypt hashes, cost 12', total > 0 && bcrypt12 === total, hashes)
    const rev = await api('mgr', 'POST', `/leave-requests/${manojOwn.id}/reverse`, {})
    check('A manager reversing their OWN approved leave → refused', rev.status === 403, `${rev.status} ${rev.body?.error?.message}`)
    check('Only Super Admin reads the audit log', (await api('hr', 'GET', '/audit-log')).status === 403 && (await api('admin', 'GET', '/audit-log')).status === 403
      && (await api('acc', 'GET', '/audit-log/export')).status === 403 && (await api('sa', 'GET', '/audit-log')).status === 200)
  }

  // ════════════════════════════════════════════════════════════════════════
  if (on('session')) {
    section('An expired access token is renewed without the person noticing (§10 Security)')
    const page = await open('hr')
    let failedOnce = false
    await page.route('**/api/employees', async (route) => {
      if (!failedOnce) {
        failedOnce = true
        return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Access token expired', requestId: 'test' } }) })
      }
      return route.continue()
    })
    const refreshed = page.waitForResponse((r) => r.url().endsWith('/api/auth/refresh') && r.status() === 200, { timeout: 15_000 })
    await page.goto(`${BASE}/employees`)
    await refreshed
    await settle(page)
    check('A 401 on a page’s request refreshes the session and the page loads', (await bodyText(page)).includes(E.ravi.name) && page.url().endsWith('/employees'))
    await page.unroute('**/api/employees')
    await page.context().close()
  }

  // ════════════════════════════════════════════════════════════════════════
  if (on('datastate')) {
    section('A failed request shows the failure — never an empty list (DataState)')
    const page = await open('hr')
    await page.route('**/api/leave-requests', (route) => route.fulfill({ status: 500, contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'INTERNAL', message: 'Something went wrong on our side.', requestId: 'req-e2e-500' } }) }))
    page.__expect500 = true
    await page.goto(`${BASE}/leave`)
    // The list is drawn twice — a table for a computer, cards for a phone — and
    // each says the error; the one on screen is the one that counts.
    const err = page.locator('main [role="alert"]', { hasText: 'This could not be loaded' }).filter({ visible: true })
    await err.waitFor({ timeout: 20_000 })
    const text = await bodyText(page)
    check('The error view says so, with the reference, and a Try again', text.includes('Something went wrong on our side.') && text.includes('Reference: req-e2e-500') && await err.getByRole('button', { name: 'Try again' }).isVisible())
    check('…and nowhere does it claim there are no requests, or show made-up counts', !text.includes('No leave requests found') && !text.includes('All requests are up to date') && !/\b0\s*\n?\s*Pending/.test(text))
    await shot(page, 'datastate-500')
    await page.unroute('**/api/leave-requests')
    page.__expect500 = false
    await err.getByRole('button', { name: 'Try again' }).click()
    await page.getByText(E.priya.name).filter({ visible: true }).first().waitFor({ timeout: 20_000 })
    check('Try again, once the server answers, shows the list', (await bodyText(page)).includes('Family function'))

    await page.route('**/api/leave-requests', (route) => route.abort('internetdisconnected'))
    await page.reload()
    await page.getByText('Could not reach the server').first().waitFor({ timeout: 30_000 })
    check('No connection at all reads "Could not reach the server", not "Failed to fetch"', !(await bodyText(page)).includes('Failed to fetch'))
    await page.unroute('**/api/leave-requests')

    await page.route('**/api/holidays**', (route) => route.fulfill({ status: 403, contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'FORBIDDEN', message: 'You do not have permission to do that.', requestId: 'req-e2e-403' } }) }))
    await page.reload()
    await page.getByRole('tab', { name: /Holiday Calendar/ }).click()
    const denied = page.locator('main [role="alert"]', { hasText: 'You do not have permission' })
    await denied.waitFor({ timeout: 20_000 })
    check('A refusal says so plainly, and offers no pointless Try again', !(await denied.getByRole('button', { name: 'Try again' }).count()))
    await page.unroute('**/api/holidays**')

    // A settings form whose data failed must not show blank fields to save over the real ones.
    const sa = await open('sa')
    await sa.route('**/api/settings/company', (route) => route.request().method() === 'GET'
      ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'INTERNAL', message: 'Down for a moment.', requestId: 'req-co' } }) })
      : route.continue())
    sa.__expect500 = true
    await sa.goto(`${BASE}/settings?tab=company`)
    await sa.getByText('Down for a moment.').first().waitFor({ timeout: 20_000 })
    check('Company settings that failed to load show the error, not an empty form with a Save', !(await sa.getByRole('button', { name: 'Save Changes' }).count()))
    await sa.unroute('**/api/settings/company')
    sa.__expect500 = false
    await sa.context().close()
    await page.context().close()
  }

  // ════════════════════════════════════════════════════════════════════════
  if (on('boundary')) {
    section('A page that breaks stays inside its box (error boundaries), and 404s')
    const page = await open('emp')
    // A page's code file gone after a deploy.
    const reportsLike = await page.evaluate(() => [...document.querySelectorAll('link[rel=modulepreload]')].map((l) => l.href))
    await page.route('**/assets/Leave-*.js', (route) => route.fulfill({ status: 404, contentType: 'text/html', body: 'gone' }))
    await menuLink(page, 'Leave').click()
    await page.getByText('A new version of EMS is available').waitFor({ timeout: 20_000 })
    check('A page whose code is gone after a deploy says "a new version", with Reload', await page.getByRole('button', { name: 'Reload' }).isVisible())
    check('…and the sidebar and top bar still work around it', await menuLink(page, 'Home').isVisible())
    await shot(page, 'boundary-new-version')
    await page.unroute('**/assets/Leave-*.js')
    await menuLink(page, 'Home').click()
    await page.waitForURL('**/dashboard')
    check('Choosing another page leaves the broken one behind', !(await page.getByText('A new version of EMS is available').count()))
    await page.getByRole('button', { name: 'Reload' }).count()

    // A page that throws while drawing: the payslip list answered with nothing usable.
    await page.route('**/api/payslips/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { unexpected: true }, meta: {} }) }))
    const errorsBefore = pageErrors.length
    // Loaded afresh: Home's payslip card already holds the real list, which the
    // page would show from memory without asking again.
    await page.goto(`${BASE}/payslips`)
    await page.getByText('This page ran into a problem').waitFor({ timeout: 20_000 })
    check('A page that throws shows "This page ran into a problem" with Try again and a way Home',
      await page.getByRole('button', { name: 'Try again' }).isVisible() && await page.getByRole('link', { name: 'Go to Home' }).isVisible())
    pageErrors.splice(errorsBefore) // the crash was provoked on purpose
    await shot(page, 'boundary-crash')
    await page.unroute('**/api/payslips/me')
    await page.getByRole('button', { name: 'Try again' }).click()
    await settle(page)
    check('Try again, once the answer is sound, draws the page', (await bodyText(page)).includes('My Payslips') && !(await page.getByText('This page ran into a problem').count()))

    await page.goto(`${BASE}/definitely/not/a/page`)
    await page.getByText('There is no page here').waitFor({ timeout: 20_000 })
    check('Signed in, an unknown address says there is no page, and names it', (await bodyText(page)).includes('/definitely/not/a/page') && await page.getByRole('link', { name: 'Go to Home' }).isVisible())
    await shot(page, 'not-found')
    await page.goto(`${BASE}/`)
    await page.waitForURL('**/dashboard')
    check('The bare address goes to the dashboard', page.url().endsWith('/dashboard'))
    await page.context().close()
  }

  // ════════════════════════════════════════════════════════════════════════
  if (on('leave')) {
    section('Leave: names, statuses, withdraw and reverse')
    const hr = await open('hr')
    await hr.goto(`${BASE}/leave`)
    await settle(hr)
    let text = await bodyText(hr)
    check('Each request names its employee, code and department (not "—")', text.includes(E.priya.name) && text.includes(E.ravi.name) && text.includes(E.priya.code))
    check('A withdrawn request is listed as Cancelled — the page no longer falls over on one', text.includes('Cancelled'))
    check('Leave types read as names, not codes', text.includes('Casual Leave') && !/\bCL\b/.test(text.replace(/CL\s*\(/g, '')))
    const typeOptions = await hr.locator('select').first().locator('option').allInnerTexts()
    check('The type filter offers the company’s own types', typeOptions.includes('Casual Leave'), typeOptions.join(', '))
    await hr.locator('select').first().selectOption({ label: 'Casual Leave' })
    check('…and filtering by one finds its requests', (await bodyText(hr)).includes('Family function'))
    await hr.locator('select').first().selectOption('all')
    await hr.getByRole('button', { name: 'cancelled', exact: true }).click()
    text = await bodyText(hr)
    check('The Cancelled filter shows only cancelled requests', text.includes('Changed my mind') && !text.includes('Family function'))
    await hr.getByRole('button', { name: 'All', exact: true }).click()
    check('The dead Export button is gone', !(await hr.locator('main').getByRole('button', { name: 'Export' }).count()))
    // HR sees Ravi's approved leave and cannot reverse it (Day 22): his
    // reporting manager, Rekha, does.
    check('HR is offered no Reverse — approving and cancelling follow the company tree',
      !(await hr.locator('tr', { hasText: 'Trip home' }).getByRole('button', { name: 'Reverse', exact: true }).count()))
    await hr.context().close()
    const rm = await open('rm')
    await rm.goto(`${BASE}/leave`)
    await settle(rm)
    const raviRow = rm.locator('tr', { hasText: 'Trip home' })
    await raviRow.getByRole('button', { name: 'Reverse', exact: true }).click()
    const rd = rm.getByRole('dialog', { name: `Reverse ${E.ravi.name}’s approved leave?` })
    await rd.waitFor()
    await rm.keyboard.press('Escape')
    check('Escape closes the reverse dialog and nothing happens', !(await rd.count()) && (await raviRow.innerText()).includes('Approved'))
    await raviRow.getByRole('button', { name: 'Reverse', exact: true }).click()
    await rd.getByRole('textbox').fill('Trip postponed')
    await shot(rm, 'leave-reverse-dialog')
    await rd.getByRole('button', { name: 'Reverse leave' }).click()
    await waitToast(rm, 'Leave reversed')
    await rm.waitForTimeout(500)
    check('Reversing turns the approved leave Cancelled', (await rm.locator('tr', { hasText: 'Trip home' }).innerText()).includes('Cancelled'))
    const bal = (await api('emp2', 'GET', '/leave-requests/balances')).body.data.balances.find((b) => b.code === 'CL')
    check('…and the days are back in Ravi’s balance', bal.available === 12, JSON.stringify(bal))
    await rm.context().close()

    const mgr = await open('mgr')
    await mgr.goto(`${BASE}/leave`)
    await settle(mgr)
    const own = mgr.locator('tr', { hasText: 'Own errand' })
    await own.waitFor({ timeout: 15_000 })
    check('A manager’s own approved leave offers no Reverse to them', !(await own.getByRole('button', { name: 'Reverse', exact: true }).count()))
    const priyaRow = mgr.locator('tr', { hasText: 'Family function' })
    await priyaRow.waitFor({ timeout: 15_000 })
    check('…while their report’s pending request offers Approve and Reject', await priyaRow.getByRole('button', { name: 'Approve', exact: true }).isVisible() && await priyaRow.getByRole('button', { name: 'Reject', exact: true }).isVisible())
    await mgr.context().close()

    const emp = await open('emp')
    await emp.goto(`${BASE}/leave`)
    await settle(emp)
    const mine = emp.locator('tr', { hasText: 'Family function' })
    await mine.getByRole('button', { name: 'Withdraw' }).waitFor({ timeout: 15_000 })
    const approveButtons = await emp.getByRole('button', { name: 'Approve', exact: true }).evaluateAll((els) => els.map((e) => e.outerHTML.slice(0, 160)))
    check('An employee sees Withdraw on their own pending request, and no Approve', await mine.getByRole('button', { name: 'Withdraw' }).isVisible() && approveButtons.length === 0, approveButtons.join(' | '))
    await mine.getByRole('button', { name: 'Withdraw' }).click()
    const wd = emp.getByRole('dialog', { name: 'Withdraw this leave request?' })
    check('The withdraw dialog names the leave and starts on Cancel', (await wd.innerText()).includes('Casual Leave') && await wd.getByRole('button', { name: 'Cancel' }).evaluate((b) => b === document.activeElement))
    await wd.getByRole('button', { name: 'Cancel' }).click()
    check('Cancel leaves it pending', (await mine.innerText()).includes('Pending'))
    await mine.getByRole('button', { name: 'Withdraw' }).click()
    await wd.getByRole('button', { name: 'Withdraw' }).click()
    await waitToast(emp, 'Leave request withdrawn')
    await emp.waitForTimeout(500)
    check('Withdrawing makes it Cancelled', (await emp.locator('tr', { hasText: 'Family function' }).innerText()).includes('Cancelled'))
    await shot(emp, 'leave-employee-after-withdraw')
    await emp.context().close()
  }

  // ════════════════════════════════════════════════════════════════════════
  if (on('confirms')) {
    section('Settings: the six confirmations, in the app’s own dialog')
    const sa = await open('sa')
    await sa.goto(`${BASE}/settings?tab=leave`)
    await settle(sa)
    await sa.getByTitle('Archive E2E Temp Leave').click()
    let d = sa.getByRole('dialog', { name: 'Archive E2E Temp Leave?' })
    await d.waitFor()
    await d.getByRole('button', { name: 'Cancel' }).click()
    check('Leave type: Cancel keeps it', await sa.getByTitle('Archive E2E Temp Leave').isVisible())
    await sa.getByTitle('Archive E2E Temp Leave').click()
    await d.getByRole('button', { name: 'Archive' }).click()
    await d.waitFor({ state: 'detached' })
    check('Leave type: Archive archives it', !(await sa.getByTitle('Archive E2E Temp Leave').count()))

    await sa.getByTitle('Remove E2E Temp Holiday').click()
    d = sa.getByRole('dialog', { name: /Remove E2E Temp Holiday on Thu, 24 Dec 2026\?/ })
    await d.waitFor()
    await sa.keyboard.press('Escape')
    check('Holiday: Escape keeps it', await sa.getByTitle('Remove E2E Temp Holiday').isVisible())
    await sa.getByTitle('Remove E2E Temp Holiday').click()
    await d.getByRole('button', { name: 'Remove' }).click()
    await d.waitFor({ state: 'detached' })
    check('Holiday: Remove removes it, and the day reads "Thu, 24 Dec" (not Sept-style)', !(await sa.getByTitle('Remove E2E Temp Holiday').count()))

    await sa.goto(`${BASE}/settings?tab=organisation`)
    await settle(sa)
    const deptRow = sa.locator('li, div.flex', { hasText: 'E2E Temp Dept' }).filter({ has: sa.getByTitle('Archive') }).last()
    await deptRow.getByTitle('Archive').click()
    d = sa.getByRole('dialog', { name: 'Archive the department "E2E Temp Dept"?' })
    await d.waitFor()
    await d.getByRole('button', { name: 'Archive' }).click()
    await d.waitFor({ state: 'detached' })
    check('Department: Archive archives it', !(await sa.locator('li, div.flex', { hasText: 'E2E Temp Dept' }).filter({ has: sa.getByTitle('Archive') }).count()))
    const shiftRow = sa.locator('tr', { hasText: 'E2E Night' })
    await shiftRow.getByTitle('Archive').click()
    d = sa.getByRole('dialog', { name: 'Archive the "E2E Night" shift?' })
    await d.waitFor()
    await d.getByRole('button', { name: 'Archive' }).click()
    await d.waitFor({ state: 'detached' })
    check('Shift: Archive archives it', !(await sa.locator('tr', { hasText: 'E2E Night' }).getByTitle('Archive').count()))

    await sa.goto(`${BASE}/settings?tab=users`)
    await settle(sa)
    const raviUser = sa.locator('tr', { hasText: fx.users.emp2 })
    await raviUser.getByTitle('Password reset link').click()
    d = sa.getByRole('dialog', { name: `Create a password reset link for ${fx.users.emp2}?` })
    await d.waitFor()
    await d.getByRole('button', { name: 'Create link' }).click()
    await d.waitFor({ state: 'detached' })
    check('Reset link: confirming creates the one-time link', await sa.getByText('/set-password#token=').first().isVisible().catch(() => false) || (await sa.locator('input[readonly]').count()) > 0)
    await sa.keyboard.press('Escape')
    const leaver = sa.locator('tr', { hasText: `d20-${fx.stamp}-leaver@example.com` })
    await leaver.getByTitle('Remove user').click()
    d = sa.getByRole('dialog', { name: new RegExp(`Remove .*leaver`) })
    await d.waitFor()
    check('Remove user starts on Cancel (a stray Enter does nothing)', await d.getByRole('button', { name: 'Cancel' }).evaluate((b) => b === document.activeElement))
    await d.getByRole('button', { name: 'Remove' }).click()
    await d.waitFor({ state: 'detached' })
    await sa.waitForTimeout(500)
    check('Remove user removes them', !(await sa.locator('tr', { hasText: `d20-${fx.stamp}-leaver@example.com` }).count()) || (await leaver.innerText()).match(/inactive|removed|turned off|left/i))
    await shot(sa, 'settings-users-after')
    await sa.context().close()
  }

  // ════════════════════════════════════════════════════════════════════════
  if (on('balances')) {
    section('Leave → Team Balances: granting the year, correcting a balance')
    const hr = await open('hr')
    await hr.goto(`${BASE}/leave`)
    await hr.getByRole('tab', { name: 'Team Balances' }).click()
    const banner = hr.getByText(/have not been given their 2026–27 leave yet|has not been given their 2026–27 leave yet/)
    await banner.waitFor({ timeout: 20_000 })
    const waitingText = await banner.innerText()
    check('HR is told who has not had the year’s leave, and that they cannot apply until then', /\d+ (people have|person has) not been given their 2026–27 leave yet/.test(waitingText), waitingText)
    const table = hr.locator('main table')
    check('Everybody on the books is listed, with each leave type', (await table.innerText()).includes(E.neha.name) && /earned leave/i.test(await table.innerText()))
    check('HR’s own row offers no correction', (await table.locator('tr', { hasText: E.hema.name }).innerText()).includes('Your own'))
    await shot(hr, 'balances-before-grant')

    await hr.getByRole('button', { name: 'Grant leave' }).click()
    const gd = hr.getByRole('dialog', { name: 'Grant the 2026–27 leave?' })
    await gd.getByText('Joined partway through the year').waitFor({ timeout: 20_000 })
    const gdText = await gd.innerText()
    check('The grant dialog says who gets what, naming the pro-rated joiner', gdText.includes(`${E.neha.name} · Casual Leave`) && gdText.includes('7 days'), gdText.replace(/\s+/g, ' ').slice(0, 300))
    await shot(hr, 'balances-grant-dialog')
    await gd.getByRole('button', { name: 'Grant leave' }).click()
    await waitToast(hr, 'Leave granted:')
    await hr.getByText('Everybody here has their 2026–27 leave.').waitFor({ timeout: 20_000 })
    check('After the grant, everybody has the year’s leave', true)
    // Columns by code: CL, CO, EL, SL, WFH.
    // Each type's cell: the days left first, then any "applied for" under it.
    const cells = (name) => table.locator('tr', { hasText: name }).locator('td.tabular-nums > span:first-child').allInnerTexts()
    const [neha, priya, kiran] = [await cells(E.neha.name), await cells(E.priya.name), await cells(E.kiran.name)]
    check('The joiner has the months that are left (7 of 12, 9 of 15); others the full year', JSON.stringify(neha) === '["7","0","9","7","0"]' && priya[0] === '12' && priya[3] === '12', `${neha} | ${priya}`)
    // The seed gave everybody Casual Leave before today; today's grant (Sick and Earned) must give Kiran none.
    check('Somebody who has already left is given nothing by the grant', kiran[2] === '0' && kiran[3] === '0', kiran.join(','))

    // A correction.
    await hr.getByRole('button', { name: `Correct ${E.ravi.name}’s balance` }).first().click()
    const cd = hr.getByRole('dialog', { name: `Correct ${E.ravi.name}’s leave — 2026–27` })
    await cd.waitFor()
    await cd.locator('select').selectOption({ label: 'Casual Leave' })
    await cd.getByPlaceholder('1 or 1.5').fill('0.3')
    check('Anything but whole or half days is refused before sending', await cd.getByText('Use whole or half days.').isVisible() && await cd.getByRole('button', { name: 'Save correction' }).isDisabled())
    await cd.getByPlaceholder('1 or 1.5').fill('1.5')
    check('Save waits for a reason', await cd.getByRole('button', { name: 'Save correction' }).isDisabled())
    await cd.getByPlaceholder(/Worked on a holiday/).fill('Worked on the Diwali weekend')
    check('The dialog shows the balance after the change', (await cd.innerText()).includes('After this: 13.5 days'), (await cd.innerText()).replace(/\s+/g, ' '))
    await shot(hr, 'balances-correct-dialog')
    await cd.getByRole('button', { name: 'Save correction' }).click()
    await waitToast(hr, `${E.ravi.name}: added 1.5 days of Casual Leave`)
    check('Saving closes the dialog, and the row shows the new balance', !(await cd.count()) && (await table.locator('tr', { hasText: E.ravi.name }).innerText()).includes('13.5'))

    await hr.getByRole('button', { name: `Correct ${E.ravi.name}’s balance` }).first().click()
    await cd.locator('select').selectOption({ label: 'Casual Leave' })
    await cd.getByLabel('Take days away').check()
    await cd.getByPlaceholder('1 or 1.5').fill('50')
    await cd.getByPlaceholder(/Worked on a holiday/).fill('Too many on purpose')
    check('Taking away more than there is is stopped before sending, saying how many can go', await cd.getByText('At most 13.5 days can be taken away').isVisible() && await cd.getByRole('button', { name: 'Save correction' }).isDisabled())
    await hr.keyboard.press('Escape')

    await hr.getByRole('button', { name: '2027–28' }).click()
    await hr.getByText(/not been given their 2027–28 leave yet/).waitFor({ timeout: 20_000 })
    check('Next year can be looked at, and granted ahead of time', true)
    await hr.context().close()

    const ravi = await open('emp2')
    const notice = (await api('emp2', 'GET', '/notifications')).body.data.find((n) => n.title.includes('1.5 days of Casual Leave added'))
    check('Ravi is told of the correction, with the reason', notice && notice.message.includes('Worked on the Diwali weekend') && notice.message.includes('13.5'), JSON.stringify(notice))
    await ravi.goto(`${BASE}/leave`)
    check('An employee has no Team Balances tab', !(await ravi.getByRole('tab', { name: 'Team Balances' }).count()))
    await ravi.getByRole('tab', { name: /Leave Balance/ }).click()
    await ravi.getByText('Casual Leave').first().waitFor({ timeout: 15_000 })
    check('…and sees the corrected balance on their own tab', (await ravi.locator('main').innerText()).includes('13.5'))
    await ravi.context().close()

    for (const [who, expected] of [['mgr', [E.manoj.name, E.priya.name]], ['rm', [E.rekha.name, E.ravi.name]]]) {
      const page = await open(who)
      await page.goto(`${BASE}/leave`)
      await page.getByRole('tab', { name: 'Team Balances' }).click()
      // The tab's own panel (the tab switches in a transition, so the last tab
      // stays on screen meanwhile), and its rows, not the "Loading…" one before them.
      const panel = page.getByRole('tabpanel', { name: 'Team Balances' })
      await panel.locator('tbody tr', { hasText: expected[0] }).first().waitFor({ timeout: 15_000 })
      // The name is the first line of the person's cell; their code is under it.
      const names = (await panel.locator('tbody tr td:first-child p:first-of-type').allInnerTexts()).sort()
      check(`${who}: Team Balances shows only their own team`, JSON.stringify(names) === JSON.stringify([...expected].sort()), names.join(', '))
      check(`${who}: …and offers no grant and no correction`, !(await page.getByRole('button', { name: 'Grant leave' }).count()) && !(await page.getByRole('button', { name: /^Correct / }).count()))
      await page.context().close()
    }

    const phone = await open('hr', { width: 390, height: 844 })
    await phone.goto(`${BASE}/leave`)
    await phone.getByRole('tab', { name: 'Team Balances' }).click()
    await phone.locator('main ul li').first().waitFor({ timeout: 15_000 })
    check('On a phone, Team Balances is cards and fits the screen', await noHorizontalScroll(phone))
    await shot(phone, 'balances-phone')
    await phone.context().close()

    const log = (await api('sa', 'GET', '/audit-log?category=time')).body.data.map((r) => r.summary)
    check('The audit log records the grant and the correction in words',
      log.some((s) => /^Granted the 2026–27 leave: /.test(s)) && log.some((s) => s.startsWith(`Added 1.5 days of Casual Leave to ${E.ravi.name}’s balance, now 13.5 — “Worked on the Diwali weekend”`)), log.slice(0, 4).join(' | '))
  }

  // ════════════════════════════════════════════════════════════════════════
  if (on('dashboard')) {
    section('Dashboards: real figures, names and colours')
    const emp = await open('emp')
    await settle(emp)
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date())
    let sundays = 0
    for (let d = 1; d <= Number(today.slice(8, 10)); d++) if (new Date(`${today.slice(0, 8)}${String(d).padStart(2, '0')}T00:00:00Z`).getUTCDay() === 0) sundays++
    // Home's "My month": each figure is its value over its label.
    const month = emp.getByRole('region', { name: 'My month' })
    const offLabel = month.getByText('Weekly off', { exact: true })
    await offLabel.waitFor({ timeout: 20_000 })
    const offs = await offLabel.locator('xpath=preceding-sibling::p[1]').innerText()
    check('The employee dashboard counts this month’s weekly offs from the rule, not a made-up 0', Number(offs) === sundays, `${offs} shown, ${sundays} Sundays so far`)
    await emp.context().close()
    await api('emp2', 'POST', '/leave-requests', { leaveTypeId: cl, fromDate: '2026-11-09', toDate: '2026-11-09', reason: 'Dashboard check' })
    const hr = await open('hr')
    await settle(hr)
    // HR decides none of it: Home's "Leave waiting" lists it, newest first, with who and what.
    const raviLeave = hr.getByRole('region', { name: 'Leave waiting' }).getByRole('listitem').filter({ hasText: E.ravi.name }).first()
    await raviLeave.waitFor({ timeout: 15_000 }).catch(() => undefined)
    const rowText = await raviLeave.innerText().catch(() => '')
    check('The HR dashboard’s pending leave names the person and the type', rowText.includes('Casual Leave') && !rowText.includes('Unknown'), rowText.replace(/\s+/g, ' '))
    // People by department: a bar each, each in a colour.
    const byDepartment = hr.locator('main div', { has: hr.getByText('By department', { exact: true }) }).last()
    const bars = await byDepartment.locator('li span[aria-hidden="true"] > span').evaluateAll((els) => els.map((e) => e.style.background))
    check('Every department’s bar has a colour', bars.length > 0 && bars.every((b) => b && b !== 'undefined'), bars.join(','))
    await shot(hr, 'dashboard-hr')
    await hr.context().close()
  }

  // ════════════════════════════════════════════════════════════════════════
  if (on('audit')) {
    section('The audit log (Settings → Audit Log)')
    // Things worth finding: a download, an export, a refused request.
    await api('hr', 'GET', `/employee-documents/${lastDocId}/file`)
    await fetch(`${API}/employees/export`, { headers: { Authorization: `Bearer ${await freshToken('hr')}` } })
    await api('emp', 'GET', '/payroll-runs')
    const sa = await open('sa')
    await sa.goto(`${BASE}/settings?tab=audit`)
    await settle(sa)
    let text = await bodyText(sa)
    check('It opens on the newest entries, in sentences', text.includes('Signed in') && text.includes(`Opened ${E.ravi.name}’s PAN Card`))
    check('Downloads, exports and refusals are there', text.includes('Exported the employee list') && text.includes('Was refused GET /api/payroll-runs'))
    check('No raw action codes or ISO timestamps on screen', !/\b[a-z]+\.[a-z]+_[a-z_]+\b/.test(text) && !/\d{4}-\d{2}-\d{2}T\d{2}/.test(text))
    await shot(sa, 'audit-log')
    await sa.getByLabel('Area').selectOption({ label: 'Sign-ins and sessions' })
    await settle(sa)
    const actions = await sa.locator('main tbody tr td:nth-child(3) span.font-medium').allInnerTexts()
    check('Area narrows to sign-ins only', actions.length > 0 && actions.every((a) => /Signed in|Sign-in refused|Signed out|Password|Copied session/.test(a)), [...new Set(actions)].join(', '))
    await sa.getByLabel('Area').selectOption('')
    await sa.getByLabel('Done by').selectOption({ label: E.hema.name })
    await settle(sa)
    const whos = await sa.locator('main tbody tr td:nth-child(2) span.font-medium').allInnerTexts()
    check('Done by narrows to one person', whos.length > 0 && whos.every((w) => w === E.hema.name), [...new Set(whos)].join(', '))
    await sa.getByRole('button', { name: 'Clear filters' }).click()
    await sa.getByLabel('About').selectOption({ label: `${E.ravi.name} (${E.ravi.code})` })
    await settle(sa)
    text = await bodyText(sa)
    check('About finds what happened to Ravi — his document, his leave reversed', text.includes(`${E.ravi.name}’s PAN Card`) && text.includes(`Reversed ${E.ravi.name}’s approved leave`))
    await sa.getByRole('button', { name: 'Clear filters' }).click()
    await sa.getByLabel('From').fill('2026-10-05')
    await sa.getByLabel('To').fill('2026-10-01')
    check('A range that ends before it starts is explained, not sent', await sa.getByText('The start date is after the end date').isVisible())
    await sa.getByRole('button', { name: 'Clear filters' }).click()
    await settle(sa)
    const more = sa.getByRole('button', { name: 'Load older entries' })
    if (await more.count()) {
      const before = await sa.locator('main tbody tr').count()
      await more.click()
      await sa.waitForFunction((n) => document.querySelectorAll('main tbody tr').length > n, before, { timeout: 15_000 })
      check('Load older adds the next page', (await sa.locator('main tbody tr').count()) > before)
    } else {
      check('Load older appears only when there is more (fewer than 50 entries now)', (await sa.locator('main tbody tr').count()) < 50)
    }
    const csv = await download(sa, () => sa.getByRole('button', { name: 'Export CSV' }).click(), 'audit.csv')
    const lines = csv.bytes.toString('utf8').replace(/^\uFEFF/, '').split('\r\n').filter(Boolean)
    check('Export CSV downloads the log in words, with a BOM', csv.bytes[0] === 0xef && lines[0] === 'When,Who,Their role,Area,Action,What happened,IP address,Device,Reference' && lines.length > 5, csv.name)
    await sa.getByRole('button', { name: 'Refresh' }).click()
    const exportRow = sa.locator('main tbody tr', { hasText: 'Exported the audit log' }).first()
    check('…and taking the export is itself in the log', await exportRow.waitFor({ timeout: 15_000 }).then(() => true, () => false))
    const exporter = await exportRow.locator('td').nth(1).innerText()
    check('…with the role they held when they did it (not a guess from today)', exporter.includes('Super Admin') && !exporter.includes('(now)'), exporter.replace(/s+/g, ' '))
    await sa.context().close()

    const phone = await open('sa', { width: 390, height: 844 })
    await phone.goto(`${BASE}/settings?tab=audit`)
    await settle(phone)
    check('On a phone the log is cards, readable without sideways scrolling', await noHorizontalScroll(phone) && await phone.locator('main ul li').first().isVisible())
    await shot(phone, 'audit-log-phone')
    await phone.context().close()
  }

  // ════════════════════════════════════════════════════════════════════════
  if (on('phone')) {
    section('Every page at phone width, for each role')
    for (const who of Object.keys(SIDEBAR)) {
      const page = await open(who, { width: 390, height: 844 })
      for (const [path, label] of PAGES.filter(([, l]) => SIDEBAR[who].includes(l))) {
        await page.goto(`${BASE}${path}`)
        await settle(page)
        const ok = await noHorizontalScroll(page)
        const crashed = (await bodyText(page)).includes('This page ran into a problem')
        check(`${who} on a phone: ${label} fits the screen`, ok && !crashed)
        if (['emp', 'mgr', 'acc'].includes(who)) await shot(page, `phone-${who}-${label.replace(/\s+/g, '-').toLowerCase()}`)
      }
      await page.context().close()
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  if (on('limiter')) {
    section('Sign-in limits: refreshes no longer use up the office’s sign-ins')
    let cookie = (await login('emp')).headers.get('set-cookie').split(';')[0]
    let ok = 0
    for (let i = 0; i < 110; i++) {
      const r = await fetch(`${API}/auth/refresh`, { method: 'POST', headers: { Cookie: cookie, 'X-Requested-With': 'ems', 'Content-Type': 'application/json' }, body: '{}' })
      if (r.status === 200) { ok++; cookie = r.headers.get('set-cookie').split(';')[0] }
    }
    check('110 refreshes in a row all succeed', ok === 110, `${ok}`)
    const after = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: fx.users.hr, password: fx.password }) })
    check('…and a sign-in straight after still works (the old limit would have answered 429)', after.status === 200, `${after.status}`)
  }

  check('No page threw an unexpected error during the whole run', pageErrors.length === 0, pageErrors.slice(0, 5).join(' | '))
  check('No Content-Security-Policy violation during the whole run', cspViolations.length === 0, cspViolations.slice(0, 5).join(' | '))
  check('No unexpected server error during the whole run', serverErrors.length === 0, serverErrors.slice(0, 5).join(' | '))
} catch (err) {
  console.error(err.message)
  process.exitCode = 1
} finally {
  for (const c of openContexts) await c.close().catch(() => undefined)
  await browser.close()
  const passed = results.filter((r) => r.ok).length
  console.log(`\n${passed}/${results.length} checks passed`)
}
