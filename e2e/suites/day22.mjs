// Day 22 E2E — the company tree, approvals that follow it, and "your own work
// goes up". Production build on :5183 → compiled API on :4100 → local ems_e2e.
// Fixture: the Day 20 seed (reset20.sh): Priya → Manoj, Ravi → Rekha, nobody
// else placed.
import { chromium } from 'playwright-core'
import { WORK, REPO, STORAGE as STORE, psql } from '../lib/env.mjs'
import { readFileSync, mkdirSync } from 'node:fs'

const BASE = 'http://localhost:5183'
const API = `${BASE}/api`
const DIR = WORK
const fx = JSON.parse(readFileSync(`${DIR}/day20-fixture.json`, 'utf8'))
const SHOTS = `${DIR}/shots/day22`
mkdirSync(SHOTS, { recursive: true })
const E = fx.employees

const results = []
function check(label, ok, detail = '') {
  results.push({ label, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`)
  if (!ok) throw new Error(`FAILED: ${label} ${detail}`)
}
const section = (name) => console.log(`\n── ${name} ──`)

// ── The API ─────────────────────────────────────────────────────────────────
const tokens = {}
async function login(who) {
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: fx.users[who], password: fx.password }),
  })
  const body = await res.json()
  if (res.status !== 200) throw new Error(`login ${who}: ${res.status} ${JSON.stringify(body)}`)
  tokens[who] = body.data.accessToken
  return body.data.user
}
async function api(who, method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { ...(who ? { Authorization: `Bearer ${tokens[who]}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { json = text }
  return { status: res.status, body: json }
}
const move = (employeeId, managerId) => api('sa', 'PATCH', `/employees/${employeeId}`, { reportingManagerId: managerId })

/** A weekday this many weeks out, so nothing here clashes with the seed's leave. */
function weekday(weeks, offset = 0) {
  const d = new Date()
  d.setUTCHours(0, 0, 0, 0)
  d.setUTCDate(d.getUTCDate() + weeks * 7)
  while (d.getUTCDay() !== 2) d.setUTCDate(d.getUTCDate() + 1)
  d.setUTCDate(d.getUTCDate() + offset)
  return d.toISOString().slice(0, 10)
}
const applyFor = (who, from, reason = 'Family function') =>
  api(who, 'POST', '/leave-requests', { leaveTypeId: fx.leaveTypeId, fromDate: from, toDate: from, reason })

// ── The browser ─────────────────────────────────────────────────────────────
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const pageErrors = []
const serverErrors = []
async function open(who, viewport = { width: 1366, height: 900 }) {
  const ctx = await browser.newContext({ viewport })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => pageErrors.push(`${who}: ${e.message}`))
  page.on('response', (r) => { if (r.status() >= 500 && r.url().includes('/api/')) serverErrors.push(`${who} ${r.request().method()} ${r.url().split('/api')[1]} ${r.status()}`) })
  await page.goto(`${BASE}/signin`)
  await page.getByPlaceholder('you@careermap.in or EMP001').fill(fx.users[who])
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
const toast = (page, text) => page.locator('[data-sonner-toast]', { hasText: text }).first().waitFor({ timeout: 20_000 })
async function treeTab(page) {
  await page.goto(`${BASE}/settings?tab=tree`)
  await settle(page)
  await page.getByText('Who reports to whom.').waitFor({ timeout: 20_000 })
}
/** One person's row on the chart, found through its search so the row is flat. */
async function treeRow(page, name) {
  await page.getByLabel('Find a person').fill(name)
  return page.locator('li').filter({ has: page.getByText(name, { exact: true }) }).first()
}
/** The "Nobody above" section, found by its description (the words also name a dropdown choice). */
const unplacedList = (page) =>
  page.getByText('People still here with nobody to report to').locator('xpath=ancestor::div[contains(@class,"rounded-xl")][1]')
const sideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)

try {
  for (const who of Object.keys(fx.users)) await login(who)
  // Leave from an earlier run of this suite would clash; the seed's own is earlier than these dates.
  const later = [weekday(9), weekday(10), weekday(11), weekday(12), weekday(13)]

  section('Settings → Company tree (Super Admin)')
  const sa = await open('sa')
  await treeTab(sa)
  check('no owner is marked yet, and the screen says what that means', await sa.getByText('No owner is marked.').isVisible())
  const unplacedBefore = await unplacedList(sa).innerText()
  check('the people with nobody above are listed for placing', unplacedBefore.includes('Hema Hiremath') && unplacedBefore.includes('Anil Accountant'), unplacedBefore.slice(0, 200).replace(/\n/g, ' | '))
  await shot(sa, '01-tree-before')

  let row = await treeRow(sa, 'Sunita Admin')
  await row.getByRole('button', { name: 'Make owner' }).click()
  await sa.getByRole('dialog').getByText('needs nobody’s approval').waitFor({ timeout: 10_000 })
  await sa.getByRole('dialog').getByRole('button', { name: 'Make owner' }).click()
  await toast(sa, 'Sunita Admin is now the owner')
  await settle(sa)
  check('the Super Admin marks the owner, and the warning goes', !(await sa.getByText('No owner is marked.').count()))
  await sa.getByLabel('Find a person').fill('')
  check('the owner heads the chart, marked Owner', (await sa.locator('[aria-label="Company tree"] > li').first().innerText()).startsWith('Sunita Admin'))
  row = await treeRow(sa, 'Hema Hiremath')
  check('a person who cannot be owner is not offered it', !(await row.getByRole('button', { name: 'Make owner' }).count()))

  // Place Hema (HR) and Anil (Accounts) under the owner, from "Nobody above".
  await sa.getByLabel('Find a person').fill('')
  for (const name of ['Hema Hiremath', 'Anil Accountant']) {
    const select = sa.getByLabel(`Place under — ${name}`)
    await select.selectOption({ label: 'Sunita Admin' })
    await select.locator('xpath=ancestor::div[contains(@class,"space-y-1.5")][1]').getByRole('button', { name: 'Save' }).click()
    await toast(sa, `${name} now reports to Sunita Admin`)
    await settle(sa)
  }
  // The names on the list itself — every row's dropdown names everybody too.
  const unplacedAfter = (await unplacedList(sa).locator('li p.font-medium').allInnerTexts()).join(' | ')
  check('placed people leave the “Nobody above” list', !unplacedAfter.includes('Hema Hiremath') && !unplacedAfter.includes('Anil Accountant'), unplacedAfter)

  // Ravi moves from Rekha to Anil, the Accounts head: from the chart.
  row = await treeRow(sa, 'Ravi Patil')
  await row.getByRole('button', { name: 'Change who they report to' }).click()
  await row.getByLabel('Reports to — Ravi Patil').selectOption({ label: 'Anil Accountant' })
  await row.getByRole('button', { name: 'Save' }).click()
  await toast(sa, 'Ravi Patil now reports to Anil Accountant')
  await settle(sa)
  row = await treeRow(sa, 'Ravi Patil')
  check('the chart shows the move', (await row.innerText()).includes('reports to Anil Accountant'))

  // A loop is refused, in words, where the Super Admin is looking.
  const loop = await move(E.anil.id, E.ravi.id)
  check('the server refuses a loop', loop.status === 400 && /go in a loop/.test(loop.body.error?.message), JSON.stringify(loop.body).slice(0, 160))
  row = await treeRow(sa, 'Anil Accountant')
  await row.getByRole('button', { name: 'Change who they report to' }).click()
  const anilOptions = await row.getByLabel('Reports to — Anil Accountant').locator('option').allInnerTexts()
  check('the chart does not even offer somebody under the person (no loops to pick)', !anilOptions.some((o) => o.startsWith('Ravi Patil')), anilOptions.join(', ').slice(0, 200))
  await row.getByRole('button', { name: 'Cancel' }).click()
  await sa.getByLabel('Find a person').fill('')
  await shot(sa, '02-tree-after')

  section('Settings → Approvals')
  await sa.goto(`${BASE}/settings?tab=approvals`)
  await settle(sa)
  check('the client’s choices are the defaults',
    (await sa.getByLabel('Who decides for somebody with nobody above them').inputValue()) === '' &&
    (await sa.getByLabel('Who may decide when the reporting manager is away').inputValue()) === 'super_admin' &&
    (await sa.getByLabel('Who may cancel approved leave').inputValue()) === 'manager_or_super_admin')
  await sa.getByLabel('Who may decide when the reporting manager is away').selectOption('next_up')
  await sa.getByRole('button', { name: 'Save Changes' }).first().click()
  await toast(sa, 'Approval settings saved')
  check('a change is saved', (await api('sa', 'GET', '/company-tree/approvals')).body.data.backup === 'next_up')
  await settle(sa)
  await sa.getByLabel('Who may decide when the reporting manager is away').selectOption('super_admin')
  await sa.getByRole('button', { name: 'Save Changes' }).first().click()
  await toast(sa, 'Approval settings saved')
  await shot(sa, '03-approvals')

  section('Leave follows the tree: an Accounts head approves their team')
  const raviReq = await applyFor('emp2', later[0])
  check('Ravi applies for leave', raviReq.status === 201, JSON.stringify(raviReq.body).slice(0, 160))
  const anilSession = await login('acc')
  check('Anil, whose Accounts role has no leave rights, is told he decides leave', anilSession.decidesLeave === true && !anilSession.permissions.includes('leave:read'))
  const anil = await open('acc')
  await settle(anil)
  check('his dashboard says a request is waiting for him', await anil.getByText('1 leave request waiting for you.').isVisible())
  check('his menu shows Leave', await anil.locator('nav').first().getByText('Leave', { exact: true }).isVisible())
  await anil.goto(`${BASE}/leave`)
  await settle(anil)
  check('Leave opens on Team Requests, the only tab he has', await anil.getByRole('button', { name: /Team Requests/ }).isVisible() && !(await anil.getByRole('button', { name: /^Leave Requests/ }).count()))
  const raviRow = anil.locator('tr').filter({ hasText: 'Ravi Patil' }).first()
  await raviRow.getByRole('button', { name: 'Approve' }).click()
  await settle(anil)
  await raviRow.getByText('Approved').waitFor({ timeout: 20_000 })
  check('he approves Ravi’s leave there', true)
  await shot(anil, '04-accounts-head-team-requests')

  section('HR sees every request and decides none')
  const priyaReq = await applyFor('emp', later[1])
  check('Priya applies', priyaReq.status === 201)
  const hr = await open('hr')
  await hr.goto(`${BASE}/leave`)
  await settle(hr)
  const priyaRow = hr.locator('tr').filter({ hasText: 'Priya Deshmukh' }).filter({ hasText: 'Pending' }).first()
  check('HR sees Priya’s request, saying it goes to Manoj, with no Approve', (await priyaRow.innerText()).includes('Goes to Manoj Manager') && !(await priyaRow.getByRole('button', { name: 'Approve' }).count()))
  check('HR has no Team Requests tab — nobody reports to her', !(await hr.getByRole('button', { name: /Team Requests/ }).count()))
  const hrTries = await api('hr', 'POST', `/leave-requests/${priyaReq.body.data.id}/approve`, {})
  check('the server refuses HR, naming who decides', hrTries.status === 403 && /decided by Manoj Manager/.test(hrTries.body.error?.message), hrTries.body.error?.message)
  await shot(hr, '05-hr-sees-no-approve')

  section('The manager decides; the Super Admin may stand in')
  const mgr = await open('mgr')
  await mgr.goto(`${BASE}/leave`)
  await settle(mgr)
  await mgr.getByRole('button', { name: /Team Requests/ }).click()
  const mgrRow = mgr.locator('tr').filter({ hasText: 'Priya Deshmukh' }).filter({ hasText: 'Pending' }).first()
  check('Manoj has Priya’s request under Team Requests, to decide', await mgrRow.getByRole('button', { name: 'Approve' }).isVisible())
  const standIn = await applyFor('emp', later[2], 'Wedding')
  await sa.goto(`${BASE}/leave`)
  await settle(sa)
  await sa.getByRole('button', { name: /Team Requests/ }).click()
  await sa.getByText('Waiting for somebody else — you may stand in').waitFor({ timeout: 20_000 })
  check('the Super Admin sees other managers’ waiting requests apart, to stand in', true)
  const backupRow = sa.locator('tr').filter({ hasText: 'Priya Deshmukh' }).filter({ hasText: 'Wedding' }).first()
  await backupRow.getByRole('button', { name: 'Reject' }).click()
  await settle(sa)
  // Decided, it leaves the backup list (only waiting requests are there).
  await sa.locator('tr').filter({ hasText: 'Wedding' }).first().waitFor({ state: 'detached', timeout: 20_000 }).catch(() => undefined)
  const decidedAs = (await api('sa', 'GET', `/leave-requests?status=rejected`)).body.data?.find((r) => r.id === standIn.body.data.id)
  check('the Super Admin rejects it, standing in', decidedAs?.status === 'rejected', JSON.stringify(decidedAs ?? null).slice(0, 120))
  const backupLog = await api('sa', 'GET', '/audit-log?category=time')
  const summaries = (backupLog.body.data ?? []).map((r) => r.summary)
  check('standing in is written in the log', summaries.some((s) => s.includes('standing in for their reporting manager')), summaries.slice(0, 4).join(' | '))
  void standIn
  await shot(sa, '06-sa-backup')

  section('The owner’s leave needs nobody')
  const ownerReq = await applyFor('sa', later[3], 'Travel')
  check('the owner’s leave is recorded straight away', ownerReq.status === 201 && ownerReq.body.data.status === 'approved', JSON.stringify(ownerReq.body).slice(0, 160))
  await sa.goto(`${BASE}/settings?tab=audit`)
  await settle(sa)
  check('and the log says why', (await sa.locator('main').innerText()).includes('the owner’s leave needs no approval'))

  section('Your own work goes up the tree')
  // Anil's own bank account: entered — and checked — by Sunita, above him (final
  // audit, 4 Oct: entering one's own goes up the tree as much as checking it).
  const ownEntry = await api('acc', 'PUT', `/payroll/employees/${E.anil.id}/bank-account`, { bankName: 'HDFC Bank', accountHolderName: 'ANIL ACCOUNTANT', accountNumber: '000123450001', ifsc: 'HDFC0001234', accountType: 'Savings' })
  check('he cannot enter his own account through Payroll', ownEntry.status === 403 && /person above you: Sunita Admin/.test(ownEntry.body.error?.message), ownEntry.body.error?.message)
  await api('sa', 'PUT', `/payroll/employees/${E.anil.id}/bank-account`, { bankName: 'HDFC Bank', accountHolderName: 'ANIL ACCOUNTANT', accountNumber: '000123450001', ifsc: 'HDFC0001234', accountType: 'Savings' })
  await anil.goto(`${BASE}/payroll?tab=bank`)
  await settle(anil)
  const ownBank = anil.locator('tr').filter({ hasText: 'Anil Accountant' }).first()
  await ownBank.waitFor({ timeout: 20_000 })
  check('his own account shows who enters and checks it, with no Edit or Check button',
    (await ownBank.innerText()).includes('Entered and checked by Sunita Admin') && !(await ownBank.getByRole('button', { name: /^(Check|Edit)\b/ }).count()), (await ownBank.innerText()).replace(/\n/g, ' | '))
  const ownCheck = await api('acc', 'POST', `/payroll/employees/${E.anil.id}/bank-account/verify`, { decision: 'verified', accountUpdatedAt: (await api('acc', 'GET', '/payroll/bank-accounts')).body.data.find((r) => r.employee_id === E.anil.id).bank_account.updated_at })
  check('the server refuses it, naming the person above', ownCheck.status === 403 && /person above you: Sunita Admin/.test(ownCheck.body.error?.message), ownCheck.body.error?.message)
  await shot(anil, '07-own-bank-goes-up')

  await hr.goto(`${BASE}/leave`)
  await settle(hr)
  await hr.getByRole('button', { name: /Team Balances/ }).click()
  await settle(hr)
  const hemaBalance = hr.locator('tr').filter({ hasText: 'Hema Hiremath' }).first()
  check('HR’s own balance is corrected by the person above her', (await hemaBalance.innerText()).includes('goes to Sunita Admin'), (await hemaBalance.innerText()).replace(/\n/g, ' | '))

  await hr.goto(`${BASE}/attendance`)
  await settle(hr)
  const hemaDay = hr.locator('tr').filter({ hasText: 'Hema Hiremath' }).first()
  await hemaDay.waitFor({ timeout: 20_000 })
  check('HR’s own day on the attendance roster says whom it goes to, with no Mark button',
    (await hemaDay.innerText()).includes('Goes to Sunita Admin') && !(await hemaDay.getByRole('button', { name: /^(Mark|Edit)$/ }).count()), (await hemaDay.innerText()).replace(/\n/g, ' | '))
  const takeover = await api('hr', 'PATCH', `/employees/${E.priya.id}`, { reportingManagerId: E.hema.id })
  // Since the Days 21–23 wrap-up, who somebody reports to is the Super Admin's alone to change.
  check('HR cannot move somebody under herself to take their leave over', takeover.status === 403 && /set by the Super Admin/.test(takeover.body.error?.message), takeover.body.error?.message)
  const entries = await api('hr', 'GET', '/payroll/monthly-entries?year=2026&month=9')
  check('a senior’s incentive is closed to HR', (entries.body.meta?.blocked ?? []).some((b) => b.employee_id === E.sunita.id))

  section('HR sees salaries, except the seniors’')
  const priyaRecord = await api('hr', 'GET', `/employees/${E.priya.id}`)
  const sunitaRecord = await api('hr', 'GET', `/employees/${E.sunita.id}`)
  check('HR sees Priya’s salary', 'ctc' in priyaRecord.body.data && priyaRecord.body.data.ctc === 204000, String(priyaRecord.body.data.ctc))
  check('…and not the owner’s, who is above her', !('ctc' in sunitaRecord.body.data))
  await hr.goto(`${BASE}/employees`)
  await settle(hr)
  await hr.getByText('Priya Deshmukh', { exact: true }).first().click()
  await hr.getByText('₹2,04,000').first().waitFor({ timeout: 15_000 }).catch(() => undefined)
  check('the employee page shows HR the salary section', await hr.getByText('₹2,04,000').first().isVisible())
  await shot(hr, '08-hr-salary')

  section('The two new scopes on the Roles screen')
  await sa.goto(`${BASE}/settings?tab=roles`)
  await settle(sa)
  await sa.getByRole('button', { name: 'New role' }).click()
  const scopeChoices = await sa.getByRole('dialog').getByLabel('Whose salaries').locator('option').allInnerTexts()
  check('the editor offers “Everybody under them” and “Whole company, except seniors”',
    scopeChoices.includes('Everybody under them') && scopeChoices.includes('Whole company, except seniors'), scopeChoices.join(', '))
  await sa.getByRole('dialog').getByLabel('Whose salaries').selectOption({ label: 'Whole company, except seniors' })
  check('…and says what the choice means', await sa.getByRole('dialog').getByText('Everybody, except the people above them in the company tree').isVisible())
  check('approving leave is no tick any more — the tree decides', !(await sa.getByRole('dialog').getByRole('checkbox', { name: /Approve, reject or cancel leave/ }).count()) && await sa.getByRole('dialog').getByText('Approving leave needs no tick').isVisible())
  await sa.keyboard.press('Escape')

  section('On a phone (390px)')
  const phone = await open('sa', { width: 390, height: 844 })
  await treeTab(phone)
  check('the company tree fits a phone without sideways scrolling', (await sideways(phone)) <= 1, `${await sideways(phone)}px over`)
  await shot(phone, '09-phone-tree')
  const anilPhone = await open('acc', { width: 390, height: 844 })
  await anilPhone.goto(`${BASE}/leave`)
  await settle(anilPhone)
  check('Team Requests fits a phone', (await sideways(anilPhone)) <= 1, `${await sideways(anilPhone)}px over`)
  await shot(anilPhone, '10-phone-team-requests')
  await phone.goto(`${BASE}/settings?tab=approvals`)
  await settle(phone)
  check('Approvals fits a phone', (await sideways(phone)) <= 1)

  section('Nothing broke along the way')
  check('no page errors', pageErrors.length === 0, pageErrors.join(' | '))
  check('no server errors', serverErrors.length === 0, serverErrors.join(' | '))
} catch (err) {
  console.error(err.message)
  process.exitCode = 1
} finally {
  await browser.close()
  const passed = results.filter((r) => r.ok).length
  console.log(`\n${passed}/${results.length} checks passed`)
}
