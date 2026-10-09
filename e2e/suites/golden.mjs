// Day 0 to month end, from an EMPTY database — the path CareerMap takes to go
// live. Production build on :5183 → compiled API on :4100 → local ems_e2e,
// emptied first (the runner's --reset). Real time.
//
//   1. `npm run bootstrap` makes the company and the first Super Admin — and refuses a second time.
//   2. The Super Admin fills in the company and the office location.
//   3. Staff are added one by one (with their role logins, the Super Admin typing each password) and in bulk from a CSV.
//   4. HR sets the imported employees' passwords; the owner sets his own from his link; the tree is placed; the owner marked.
//   5. HR grants the year's leave and imports last month's biometric attendance.
//   6. Accounts records salaries and bank accounts.
//   7. Today: a check-in at the office with GPS, one refused from across town, a check-out.
//   8. Leave applied for and approved up the tree.
//   9. Last month's payroll: run, approved, bank file, paid; the payslip PDF; a report; the audit log.
import { chromium } from 'playwright-core'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { BASE, API, WORK, psql } from '../lib/env.mjs'
import { openMyProfile, openEmployeeProfile, signOutVia, menuLinks, menuLink } from '../lib/ui.mjs'
import { serverScript } from '../lib/stack.mjs'

const SHOTS = join(WORK, 'shots', 'golden')
const DL = join(WORK, 'downloads-golden')
mkdirSync(SHOTS, { recursive: true })
mkdirSync(DL, { recursive: true })

const PASSWORD = 'GoldenPath2026!'
const OPERATOR = 'operator@example.com'
const OFFICE = { latitude: 18.5590, longitude: 73.7868 }

// ── Dates: today, and last month — the first payroll ────────────────────────
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date())
const addDays = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
const monthStart = (d) => `${d.slice(0, 7)}-01`
const lastMonthStart = monthStart(addDays(monthStart(today), -1))
const lastMonthEnd = addDays(monthStart(today), -1)
const LAST = { year: Number(lastMonthStart.slice(0, 4)), month: Number(lastMonthStart.slice(5, 7)) }
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const lastLabel = `${MONTHS[LAST.month - 1]} ${LAST.year}`
// Everybody joined before last month began, so it is a whole month of pay.
const JOINED = addDays(lastMonthStart, -45)
const weekday = (d) => new Date(`${d}T00:00:00Z`).getUTCDay()
/** A working day (not a Sunday) at least `n` days ahead — for leave. */
const ahead = (n) => { let d = addDays(today, n); while (weekday(d) === 0) d = addDays(d, 1); return d }

const results = []
function check(label, ok, detail = '') {
  results.push({ label, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? '  — ' + detail : ''}`)
  if (!ok) throw new Error(`FAILED: ${label} ${detail}`)
}
const section = (name) => console.log(`\n── ${name} ──`)

const browser = await chromium.launch({ channel: 'msedge', headless: true })
const problems = []
const contexts = []
async function context(who, options = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, acceptDownloads: true, ...options })
  contexts.push(ctx)
  const page = await ctx.newPage()
  page.on('pageerror', (e) => problems.push(`${who}: ${e.message}`))
  page.on('response', (r) => { if (r.status() >= 500 && r.url().includes('/api/')) problems.push(`${who}: ${r.request().method()} ${r.url().split('/api')[1]} ${r.status()}`) })
  return page
}
async function signIn(who, identifier, options = {}) {
  const page = await context(who, options)
  await page.goto(`${BASE}/signin`)
  await page.getByLabel('Work Email or Employee ID').fill(identifier)
  await page.getByPlaceholder('Enter your password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign In' }).click()
  await page.waitForURL((url) => !url.pathname.startsWith('/signin'), { timeout: 20_000 })
  return page
}
async function settle(page) {
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined)
  await page.getByText('Loading…', { exact: true }).first().waitFor({ state: 'detached', timeout: 20_000 }).catch(() => undefined)
}
async function go(page, path) {
  await page.goto(`${BASE}${path}`)
  await settle(page)
}
const toast = (page, text) => page.locator('[data-sonner-toast]', { hasText: text }).first().waitFor({ timeout: 30_000 })
/** Waits until the database says what the screen just did. */
async function until(read, expected, ms = 20_000) {
  const end = Date.now() + ms
  let last
  while (Date.now() < end) {
    last = read()
    if (last === expected) return
    await new Promise((r) => setTimeout(r, 400))
  }
  throw new Error(`waited for ${expected}, still ${last}`)
}
const shot = (page, name) => page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true })
const seen = (locator) => locator.waitFor({ timeout: 20_000 }).then(() => true, () => false)
/** The control after a form label — the forms here put the label beside, not around, the input. */
const field = (scope, label) => scope.locator(`xpath=.//label[starts-with(normalize-space(.), "${label}")]/following-sibling::*[1]`)
/** Chooses the option whose words start as given — an option may carry more than a name. Waits for it to load. */
async function pickOption(select, pattern) {
  await select.locator('option', { hasText: pattern }).first().waitFor({ state: 'attached', timeout: 20_000 })
  const value = await select.locator('option').evaluateAll((opts, src) => opts.find((o) => new RegExp(src).test(o.textContent.trim()))?.value, pattern.source)
  if (value === undefined) throw new Error(`no option like ${pattern}`)
  await select.selectOption(value)
}
/** A Settings field: its name in a <p>, the control in the next column. */
const setting = (page, label) => page.locator(`xpath=//p[normalize-space(.)="${label}"]/../following-sibling::div[1]`)
async function download(page, trigger, name) {
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), trigger()])
  const path = join(DL, name)
  await dl.saveAs(path)
  return { name: dl.suggestedFilename(), bytes: readFileSync(path) }
}

// ── The API, for the steps other suites already walk through on screen ──────
const tokens = {}
async function token(identifier) {
  if (tokens[identifier]) return tokens[identifier]
  const res = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier, password: PASSWORD }) })
  const body = await res.json()
  if (res.status !== 200) throw new Error(`sign-in ${identifier}: ${res.status} ${JSON.stringify(body)}`)
  return (tokens[identifier] = body.data.accessToken)
}
async function api(identifier, method, path, body) {
  const res = await fetch(`${API}${path}`, { method, headers: { Authorization: `Bearer ${await token(identifier)}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { json = text }
  return { status: res.status, body: json }
}

const STAFF = {
  rahul: { name: 'Rahul Mehta', code: 'CMS001', email: 'rahul@example.com', role: 'Super Admin', dept: 'Operations', designation: 'Director', salary: { BASIC: 60_000, HRA: 24_000, SPECIAL: 16_000 } },
  hema: { name: 'Hema Iyer', code: 'CMS002', email: 'hema@example.com', role: 'HR', dept: 'Human Resources', designation: 'Manager', salary: { BASIC: 30_000, HRA: 12_000, SPECIAL: 5_000 } },
  anil: { name: 'Anil Kapoor', code: 'CMS003', email: 'anil@example.com', role: 'Accounts', dept: 'Finance', designation: 'Manager', salary: { BASIC: 32_000, HRA: 12_800, SPECIAL: 5_200 } },
  manoj: { name: 'Manoj Sharma', code: 'CMS004', email: 'manoj@example.com', role: 'Manager', dept: 'Sales', designation: 'Senior Manager', salary: { BASIC: 40_000, HRA: 16_000, SPECIAL: 9_000 } },
  // Imported from a CSV: employee logins, placed in the tree afterwards.
  priya: { name: 'Priya Deshmukh', code: 'CMS005', email: 'priya@example.com', dept: 'Sales', designation: 'Executive', salary: { BASIC: 12_000, HRA: 5_000, SPECIAL: 1_000 } },
  ravi: { name: 'Ravi Patil', code: 'CMS006', email: 'ravi@example.com', dept: 'Sales', designation: 'Executive', salary: { BASIC: 13_000, HRA: 5_200, SPECIAL: 800 } },
  sunil: { name: 'Sunil Yadav', code: 'CMS007', email: null, dept: 'Operations', designation: 'Executive', salary: { BASIC: 11_000, HRA: 4_400, SPECIAL: 600 } },
}
const links = {}
const ids = {}

try {
  section('Day 0: the company is made from nothing')
  check('the database is empty — no company yet', psql('SELECT count(*) FROM "Organization"') === '0')
  serverScript('bootstrap', [], { env: { BOOTSTRAP_ADMIN_EMAIL: OPERATOR, BOOTSTRAP_ADMIN_PASSWORD: PASSWORD, BOOTSTRAP_ORG_NAME: 'CareerMap Solutions' } })
  check('bootstrap makes one company with its first Super Admin', psql('SELECT count(*) FROM "Organization"') === '1' && psql(`SELECT role FROM "Membership" m JOIN "User" u ON u.id = m."userId" WHERE u.email = '${OPERATOR}'`) === 'super_admin')
  check('…and the seven roles, departments, leave types and components it needs on day one',
    psql('SELECT count(*) FROM "Role"') === '7' && Number(psql('SELECT count(*) FROM "Department"')) >= 5 && Number(psql('SELECT count(*) FROM "LeaveType"')) >= 3 && Number(psql('SELECT count(*) FROM "SalaryComponent"')) >= 5)
  let again = 'ran'
  try { serverScript('bootstrap', [], { env: { BOOTSTRAP_ADMIN_EMAIL: 'second@example.com', BOOTSTRAP_ADMIN_PASSWORD: PASSWORD } }) } catch { again = 'refused' }
  check('a second bootstrap is refused — it runs once', again === 'refused' && psql('SELECT count(*) FROM "Organization"') === '1')

  section('The Super Admin sets up the company')
  const op = await signIn('operator', OPERATOR)
  check('the first Super Admin signs in to an empty company', op.url().includes('/dashboard'))
  await go(op, '/settings?tab=company')
  await setting(op, 'Legal Name').locator('input').fill('CareerMap Solutions Private Limited')
  await setting(op, 'Address').locator('input').fill('Baner Road')
  await op.getByPlaceholder('City').fill('Pune')
  await op.getByPlaceholder('State').fill('Maharashtra')
  await op.getByPlaceholder('PIN').fill('411045')
  await setting(op, 'Phone').locator('input').fill('02040001000')
  await setting(op, 'HR Email').locator('input').fill('hr@example.com')
  await setting(op, 'Office Name').locator('input').fill('Head Office')
  await op.getByPlaceholder('Latitude, e.g. 19.065700').fill(String(OFFICE.latitude))
  await op.getByPlaceholder('Longitude, e.g. 72.868600').fill(String(OFFICE.longitude))
  await setting(op, 'Fence Radius').locator('input').fill('50')
  await setting(op, 'Location Accuracy Needed').locator('input').fill('100')
  await op.getByRole('button', { name: 'Save Changes' }).click()
  await op.getByRole('button', { name: 'Saved' }).waitFor({ timeout: 20_000 })
  await shot(op, '01-company')
  await go(op, '/settings?tab=company')
  check('the company details and office location are saved', (await setting(op, 'Legal Name').locator('input').inputValue()) === 'CareerMap Solutions Private Limited' && (await op.getByPlaceholder('City').inputValue()) === 'Pune')
  check('…and the office location is the one punches are checked against', psql('SELECT "radiusMeters" FROM "GeofenceLocation" WHERE "isActive" = true LIMIT 1') === '50')

  section('Staff are added, one at a time, with their role logins')
  for (const key of ['rahul', 'hema', 'anil', 'manoj']) {
    const p = STAFF[key]
    await go(op, '/employees')
    await op.getByRole('button', { name: 'Add Employee' }).click()
    const modal = op.locator('div.fixed.inset-0').filter({ hasText: 'Add New Employee' })
    await field(modal, 'Full Name').fill(p.name)
    await field(modal, 'Employee Code').fill(p.code)
    await field(modal, 'Date of Joining').fill(JOINED)
    await field(modal, 'Department').selectOption({ label: p.dept })
    await field(modal, 'Designation').selectOption({ label: p.designation })
    await field(modal, 'Shift').selectOption({ index: 1 })
    if (key !== 'rahul') await pickOption(field(modal, 'Reporting Manager'), new RegExp(`^${STAFF.rahul.name}`))
    await field(modal, 'PT State').fill('Maharashtra')
    // A Super Admin login is never handed out from this form — it is its own
    // deliberate step, on the person's page (below).
    if (key !== 'rahul') {
      await modal.getByText('Give them a login to the system').click()
      await field(modal, 'Work Email').fill(p.email)
      await field(modal, 'Role').locator('option', { hasText: p.role }).first().waitFor({ state: 'attached', timeout: 20_000 })
      if (key === 'hema') {
        const offered = await field(modal, 'Role').locator('option').allInnerTexts()
        check('the Add Employee form never offers the Super Admin role', !offered.includes('Super Admin') && offered.includes('HR'), offered.join(', '))
      }
      await field(modal, 'Role').selectOption({ label: p.role })
      // A role login's password is the Super Admin's to set (client, 6 Oct 2026): typed here, and told to them.
      await modal.getByLabel('Password', { exact: true }).fill(PASSWORD)
      await modal.getByLabel('Type it again').fill(PASSWORD)
    }
    const created = op.waitForResponse((r) => r.url().endsWith('/api/employees') && r.request().method() === 'POST')
    await modal.getByRole('button', { name: 'Add Employee' }).click()
    const res = await created
    check(`${p.name} is added${key === 'rahul' ? '' : `, with ${['HR', 'Accounts', 'Admin'].includes(p.role) ? 'an' : 'a'} ${p.role} login`}`, res.status() === 201, String(res.status()))
    ids[key] = (await res.json()).data.id
    if (key === 'rahul') {
      await modal.waitFor({ state: 'detached', timeout: 10_000 }).catch(() => modal.getByRole('button', { name: 'Done' }).click())
      continue
    }
    await toast(op, `${p.name} added. They sign in with ${p.email} or Employee ID ${p.code} and the password you set`)
    check('…its password set by the Super Admin, so it works at once — no link to send',
      psql(`SELECT m.status FROM "Membership" m WHERE m."employeeId" = '${ids[key]}'`) === 'active' && (await op.locator('input[readonly].font-mono').count()) === 0)
  }

  // The owner's Super Admin login, given on his own page.
  await go(op, '/employees')
  await op.locator('tbody tr', { hasText: STAFF.rahul.code }).first().click()
  // His profile page (a drawer before the new look): logins are a tab of it.
  await op.waitForURL(/\/employees\/[0-9a-f-]{36}/, { timeout: 20_000 })
  await op.getByRole('tab', { name: /^Logins?$/ }).click()
  const drawer = op.locator('main')
  await drawer.getByRole('button', { name: /^Add login$/ }).click()
  const addLogin = drawer.getByRole('form', { name: 'Add a login' })
  // The role first: it starts on Employee, whose email is optional, and the field's label follows the role.
  await addLogin.getByLabel('Role').selectOption({ label: 'Super Admin' })
  await addLogin.getByLabel('Email for this login').fill(STAFF.rahul.email)
  check('…where giving a Super Admin login says what it hands over', await seen(addLogin.getByText(/hold the Super Admin panel/)))
  await addLogin.getByRole('button', { name: 'Add login' }).click()
  const panel = drawer.locator('input[readonly].font-mono')
  await panel.waitFor({ timeout: 20_000 })
  links.rahul = await panel.inputValue()
  check('Rahul gets a Super Admin login from his own page, with its invitation link', /\/set-password#token=/.test(links.rahul) &&
    psql(`SELECT m.role FROM "Membership" m WHERE m."employeeId" = '${ids.rahul}'`) === 'super_admin')
  await op.keyboard.press('Escape')
  await shot(op, '02-added')

  section('…and the rest in bulk, from a spreadsheet')
  const csvPath = join(WORK, 'golden-roster.csv')
  writeFileSync(csvPath, [
    'employee_code,full_name,email,date_of_joining,department,designation,shift,gender',
    ...['priya', 'ravi', 'sunil'].map((k) => {
      const p = STAFF[k]
      return `${p.code},${p.name},${p.email ?? ''},${JOINED},${p.dept},${p.designation},General,${k === 'priya' ? 'F' : 'M'}`
    }),
  ].join('\n'))
  await go(op, '/employees')
  await op.getByRole('button', { name: 'Import', exact: true }).click()
  const imp = op.locator('div.fixed.inset-0').filter({ hasText: 'Import Employees' })
  await imp.locator('input[type="file"]').setInputFiles(csvPath)
  await imp.getByText('Every row is ready.').waitFor({ timeout: 20_000 })
  check('the preview finds every row ready, two with an email for a login waiting for HR', (await imp.innerText()).includes('2 of them have an email and will get a login, waiting for HR to set its password.'))
  await imp.getByRole('button', { name: 'Import 3 employees' }).click()
  await imp.getByText('3 employees imported.').waitFor({ timeout: 20_000 })
  check('three are imported; the two logins wait for HR to set their passwords — no links handed out',
    (await imp.innerText()).includes('2 logins wait for a password.') && (await imp.locator('p.font-mono').count()) === 0)
  await shot(op, '03-imported')
  await imp.getByRole('button', { name: 'Done' }).click()
  for (const k of ['priya', 'ravi', 'sunil']) ids[k] = psql(`SELECT id FROM "Employee" WHERE "employeeCode" = '${STAFF[k].code}'`)

  section('HR sets the employees’ passwords; the owner sets his own from his link')
  const hemaFirst = await signIn('hema', STAFF.hema.email)
  check('Hema signs in with the password the Super Admin set her', !hemaFirst.url().includes('/signin'))
  await go(hemaFirst, '/settings?tab=users')
  for (const key of ['priya', 'ravi']) {
    const row = hemaFirst.locator('tr', { hasText: STAFF[key].email })
    check(`${STAFF[key].name}’s login waits: “No password yet”`, await seen(row.getByText('No password yet')))
    await row.getByRole('button', { name: `Set the password for ${STAFF[key].email}` }).click()
    const dialog = hemaFirst.getByRole('dialog', { name: `Set the password for ${STAFF[key].name}` })
    await dialog.getByLabel('New password', { exact: true }).fill(PASSWORD)
    await dialog.getByLabel('Type it again').fill(PASSWORD)
    await dialog.getByRole('button', { name: 'Set password' }).click()
    await toast(hemaFirst, `Password set for ${STAFF[key].name}`)
    check('…HR sets it, and it works at once', await seen(row.getByText('Can sign in')))
  }
  await shot(hemaFirst, '03b-hr-sets-passwords')
  await hemaFirst.context().close()
  // A Super Admin's password is always their own: Rahul sets his from the link.
  {
    const page = await context('rahul')
    await page.goto(links.rahul)
    await page.getByPlaceholder(/^At least/).fill(PASSWORD)
    await page.getByPlaceholder('The same password').fill(PASSWORD)
    await page.getByRole('button', { name: 'Save password' }).click()
    await page.waitForURL('**/signin', { timeout: 20_000 })
    await page.getByLabel('Work Email or Employee ID').fill(STAFF.rahul.email)
    await page.getByPlaceholder('Enter your password').fill(PASSWORD)
    await page.getByRole('button', { name: 'Sign In' }).click()
    await page.waitForURL((url) => !url.pathname.startsWith('/signin'), { timeout: 20_000 })
    check(`${STAFF.rahul.name} sets his own password from his link and signs in`, true)
    await page.context().close()
  }
  for (const key of ['anil', 'manoj', 'priya', 'ravi']) {
    const page = await signIn(key, STAFF[key].email)
    check(`${STAFF[key].name} signs in with the password given`, !page.url().includes('/signin'))
    await page.context().close()
  }
  const byCode = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: STAFF.priya.code.toLowerCase(), password: PASSWORD }) })
  check('…Priya by her Employee ID too, in small letters', byCode.status === 200)
  const usedAgain = await context('reuse')
  await usedAgain.goto(links.rahul)
  // Checked on arrival: a used link says so before anybody types a password.
  await usedAgain.getByRole('link', { name: 'Go to sign in' }).waitFor({ timeout: 20_000 })
  check('an invitation link works once only — opened again, it says so and offers no form',
    (await usedAgain.getByPlaceholder(/^At least/).count()) === 0, await usedAgain.locator('p.text-red-600').first().innerText().catch(() => ''))
  await usedAgain.context().close()

  section('The company tree: the owner, and who reports to whom')
  await go(op, '/settings?tab=tree')
  await op.locator('li', { hasText: STAFF.rahul.name }).getByRole('button', { name: 'Make owner' }).first().click()
  await op.getByRole('dialog').getByRole('button', { name: 'Make owner' }).click()
  await toast(op, `${STAFF.rahul.name} is now the owner`)
  for (const k of ['priya', 'ravi', 'sunil']) {
    const place = op.getByLabel(`Place under — ${STAFF[k].name}`)
    await place.waitFor({ timeout: 20_000 })
    await pickOption(place, new RegExp(`^${STAFF.manoj.name}`))
    await place.locator('xpath=ancestor::div[contains(@class,"sm:flex-row")][1]').getByRole('button', { name: 'Save' }).click()
    await toast(op, `${STAFF[k].name} now reports to ${STAFF.manoj.name}`)
    await settle(op)
  }
  await shot(op, '04-tree')
  check('Rahul is the owner; Priya, Ravi and Sunil report to Manoj, who reports to Rahul',
    psql(`SELECT count(*) FROM "Organization" WHERE "ownerEmployeeId" = '${ids.rahul}'`) === '1' &&
    psql(`SELECT count(*) FROM "Employee" WHERE "reportingManagerId" = '${ids.manoj}'`) === '3' &&
    psql(`SELECT "reportingManagerId" FROM "Employee" WHERE id = '${ids.manoj}'`) === ids.rahul)

  section('HR grants the year’s leave')
  const hema = await signIn('hema', STAFF.hema.email)
  await go(hema, '/leave')
  await hema.getByRole('tab', { name: /Team Balances/ }).click()
  await hema.getByRole('button', { name: 'Grant leave' }).click()
  await hema.getByRole('dialog').getByRole('button', { name: 'Grant leave' }).click()
  await toast(hema, 'Leave granted')
  check('everybody has the year’s leave', Number(psql('SELECT count(DISTINCT "employeeId") FROM "LeaveLedgerEntry"')) === 7)

  section('Accounts records salaries and bank accounts')
  const anil = await signIn('anil', STAFF.anil.email)
  await go(anil, '/payroll?tab=salary')
  await anil.locator('tr', { hasText: STAFF.priya.name }).getByRole('button', { name: 'Set salary' }).click()
  const sal = anil.locator('form', { hasText: 'Monthly components' })
  await sal.getByLabel(/^Starts from/).fill(JOINED)
  await sal.getByLabel(/^Annual CTC/).fill(String(Object.values(STAFF.priya.salary).reduce((a, b) => a + b, 0) * 12))
  await sal.getByLabel(/^Basic/).fill(String(STAFF.priya.salary.BASIC))
  await sal.getByLabel(/^House Rent Allowance/).fill(String(STAFF.priya.salary.HRA))
  await sal.getByLabel(/^Special Allowance/).fill(String(STAFF.priya.salary.SPECIAL))
  await sal.getByRole('button', { name: 'Save salary' }).click()
  await until(() => psql(`SELECT count(*) FROM "EmployeeFinancial" WHERE "employeeId" = '${ids.priya}'`), '1')
  check('Priya’s salary is recorded on screen', psql(`SELECT count(*) FROM "EmployeeFinancial" WHERE "employeeId" = '${ids.priya}'`) === '1')
  // The rest through the API. Anil's own goes up the tree — the owner enters it.
  for (const k of Object.keys(STAFF).filter((k) => k !== 'priya')) {
    const p = STAFF[k]
    const by = k === 'anil' || k === 'rahul' ? STAFF.rahul.email : STAFF.anil.email
    const res = await api(by, 'PUT', `/payroll/employees/${ids[k]}/salary`, { effectiveFrom: JOINED, ctc: Object.values(p.salary).reduce((a, b) => a + b, 0) * 12, components: Object.entries(p.salary).map(([code, amount]) => ({ code, amount })) })
    check(`${p.name}’s salary is recorded${k === 'anil' ? ' — by the owner, not by Anil himself' : ''}`, res.status === 200 || res.status === 201, `${res.status} ${JSON.stringify(res.body).slice(0, 200)}`)
  }
  const own = await api(STAFF.anil.email, 'PUT', `/payroll/employees/${ids.anil}/salary`, { effectiveFrom: JOINED, ctc: 1, components: [{ code: 'BASIC', amount: 99_999 }] })
  check('Accounts cannot enter their own salary', own.status === 403)

  await go(anil, '/payroll?tab=bank')
  await anil.getByRole('button', { name: `Add ${STAFF.priya.name}'s bank account` }).click()
  const bank = anil.getByRole('dialog')
  // This form's labels wrap their inputs.
  await bank.getByLabel('Bank', { exact: true }).fill('HDFC Bank')
  await bank.getByLabel('Name on the account').fill('PRIYA DESHMUKH')
  await bank.getByLabel('Account number', { exact: true }).fill('50100200300405')
  await bank.getByLabel('Account number again').fill('50100200300405')
  await bank.getByLabel('IFSC').fill('HDFC0000123')
  await bank.getByText('I have checked these details').click()
  await bank.getByRole('button', { name: 'Save', exact: true }).click()
  await toast(anil, `${STAFF.priya.name}'s bank account saved`)
  check('Priya’s bank account is recorded and checked', psql(`SELECT "verificationStatus" FROM "EmployeeBankAccount" WHERE "employeeId" = '${ids.priya}'`) === 'verified')
  let n = 0
  for (const k of Object.keys(STAFF).filter((k) => k !== 'priya')) {
    n += 1
    const by = k === 'anil' || k === 'rahul' ? STAFF.rahul.email : STAFF.anil.email
    const res = await api(by, 'PUT', `/payroll/employees/${ids[k]}/bank-account`, { bankName: 'State Bank of India', accountHolderName: STAFF[k].name.toUpperCase(), accountNumber: `3020030040${n}`, ifsc: 'SBIN0001234', markVerified: true })
    check(`${STAFF[k].name}’s bank account is recorded and checked`, res.status === 200, `${res.status} ${JSON.stringify(res.body).slice(0, 200)}`)
  }

  section('HR imports last month’s attendance from the biometric machine')
  const holidays = new Set(((await api(OPERATOR, 'GET', `/holidays?year=${LAST.year}`)).body.data ?? []).map((h) => h.date))
  const days = []
  for (let d = lastMonthStart; d <= lastMonthEnd; d = addDays(d, 1)) if (weekday(d) !== 0 && !holidays.has(d)) days.push(d)
  const dmy = (d) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`
  const file = (keys) => ['emp_id,date,in_time,out_time', ...keys.flatMap((k) => days.map((d) => `${STAFF[k].code},${dmy(d)},09:2${days.indexOf(d) % 10},18:4${days.indexOf(d) % 10}`))].join('\n')
  // Hema's own days go to the person above her, as her own attendance always
  // does; so do the owner's, who marks attendance too and is above her.
  const others = Object.keys(STAFF).filter((k) => k !== 'hema' && k !== 'rahul')
  writeFileSync(join(WORK, 'golden-attendance.csv'), file(others))
  await go(hema, '/attendance')
  await hema.getByRole('button', { name: 'Import', exact: true }).click()
  const att = hema.getByRole('dialog', { name: 'Import attendance' })
  await att.locator('input[type="file"]').setInputFiles(join(WORK, 'golden-attendance.csv'))
  await att.getByText('Every row is ready.').waitFor({ timeout: 30_000 })
  await shot(hema, '05-attendance-preview')
  await att.getByRole('button', { name: /^Import \d+ days$/ }).click()
  await att.getByText(/\d+ days imported/).waitFor({ timeout: 60_000 })
  check(`HR imports ${others.length * days.length} days for five people`, (await att.innerText()).includes(`${others.length * days.length} days imported`))
  await att.getByRole('button', { name: 'Done' }).click()
  const ownFile = await api(STAFF.hema.email, 'POST', '/attendance/import', { csv: file(['hema']), dryRun: true })
  check('HR’s own days are refused to HR — they go to the person above', ownFile.status === 200 && ownFile.body.data.summary.invalid === days.length && /own attendance/.test(ownFile.body.data.rows[0].issues[0].message))
  const ownersFile = await api(STAFF.hema.email, 'POST', '/attendance/import', { csv: file(['rahul']), dryRun: true })
  check('…and so are the owner’s, who marks attendance too and is above her', ownersFile.status === 200 && ownersFile.body.data.summary.invalid === days.length)
  const byOwner = await api(STAFF.rahul.email, 'POST', '/attendance/import', { csv: file(['hema', 'rahul']), dryRun: false })
  check('…and the owner imports both — his own is his to do', byOwner.status === 201 && byOwner.body.data.summary.imported === 2 * days.length, JSON.stringify(byOwner.body).slice(0, 300))
  await go(hema, `/attendance`)
  await hema.getByRole('button', { name: /Monthly/ }).click()
  await hema.getByRole('button', { name: 'Previous month' }).click()
  const hoursTable = hema.getByRole('table', { name: `Hours worked in ${lastLabel}` })
  check(`${lastLabel}’s hours are shown, person by person`, await seen(hoursTable))
  const priyaHours = await hoursTable.locator('tr', { hasText: STAFF.priya.name }).innerText()
  check('…Priya’s month adds up from the machine’s days', priyaHours.includes(String(days.length)), priyaHours.replace(/\s+/g, ' '))
  await shot(hema, '05b-month-hours')

  section('Today: checking in at the office, with the phone’s location')
  const priya = await signIn('priya', STAFF.priya.email, { geolocation: { ...OFFICE, accuracy: 15 }, permissions: ['geolocation'] })
  await go(priya, '/dashboard')
  await priya.getByRole('button', { name: /Check In/ }).click()
  await until(() => psql(`SELECT count(*) FROM "Attendance" WHERE "employeeId" = '${ids.priya}' AND date = '${today}' AND "checkIn" IS NOT NULL`), '1')
  check('Priya checks in from the office: the location is confirmed', psql(`SELECT "geofenceVerified" FROM "Attendance" WHERE "employeeId" = '${ids.priya}' AND date = '${today}'`) === 't')
  const ravi = await signIn('ravi', STAFF.ravi.email, { geolocation: { latitude: OFFICE.latitude + 0.02, longitude: OFFICE.longitude, accuracy: 15 }, permissions: ['geolocation'] })
  await go(ravi, '/dashboard')
  await ravi.getByRole('button', { name: /Check In/ }).click()
  const refused = ravi.locator('[data-sonner-toast][data-type="error"]').first()
  await refused.waitFor({ timeout: 20_000 })
  check('Ravi, two kilometres away, is refused — and told how far he is', /\bm\b|metres|km|away|outside/i.test(await refused.innerText()), await refused.innerText())
  check('…and nothing is recorded for him', psql(`SELECT count(*) FROM "Attendance" WHERE "employeeId" = '${ids.ravi}' AND date = '${today}'`) === '0')
  // A working day's length, as if the day had passed.
  psql(`UPDATE "Attendance" SET "checkIn" = now() - interval '9 hours 10 minutes' WHERE "employeeId" = '${ids.priya}' AND date = '${today}'`)
  await go(priya, '/dashboard')
  await priya.getByRole('button', { name: /Check Out/ }).click()
  await until(() => psql(`SELECT count(*) FROM "Attendance" WHERE "employeeId" = '${ids.priya}' AND date = '${today}' AND "checkOut" IS NOT NULL`), '1')
  const hours = Number(psql(`SELECT "hoursWorked" FROM "Attendance" WHERE "employeeId" = '${ids.priya}' AND date = '${today}'`))
  // The whole stay: no break comes off (client, 8 Oct 2026).
  check('Priya checks out: her hours are worked out, check-in to check-out', hours > 9.1 && hours < 9.3, String(hours))
  await shot(priya, '06-punched')

  section('Leave, up the tree')
  const leaveDay = ahead(10)
  await go(priya, '/leave')
  await priya.getByRole('button', { name: 'Apply for Leave' }).click()
  const form = priya.locator('form', { hasText: 'Leave Type' })
  await pickOption(form.locator('select').first(), /^Casual Leave/)
  await form.locator('input[type="date"]').nth(0).fill(leaveDay)
  await form.locator('input[type="date"]').nth(1).fill(leaveDay)
  await form.locator('textarea').fill('Family function')
  await priya.getByText(/1 day of leave|1 day/).first().waitFor({ timeout: 20_000 })
  await priya.getByRole('button', { name: 'Submit Request' }).click()
  await until(() => psql(`SELECT count(*) FROM "LeaveRequest" WHERE "employeeId" = '${ids.priya}'`), '1')
  const manoj = await signIn('manoj', STAFF.manoj.email)
  await go(manoj, '/leave?tab=decide')
  // Her request's own row — the table's on a computer, the card's on a phone — not the card around the list.
  const row = manoj.locator('main tr, main li', { hasText: STAFF.priya.name }).filter({ visible: true }).filter({ has: manoj.getByRole('button', { name: 'Approve' }) }).first()
  await row.getByRole('button', { name: 'Approve' }).click()
  const confirm = manoj.getByRole('dialog')
  if (await confirm.isVisible().catch(() => false)) await confirm.getByRole('button', { name: /^Approve/ }).click()
  await until(() => psql(`SELECT status FROM "LeaveRequest" WHERE "employeeId" = '${ids.priya}'`), 'approved')
  check('Manoj approves Priya’s leave: one day comes off her balance', psql(`SELECT status FROM "LeaveRequest" WHERE "employeeId" = '${ids.priya}'`) === 'approved')

  section(`Month end: ${lastLabel}’s payroll`)
  await go(anil, '/payroll?tab=runs')
  await anil.getByRole('button', { name: new RegExp(`^${lastLabel}`) }).first().click()
  await anil.getByText(`${lastLabel} — no payroll run yet`).waitFor({ timeout: 30_000 })
  await shot(anil, '07-readiness')
  await anil.getByRole('button', { name: 'Run payroll' }).click()
  await toast(anil, 'calculated as a draft')
  await anil.getByText(`${lastLabel} payroll`).waitFor()
  const draft = await anil.locator('main').innerText()
  check('Accounts runs it: a draft for all seven, with its figures', draft.includes('Draft') && /\b7 employees\b/.test(draft), draft.slice(0, 300).replace(/\s+/g, ' '))

  const rahul = await signIn('rahul', STAFF.rahul.email)
  await go(rahul, '/payroll?tab=runs')
  await rahul.getByRole('button', { name: new RegExp(`^${lastLabel}`) }).first().click()
  await rahul.getByRole('button', { name: 'Approve', exact: true }).click()
  const ask = rahul.getByRole('dialog', { name: `Approve ${lastLabel}` })
  await ask.getByRole('button', { name: 'Approve', exact: true }).click()
  await toast(rahul, `${lastLabel} approved`)
  check('the owner approves it — with no day paid on no record', psql(`SELECT status || ':' || "assumedDays" FROM "PayrollRun" WHERE year = ${LAST.year} AND month = ${LAST.month}`).startsWith('approved:0'),
    psql(`SELECT status || ':' || "assumedDays" FROM "PayrollRun" WHERE year = ${LAST.year} AND month = ${LAST.month}`))

  await go(anil, '/payroll?tab=runs')
  await anil.getByRole('button', { name: new RegExp(`^${lastLabel}`) }).first().click()
  await anil.getByRole('button', { name: 'Bank file', exact: true }).click()
  const bankFile = anil.getByRole('dialog', { name: 'Bank transfer file' })
  await bankFile.getByText('7 payments').waitFor({ timeout: 30_000 })
  const csv = await download(anil, () => bankFile.getByRole('button', { name: 'Download CSV' }).click(), 'bank.csv')
  const lines = csv.bytes.toString('utf8').replace(/^﻿/, '').split('\r\n').filter(Boolean)
  const net = Number(psql(`SELECT "netPayable" FROM "PayrollRun" WHERE year = ${LAST.year} AND month = ${LAST.month}`))
  const paidOut = lines.slice(1).map((l) => Number(l.split(',')[3])).reduce((a, b) => a + b, 0)
  check('the bank file pays all seven, and adds up to the run’s net pay', lines.length === 8 && Math.abs(paidOut - net) < 0.01, `${lines.length} lines, ${paidOut} vs ${net}`)
  await bankFile.getByRole('button', { name: 'Close' }).click()
  await anil.getByRole('button', { name: 'Mark as paid' }).click()
  await anil.getByRole('dialog', { name: `Mark ${lastLabel} as paid` }).getByRole('button', { name: 'Mark as paid' }).click()
  await toast(anil, 'marked as paid')
  check('Accounts marks it paid', psql(`SELECT status FROM "PayrollRun" WHERE year = ${LAST.year} AND month = ${LAST.month}`) === 'paid')
  await shot(anil, '08-paid')

  section('Everybody gets their payslip')
  await go(priya, '/payslips')
  check(`Priya has her ${lastLabel} payslip`, await seen(priya.locator('main').getByText(lastLabel).filter({ visible: true }).first()))
  const pdf = await download(priya, () => priya.getByRole('button', { name: /PDF/ }).filter({ visible: true }).first().click(), 'priya.pdf')
  check('…and downloads it as a PDF', pdf.bytes.subarray(0, 4).toString() === '%PDF')
  const slip = psql(`SELECT "grossEarnings" || '|' || "employeePf" || '|' || "employeeEsi" || '|' || "professionalTax" || '|' || "netPayable" FROM "Payslip" WHERE "employeeId" = '${ids.priya}'`).split('|').map(Number)
  // 18,000 a month, a whole month: PF 12% of 12,000; ESI 0.75% of 18,000; no PT for a woman under 25,000.
  check('her pay is right: ₹18,000 gross, PF ₹1,440, ESI ₹135, no PT, ₹16,425 net', slip[0] === 18_000 && slip[1] === 1_440 && slip[2] === 135 && slip[3] === 0 && slip[4] === 16_425, slip.join(' '))
  await go(priya, '/dashboard')
  await priya.locator('header button[aria-label*="otification"], header button:has(svg.lucide-bell)').first().click().catch(() => undefined)
  check('…and the bell told her it is ready', Number(psql(`SELECT count(*) FROM "Notification" n JOIN "Membership" m ON m."userId" = n."userId" WHERE m."employeeId" = '${ids.priya}' AND n.event = 'payslip.ready'`)) >= 1)

  section('Reports and the audit log')
  await go(rahul, '/reports')
  const card = rahul.getByText('Monthly Payroll', { exact: true }).first()
  await card.waitFor({ timeout: 20_000 })
  await card.locator('xpath=ancestor::div[contains(@class, "rounded-xl")][1]').getByRole('button', { name: /Open & export/ }).click()
  const report = rahul.getByRole('dialog')
  await report.getByLabel('Month').selectOption({ label: lastLabel }).catch(() => undefined)
  await settle(rahul)
  const exported = await download(rahul, () => report.getByRole('button', { name: /Export CSV/ }).click(), 'payroll-summary.csv')
  check('the payroll summary report exports, with the seven people in it', ['Rahul', 'Priya', 'Sunil'].every((name) => exported.bytes.toString('utf8').includes(name)))
  await report.getByRole('button', { name: 'Close' }).click()
  await go(rahul, '/settings?tab=audit')
  const log = await rahul.locator('main').innerText()
  check('the audit log has the day: the company, the people, the payroll', /Approved/i.test(log) && /payroll/i.test(log), log.slice(0, 200).replace(/\s+/g, ' '))
  await shot(rahul, '09-audit')

  section('Nothing went wrong underneath')
  check('no page error, no server error on the whole path', problems.length === 0, problems.slice(0, 5).join(' | '))
} catch (err) {
  console.error(err)
  process.exitCode = 1
  // Every page as it was when it stopped, to see why.
  let i = 0
  for (const ctx of contexts) for (const page of ctx.pages()) await page.screenshot({ path: join(SHOTS, `failed-${++i}.png`), fullPage: true }).catch(() => undefined)
} finally {
  for (const ctx of contexts) await ctx.close().catch(() => undefined)
  await browser.close()
  const failed = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - failed}/${results.length} checks passed${process.exitCode ? ' — STOPPED EARLY' : ''}`)
}
