// Passwords set by the company (client, 6 Oct 2026), through the browser.
//
// HR gives a new employee an Employee ID and a password, typed by hand —
// nothing generated — and the login works at once, with no email: the
// employee signs in with the Employee ID, in any letters. The employee cannot
// change it; HR sets a new one, which signs out the old sessions and says so
// in the bell. A role login's password is the Super Admin's alone. A roster
// import makes logins that wait for HR. Settings → Users & Roles → Passwords
// hands either kind back to its owner (links, as before) and sets the length.
// Someone with two logins reaches the employee login by the Employee ID.
// On a computer and a phone. Production build on :5183 → compiled API on
// :4100 → local ems_e2e, Day 20 seed (the company's defaults: HR sets
// employees' passwords, the Super Admin role logins', at least 10 characters).
import { chromium } from 'playwright-core'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { WORK } from '../lib/env.mjs'
import { openMyProfile, openEmployeeProfile, notificationPanel } from '../lib/ui.mjs'

const BASE = 'http://localhost:5183'
const API = `${BASE}/api`
const fx = JSON.parse(readFileSync(`${WORK}/day20-fixture.json`, 'utf8'))
const E = fx.employees
const SHOTS = `${WORK}/shots/passwords`
mkdirSync(SHOTS, { recursive: true })
const PHONE = { width: 390, height: 844 }
const DESKTOP = { width: 1366, height: 900 }

// The new employee, with no email: her Employee ID has capitals, she types it in small letters.
const POOJA = { name: 'Pooja Pawar', code: `CMS-PW${fx.stamp}`, first: 'Welcome@2026', second: 'NewStart@2026' }
// Two from a roster: one with an email (a login waiting for HR), one without (no login).
const IMRAN = { name: 'Imran Shaikh', code: `CMS-IM${fx.stamp}`, email: `d20-${fx.stamp}-imran@example.com`, password: 'Imran@2026xy' }
const LATA = { name: 'Lata Kale', code: `CMS-LK${fx.stamp}` }
const HEMA_OWN = 'HemaOwn@2026'
const SUNITA_OWN = 'SunitaOwn@2026'
const SUNITA_NEW = 'SunitaNew@2026'
const MANOJ_NEW = 'Manoj@2026xy'

// ── Reporting: PASS / FAIL lines, which the runner counts ──────────────────
let passed = 0
const failures = []
function check(name, ok, detail = '') {
  if (ok) { passed++; console.log(`PASS  ${name}`) } else { failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`FAIL  ${name}${detail ? `  — ${detail}` : ''}`) }
}
const section = (name) => console.log(`\n── ${name}`)

// ── The API ─────────────────────────────────────────────────────────────────
async function signIn(identifier, password = fx.password) {
  const res = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier, password }) })
  return { status: res.status, body: await res.json().catch(() => null) }
}
/** A token per login, signed in again once it is a few minutes old (they last fifteen). */
const tokens = {}
async function tokenOf(who) {
  const held = tokens[who]
  if (held && Date.now() - held.at < 8 * 60_000) return held.token
  const res = await signIn(fx.users[who])
  if (res.status !== 200) throw new Error(`${who} could not sign in: ${res.status} ${JSON.stringify(res.body)}`)
  tokens[who] = { token: res.body.data.accessToken, at: Date.now() }
  return tokens[who].token
}
async function api(who, method, path, body) {
  const token = typeof who === 'string' && fx.users[who] ? await tokenOf(who) : who
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'X-Requested-With': 'ems', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { json = text }
  return { status: res.status, body: json }
}
const loginsOf = async (employeeId) => (await api('sa', 'GET', `/employees/${employeeId}`)).body.data?.logins ?? []
const loginByEmail = async (email) => (await api('sa', 'GET', '/users')).body.data.find((u) => u.email === email)
const RULES = (employeePasswords, rolePasswords = 'company', passwordMinLength = 10) => ({ employeePasswords, rolePasswords, passwordMinLength })

// ── The browser ─────────────────────────────────────────────────────────────
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const pageErrors = []
const serverErrors = []

/** A fresh browser signed in as `who` (a fixture login) or { as, id, password }. */
async function open(who, viewport = DESKTOP) {
  const label = typeof who === 'string' ? who : who.as
  const identifier = typeof who === 'string' ? fx.users[who] : who.id
  const password = typeof who === 'string' ? fx.password : who.password
  const ctx = await browser.newContext({ viewport })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => pageErrors.push(`${label}: ${e.message}`))
  page.on('response', (r) => { if (r.url().includes('/api/') && r.status() >= 500) serverErrors.push(`${label}: ${r.status()} ${r.request().method()} ${r.url().split('/api')[1]}`) })
  await page.goto(`${BASE}/signin`)
  await page.getByLabel('Work Email or Employee ID').fill(identifier)
  await page.getByPlaceholder('Enter your password').fill(password)
  await page.getByRole('button', { name: 'Sign In' }).click()
  await page.waitForURL((url) => !url.pathname.startsWith('/signin'), { timeout: 20_000 })
  await settle(page)
  return page
}
async function settle(page) {
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined)
  await page.getByText(/^Loading/).first().waitFor({ state: 'detached', timeout: 20_000 }).catch(() => undefined)
  await page.waitForTimeout(250)
}
const go = async (page, path) => { await page.goto(`${BASE}${path}`); await settle(page) }
const shown = (locator, timeout = 10_000) => locator.first().waitFor({ timeout }).then(() => true, () => false)
const gone = (locator, timeout = 5_000) => locator.first().waitFor({ state: 'detached', timeout }).then(() => true, () => false)
const sideways = (page) => page.evaluate(() => {
  const main = document.querySelector('main')
  return Math.max(document.documentElement.scrollWidth - window.innerWidth, main ? main.scrollWidth - main.clientWidth : 0)
})
/** A form field by the label above it (the Add Employee form's labels are not tied to their inputs). */
const field = (scope, label) => scope.locator(`xpath=.//label[starts-with(normalize-space(.), "${label}")]/following-sibling::*[1]`)
const shot = (page, name) => page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false }).catch(() => undefined)
/** The buttons that set a password, on a page or in a part of one. */
const setPasswordButtons = (scope) => scope.getByRole('button', { name: /^Set (a new|the) password for / })

try {
  // ═══════════════════════════════════════════════════════════════════════
  section('HR adds a new employee with an Employee ID and a password, and no email')
  const hr = await open('hr')
  let employeePosts = 0
  hr.on('request', (r) => { if (r.method() === 'POST' && r.url().endsWith('/api/employees')) employeePosts++ })
  await go(hr, '/employees')
  await hr.getByRole('button', { name: 'Add Employee' }).click()
  const add = hr.getByRole('dialog', { name: 'Add New Employee' })
  await field(add, 'Full Name').fill(POOJA.name)
  await field(add, 'Employee Code').fill(POOJA.code)
  await field(add, 'Date of Joining').fill('2026-10-01')
  await field(add, 'Department').selectOption({ label: 'Technology' })
  await add.getByText('Give them a login to the system').click()
  const pw = add.getByLabel('Password', { exact: true })
  const again = add.getByLabel('Type it again')
  check('the login’s email is optional for an employee', await shown(add.getByText('Work Email (optional)')))
  check('…and HR types its password, told the company’s length', await shown(pw) && await shown(add.getByText('At least 10 characters.')))
  const addWords = await add.innerText()
  check('…saying she signs in with her Employee ID, and only HR or the Super Admin can change it',
    addWords.includes('They sign in with their Employee ID (or the email, if given) and this password') && addWords.includes('only HR or the Super Admin can change it'))
  await shot(hr, '01-add-employee-login')

  await pw.fill('short1')
  await again.fill('short1')
  await add.getByRole('button', { name: 'Add Employee' }).click()
  check('a short password is stopped before anything is sent', await shown(add.getByRole('alert').filter({ hasText: 'The password must be at least 10 characters' })) && employeePosts === 0)
  await pw.fill(POOJA.first)
  await again.fill('Welcome@2027')
  await add.getByRole('button', { name: 'Add Employee' }).click()
  check('…and two that differ', await shown(add.getByRole('alert').filter({ hasText: 'The two passwords are not the same' })) && employeePosts === 0)
  await again.fill(POOJA.first)
  const created = hr.waitForResponse((r) => r.url().endsWith('/api/employees') && r.request().method() === 'POST')
  await add.getByRole('button', { name: 'Add Employee' }).click()
  const createdRes = await created
  const createdBody = await createdRes.json()
  check('Pooja is added, her login started with the password typed', createdRes.status() === 201 && createdBody.meta?.login_start === 'password', `${createdRes.status()} ${createdBody.meta?.login_start}`)
  check('…and HR is told how she signs in, and to pass the password on',
    await shown(hr.getByText(`${POOJA.name} added. They sign in with Employee ID ${POOJA.code} and the password you set — tell them the password yourself.`)))
  POOJA.id = createdBody.data.id
  const poojaLogin = createdBody.data.logins?.[0]
  POOJA.loginId = poojaLogin?.id
  check('…a login with no email, working at once', poojaLogin?.email === null && poojaLogin?.status === 'active' && poojaLogin?.has_password === true && poojaLogin?.login_kind === 'employee', JSON.stringify(poojaLogin))
  check('…and no link anywhere', !JSON.stringify(createdBody).includes('token'))

  // ═══════════════════════════════════════════════════════════════════════
  section('She signs in with her Employee ID, typed in small letters')
  const pooja = await open({ as: 'pooja', id: POOJA.code.toLowerCase(), password: POOJA.first })
  check('she is in', !pooja.url().includes('/signin'), pooja.url())
  await pooja.locator('header [aria-haspopup="menu"]').click()
  check('her menu names the login by her Employee ID', await shown(pooja.getByRole('menu').getByText(`Employee ID ${POOJA.code}`, { exact: true })))
  await pooja.keyboard.press('Escape')
  await openMyProfile(pooja, 'Password')
  check('My Profile says HR sets her password and she cannot change it', await shown(pooja.getByText('At this company HR sets your password, and you cannot change it here.', { exact: false })))
  check('…with no form to change it', (await pooja.getByText('Current Password').count()) === 0)
  await shot(pooja, '02-employee-password-tab')
  const poojaToken = (await signIn(POOJA.code, POOJA.first)).body?.data?.accessToken
  const ownChange = await api(poojaToken, 'POST', '/auth/change-password', { currentPassword: POOJA.first, newPassword: 'MyOwnOne@2026' })
  check('the server refuses her changing it too, pointing her to HR', ownChange.status === 403 && ownChange.body?.error?.message === 'Your password is set by HR. Ask HR to change it.', `${ownChange.status} ${ownChange.body?.error?.message}`)
  check('a wrong password does not sign her in', (await signIn(POOJA.code, 'Welcome@2025')).status === 401)

  // ═══════════════════════════════════════════════════════════════════════
  section('HR sets her a new password')
  let main = await openEmployeeProfile(hr, BASE, POOJA.name, /^Logins?$/)
  const logins = main.getByRole('list', { name: 'Logins' })
  check('her page lists the login by its Employee ID', await shown(logins.getByText(`Employee ID ${POOJA.code}`, { exact: true })) && await shown(logins.getByText('Can sign in · Employee')))
  await main.getByRole('button', { name: `Set a new password for Employee ID ${POOJA.code}` }).click()
  const dialog = hr.getByRole('dialog', { name: `Set a new password for ${POOJA.name}` })
  check('a dialog asks for the new password, saying her devices are signed out', await shown(dialog) && (await dialog.innerText()).includes('Every device signed in with the old password is signed out'))
  await dialog.getByLabel('New password', { exact: true }).fill('Short@1')
  await dialog.getByLabel('Type it again').fill('Short@1')
  await dialog.getByRole('button', { name: 'Set password' }).click()
  check('…stops a short one', await shown(dialog.getByRole('alert').filter({ hasText: 'The password must be at least 10 characters' })))
  await dialog.getByLabel('New password', { exact: true }).fill(POOJA.second)
  await dialog.getByLabel('Type it again').fill(POOJA.second)
  await shot(hr, '03-set-new-password')
  await dialog.getByRole('button', { name: 'Set password' }).click()
  check('…and sets it, telling HR to pass it on', await shown(hr.getByText(`New password set for ${POOJA.name}. Tell them yourself — it is not shown again.`)) && await gone(dialog))

  await go(pooja, '/dashboard')
  await pooja.waitForURL('**/signin', { timeout: 20_000 }).catch(() => undefined)
  check('her open session is signed out at once', pooja.url().includes('/signin'), pooja.url())
  check('…her old token no longer works', (await api(poojaToken, 'GET', '/auth/session')).status === 401)
  check('the old password no longer signs in', (await signIn(POOJA.code, POOJA.first)).status === 401)
  await pooja.context().close()
  const pooja2 = await open({ as: 'pooja', id: POOJA.code, password: POOJA.second })
  check('the new one does', !pooja2.url().includes('/signin'))
  await pooja2.getByRole('button', { name: /^Notifications/ }).click()
  const bell = notificationPanel(pooja2)
  check('the bell tells her a new password was set, by HR', await shown(bell.getByText('A new password was set for you')) && await shown(bell.getByText(/HR set a new password for you/)))
  await shot(pooja2, '04-bell-new-password')
  await pooja2.context().close()

  // ═══════════════════════════════════════════════════════════════════════
  section('A roster import: the logins wait for HR to set their passwords')
  const csvPath = join(WORK, 'passwords-roster.csv')
  writeFileSync(csvPath, `employee_code,full_name,email\n${IMRAN.code},${IMRAN.name},${IMRAN.email}\n${LATA.code},${LATA.name},\n`)
  await go(hr, '/employees')
  await hr.getByRole('button', { name: 'Import', exact: true }).click()
  const imp = hr.getByRole('dialog', { name: 'Import Employees' })
  await imp.locator('input[type="file"]').setInputFiles(csvPath)
  check('the preview says the one with an email gets a login waiting for HR — no link', await shown(imp.getByText('1 of them have an email and will get a login, waiting for HR to set its password.', { exact: false }), 20_000))
  await imp.getByRole('button', { name: 'Import 2 employees' }).click()
  check('after the import, it says one login waits for a password, and where to set it',
    await shown(imp.getByText('1 login waits for a password.', { exact: false }), 20_000) && (await imp.innerText()).includes('No password yet'))
  check('…and hands out no invitation links', (await imp.getByText('Invitation links').count()) === 0)
  await shot(hr, '05-import-waiting')
  await imp.getByRole('button', { name: 'Done' }).click()
  const imranLogin = await loginByEmail(IMRAN.email)
  check('the login is there, waiting for its password, and cannot sign in yet',
    imranLogin?.status === 'invited' && imranLogin?.has_password === false && (await signIn(IMRAN.email, IMRAN.password)).status === 401, JSON.stringify(imranLogin))

  await go(hr, '/settings?tab=users')
  const imranRow = hr.locator('tr', { hasText: IMRAN.email })
  check('Users & Roles shows it as “No password yet”', await shown(imranRow.getByText('No password yet')))
  await imranRow.getByRole('button', { name: `Set the password for ${IMRAN.email}` }).click()
  const first = hr.getByRole('dialog', { name: `Set the password for ${IMRAN.name}` })
  check('…where HR sets its first password, which makes it work at once', await shown(first) && (await first.innerText()).includes('Their login works as soon as it is set.'))
  await first.getByLabel('New password', { exact: true }).fill(IMRAN.password)
  await first.getByLabel('Type it again').fill(IMRAN.password)
  await first.getByRole('button', { name: 'Set password' }).click()
  check('…and says so', await shown(hr.getByText(`Password set for ${IMRAN.name}. Tell them yourself`, { exact: false })))
  check('…the row now reads “Can sign in”', await shown(imranRow.getByText('Can sign in')))
  check('he signs in by email, and by Employee ID', (await signIn(IMRAN.email, IMRAN.password)).status === 200 && (await signIn(IMRAN.code.toLowerCase(), IMRAN.password)).status === 200)
  check('the roster row with no email got no login', (await loginsOf((await api('sa', 'GET', `/employees?search=${encodeURIComponent(LATA.code)}`)).body.data?.[0]?.id ?? 'none')).length === 0)

  // ═══════════════════════════════════════════════════════════════════════
  section('The Super Admin: role logins’ passwords, and a second login with no email')
  const sa = await open('sa')
  await openMyProfile(sa, 'Password')
  check('the Super Admin changes their own password, as before', await shown(sa.getByText('Current Password')))
  main = await openEmployeeProfile(sa, BASE, E.manoj.name, /^Logins?$/)
  await main.getByRole('button', { name: `Set a new password for ${fx.users.mgr}` }).click()
  const manojDialog = sa.getByRole('dialog', { name: `Set a new password for ${E.manoj.name}` })
  await manojDialog.getByLabel('New password', { exact: true }).fill(MANOJ_NEW)
  await manojDialog.getByLabel('Type it again').fill(MANOJ_NEW)
  await manojDialog.getByRole('button', { name: 'Set password' }).click()
  check('the Super Admin sets a manager’s (role login) password', await shown(sa.getByText(`New password set for ${E.manoj.name}.`, { exact: false })) && (await signIn(fx.users.mgr, MANOJ_NEW)).status === 200)
  const manoj = await open({ as: 'mgr', id: fx.users.mgr, password: MANOJ_NEW })
  await openMyProfile(manoj, 'Password')
  check('the manager reads that the Super Admin sets it', await shown(manoj.getByText('At this company the Super Admin sets your password', { exact: false })))
  await manoj.context().close()

  main = await openEmployeeProfile(sa, BASE, E.hema.name, /^Logins?$/)
  await main.getByRole('button', { name: 'Add another login' }).click()
  const addLogin = main.getByRole('form', { name: 'Add a login' })
  check('Hema (HR) is offered an employee login, its email optional', (await addLogin.getByLabel('Role').inputValue()) === 'employee' && await shown(addLogin.getByText('Email (optional)')))
  await addLogin.getByLabel('Password', { exact: true }).fill(HEMA_OWN)
  await addLogin.getByLabel('Type it again').fill(HEMA_OWN)
  await addLogin.getByRole('button', { name: 'Add login' }).click()
  check('…added with no email, signing in by her Employee ID', await shown(sa.getByText(`Login ready: ${E.hema.name} signs in with Employee ID ${E.hema.code} and the password you set.`, { exact: false })))
  check('her page says the Employee ID opens the employee login, the other its email', await shown(main.getByText('Their Employee ID opens the employee login; every other login signs in with its own email.', { exact: false })))
  await shot(sa, '06-hema-two-logins')
  const hemaByCode = await signIn(E.hema.code, HEMA_OWN)
  check('her Employee ID opens the employee login', hemaByCode.status === 200 && hemaByCode.body.data.user.role === 'employee' && hemaByCode.body.data.user.email === null, `${hemaByCode.status} ${hemaByCode.body?.data?.user?.role}`)
  check('…her email the HR login, with its own password', (await signIn(fx.users.hr)).body?.data?.user?.role === 'hr')
  const hemaOwn = await open({ as: 'hema-own', id: E.hema.code, password: HEMA_OWN })
  check('in the browser too: “Signed in as Employee”', await shown(hemaOwn.locator('[data-signed-in-as]', { hasText: 'Signed in as Employee' })))
  await hemaOwn.context().close()

  // ═══════════════════════════════════════════════════════════════════════
  section('A Super Admin’s own employee login: its password is theirs')
  main = await openEmployeeProfile(sa, BASE, E.sunita.name, /^Logins?$/)
  await main.getByRole('button', { name: 'Add another login' }).click()
  const ownForm = main.getByRole('form', { name: 'Add a login' })
  await ownForm.getByLabel('Password', { exact: true }).fill(SUNITA_OWN)
  await ownForm.getByLabel('Type it again').fill(SUNITA_OWN)
  await ownForm.getByRole('button', { name: 'Add login' }).click()
  check('the Super Admin gives herself an employee login with no email', await shown(main.getByText(`Employee ID ${E.sunita.code}`, { exact: true })))
  await main.getByRole('button', { name: `Set a new password for Employee ID ${E.sunita.code}` }).click()
  const ownDialog = sa.getByRole('dialog', { name: `Set a new password for your Employee ID ${E.sunita.code} login` })
  check('…and may set its password from her own page', await shown(ownDialog) && (await ownDialog.innerText()).includes('You sign in to it with'))
  check('…while her Super Admin login (the one in use) offers no such button',
    (await main.getByRole('button', { name: `Set a new password for ${fx.users.sa}` }).count()) === 0)
  await ownDialog.getByLabel('New password', { exact: true }).fill(SUNITA_NEW)
  await ownDialog.getByLabel('Type it again').fill(SUNITA_NEW)
  await ownDialog.getByRole('button', { name: 'Set password' }).click()
  check('…it is set', await shown(sa.getByText(`New password set for your Employee ID ${E.sunita.code} login.`)))
  const sunitaOwn = await open({ as: 'sunita-own', id: E.sunita.code.toLowerCase(), password: SUNITA_NEW })
  check('her Employee ID opens the employee login, with the new password', await shown(sunitaOwn.locator('[data-signed-in-as]', { hasText: 'Signed in as Employee' })))
  await openMyProfile(sunitaOwn, 'Password')
  check('…where she may change it herself — nobody above her could', await shown(sunitaOwn.getByText('Current Password')))
  await sunitaOwn.context().close()

  // ═══════════════════════════════════════════════════════════════════════
  section('What HR cannot do')
  main = await openEmployeeProfile(hr, BASE, E.manoj.name, /^Logins?$/)
  check('no Set password on a manager’s (role) login — the login is listed, with no button',
    await shown(main.getByText('Can sign in · Manager')) && (await setPasswordButtons(main).count()) === 0)
  const mgrLogin = await loginByEmail(fx.users.mgr)
  const hrOnRole = await api('hr', 'POST', `/users/${mgrLogin.id}/password`, { password: 'Manager@2026x' })
  check('…and the server refuses it', hrOnRole.status === 403 && hrOnRole.body?.error?.message === 'Only the Super Admin sets the password of a role login.', `${hrOnRole.status} ${hrOnRole.body?.error?.message}`)
  main = await openEmployeeProfile(hr, BASE, E.hema.name, /^Logins?$/)
  check('none on her own logins — the HR one or her employee one, both listed',
    await shown(main.getByText('Can sign in · HR')) && await shown(main.getByText(`Employee ID ${E.hema.code}`, { exact: true })) && (await setPasswordButtons(main).count()) === 0)
  main = await openEmployeeProfile(hr, BASE, E.anil.name, /^Logins?$/)
  check('no Add login for somebody whose login is not below HR (Accounts)',
    await shown(main.getByText('Can sign in · Accounts')) && (await main.getByRole('button', { name: /^Add (another )?login$/ }).count()) === 0 && (await setPasswordButtons(main).count()) === 0)
  const hemaEmployeeLogin = (await loginsOf(E.hema.id)).find((l) => l.login_kind === 'employee')
  const ownSet = await api('hr', 'POST', `/users/${hemaEmployeeLogin?.id}/password`, { password: 'MyOwnOne@2026' })
  check('…and the server refuses her own', ownSet.status === 403, String(ownSet.status))
  await openMyProfile(hr, 'Password')
  check('her My Profile says the Super Admin sets her (HR) password', await shown(hr.getByText('At this company the Super Admin sets your password', { exact: false })))
  main = await openEmployeeProfile(hr, BASE, E.priya.name, /^Logins?$/)
  check('…while an employee’s page offers HR “Set new password”', await shown(main.getByRole('button', { name: `Set a new password for ${fx.users.emp}` })))
  await go(hr, '/settings?tab=users')
  check('Users & Roles: HR sees no Passwords rules', (await hr.getByRole('region', { name: 'Passwords' }).count()) === 0)
  check('…a key on the employees’ rows, none on the manager’s', await shown(hr.getByRole('button', { name: `Set a new password for ${fx.users.emp}` })) &&
    (await hr.getByRole('button', { name: `Set a new password for ${fx.users.mgr}` }).count()) === 0)
  await shot(hr, '07-hr-users')

  // ═══════════════════════════════════════════════════════════════════════
  section('Settings → Users & Roles → Passwords, as the Super Admin')
  await go(sa, '/settings?tab=users')
  const rules = sa.getByRole('region', { name: 'Passwords' })
  const employeeRule = sa.getByLabel('Who sets employee logins’ passwords')
  const roleRule = sa.getByLabel('Who sets role logins’ passwords')
  const length = sa.getByLabel('Shortest password, in characters')
  const save = sa.getByRole('button', { name: /^(Save Changes|Saved)$/ })
  check('the rules are there, at their defaults: HR, the Super Admin, 10',
    await shown(rules) && (await employeeRule.inputValue()) === 'company' && (await roleRule.inputValue()) === 'company' && (await length.inputValue()) === '10')
  await rules.scrollIntoViewIfNeeded()
  await shot(sa, '08-password-rules')
  await length.fill('7')
  check('a length below 8 cannot be saved', await shown(sa.getByRole('alert').filter({ hasText: 'Between 8 and 64 characters.' })) && await save.isDisabled())
  await length.fill('12')
  await save.click()
  check('a longer minimum is saved', await shown(sa.getByText('Password rules saved')))
  // A reload reads the session again: HR's screens learn the new length from it.
  main = await openEmployeeProfile(hr, BASE, E.priya.name, /^Logins?$/)
  await main.getByRole('button', { name: `Set a new password for ${fx.users.emp}` }).click()
  const twelve = hr.getByRole('dialog', { name: `Set a new password for ${E.priya.name}` })
  check('HR’s dialog asks for 12 now', await shown(twelve.getByText('At least 12 characters.')))
  await twelve.getByLabel('New password', { exact: true }).fill('Eleven@2026')
  await twelve.getByLabel('Type it again').fill('Eleven@2026')
  await twelve.getByRole('button', { name: 'Set password' }).click()
  check('…and stops 11', await shown(twelve.getByRole('alert').filter({ hasText: 'The password must be at least 12 characters' })))
  check('…as the server does', (await api('hr', 'POST', `/users/${(await loginByEmail(fx.users.emp)).id}/password`, { password: 'Eleven@2026' })).status === 422)
  await twelve.getByRole('button', { name: 'Cancel' }).click()

  await go(sa, '/settings?tab=users')
  await employeeRule.selectOption('self')
  await length.fill('10')
  await save.click()
  check('handed back to employees: saved', await shown(sa.getByText('Password rules saved')))
  main = await openEmployeeProfile(hr, BASE, E.priya.name, /^Logins?$/)
  check('HR no longer sets an employee’s password — the login is listed, with no button',
    await shown(main.getByText('Can sign in · Employee')) && (await setPasswordButtons(main).count()) === 0)
  check('…and the server agrees', (await api('hr', 'POST', `/users/${(await loginByEmail(fx.users.emp)).id}/password`, { password: 'SelfMode@2026' })).status === 409)
  await go(hr, '/employees')
  await hr.getByRole('button', { name: 'Add Employee' }).click()
  const addSelf = hr.getByRole('dialog', { name: 'Add New Employee' })
  await addSelf.getByText('Give them a login to the system').click()
  check('…and a new login gets a link, typed no password', await shown(addSelf.getByText('No password is set here. After saving you get a one-time link to send them', { exact: false })) &&
    (await addSelf.getByLabel('Password', { exact: true }).count()) === 0)
  await hr.keyboard.press('Escape')
  const priya = await open('emp')
  await openMyProfile(priya, 'Password')
  check('the employee may change her own now', await shown(priya.getByText('Current Password')))
  await priya.context().close()
  const link = await api('sa', 'POST', `/users/${POOJA.loginId}/password-link`, {})
  check('…and a reset link can be issued for Pooja', link.status === 201 && typeof link.body?.data?.invite?.token === 'string', String(link.status))

  await go(sa, '/settings?tab=users')
  await employeeRule.selectOption('company')
  await save.click()
  check('taken back by the company: saved', await shown(sa.getByText('Password rules saved')))
  const linkPage = await (await browser.newContext()).newPage()
  linkPage.on('pageerror', (e) => pageErrors.push(`link: ${e.message}`))
  await linkPage.goto(`${BASE}/set-password#token=${encodeURIComponent(link.body?.data?.invite?.token ?? '')}`)
  check('the link issued meanwhile can no longer be used, and says who sets it', await shown(linkPage.getByRole('alert').filter({ hasText: 'This link can no longer be used. Your password is set by HR: ask them for it.' }), 20_000))
  await shot(linkPage, '09-dead-link')
  await linkPage.context().close()

  // ═══════════════════════════════════════════════════════════════════════
  section('Forgot password, on the sign-in page')
  const signinPage = await (await browser.newContext()).newPage()
  await signinPage.goto(`${BASE}/signin`)
  await signinPage.getByRole('button', { name: 'Forgot password?' }).click()
  check('it says to ask HR, or the Super Admin for a role login', await shown(signinPage.getByText('Ask HR — or, if you sign in for a role (HR, Accounts, a manager), the Super Admin. They set a new password for you, or send you a link to choose one.')))
  check('…and that the Employee ID opens the employee login', await shown(signinPage.getByText('Have two logins? Your Employee ID opens your employee login; sign in to the other with its email.')))
  await signinPage.context().close()

  // ═══════════════════════════════════════════════════════════════════════
  section('On a phone (390px)')
  const poojaPhone = await open({ as: 'pooja-phone', id: POOJA.code.toLowerCase(), password: POOJA.second }, PHONE)
  check('Pooja signs in by Employee ID on a phone', !poojaPhone.url().includes('/signin'))
  await openMyProfile(poojaPhone, 'Password')
  check('…her Password tab says HR sets it', await shown(poojaPhone.getByText('At this company HR sets your password', { exact: false })))
  check('…with no sideways scrolling', (await sideways(poojaPhone)) <= 1, `${await sideways(poojaPhone)}px`)
  await shot(poojaPhone, '10-phone-employee-password')
  await poojaPhone.context().close()

  const hrPhone = await open('hr', PHONE)
  main = await openEmployeeProfile(hrPhone, BASE, POOJA.name, /^Logins?$/)
  await main.getByRole('button', { name: `Set a new password for Employee ID ${POOJA.code}` }).click()
  const phoneDialog = hrPhone.getByRole('dialog', { name: `Set a new password for ${POOJA.name}` })
  check('HR’s Set password dialog opens on a phone, both fields in view', await shown(phoneDialog) &&
    await phoneDialog.getByLabel('New password', { exact: true }).isVisible() && await phoneDialog.getByLabel('Type it again').isVisible())
  const dialogBox = await phoneDialog.locator('form').boundingBox()
  check('…and fits the screen', dialogBox !== null && dialogBox.x >= 0 && dialogBox.x + dialogBox.width <= PHONE.width + 1, JSON.stringify(dialogBox))
  await shot(hrPhone, '11-phone-set-password')
  await phoneDialog.getByRole('button', { name: 'Cancel' }).click()
  check('…the profile page has no sideways scrolling', (await sideways(hrPhone)) <= 1, `${await sideways(hrPhone)}px`)
  await hrPhone.context().close()

  const saPhone = await open('sa', PHONE)
  await go(saPhone, '/settings?tab=users')
  const phoneRules = saPhone.getByRole('region', { name: 'Passwords' })
  await phoneRules.scrollIntoViewIfNeeded().catch(() => undefined)
  check('the Passwords rules on a phone', await shown(phoneRules) && await saPhone.getByLabel('Who sets employee logins’ passwords').isVisible())
  check('…with no sideways scrolling', (await sideways(saPhone)) <= 1, `${await sideways(saPhone)}px`)
  await shot(saPhone, '12-phone-rules')
  await saPhone.context().close()

  await hr.context().close()
  await sa.context().close()

  section('Nothing broke along the way')
  check('no page errors', pageErrors.length === 0, pageErrors.slice(0, 5).join(' | '))
  check('no server errors', serverErrors.length === 0, serverErrors.slice(0, 5).join(' | '))
} catch (err) {
  failures.push(`stopped: ${err.message}`)
  console.log(`FAIL  stopped: ${err.message}`)
  console.error(err)
} finally {
  // The company's rules as the seed made them, whatever happened above.
  try {
    const back = await api('sa', 'PUT', '/users/password-rules', RULES('company'))
    check('the password rules are put back to their defaults', back.status === 200, String(back.status))
  } catch (err) {
    failures.push(`putting the rules back: ${err.message}`)
  }
  await browser.close()
  console.log(`\n${passed} passed, ${failures.length} failed`)
  if (failures.length) {
    console.log(failures.map((f) => `  ✗ ${f}`).join('\n'))
    process.exitCode = 1
  }
}
