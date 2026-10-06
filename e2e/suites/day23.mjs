// Day 23 E2E — two logins, one person; and the Day 22 items that were first
// tested only on the server (making an owner of somebody with a manager, the
// "next up" backup, salary "Entered by", the TDS picker, the documents note).
// Production build on :5183 → compiled API on :4100 → local ems_e2e.
// Fixture: the Day 20 seed (reset20.sh), fresh.
import { chromium } from 'playwright-core'
import { WORK, REPO, STORAGE as STORE, psql } from '../lib/env.mjs'
import { openMyProfile, openEmployeeProfile, signOutVia, menuLinks, menuLink } from '../lib/ui.mjs'
import { readFileSync, mkdirSync } from 'node:fs'

const BASE = 'http://localhost:5183'
const API = `${BASE}/api`
const DIR = WORK
const fx = JSON.parse(readFileSync(`${DIR}/day20-fixture.json`, 'utf8'))
const SHOTS = `${DIR}/shots/day23`
mkdirSync(SHOTS, { recursive: true })
const E = fx.employees
const PRIYA_HR = `d20-${fx.stamp}-priya.hr@example.com`

const results = []
function check(label, ok, detail = '') {
  results.push({ label, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`)
  if (!ok) throw new Error(`FAILED: ${label} ${detail}`)
}
const section = (name) => console.log(`\n── ${name} ──`)

// ── The API ─────────────────────────────────────────────────────────────────
const tokens = {}
async function signIn(identifier, password = fx.password) {
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier, password }),
  })
  return { status: res.status, body: await res.json() }
}
async function login(who) {
  const res = await signIn(fx.users[who])
  if (res.status !== 200) throw new Error(`login ${who}: ${res.status} ${JSON.stringify(res.body)}`)
  tokens[who] = res.body.data.accessToken
  return res.body.data.user
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
const loginsOf = async (employeeId) => (await api('sa', 'GET', `/employees/${employeeId}`)).body.data.logins

/** A weekday this many weeks out, so nothing here clashes with the seed's leave. */
function weekday(weeks, offset = 0) {
  const d = new Date()
  d.setUTCHours(0, 0, 0, 0)
  d.setUTCDate(d.getUTCDate() + weeks * 7)
  while (d.getUTCDay() !== 3) d.setUTCDate(d.getUTCDate() + 1)
  d.setUTCDate(d.getUTCDate() + offset)
  return d.toISOString().slice(0, 10)
}
const applyFor = (who, from, reason = 'Family function') =>
  api(who, 'POST', '/leave-requests', { leaveTypeId: fx.leaveTypeId, fromDate: from, toDate: from, reason })

// ── The browser ─────────────────────────────────────────────────────────────
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const pageErrors = []
const serverErrors = []
const PHONE = { width: 390, height: 844 }
/** Signs in as a fixture user (`who`), or as `{ email, label }` with the fixture password. */
async function open(who, viewport = { width: 1366, height: 900 }) {
  const label = typeof who === 'string' ? who : who.label
  const email = typeof who === 'string' ? fx.users[who] : who.email
  const ctx = await browser.newContext({ viewport })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => pageErrors.push(`${label}: ${e.message}`))
  page.on('response', (r) => { if (r.status() >= 500 && r.url().includes('/api/')) serverErrors.push(`${label} ${r.request().method()} ${r.url().split('/api')[1]} ${r.status()}`) })
  await page.goto(`${BASE}/signin`)
  await page.getByLabel('Work Email or Employee ID').fill(email)
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
const sideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
const topBar = (page) => page.locator('header').innerText()
/** Somebody's profile page (a drawer before the new look), on its Logins tab. */
async function openDrawer(page, name) {
  return openEmployeeProfile(page, BASE, name, /^Logins?$/)
}
const loginsList = (drawer) => drawer.getByRole('list', { name: 'Logins' })
/** True when the page has been sent back to sign in — its session ended. */
async function signedOut(page) {
  await page.goto(`${BASE}/dashboard`)
  return page.waitForURL((url) => url.pathname.startsWith('/signin'), { timeout: 20_000 }).then(() => true, () => false)
}

try {
  for (const who of Object.keys(fx.users)) await login(who)
  // These checks hand out links: people setting their own passwords (Settings →
  // Passwords, "self"). The company setting them — the default since 6 Oct 2026 —
  // has its own suite, passwords.mjs.
  const asOwners = await api('sa', 'PUT', '/users/password-rules', { employeePasswords: 'self', rolePasswords: 'self', passwordMinLength: 10 })
  if (asOwners.status !== 200) throw new Error(`password rules: ${asOwners.status} ${JSON.stringify(asOwners.body)}`)

  // ── Day 22, in the browser ──────────────────────────────────────────────
  section('Making an owner of somebody who has a manager (Day 22)')
  check('Sunita is placed under Hema first', (await move(E.sunita.id, E.hema.id)).status === 200)
  const sa = await open('sa')
  await sa.goto(`${BASE}/settings?tab=tree`)
  await settle(sa)
  await sa.getByLabel('Find a person').fill('Sunita Admin')
  const sunitaRow = sa.locator('li').filter({ has: sa.getByText('Sunita Admin', { exact: true }) }).first()
  await sunitaRow.getByRole('button', { name: 'Make owner' }).click()
  const ownerDialog = sa.getByRole('dialog')
  await ownerDialog.getByText('needs nobody’s approval').waitFor({ timeout: 10_000 })
  check('the dialog says her reporting line to Hema is taken away', await ownerDialog.getByText('They report to Hema Hiremath now; that line is taken away.').isVisible())
  await shot(sa, '01-owner-with-manager')
  await ownerDialog.getByRole('button', { name: 'Make owner' }).click()
  await toast(sa, 'Sunita Admin is now the owner')
  const sunita = (await api('sa', 'GET', `/employees/${E.sunita.id}`)).body.data
  check('…and it is: Sunita is the owner, with nobody above', sunita.reporting_manager_id === null && (await api('sa', 'GET', '/company-tree')).body.data.owner_id === E.sunita.id)

  // The tree the rest runs on: Hema, Anil and Manoj under Sunita, Rekha under Manoj.
  for (const [who, above] of [[E.hema, E.sunita], [E.anil, E.sunita], [E.manoj, E.sunita], [E.rekha, E.manoj]]) {
    const res = await move(who.id, above.id)
    check(`${who.name} reports to ${above.name}`, res.status === 200, JSON.stringify(res.body).slice(0, 160))
  }

  section('The “next up” backup decides (Day 22)')
  await sa.goto(`${BASE}/settings?tab=approvals`)
  await settle(sa)
  await sa.getByLabel('Who may decide when the reporting manager is away').selectOption('next_up')
  // The leave rules' Save; the requests' own Save sits below it (V1 gaps).
  await sa.getByRole('button', { name: 'Save Changes' }).first().click()
  await toast(sa, 'Approval settings saved')
  const raviReq = await applyFor('emp2', weekday(15))
  check('Ravi applies (his leave is Rekha’s to decide)', raviReq.status === 201, JSON.stringify(raviReq.body).slice(0, 160))
  const manoj = await open('mgr')
  await manoj.goto(`${BASE}/leave?tab=decide`)
  await settle(manoj)
  await manoj.getByText('Waiting for somebody else — you may stand in').waitFor({ timeout: 20_000 })
  const standIn = manoj.locator('tr').filter({ hasText: 'Ravi Patil' }).filter({ hasText: 'Pending' }).first()
  check('Manoj, Rekha’s own manager, is offered Ravi’s request to stand in', await standIn.getByRole('button', { name: 'Approve' }).isVisible())
  check('…marked as standing in for Rekha', (await standIn.getByRole('button', { name: 'Approve' }).getAttribute('title')) === 'Standing in for Rekha Rao')
  await shot(manoj, '02-next-up-backup')
  await standIn.getByRole('button', { name: 'Approve' }).click()
  let decided = null
  for (let i = 0; i < 40 && decided?.status !== 'approved'; i++) {
    await new Promise((r) => setTimeout(r, 250))
    decided = ((await api('sa', 'GET', '/leave-requests')).body.data ?? []).find((r) => r.id === raviReq.body.data.id)
  }
  check('he approves it as the backup', decided?.status === 'approved', JSON.stringify(decided).slice(0, 160))
  const rules = (await api('sa', 'GET', '/company-tree/approvals')).body.data
  await api('sa', 'PUT', '/company-tree/approvals', { noManagerApproverId: rules.no_manager_approver_id, backup: 'super_admin', reversal: rules.reversal, version: rules.version })
  check('the backup is back at the client’s choice', (await api('sa', 'GET', '/company-tree/approvals')).body.data.backup === 'super_admin')

  section('Accounts’ own salary and tax go up (Day 22)')
  const tds = await api('sa', 'PUT', '/settings/payroll', { tdsEnabled: true })
  check('TDS through payroll is switched on for this run', tds.status === 200, JSON.stringify(tds.body).slice(0, 200))
  const anil = await open('acc')
  await anil.goto(`${BASE}/payroll?tab=salary`)
  await settle(anil)
  const anilRow = anil.locator('tr', { hasText: 'Anil Accountant' }).first()
  check('his own row says who enters his salary: “Entered by Sunita Admin”', (await anilRow.innerText()).includes('Entered by Sunita Admin'), (await anilRow.innerText()).replace(/\n/g, ' | '))
  check('…and offers History, not Change', await anilRow.getByRole('button', { name: 'History' }).isVisible())
  await anil.goto(`${BASE}/payroll?tab=tds`)
  await settle(anil)
  await anil.getByRole('button', { name: 'Set monthly TDS' }).click()
  const tdsDialog = anil.getByRole('dialog')
  const picker = tdsDialog.locator('select').first()
  await picker.locator('option', { hasText: 'Priya Deshmukh' }).waitFor({ state: 'attached', timeout: 20_000 })
  const own = picker.locator('option', { hasText: 'Anil Accountant' })
  const disabledOf = (option) => option.evaluate((o) => o.disabled)
  check('in the TDS picker his own name is greyed out, saying where it goes', (await disabledOf(own)) && (await own.innerText()).includes('— goes to Sunita Admin'), `${await own.innerText()} disabled=${await disabledOf(own)}`)
  check('…and other people can be chosen', !(await disabledOf(picker.locator('option', { hasText: 'Priya Deshmukh' }))))
  await shot(anil, '03-tds-picker')
  await anil.keyboard.press('Escape')

  section('HR’s own documents are checked above (Day 22)')
  const hema = await open('hr')
  await hema.goto(`${BASE}/documents?tab=employees&employee=${E.hema.id}`)
  await settle(hema)
  await hema.getByText('Your own documents are checked by the person above you: Sunita Admin.').waitFor({ timeout: 20_000 })
  check('her own checklist says the person above her checks them', true)
  await shot(hema, '04-own-documents-note')

  section('Before her role login: Priya does no HR work')
  await hema.goto(`${BASE}/leave?tab=team`)
  await settle(hema)
  let priyaBalance = hema.locator('tr', { hasText: 'Priya Deshmukh' }).first()
  check('HR may correct Priya’s balance', await priyaBalance.getByRole('button', { name: /Correct Priya Deshmukh/ }).isVisible())

  // ── Day 23 ──────────────────────────────────────────────────────────────
  section('The Super Admin adds a role login on the person’s page')
  let drawer = await openDrawer(sa, 'Priya Deshmukh')
  let list = loginsList(drawer)
  check('her page lists her one login', (await list.locator('li').count()) === 1 && (await list.innerText()).includes('Can sign in · Employee'), (await list.innerText()).replace(/\n/g, ' | '))
  await drawer.getByRole('button', { name: 'Add another login' }).click()
  const form = drawer.getByRole('form', { name: 'Add a login' })
  check('the role is a choice somebody makes — nothing is picked for her', (await form.locator('select').inputValue()) === '')
  check('the role picker does not offer the role she already has', !(await form.locator('option', { hasText: /^Employee$/ }).count()))
  await form.getByPlaceholder('name.role@company.in').fill(PRIYA_HR)
  await form.locator('select').selectOption({ label: 'Super Admin' })
  check('choosing Super Admin warns what that login will hold', await form.getByText('This login will hold the Super Admin panel').isVisible())
  await form.locator('select').selectOption({ label: 'HR' })
  check('…and the warning goes for HR', !(await form.getByText('This login will hold the Super Admin panel').count()))
  await form.getByRole('button', { name: 'Add login' }).click()
  await drawer.getByText(`Invitation link for ${PRIYA_HR}`).waitFor({ timeout: 20_000 })
  const firstLink = await drawer.locator('input[readonly]').inputValue()
  check('the new login gets its own invitation link', firstLink.includes('/set-password#token='))
  await list.locator('li').nth(1).waitFor({ timeout: 20_000 })
  const both = await list.innerText()
  check('her page now lists both logins, each with its own email', both.includes(fx.users.emp) && both.includes(PRIYA_HR) && both.includes('Invited — has not set a password · HR'), both.replace(/\n/g, ' | '))
  check('…and says what two logins mean', await drawer.getByText('One person, 2 logins, each with its own password.', { exact: false }).isVisible())
  await shot(sa, '05-drawer-two-logins')
  // The first link "lost": a new one from her page, and the old one stops working.
  await list.locator('li', { hasText: PRIYA_HR }).getByRole('button', { name: /New invitation link/ }).click()
  await drawer.locator('input[readonly]').evaluate((input, old) => new Promise((resolve) => {
    const tick = () => (input.value && input.value !== old ? resolve() : setTimeout(tick, 100))
    tick()
  }), firstLink)
  const link = await drawer.locator('input[readonly]').inputValue()
  const tokenOf = (url) => decodeURIComponent(url.split('#token=')[1])
  const oldLink = await fetch(`${API}/auth/password-link/inspect`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: tokenOf(firstLink) }) })
  check('her page gives the invited login a new link, and the first stops working', link !== firstLink && oldLink.status !== 200, `old link answers ${oldLink.status}`)
  // A login added with a mistyped address is taken back from her page.
  const TYPO = `d20-${fx.stamp}-priya.acountz@example.com`
  await drawer.getByRole('button', { name: 'Add another login' }).click()
  const typoForm = drawer.getByRole('form', { name: 'Add a login' })
  await typoForm.getByPlaceholder('name.role@company.in').fill(TYPO)
  await typoForm.locator('select').selectOption({ label: 'Accounts' })
  await typoForm.getByRole('button', { name: 'Add login' }).click()
  const typoRow = list.locator('li', { hasText: TYPO })
  await typoRow.waitFor({ timeout: 20_000 })
  await typoRow.getByRole('button', { name: /^Withdraw the login/ }).click()
  await sa.getByRole('dialog').getByRole('button', { name: 'Withdraw' }).click()
  await typoRow.waitFor({ state: 'detached', timeout: 20_000 })
  check('a mistyped login is withdrawn from her page, leaving her two', (await loginsOf(E.priya.id)).length === 2)
  check('no second person was made', ((await api('sa', 'GET', '/employees')).body.data).filter((e) => e.full_name === 'Priya Deshmukh').length === 1)

  section('She sets its password and signs in to it')
  const linkCtx = await browser.newContext({ viewport: { width: 1366, height: 900 } })
  const setPw = await linkCtx.newPage()
  setPw.on('pageerror', (e) => pageErrors.push(`set-password: ${e.message}`))
  await setPw.goto(link)
  await setPw.getByPlaceholder('At least 10 characters').fill(fx.password)
  await setPw.getByPlaceholder('The same password').fill(fx.password)
  await setPw.getByRole('button', { name: 'Save password' }).click()
  await setPw.waitForURL((url) => url.pathname.startsWith('/signin'), { timeout: 20_000 })
  check('the link sets the HR login’s password', true)
  const priyaHr = await open({ email: PRIYA_HR, label: 'priya-hr' })
  await settle(priyaHr)
  check('the top bar says “Signed in as HR”', (await topBar(priyaHr)).includes('Signed in as HR'), (await topBar(priyaHr)).replace(/\n/g, ' | '))
  const priya = await open('emp')
  await settle(priya)
  check('her employee login says “Signed in as Employee”', (await topBar(priya)).includes('Signed in as Employee'))
  const hrSession = (await signIn(PRIYA_HR)).body.data.user
  const empSession = (await signIn(fx.users.emp)).body.data.user
  check('both logins are the same person', hrSession.employee.id === E.priya.id && empSession.employee.id === E.priya.id)
  tokens.priyaHr = (await signIn(PRIYA_HR)).body.data.accessToken
  await shot(priyaHr, '06-signed-in-as-hr')

  section('The employee login is self-service; the HR login does the role’s work')
  const empNav = await priya.locator('nav').first().innerText()
  check('the employee login’s menu has no Employees or Settings', !empNav.includes('Employees') && !empNav.includes('Settings'), empNav.replace(/\n/g, ' | '))
  check('…and the server agrees', (await api('emp', 'GET', '/employees')).status === 403)
  const hrNav = await priyaHr.locator('nav').first().innerText()
  check('the HR login’s menu has Employees', hrNav.includes('Employees'))

  section('Her team’s leave is decided from the HR login only')
  check('Ravi is placed under Priya', (await move(E.ravi.id, E.priya.id)).status === 200)
  const raviLeave = await applyFor('emp2', weekday(17))
  check('Ravi applies', raviLeave.status === 201, JSON.stringify(raviLeave.body).slice(0, 160))
  await priya.goto(`${BASE}/leave`)
  await settle(priya)
  check('her employee login has no Team Requests — it is for her own things', !(await priya.getByRole('tab', { name: /Team Requests/ }).count()))
  await priyaHr.goto(`${BASE}/leave?tab=decide`)
  await settle(priyaHr)
  const raviRow = priyaHr.locator('tr').filter({ hasText: 'Ravi Patil' }).filter({ hasText: 'Pending' }).first()
  check('her HR login has Ravi’s request to decide', await raviRow.getByRole('button', { name: 'Approve' }).isVisible())
  await shot(priyaHr, '06b-hr-login-team-requests')
  await raviRow.getByRole('button', { name: 'Approve' }).click()
  let raviDecided = null
  for (let i = 0; i < 40 && raviDecided?.status !== 'approved'; i++) {
    await new Promise((r) => setTimeout(r, 250))
    raviDecided = ((await api('sa', 'GET', '/leave-requests')).body.data ?? []).find((r) => r.id === raviLeave.body.data.id)
  }
  check('…and approves it there', raviDecided?.status === 'approved')

  section('Her own work goes up from both logins')
  await priyaHr.goto(`${BASE}/leave?tab=team`)
  await settle(priyaHr)
  const ownRow = priyaHr.locator('tr', { hasText: 'Priya Deshmukh' }).first()
  check('on the HR login, her own balance says “Your own · goes to …”', (await ownRow.innerText()).includes('Your own · goes to'), (await ownRow.innerText()).replace(/\n/g, ' | '))
  const adjust = (who, target) => api(who, 'POST', '/leave-balances/adjustments', { employeeId: target, leaveTypeId: fx.leaveTypeId, days: 1, note: 'Correction' })
  const fromHr = await adjust('priyaHr', E.priya.id)
  check('the server refuses her own correction from the HR login', fromHr.status === 403 && /your own leave balance/.test(fromHr.body.error?.message ?? ''), fromHr.body.error?.message)
  check('…and from the employee login', (await adjust('emp', E.priya.id)).status === 403)
  await hema.goto(`${BASE}/leave?tab=team`)
  await settle(hema)
  priyaBalance = hema.locator('tr', { hasText: 'Priya Deshmukh' }).first()
  check('now Hema, a fellow HR person, may not correct Priya’s balance either', (await priyaBalance.innerText()).includes('Not yours · goes to') && !(await priyaBalance.getByRole('button', { name: /Correct Priya Deshmukh/ }).count()), (await priyaBalance.innerText()).replace(/\n/g, ' | '))
  await shot(hema, '07-peer-hr-blocked')

  section('Her leave, from either login')
  const priyaReq = await applyFor('emp', weekday(16))
  check('she applies from her employee login', priyaReq.status === 201, JSON.stringify(priyaReq.body).slice(0, 160))
  const ownDecide = await api('priyaHr', 'POST', `/leave-requests/${priyaReq.body.data.id}/approve`, {})
  check('her HR login cannot approve her own leave', ownDecide.status === 403 && /your own leave/.test(ownDecide.body.error?.message ?? ''), ownDecide.body.error?.message)
  check('Manoj, above her, decides it', (await api('mgr', 'POST', `/leave-requests/${priyaReq.body.data.id}/approve`, {})).status === 200)

  section('The audit log says which login')
  await sa.goto(`${BASE}/settings?tab=audit`)
  await settle(sa)
  const doneBy = sa.locator('label', { hasText: 'Done by' }).locator('select')
  const choices = await doneBy.locator('option').allInnerTexts()
  check('“Done by” lists both of her logins, each by its role', choices.includes('Priya Deshmukh — HR login') && choices.includes('Priya Deshmukh — Employee login'), choices.filter((c) => c.includes('Priya')).join(' | '))
  await doneBy.selectOption({ label: 'Priya Deshmukh — HR login' })
  await settle(sa)
  // The table on a computer; its "Who" cell is the name, then the role it held.
  const whoCells = sa.locator('table').last().locator('tbody tr td:nth-child(2)')
  await whoCells.first().waitFor({ timeout: 20_000 })
  const who = (await whoCells.allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim())
  const what = await sa.locator('table').last().innerText()
  // A sign-in records no role of its own, so it reads the role as it is "(now)".
  check('…and picks out only what her HR login did — approving Ravi’s leave among it', who.length > 0 && who.every((t) => t === 'Priya Deshmukh HR' || t === 'Priya Deshmukh HR (now)') && what.includes('Approved 1 day of leave for Ravi Patil'), `${who.length} rows: ${[...new Set(who)].join(' | ')}`)

  section('Users settings: one person, two logins together')
  await sa.goto(`${BASE}/settings?tab=users`)
  await settle(sa)
  const group = sa.locator(`tr[data-person="${E.priya.id}"]`)
  check('her two logins are listed together', (await group.count()) === 2)
  check('her name once, with “2 logins”', (await group.nth(0).innerText()).includes('Priya Deshmukh') && (await group.nth(0).innerText()).includes('2 logins'))
  check('the second row is “Their other login”', (await group.nth(1).innerText()).includes('Their other login') && (await group.nth(1).innerText()).includes(PRIYA_HR))
  check('Remove sits on the person, once', (await group.getByTitle('Remove user').count()) === 1)
  await shot(sa, '08-users-grouped')

  section('Turning one login off leaves the other')
  drawer = await openDrawer(sa, 'Priya Deshmukh')
  list = loginsList(drawer)
  const hrItem = list.locator('li', { hasText: PRIYA_HR })
  await hrItem.getByRole('button', { name: 'Turn off' }).click()
  // Asked once more: turning a login off signs it out everywhere.
  const offDialog = sa.getByRole('dialog')
  check('turning a login off is asked once more, saying the other login keeps working', (await offDialog.innerText()).includes('Their other login keeps working.'))
  await offDialog.getByRole('button', { name: 'Turn off' }).click()
  await hrItem.getByText('Turned off · HR').waitFor({ timeout: 20_000 })
  check('the Super Admin turns her HR login off from her page', (await loginsOf(E.priya.id)).find((l) => l.email === PRIYA_HR)?.status === 'inactive')
  check('the HR login is signed out at once', await signedOut(priyaHr))
  await priya.goto(`${BASE}/dashboard`)
  await settle(priya)
  check('her employee login carries on', !priya.url().includes('/signin') && (await topBar(priya)).includes('Signed in as Employee'))
  await hrItem.getByRole('button', { name: 'Turn on' }).click()
  await hrItem.getByText('Can sign in · HR').waitFor({ timeout: 20_000 })
  check('…and turns it back on', (await loginsOf(E.priya.id)).find((l) => l.email === PRIYA_HR)?.status === 'active')

  section('Signing in by Employee ID')
  // Her employee login may have no email (client, 6 Oct 2026): the ID is its way in, the HR login has its own email.
  const byCode = await signIn(E.priya.code)
  check('her Employee ID opens her employee login', byCode.status === 200 && byCode.body.data?.user?.email === fx.users.emp && byCode.body.data?.user?.role === 'employee', `${byCode.status} ${byCode.body.data?.user?.email} ${byCode.body.data?.user?.role}`)
  check('somebody with one login still signs in by Employee ID', (await signIn(E.ravi.code)).status === 200)
  const signinPage = await (await browser.newContext()).newPage()
  await signinPage.goto(`${BASE}/signin`)
  check('the sign-in page says the ID opens the employee login, the other its email', await signinPage.getByText('Have two logins? Your Employee ID opens your employee login; sign in to the other with its email.').isVisible())

  section('On a phone (390px)')
  const hrPhone = await open({ email: PRIYA_HR, label: 'priya-hr-phone' }, PHONE)
  await settle(hrPhone)
  check('the top bar shows which login is open on a phone', await hrPhone.locator('header span[title="Signed in as HR"]').isVisible())
  check('the dashboard fits a phone', (await sideways(hrPhone)) <= 1, `${await sideways(hrPhone)}px over`)
  await shot(hrPhone, '09-phone-signed-in-as')
  const saPhone = await open('sa', PHONE)
  const phoneDrawer = await openDrawer(saPhone, 'Priya Deshmukh')
  await loginsList(phoneDrawer).waitFor({ timeout: 20_000 })
  check('her logins fit a phone', (await sideways(saPhone)) <= 1, `${await sideways(saPhone)}px over`)
  await phoneDrawer.getByRole('button', { name: 'Add another login' }).click()
  check('…and so does the add-login form', (await sideways(saPhone)) <= 1)
  await shot(saPhone, '10-phone-drawer-logins')
  await saPhone.goto(`${BASE}/settings?tab=users`)
  await settle(saPhone)
  check('Users settings fits a phone (the table scrolls in its box)', (await sideways(saPhone)) <= 1, `${await sideways(saPhone)}px over`)

  section('Leaving closes both')
  const priyaHr2 = await open({ email: PRIYA_HR, label: 'priya-hr-2' })
  await sa.goto(`${BASE}/settings?tab=users`)
  await settle(sa)
  await sa.locator(`tr[data-person="${E.priya.id}"]`).first().getByTitle('Remove user').click()
  const removeDialog = sa.getByRole('dialog')
  const words = await removeDialog.innerText()
  check('the dialog says both logins close, naming both emails', words.includes('All 2 of their logins close together') && words.includes(fx.users.emp) && words.includes(PRIYA_HR), words.replace(/\n/g, ' | '))
  await shot(sa, '11-remove-both')
  await removeDialog.getByRole('button', { name: 'Remove' }).click()
  await removeDialog.waitFor({ state: 'detached', timeout: 20_000 })
  const after = (await api('sa', 'GET', '/users')).body.data.filter((u) => u.person_id === E.priya.id)
  check('both logins are closed', after.length === 2 && after.every((u) => u.status === 'inactive'), JSON.stringify(after.map((u) => u.status)))
  check('her employee login is signed out', await signedOut(priya))
  check('…and her HR login', await signedOut(priyaHr2))
  check('neither signs in again', (await signIn(fx.users.emp)).status === 401 && (await signIn(PRIYA_HR)).status === 401)
  await sa.goto(`${BASE}/settings?tab=users`)
  await settle(sa)
  const leftGroup = sa.locator(`tr[data-person="${E.priya.id}"]`)
  check('Users settings marks her Left, with nothing to switch back on or remove', (await leftGroup.first().innerText()).includes('Left') && (await leftGroup.getByRole('button').count()) === 0, (await leftGroup.first().innerText()).replace(/\n/g, ' | '))
  check('…and the server refuses turning a login of hers back on', (await api('sa', 'PATCH', `/users/${after[0].id}/status`, { status: 'active' })).status === 400)
  await shot(sa, '12-users-left')

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
