// Day 21 E2E — Settings → Roles & Permissions, and every place a role is
// named or handed out. Production build on :5183 → compiled API on :4100 →
// local ems_e2e. Fixture: the Day 20 seed (reset20.sh), whose users cover
// every built-in role.
import { chromium } from 'playwright-core'
import { WORK, REPO, STORAGE as STORE, psql } from '../lib/env.mjs'
import { readFileSync, mkdirSync } from 'node:fs'

const BASE = 'http://localhost:5183'
const API = `${BASE}/api`
const DIR = WORK
const fx = JSON.parse(readFileSync(`${DIR}/day20-fixture.json`, 'utf8'))
const SHOTS = `${DIR}/shots/day21`
mkdirSync(SHOTS, { recursive: true })
const STAMP = String(Date.now()).slice(-5)

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
const membershipOf = async (who) => {
  const users = await api('sa', 'GET', '/users')
  return users.body.data.find((u) => u.email === fx.users[who])
}

// ── The browser ─────────────────────────────────────────────────────────────
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const pageErrors = []
const serverErrors = []
async function newPage(who, viewport = { width: 1366, height: 900 }) {
  const ctx = await browser.newContext({ viewport })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => pageErrors.push(`${who}: ${e.message}`))
  page.on('response', (r) => { if (r.status() >= 500 && r.url().includes('/api/')) serverErrors.push(`${who} ${r.request().method()} ${r.url().split('/api')[1]} ${r.status()}`) })
  return page
}
async function open(who, viewport, before) {
  const page = await newPage(who, viewport)
  before?.(page)
  await page.goto(`${BASE}/signin`)
  await page.getByPlaceholder('you@careermap.in or EMP001').fill(fx.users[who])
  await page.getByPlaceholder('Enter your password').fill(fx.password)
  await page.getByRole('button', { name: 'Sign In' }).click()
  // The dashboard, or — for a role without one — the first area it opens.
  await page.waitForURL((url) => !url.pathname.startsWith('/signin'), { timeout: 20_000 })
  return page
}
const shot = (page, name) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true })
async function settle(page) {
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined)
  await page.getByText('Loading…', { exact: true }).first().waitFor({ state: 'detached', timeout: 20_000 }).catch(() => undefined)
}
const waitToast = (page, text) => page.locator('[data-sonner-toast]', { hasText: text }).first().waitFor({ timeout: 20_000 })
async function rolesTab(page) {
  await page.goto(`${BASE}/settings?tab=roles`)
  await settle(page)
  await page.getByText('Make roles, decide what each one can do').waitFor({ timeout: 20_000 })
}
const roleRow = (page, name) => page.locator('li').filter({ has: page.getByText(name, { exact: true }) }).first()
const dialog = (page) => page.getByRole('dialog').last()

try {
  for (const who of Object.keys(fx.users)) await login(who)

  // Clear anything an earlier run of this suite left behind.
  for (const r of (await api('sa', 'GET', '/roles')).body.data.roles.filter((r) => !r.built_in)) {
    const holders = (await api('sa', 'GET', '/users')).body.data.filter((u) => u.role === r.key)
    for (const h of holders) await api('sa', 'PUT', `/users/${h.id}/role`, { role: 'employee' })
  }
  for (let pass = 0; pass < 3; pass++) {
    for (const r of (await api('sa', 'GET', '/roles')).body.data.roles.filter((r) => !r.built_in)) await api('sa', 'DELETE', `/roles/${r.key}`)
  }
  for (const r of (await api('sa', 'GET', '/roles')).body.data.roles.filter((r) => r.changed_from_default && !r.locked)) {
    await api('sa', 'POST', `/roles/${r.key}/reset`, { version: r.version })
  }

  section('API: who may see roles, and every login’s role by name')
  const list = await api('sa', 'GET', '/roles')
  check('the Super Admin sees the seven built-in roles', list.status === 200 && list.body.data.roles.length === 7, `${list.body.data.roles.length}`)
  for (const who of ['admin', 'hr', 'mgr', 'rm', 'acc', 'emp']) {
    check(`${who} is refused the roles list`, (await api(who, 'GET', '/roles')).status === 403)
  }
  const names = { sa: 'Super Admin', admin: 'Admin', hr: 'HR', mgr: 'Manager', rm: 'Reporting Manager', acc: 'Accounts', emp: 'Employee' }
  for (const [who, name] of Object.entries(names)) {
    const user = await login(who)
    check(`${who} signs in with the role name “${name}”`, user.roleName === name, user.roleName)
  }

  section('The Roles & Permissions screen (Super Admin, desktop)')
  const sa = await open('sa')
  await page_tabs(sa)
  async function page_tabs(page) {
    await page.goto(`${BASE}/settings`)
    await settle(page)
    check('Settings has a Roles & Permissions tab for the Super Admin', await page.getByRole('button', { name: 'Roles & Permissions' }).first().isVisible())
  }
  await rolesTab(sa)
  const rowNames = await sa.locator('ul li p.font-semibold').allInnerTexts()
  check('roles are listed in their order, the Super Admin first', rowNames[0] === 'Super Admin' && rowNames.length === 7, rowNames.join(' > '))
  check('HR’s team roles sit under HR in the list (Manager before Reporting Manager before Employee)',
    rowNames.indexOf('HR') < rowNames.indexOf('Manager') && rowNames.indexOf('Manager') < rowNames.indexOf('Reporting Manager') && rowNames.indexOf('Reporting Manager') < rowNames.indexOf('Employee'),
    rowNames.join(' > '))
  check('the Super Admin role is marked Locked, and as their own', await roleRow(sa, 'Super Admin').getByText('Locked').isVisible() && await roleRow(sa, 'Super Admin').getByText('Your role').isVisible())
  check('the Super Admin role offers View, not Edit or Delete',
    await roleRow(sa, 'Super Admin').getByRole('button', { name: 'View' }).isVisible() && !(await roleRow(sa, 'Super Admin').getByRole('button', { name: /Delete/ }).count()))
  check('a built-in role offers no Delete', !(await roleRow(sa, 'HR').getByRole('button', { name: /Delete/ }).count()))
  await shot(sa, '01-roles-list')

  await roleRow(sa, 'Super Admin').getByRole('button', { name: 'View' }).click()
  check('viewing the Super Admin role says it can never change, with no Save', await dialog(sa).getByText('can never be changed').isVisible() && !(await dialog(sa).getByRole('button', { name: /Save/ }).count()))
  await sa.keyboard.press('Escape')
  check('Escape closes it', (await sa.getByRole('dialog').count()) === 0)

  section('Making a role')
  await sa.getByRole('button', { name: 'New role' }).click()
  const ed = dialog(sa)
  await ed.getByLabel('Name').fill(`Team Lead ${STAMP}`)
  await ed.getByLabel('Comes under').selectOption({ label: 'Manager' })
  // (Approving leave is no tick since Day 22 — the company tree decides it — so
  // the permission that needs "See leave" here is correcting balances.)
  await ed.getByRole('checkbox', { name: /^Give the yearly leave and correct balances/ }).check()
  check('ticking “Correct balances” ticks “See leave requests and balances” with it', await ed.getByRole('checkbox', { name: /^See leave requests and balances/ }).isChecked())
  await ed.getByLabel('Whose leave').selectOption({ label: 'Their team' })
  await ed.getByRole('checkbox', { name: /^Open the dashboard/ }).check()
  await ed.getByRole('checkbox', { name: /^See their own notifications/ }).check()
  const previewText = await ed.getByText('What this role will be able to do').locator('..').innerText()
  check('the preview says what the role will do and whose', /Leave \(their team\): See leave requests and balances, Give the yearly leave and correct balances/.test(previewText), previewText.replace(/\n/g, ' | '))
  // Unticking what another needs takes that one away too.
  await ed.getByRole('checkbox', { name: /^See leave requests and balances/ }).uncheck()
  check('unticking “See leave” unticks “Correct balances”, which needs it', !(await ed.getByRole('checkbox', { name: /^Give the yearly leave and correct balances/ }).isChecked()))
  await ed.getByRole('checkbox', { name: /^Give the yearly leave and correct balances/ }).check()
  const payslipChoices = await ed.getByLabel('Whose payslips').locator('option').allInnerTexts()
  check('payslips offer only their own or the whole company', payslipChoices.join('|') === 'Only their own|Whole company', payslipChoices.join(', '))
  check('the Payroll area says it covers the whole company', await ed.getByText('Payroll covers the whole company').isVisible())
  check('a checkbox is named by its permission alone, with what it needs said beside it',
    (await ed.getByRole('checkbox', { name: 'Give the yearly leave and correct balances', exact: true }).count()) === 1)
  await shot(sa, '02-new-role-editor')
  await ed.getByRole('button', { name: 'Create role' }).click()
  await sa.getByRole('status').filter({ hasText: `Team Lead ${STAMP}` }).waitFor({ timeout: 20_000 })
  check('the role is created and the screen says so', true)
  await settle(sa)
  check('it is listed under Manager, held by nobody yet',
    /Comes under Manager · 0 people/.test(await roleRow(sa, `Team Lead ${STAMP}`).innerText()), await roleRow(sa, `Team Lead ${STAMP}`).innerText())

  await sa.getByRole('button', { name: 'New role' }).click()
  await dialog(sa).getByLabel('Name').fill('hr')
  await dialog(sa).getByRole('checkbox', { name: /^Open the dashboard/ }).check()
  await dialog(sa).getByRole('button', { name: 'Create role' }).click()
  await dialog(sa).getByRole('alert').filter({ hasText: 'There is already a role called “HR”.' }).waitFor({ timeout: 20_000 })
  check('a name already taken is refused, in words, inside the editor', true)
  await sa.keyboard.press('Escape')

  await sa.getByRole('button', { name: 'New role' }).click()
  const pd = dialog(sa)
  await pd.getByLabel('Name').fill(`Payroll Desk ${STAMP}`)
  await pd.getByRole('checkbox', { name: /^Prepare the monthly payroll/ }).check()
  await pd.getByRole('checkbox', { name: /^Approve or reopen the payroll/ }).check()
  check('ticking both prepare and approve shows the warning', await pd.getByText('can both prepare and approve the payroll').first().isVisible())
  await pd.getByRole('button', { name: 'Create role' }).click()
  await sa.getByRole('button', { name: 'Save anyway' }).click()
  await sa.getByRole('status').filter({ hasText: `Payroll Desk ${STAMP}` }).waitFor({ timeout: 20_000 })
  check('saving it asks once more, then creates it', true)

  await sa.getByRole('button', { name: 'New role' }).click()
  const lr = dialog(sa)
  await lr.getByLabel('Name').fill(`Log Reader ${STAMP}`)
  await lr.getByRole('checkbox', { name: /^Read the audit log/ }).check()
  check('ticking “Read the audit log” warns that it shows the whole company', await lr.getByText('The audit log shows everything that happened in EMS').isVisible())
  await lr.getByRole('button', { name: 'Create role' }).click()
  check('saving it asks once more, in its own words', await sa.getByRole('dialog').getByText('Save a role that can read the audit log?').isVisible())
  await shot(sa, '02b-audit-warning')
  await sa.getByRole('button', { name: 'Save anyway' }).click()
  await sa.getByRole('status').filter({ hasText: `Log Reader ${STAMP}` }).waitFor({ timeout: 20_000 })
  check('…then creates it', true)

  section('Giving the role, and the change reaching the holder at once')
  const emp2 = await membershipOf('emp2')
  await sa.goto(`${BASE}/settings?tab=users`)
  await settle(sa)
  const ownRow = sa.locator('tr').filter({ hasText: fx.users.sa })
  check('the Super Admin’s own row offers no buttons — the server would refuse each', (await ownRow.getByRole('button').count()) === 0)
  check('the Super Admin’s list is the organisation’s, with no “nobody under yours” note',
    await sa.getByText(/\d+ logins in your organisation\./).isVisible() && !(await sa.getByText('Nobody listed here has a role under yours').count()))
  const emp2Row = sa.locator('tr').filter({ hasText: fx.users.emp2 })
  await emp2Row.getByTitle('Edit role').click()
  const roleSelect = emp2Row.getByLabel(/^Role for/)
  const offered = await roleSelect.locator('option').allInnerTexts()
  check('the role picker offers the new role among the company’s roles', offered.includes(`Team Lead ${STAMP}`), offered.join(', '))
  await roleSelect.selectOption({ label: `Team Lead ${STAMP}` })
  await emp2Row.getByRole('button', { name: 'Save role' }).click()
  await emp2Row.getByText(`Team Lead ${STAMP}`, { exact: true }).waitFor({ timeout: 20_000 })
  check('the Users list shows the custom role by name', true)

  const tl = await open('emp2')
  await settle(tl)
  check('the holder’s top bar names their custom role', (await tl.locator('header').innerText()).includes(`Team Lead ${STAMP}`))
  const navText = async () => tl.locator('nav').first().innerText()
  check('their menu has Leave and no Payroll, Employees or Settings',
    /Leave/.test(await navText()) && !/Payroll|Employees|Settings/.test(await navText()), (await navText()).replace(/\n/g, ' | '))

  // The Super Admin widens the role while the holder is signed in.
  const roleNow = (await api('sa', 'GET', '/roles')).body.data.roles.find((r) => r.name === `Team Lead ${STAMP}`)
  const widened = await api('sa', 'PUT', `/roles/${roleNow.key}`, {
    name: roleNow.name, description: '', parentKey: roleNow.parent_key,
    permissions: [...roleNow.permissions, 'employee:read'], scopes: { ...roleNow.scopes, employee: 'ORGANIZATION' }, version: roleNow.version,
  })
  check('the Super Admin widens the role while it is held', widened.status === 200 && widened.body.data.holders === 1, JSON.stringify(widened.body).slice(0, 200))
  await tl.getByRole('link', { name: 'Leave' }).first().click()
  await settle(tl)
  await tl.locator('nav').first().getByText('Employees').waitFor({ timeout: 20_000 })
  check('the holder’s menu gains Employees at their next click — no reload, no new sign-in', true)
  await shot(tl, '03-holder-after-change')

  section('Reset to default')
  const hr = (await api('sa', 'GET', '/roles')).body.data.roles.find((r) => r.key === 'hr')
  const renamed = await api('sa', 'PUT', '/roles/hr', { name: 'People Team', description: 'For the test', parentKey: 'super_admin', permissions: hr.permissions, scopes: hr.scopes, version: hr.version })
  check('HR can be renamed', renamed.status === 200)
  await rolesTab(sa)
  check('a changed built-in role is marked Changed, with a Reset button',
    await roleRow(sa, 'People Team').getByText('Changed').isVisible() && await roleRow(sa, 'People Team').getByRole('button', { name: 'Reset' }).isVisible())
  await roleRow(sa, 'People Team').getByRole('button', { name: 'Reset' }).click()
  await sa.getByRole('button', { name: 'Reset', exact: true }).last().click()
  await sa.getByRole('status').filter({ hasText: 'is back to how EMS started it' }).waitFor({ timeout: 20_000 })
  await settle(sa)
  check('reset puts its name back and the mark goes', await roleRow(sa, 'HR').isVisible() && !(await roleRow(sa, 'HR').getByText('Changed').count()))

  section('Deleting')
  await rolesTab(sa)
  await roleRow(sa, `Team Lead ${STAMP}`).getByRole('button', { name: /Delete/ }).click()
  check('deleting a role somebody holds explains why it cannot go', await sa.getByRole('dialog').getByText('still hold this role').isVisible())
  check('…and its Delete button cannot be pressed', await sa.getByRole('dialog').getByRole('button', { name: 'Delete' }).isDisabled())
  await sa.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click()
  // A role with another under it cannot go either, even once nobody holds it.
  await api('sa', 'PUT', `/users/${emp2.id}/role`, { role: 'employee' })
  const lead = (await api('sa', 'GET', '/roles')).body.data.roles.find((r) => r.name === `Team Lead ${STAMP}`)
  const sub = await api('sa', 'POST', '/roles', { name: `Sub Lead ${STAMP}`, description: '', parentKey: lead.key, permissions: ['dashboard:read'], scopes: {} })
  check('a role can be made under the custom role', sub.status === 201)
  await rolesTab(sa)
  await roleRow(sa, `Team Lead ${STAMP}`).getByRole('button', { name: /Delete/ }).click()
  check('deleting a role others come under names them, and Delete cannot be pressed',
    await sa.getByRole('dialog').getByText(`“Sub Lead ${STAMP}” comes under this role`).isVisible() && await sa.getByRole('dialog').getByRole('button', { name: 'Delete' }).isDisabled())
  await sa.keyboard.press('Escape')
  await roleRow(sa, `Sub Lead ${STAMP}`).getByRole('button', { name: /Delete/ }).click()
  await sa.getByRole('dialog').getByRole('button', { name: 'Delete' }).click()
  await sa.getByRole('status').filter({ hasText: 'was deleted' }).waitFor({ timeout: 20_000 })
  await settle(sa)
  await roleRow(sa, `Team Lead ${STAMP}`).getByRole('button', { name: /Delete/ }).click()
  check('once nobody holds it and nothing comes under it, Delete can be pressed', await sa.getByRole('dialog').getByRole('button', { name: 'Delete' }).isEnabled())
  await sa.getByRole('dialog').getByRole('button', { name: 'Delete' }).click()
  await sa.getByRole('status').filter({ hasText: `“Team Lead ${STAMP}” was deleted` }).waitFor({ timeout: 20_000 })
  await settle(sa)
  check('…and it is deleted and gone from the list', (await roleRow(sa, `Team Lead ${STAMP}`).count()) === 0)

  section('The audit log says what happened, in words')
  await sa.goto(`${BASE}/settings?tab=audit`)
  await settle(sa)
  const logText = await sa.locator('main').innerText()
  check('it records the role being created', logText.includes(`Created the role “Team Lead ${STAMP}” under Manager`))
  check('…with whose information it reaches', /Created the role “Team Lead \d+” under Manager, which can: [^\n]*; reaches Leave: Their team/.test(logText))
  check('…being widened, in the screen’s own words', logText.includes(`Changed the role “Team Lead ${STAMP}”: can now: See employee records`))
  check('…the reset', logText.includes('Reset the role “HR” to how it started: renamed from “People Team”'))
  check('…and the deletion', logText.includes(`Deleted the role “Team Lead ${STAMP}”`))

  section('Who is offered which roles')
  const hrPage = await open('hr')
  await hrPage.goto(`${BASE}/settings`)
  await settle(hrPage)
  check('HR has no Roles & Permissions tab', !(await hrPage.getByRole('button', { name: 'Roles & Permissions' }).count()))
  await hrPage.goto(`${BASE}/employees`)
  await settle(hrPage)
  await hrPage.getByRole('button', { name: /Add Employee/ }).first().click()
  await hrPage.getByLabel(/Give them a login/).check()
  await settle(hrPage)
  // The login's role picker — the one with an "Employee" option, not the
  // reporting-manager list of people.
  const loginSelect = hrPage.locator('select').filter({ has: hrPage.locator('option', { hasText: /^Employee$/ }) }).first()
  const hrOffers = await loginSelect.locator('option').allInnerTexts()
  check('HR may give only the roles below HR: Manager, Reporting Manager, Employee',
    ['Manager', 'Reporting Manager', 'Employee'].every((n) => hrOffers.includes(n)) && !hrOffers.some((n) => ['Super Admin', 'Admin', 'Accounts', 'HR'].includes(n)),
    hrOffers.join(', '))
  check('…starting on Employee', (await loginSelect.inputValue()) === 'employee')
  await hrPage.keyboard.press('Escape')
  // HR's API token was ended on purpose when the HR role was reset above.
  check('an API token from before the HR role was reset is refused', (await api('hr', 'GET', '/employees')).status === 401)
  await login('hr')
  const refused = await api('hr', 'POST', '/employees', { employeeCode: `D21-${STAMP}`, fullName: 'Refused Test', login: { email: `d21-${STAMP}@example.com`, role: 'accounts' } })
  check('the server refuses HR giving Accounts even when asked directly', refused.status === 403, `${refused.status}`)

  await sa.goto(`${BASE}/settings?tab=users`)
  await settle(sa)
  await sa.getByRole('button', { name: 'Invite user' }).click()
  const inviteOptions = await sa.locator('form select').first().locator('option').allInnerTexts()
  check('the invite form never offers Super Admin', !inviteOptions.includes('Super Admin') && inviteOptions.includes('Employee'), inviteOptions.join(', '))

  section('A role holding only the audit log')
  const readerRole = (await api('sa', 'GET', '/roles')).body.data.roles.find((r) => r.name === `Log Reader ${STAMP}`)
  const empLogin = await membershipOf('emp')
  await api('sa', 'PUT', `/users/${empLogin.id}/role`, { role: readerRole.key })
  const readerRefused = []
  const reader = await open('emp', undefined, (page) =>
    page.on('response', (r) => { if (r.url().includes('/api/') && r.status() === 403) readerRefused.push(r.url().split('/api')[1]) }))
  await reader.waitForURL('**/settings**', { timeout: 20_000 })
  await settle(reader)
  check('a role without a dashboard signs in to the first area it opens, with nothing refused',
    readerRefused.length === 0 && !(await reader.locator('[data-sonner-toast]').filter({ hasText: 'permission' }).count()), readerRefused.join(', '))
  await reader.goto(`${BASE}/settings?tab=audit`)
  await settle(reader)
  await reader.getByLabel('Done by').locator('option').nth(1).waitFor({ state: 'attached', timeout: 20_000 })
  const doneBy = await reader.getByLabel('Done by').locator('option').allInnerTexts()
  const about = await reader.getByLabel('About').locator('option').allInnerTexts()
  check('its “Done by” lists the whole company, though it cannot open Users',
    doneBy[0] === 'Anybody' && ['Sunita Admin', 'Hema Hiremath', 'Anil Accountant', 'Ravi Patil'].every((n) => doneBy.includes(n)) && doneBy.length >= 10, doneBy.join(', '))
  check('…and “About” lists every employee, though it cannot open Employees',
    about[0] === 'Anyone' && about.some((o) => o.startsWith('Kiran Kumar (')), about.slice(0, 3).join(', '))
  check('…and the log itself reads', /Created the role/.test(await reader.locator('main').innerText()))
  await shot(reader, '08-audit-only-role')
  await api('sa', 'PUT', `/users/${empLogin.id}/role`, { role: 'employee' })

  section('A roster import by somebody who cannot give logins')
  const adminPage = await open('admin')
  await adminPage.goto(`${BASE}/employees`)
  await settle(adminPage)
  await adminPage.getByRole('button', { name: 'Import', exact: true }).click()
  const upload = (text) => adminPage.locator('input[type=file]').setInputFiles({ name: 'roster.csv', mimeType: 'text/csv', buffer: Buffer.from(text) })
  await upload(`employee_code,full_name,email\nD21I-${STAMP},Imp Test,d21i-${STAMP}@example.com\n`)
  await adminPage.getByRole('alert').filter({ hasText: 'cannot give Employee logins' }).waitFor({ timeout: 20_000 })
  check('Admin’s preview of a roster with emails says, in the window, that their role cannot give those logins', true)
  check('…and offers nothing to import', await adminPage.getByRole('button', { name: /^Import\s*$/ }).last().isDisabled())
  await shot(adminPage, '09-admin-import-refused')
  await upload(`employee_code,full_name\nD21I-${STAMP},Imp Test\n`)
  await adminPage.getByText('Every row is ready').waitFor({ timeout: 20_000 })
  check('…while the same roster without emails previews as ready', !(await adminPage.getByRole('alert').filter({ hasText: 'cannot give Employee logins' }).count()))

  section('A login keeper whose reach is one department')
  const keeper = await api('sa', 'POST', '/roles', {
    name: `Dept Keeper ${STAMP}`, description: '', parentKey: 'super_admin',
    permissions: ['dashboard:read', 'user:status:update'], scopes: { employee: 'DEPARTMENT' },
  })
  check('a department-scoped login keeper role is made', keeper.status === 201, JSON.stringify(keeper.body).slice(0, 200))
  const empMember = await membershipOf('emp')
  await api('sa', 'PUT', `/users/${empMember.id}/role`, { role: keeper.body.data.key })
  await login('emp')
  const everyone = (await api('sa', 'GET', '/users')).body.data
  const deptOf = new Map((await api('sa', 'GET', '/employees')).body.data.map((e) => [e.employee_id, e.department_id]))
  const myDept = deptOf.get(empMember.employee_id)
  const theirs = (await api('emp', 'GET', '/users')).body.data
  check('they see only the logins of their own department',
    theirs.length > 0 && theirs.length < everyone.length && theirs.every((u) => deptOf.get(u.employee_id) === myDept),
    `${theirs.length} of ${everyone.length}`)
  const outsider = everyone.find((u) => u.employee_id && deptOf.get(u.employee_id) !== myDept)
  const offed = await api('emp', 'PATCH', `/users/${outsider.id}/status`, { status: 'inactive' })
  const outsiderNow = (await api('sa', 'GET', '/users')).body.data.find((u) => u.id === outsider.id)
  check('another department’s login is not found to them, and stays as it was', offed.status === 404 && outsiderNow.status === outsider.status, `${offed.status} ${outsiderNow.status}`)
  const keeperPage = await open('emp')
  await keeperPage.goto(`${BASE}/settings?tab=users`)
  await settle(keeperPage)
  const shownRows = await keeperPage.locator('tbody tr').count()
  check('their Users tab lists the same logins, and not the Super Admin’s', shownRows === theirs.length && !(await keeperPage.locator('tbody').innerText()).includes(fx.users.sa), `${shownRows} rows`)
  check('…and says they are their department’s, not the organisation’s',
    await keeperPage.getByText(`${theirs.length} login${theirs.length !== 1 ? 's' : ''} in your department — the people your role reaches.`).isVisible())
  check('…and, with no role under theirs, why there is nothing to press',
    await keeperPage.getByText('Nobody listed here has a role under yours').isVisible() && (await keeperPage.locator('tbody button').count()) === 0)
  await shot(keeperPage, '06-dept-keeper-users')
  const keeperPhone = await open('emp', { width: 390, height: 844 })
  await keeperPhone.goto(`${BASE}/settings?tab=users`)
  await settle(keeperPhone)
  await keeperPhone.getByText('Nobody listed here has a role under yours').waitFor({ timeout: 20_000 })
  const keeperWide = await keeperPhone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  check('on a phone, their Users tab and its note fit without sideways scrolling', keeperWide <= 1, `${keeperWide}px over`)
  const statusReachable = await keeperPhone.evaluate(() => {
    const box = document.querySelector('table')?.parentElement
    if (!box) return false
    box.scrollLeft = box.scrollWidth
    const th = [...document.querySelectorAll('th')].find((h) => h.textContent.trim() === 'Status')
    const r = th?.getBoundingClientRect()
    return Boolean(r && r.right <= window.innerWidth && r.left >= 0)
  })
  check('…and the table scrolls within its box, so Status and Actions can be reached', statusReachable)
  await shot(keeperPhone, '07-dept-keeper-phone')
  await api('sa', 'PUT', `/users/${empMember.id}/role`, { role: 'employee' })

  section('On a phone (390px)')
  const phone = await open('sa', { width: 390, height: 844 })
  await rolesTab(phone)
  const wide = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  check('the roles list fits a phone without sideways scrolling', wide <= 1, `${wide}px over`)
  await phone.getByRole('button', { name: 'New role' }).click()
  const pe = dialog(phone)
  await pe.getByLabel('Name').fill(`Phone Role ${STAMP}`)
  await pe.getByRole('checkbox', { name: /^Open the dashboard/ }).check()
  const create = pe.getByRole('button', { name: 'Create role' })
  await create.scrollIntoViewIfNeeded()
  check('the editor’s Create button can be reached on a phone', await create.isVisible())
  const dialogWide = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  check('the editor fits a phone without sideways scrolling', dialogWide <= 1, `${dialogWide}px over`)
  await shot(phone, '04-phone-editor')
  await create.click()
  await phone.getByRole('status').filter({ hasText: `Phone Role ${STAMP}` }).waitFor({ timeout: 20_000 })
  check('a role can be made on a phone', true)
  await shot(phone, '05-phone-list')

  section('Nothing broke along the way')
  check('no page errors', pageErrors.length === 0, pageErrors.join(' | '))
  check('no server errors', serverErrors.length === 0, serverErrors.join(' | '))
} catch (err) {
  console.error(err.message)
  process.exitCode = 1
} finally {
  // Leave the company as it was: no custom roles, every built-in at its default.
  try {
    for (const r of (await api('sa', 'GET', '/roles')).body.data.roles.filter((r) => !r.built_in)) {
      for (const h of (await api('sa', 'GET', '/users')).body.data.filter((u) => u.role === r.key)) await api('sa', 'PUT', `/users/${h.id}/role`, { role: 'employee' })
    }
    for (let pass = 0; pass < 3; pass++) {
      for (const r of (await api('sa', 'GET', '/roles')).body.data.roles.filter((r) => !r.built_in)) await api('sa', 'DELETE', `/roles/${r.key}`)
    }
  } catch { /* the next run clears it first */ }
  await browser.close()
  const passed = results.filter((r) => r.ok).length
  console.log(`\n${passed}/${results.length} checks passed`)
}
