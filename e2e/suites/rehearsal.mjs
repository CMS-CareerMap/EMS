// The laptop rehearsal of the box (deploy/local/rehearse.sh), through the
// browser and over HTTPS: https://localhost:8443 → the stand-in edge Caddy →
// EMS's web container → the API container → PostgreSQL, all from the images
// that go to the client.
//
//   REHEARSAL_SA_PASSWORD='…' node suites/rehearsal.mjs
//
// It needs a rehearsal with its first Super Admin (superadmin@example.com
// unless REHEARSAL_SA_EMAIL says otherwise), and `docker` on the PATH. It adds
// one company document. It never touches the browser-test stack (:5183/:4100).
// Each run signs in four times (two of them wrong, on purpose); the sign-in
// limit allows ten in 15 minutes, so a third run soon after needs
// `docker compose restart api` in deploy/local/.box first.
//
// Checked: the page's security headers as production sends them (with
// upgrade-insecure-requests), caching, real 404s, the SPA fallback, the API's
// own headers; sign-in, the refresh cookie (Secure, HttpOnly, Lax, /api/auth)
// and a reload that keeps the session; every page of the Super Admin's menu,
// still signed in, with no error, no page error, no 5xx and no CSP violation;
// Home on a phone with no sideways scrolling; a file uploaded and read back
// byte for byte; the upload limits of the API and of the web container; the
// visitor's own address in the audit log, whatever X-Forwarded-For says;
// signing out.
import { chromium } from 'playwright-core'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { WORK } from '../lib/env.mjs'

const BASE = process.env.REHEARSAL_URL ?? 'https://localhost:8443'
const API = `${BASE}/api`
const EMAIL = process.env.REHEARSAL_SA_EMAIL ?? 'superadmin@example.com'
const PASSWORD = process.env.REHEARSAL_SA_PASSWORD
if (!PASSWORD) {
  console.error('Set REHEARSAL_SA_PASSWORD to the rehearsal Super Admin’s password.')
  process.exit(2)
}
const SHOTS = join(WORK, 'shots', 'rehearsal')
mkdirSync(SHOTS, { recursive: true })

let passed = 0
let failed = 0
function check(label, ok, detail = '') {
  if (ok) passed++
  else failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail && !ok ? '  — ' + detail : ''}`)
}
const section = (name) => console.log(`\n── ${name} ──`)

const browser = await chromium.launch({ channel: 'msedge', headless: true })
// The rehearsal's certificate is Caddy's own local one, which no browser trusts.
const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1366, height: 900 } })
const http = context.request

const cspViolations = []
const pageErrors = []
const serverErrors = []
context.on('page', (p) => watch(p))
function watch(page) {
  page.on('console', (m) => { if (m.type() === 'error' && /Content Security Policy|Refused to/i.test(m.text())) cspViolations.push(m.text()) })
  page.on('pageerror', (e) => pageErrors.push(e.message))
  page.on('response', (r) => { if (r.status() >= 500) serverErrors.push(`${r.status()} ${r.url()}`) })
}

try {
  // ════════════════════════════════════════════════════════════════════════
  section('The web container, through the edge')
  const index = await http.get(`${BASE}/dashboard`)
  const h = index.headers()
  check('The app page answers over HTTPS', index.status() === 200 && (await index.text()).includes('<div id="root">'))
  check('…with the production CSP, upgrade-insecure-requests included',
    (h['content-security-policy'] ?? '').includes("script-src 'self'") && h['content-security-policy'].includes("frame-ancestors 'none'") && h['content-security-policy'].includes('upgrade-insecure-requests'),
    h['content-security-policy'])
  check('…HSTS, nosniff, DENY framing, the referrer, permissions and opener policies',
    h['strict-transport-security'] === 'max-age=31536000; includeSubDomains' && h['x-content-type-options'] === 'nosniff' && h['x-frame-options'] === 'DENY'
    && h['referrer-policy'] === 'strict-origin-when-cross-origin' && (h['permissions-policy'] ?? '').includes('geolocation=(self)') && h['cross-origin-opener-policy'] === 'same-origin',
    JSON.stringify(h))
  check('index.html is never cached', h['cache-control'] === 'no-cache', h['cache-control'])

  const assetPath = (await (await http.get(`${BASE}/`)).text()).match(/\/assets\/index-[^"]+\.js/)?.[0]
  const asset = await http.get(`${BASE}${assetPath}`, { headers: { 'Accept-Encoding': 'gzip' } })
  check('A built file is cached for a year, immutable', asset.status() === 200 && asset.headers()['cache-control'] === 'public, max-age=31536000, immutable', `${assetPath} ${asset.status()} ${asset.headers()['cache-control']}`)
  check('…and sent compressed', ['gzip', 'zstd'].includes(asset.headers()['content-encoding']), asset.headers()['content-encoding'])
  check('…with the page’s headers too', asset.headers()['x-frame-options'] === 'DENY')

  const missing = await http.get(`${BASE}/assets/does-not-exist-123.js`)
  check('A missing built file is a real 404, cached by nobody', missing.status() === 404 && missing.headers()['cache-control'] === 'no-store', `${missing.status()} ${missing.headers()['cache-control']}`)
  const dot = await http.get(`${BASE}/.env`)
  const git = await http.get(`${BASE}/.git/config`)
  check('Dot-files are a plain 404, not the app', dot.status() === 404 && git.status() === 404 && !(await dot.text()).includes('id="root"'))
  const deep = await http.get(`${BASE}/employees/some-id?tab=salary`)
  check('Any other address is the app (the SPA fallback)', deep.status() === 200 && (await deep.text()).includes('<div id="root">'))

  const session = await http.get(`${API}/auth/session`)
  const sh = session.headers()
  check('The API answers in its own JSON with helmet’s headers, not the page’s CSP',
    session.status() === 401 && (await session.json()).error?.code === 'UNAUTHENTICATED' && sh['x-content-type-options'] === 'nosniff'
    && !(sh['content-security-policy'] ?? '').includes('fonts.googleapis.com'))
  check('API answers are not compressed', !sh['content-encoding'], sh['content-encoding'])

  // ════════════════════════════════════════════════════════════════════════
  section('Signing in')
  const page = await context.newPage()
  await page.goto(`${BASE}/signin`)
  await page.getByLabel('Work Email or Employee ID').fill(EMAIL)
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
  await page.getByRole('button', { name: /sign in/i }).click()
  await page.waitForURL(/\/dashboard/, { timeout: 20000 })
  check('The Super Admin signs in and lands on Home', page.url().includes('/dashboard'))

  // All of them: asked for by the page's address, a cookie on /api/auth would not show.
  const cookie = (await context.cookies()).find((c) => c.name === 'ems_refresh')
  check('The refresh cookie is Secure, HttpOnly, SameSite=Lax, for /api/auth only',
    cookie && cookie.secure && cookie.httpOnly && cookie.sameSite === 'Lax' && cookie.path === '/api/auth', JSON.stringify(cookie))

  await page.reload()
  await page.waitForLoadState('networkidle')
  check('A reload keeps the session (the cookie works through both proxies)', page.url().includes('/dashboard') && await page.getByRole('heading', { level: 1 }).first().isVisible())

  // ════════════════════════════════════════════════════════════════════════
  section('Every page of the menu')
  const PAGES = ['/dashboard', '/employees', '/attendance', '/leave', '/requests', '/payroll', '/payslips', '/documents', '/reports', '/settings']
  for (const path of PAGES) {
    await page.goto(`${BASE}${path}`)
    await page.waitForLoadState('networkidle')
    // Still on the page asked for (a lost session would land on sign-in, which
    // has a heading too), signed in (the user menu), with no error view.
    const stayed = new URL(page.url()).pathname === path
    const heading = await page.getByRole('heading', { level: 1 }).first().isVisible().catch(() => false)
    const signedIn = await page.getByRole('banner').getByText('Signed in as Super Admin').isVisible().catch(() => false)
    const broken = await page.getByText(/something went wrong|could not load|cannot be reached/i).count()
    check(`${path} opens, signed in, with its heading and no error`, stayed && heading && signedIn && broken === 0, page.url())
  }
  await page.screenshot({ path: join(SHOTS, 'settings-desktop.png') })

  // ════════════════════════════════════════════════════════════════════════
  section('On a phone')
  // Its own sign-in: a copy of the computer's cookie would be a refresh token
  // used twice, and the server rightly ends the whole session for that.
  const phone = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  phone.on('page', (p) => watch(p))
  const mobile = await phone.newPage()
  await mobile.goto(`${BASE}/signin`)
  await mobile.getByLabel('Work Email or Employee ID').fill(EMAIL)
  await mobile.getByLabel('Password', { exact: true }).fill(PASSWORD)
  await mobile.getByRole('button', { name: /sign in/i }).click()
  await mobile.waitForURL(/\/dashboard/, { timeout: 20000 })
  await mobile.waitForLoadState('networkidle')
  const sideways = await mobile.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  check('Home on a 390px phone: signed in, no sideways scrolling', mobile.url().includes('/dashboard') && sideways <= 1, `overflow ${sideways}px`)
  await mobile.screenshot({ path: join(SHOTS, 'home-phone.png'), fullPage: true })
  await phone.close()

  // ════════════════════════════════════════════════════════════════════════
  section('Files, through both proxies')
  // As the app itself asks (src/http/middleware/csrfGuard.ts).
  const token = await page.evaluate(async () => {
    const r = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ems' }, body: '{}' })
    return (await r.json()).data?.accessToken
  })
  check('A fresh access token comes from the refresh cookie', typeof token === 'string' && token.length > 20)
  const auth = { Authorization: `Bearer ${token}` }
  const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(40_000, 'a'), Buffer.from('\n%%EOF\n')])
  const posted = await http.post(`${API}/company-documents`, {
    headers: auth,
    multipart: { title: 'Rehearsal handbook', category: 'handbook', file: { name: 'handbook.pdf', mimeType: 'application/pdf', buffer: pdf } },
  })
  const doc = posted.ok() ? (await posted.json()).data : null
  check('A company document uploads', posted.status() === 201 && doc?.id, `${posted.status()} ${await posted.text()}`)
  if (doc?.id) {
    const back = await http.get(`${API}/company-documents/${doc.id}/file`, { headers: auth })
    const sha = (b) => createHash('sha256').update(b).digest('hex')
    check('…and reads back byte for byte', back.status() === 200 && sha(await back.body()) === sha(pdf))
  }
  const big = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(3 * 1024 * 1024, 'a')])
  const overApi = await http.post(`${API}/company-documents`, {
    headers: auth,
    multipart: { title: 'Too big', category: 'other', file: { name: 'big.pdf', mimeType: 'application/pdf', buffer: big } },
  })
  const overApiBody = await overApi.text()
  check('Over the company’s limit (2 MB): the API refuses it in its own words',
    [413, 422].includes(overApi.status()) && overApiBody.includes('the most this company accepts is 2 MB'), `${overApi.status()} ${overApiBody.slice(0, 200)}`)
  const huge = Buffer.alloc(13 * 1024 * 1024, 'a')
  const overWeb = await http.post(`${API}/company-documents`, {
    headers: auth,
    multipart: { title: 'Far too big', category: 'other', file: { name: 'huge.pdf', mimeType: 'application/pdf', buffer: huge } },
  }).catch((e) => ({ status: () => 0, text: async () => e.message }))
  const overWebBody = await overWeb.text()
  check('Over 12 MB: refused with 413, never reaching the API’s parser', overWeb.status() === 413 && !overWebBody.includes('requestId'), `${overWeb.status()} ${overWebBody.slice(0, 200)}`)

  // ════════════════════════════════════════════════════════════════════════
  section('The visitor’s address, through both proxies')
  // On Docker Desktop, a request to the published port reaches the edge from
  // the gateway of the `edge` network: that is "the visitor" here.
  const gateway = execFileSync('docker', ['network', 'inspect', 'edge', '--format', '{{(index .IPAM.Config 0).Gateway}}'], { encoding: 'utf8' }).trim()
  const wrong = (headers) => http.post(`${API}/auth/login`, { headers, data: { identifier: EMAIL, password: 'not-the-password-1' } })
  const plain = await wrong({})
  const forged = await wrong({ 'X-Forwarded-For': '203.0.113.9', 'X-Real-IP': '203.0.113.9' })
  check('Two failed sign-ins are refused', plain.status() === 401 && forged.status() === 401, `${plain.status()} ${forged.status()}`)
  const log = await http.get(`${API}/audit-log`, { headers: auth })
  const failures = log.ok() ? (await log.json()).data.filter((r) => r.action === 'auth.login_failed').slice(0, 2) : []
  check('The audit log records the visitor’s own address for both', failures.length === 2 && failures.every((r) => r.ip === gateway),
    `gateway ${gateway}; recorded ${failures.map((r) => r.ip).join(', ')} (${log.status()})`)
  check('…never the address a visitor wrote in X-Forwarded-For', failures.every((r) => r.ip !== '203.0.113.9'))

  // ════════════════════════════════════════════════════════════════════════
  section('Signing out')
  await page.goto(`${BASE}/dashboard`)
  await page.waitForLoadState('networkidle')
  const signedOut = await page.evaluate(async () => (await fetch('/api/auth/logout', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ems' }, body: '{}' })).status)
  const after = (await context.cookies()).find((c) => c.name === 'ems_refresh')
  check('Signing out clears the refresh cookie', signedOut < 300 && !after, `${signedOut} ${JSON.stringify(after)}`)

  section('The whole run')
  check('No page error', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
  check('No 5xx from the server', serverErrors.length === 0, serverErrors.slice(0, 3).join(' | '))
  check('No Content-Security-Policy violation', cspViolations.length === 0, cspViolations.slice(0, 3).join(' | '))
} catch (err) {
  failed++
  console.error(err)
} finally {
  await browser.close()
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
