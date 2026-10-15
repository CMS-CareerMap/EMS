// Whose payroll (client, 15 Oct 2026): the Payroll module has a reach of its
// own on Roles & Permissions, working as "Whose leave" does — whatever is
// chosen decides whom a role is shown. A "Payroll – Sales" role works with
// the Sales people's salaries, bank accounts, incentives, payslips, bank file
// lines and reports, and nobody else's; it does what its permissions say —
// recalculating, approving — and is shown Sales's share of the month, never
// the company's totals, others counted and never named. Every role kept what
// it had (the migration).
// Production build on :5183 → compiled API on :4100 → local ems_e2e, Day 20 seed.
import { chromium } from 'playwright-core'
import { mkdirSync, readFileSync } from 'node:fs'
import { WORK, psql } from '../lib/env.mjs'

const BASE = 'http://localhost:5183'
const API = `${BASE}/api`
const fx = JSON.parse(readFileSync(`${WORK}/day20-fixture.json`, 'utf8'))
const SHOTS = `${WORK}/shots/payrollscope`
mkdirSync(SHOTS, { recursive: true })
const STAMP = String(Date.now()).slice(-5)
const PHONE = { width: 390, height: 844 }
const DESKTOP = { width: 1366, height: 900 }
const E = fx.employees
const orgId = fx.organizationId
const SALES = [E.manoj, E.rekha, E.priya, E.ravi]
const salesIds = new Set(SALES.map((e) => e.id))

let passed = 0
const failures = []
function check(name, ok, detail = '') {
  if (ok) { passed++; console.log(`PASS  ${name}`) } else { failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`FAIL  ${name}${detail ? `  — ${detail}` : ''}`) }
}
const section = (name) => console.log(`\n── ${name}`)

// ── The API ─────────────────────────────────────────────────────────────────
const tokens = {}
async function login(who) {
  const res = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: fx.users[who], password: fx.password }) })
  const body = await res.json()
  if (res.status !== 200) throw new Error(`login ${who}: ${res.status} ${JSON.stringify(body)}`)
  tokens[who] = body.data.accessToken
  return body.data.user
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
  return { status: res.status, body: json }
}
/** A tiny PNG — a cheque photo, as far as the upload can tell. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
async function submitOwnBank(who, accountNumber) {
  const form = new FormData()
  form.set('bankName', 'State Bank of India')
  form.set('accountHolderName', 'TEST HOLDER')
  form.set('accountNumber', accountNumber)
  form.set('ifsc', 'SBIN0001234')
  form.set('proof', new Blob([PNG], { type: 'image/png' }), 'cheque.png')
  const res = await fetch(`${API}/payslips/me/bank-account`, { method: 'PUT', headers: { Authorization: `Bearer ${tokens[who]}` }, body: form })
  return res.status
}

// ── The browser ─────────────────────────────────────────────────────────────
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const pageErrors = []
const serverErrors = []
async function open(who, viewport = DESKTOP) {
  const ctx = await browser.newContext({ viewport })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => pageErrors.push(`${who}: ${e.message}`))
  page.on('response', (r) => { if (r.url().includes('/api/') && r.status() >= 500) serverErrors.push(`${r.status()} ${r.url().split('/api')[1]}`) })
  await page.goto(`${BASE}/signin`)
  await page.getByLabel('Work Email or Employee ID').fill(fx.users[who])
  await page.getByPlaceholder('Enter your password').fill(fx.password)
  await page.getByRole('button', { name: 'Sign In' }).click()
  await page.waitForURL((url) => !url.pathname.startsWith('/signin'), { timeout: 20_000 })
  return page
}
const shown = (locator, timeout = 20_000) => locator.first().waitFor({ timeout }).then(() => true, () => false)
const sideways = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
async function settle(page) {
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined)
  await page.getByText('Loading…', { exact: true }).first().waitFor({ state: 'detached', timeout: 20_000 }).catch(() => undefined)
}
const names = (rows, key = 'full_name') => rows.map((r) => r[key]).sort()

const role = `Payroll Sales ${STAMP}`
let roleKey = null
let rekhaLogin = null

try {
  for (const who of Object.keys(fx.users)) await login(who)

  section('Every role says whose payroll: the reach each had')
  const scopeOf = (key) => psql(`SELECT scopes->>'payroll' FROM "Role" WHERE "organizationId" = '${orgId}' AND key = '${key}'`)
  check('every role of the company says whose payroll', psql(`SELECT count(*) FROM "Role" WHERE "organizationId" = '${orgId}' AND NOT (coalesce(scopes, '{}'::jsonb) ? 'payroll')`) === '0')
  check('…Accounts: whole company; HR (incentives): the company except seniors, as its salaries; Manager: their own',
    scopeOf('accounts') === 'ORGANIZATION' && scopeOf('hr') === 'ORGANIZATION_EXCEPT_ABOVE' && scopeOf('manager') === 'SELF' && scopeOf('super_admin') === 'ORGANIZATION',
    [scopeOf('accounts'), scopeOf('hr'), scopeOf('manager'), scopeOf('super_admin')].join(' '))

  section('Super Admin: “Whose payroll” on Roles & Permissions, as “Whose leave”')
  const sa = await open('sa')
  await sa.goto(`${BASE}/settings?tab=roles`)
  await settle(sa)
  await sa.getByRole('button', { name: 'New role' }).click()
  const ed = sa.getByRole('dialog').last()
  const whose = ed.getByLabel('Whose payroll')
  const options = await whose.locator('option').allInnerTexts().catch(() => [])
  const leaveOptions = await ed.getByLabel('Whose leave').locator('option').allInnerTexts().catch(() => [])
  check('the Payroll area asks “Whose payroll”, offering exactly what “Whose leave” offers', options.length === 6 && options.join('|') === leaveOptions.join('|'), options.join(', '))
  check('…and says whose things it decides', await shown(ed.getByText(/The people chosen here are the ones whose salaries, incentives, tax, loans, bank accounts, payslips/)))
  await whose.selectOption({ label: 'Their department' })
  await ed.getByRole('checkbox', { name: /^Prepare the monthly payroll/ }).check()
  check('…any choice goes with any tick — no refusal, no warning of its own', (await ed.getByRole('alert').count()) === 0,
    (await ed.getByRole('alert').allInnerTexts().catch(() => [])).join(' | '))
  await sa.screenshot({ path: `${SHOTS}/sa-role-editor.png`, fullPage: true })
  await sa.keyboard.press('Escape')

  const made = await api('sa', 'POST', '/roles', {
    name: role, description: 'Payroll for the Sales team', parentKey: 'super_admin',
    permissions: ['dashboard:read', 'notification:read', 'employee:read', 'employee:compensation:read', 'payroll:structure:read', 'payroll:structure:manage', 'payroll:entry:manage', 'payroll:run:create', 'payroll:run:approve', 'employee:bank:read', 'employee:bank:manage', 'report:read'],
    scopes: { employee: 'ORGANIZATION', compensation: 'DEPARTMENT', payroll: 'DEPARTMENT' },
  })
  roleKey = made.body?.data?.key
  check('a “Payroll Sales” role — prepare and approve included — whose payroll: their department', made.status === 201 && Boolean(roleKey), `${made.status} ${JSON.stringify(made.body).slice(0, 200)}`)
  rekhaLogin = (await api('sa', 'GET', '/users')).body.data.find((u) => u.email === fx.users.rm)
  const given = await api('sa', 'PUT', `/users/${rekhaLogin.id}/role`, { role: roleKey })
  check('…given to Rekha (Sales)', given.status === 200, String(given.status))
  await login('rm')
  await sa.context().close()

  section('Accounts prepares August — the whole company')
  const run = await api('acc', 'POST', '/payroll-runs', { year: 2026, month: 8 })
  const runId = run.body?.data?.id
  check('Accounts runs August for everybody', run.status === 201 && run.body.data.partial === false && run.body.data.employee_count >= 8, `${run.status} ${run.body?.data?.employee_count}`)
  const hemaSlip = run.body.data.payslips.find((p) => p.employee_id === E.hema.id)
  const raviSlip = run.body.data.payslips.find((p) => p.employee_id === E.ravi.id)

  section('Rekha, Payroll Sales: the Sales people, nobody else')
  const roster = await api('rm', 'GET', '/payroll/employees')
  check('Salary structure: the Sales people only', roster.status === 200 && names(roster.body.data).join('|') === names(SALES, 'name').join('|'), names(roster.body.data).join(', '))
  check('…a salary outside Sales: not found', (await api('rm', 'GET', `/payroll/employees/${E.hema.id}/salary`)).status === 404 && (await api('rm', 'GET', `/payroll/employees/${E.ravi.id}/salary`)).status === 200)
  const setHema = await api('rm', 'PUT', `/payroll/employees/${E.hema.id}/salary`, { effectiveFrom: '2026-11-01', ctc: 400000, components: [{ code: 'BASIC', amount: 25000 }] })
  check('…nor entered', setHema.status === 404, String(setHema.status))
  const calcHema = await api('rm', 'POST', '/payroll/calculate', { employeeId: E.hema.id, year: 2026, month: 8 })
  const calcRavi = await api('rm', 'POST', '/payroll/calculate', { employeeId: E.ravi.id, year: 2026, month: 8 })
  check('…nor worked out', calcHema.status === 404 && calcRavi.status === 200, `${calcHema.status} ${calcRavi.status}`)
  const banks = await api('rm', 'GET', '/payroll/bank-accounts')
  check('Bank accounts: the Sales people only', banks.status === 200 && banks.body.data.every((b) => salesIds.has(b.employee_id)) && banks.body.data.length === 4, JSON.stringify(banks.body.data?.map?.((b) => b.full_name)))
  check('…another’s account cannot be checked', (await api('rm', 'POST', `/payroll/employees/${E.hema.id}/bank-account/verify`, { decision: 'verified', accountUpdatedAt: new Date().toISOString() })).status === 404)
  const entries = await api('rm', 'GET', '/payroll/monthly-entries?year=2026&month=8')
  const blocked = new Set((entries.body.meta?.blocked ?? []).map((b) => b.employee_id))
  check('Incentives: everybody outside Sales is not hers to enter', entries.status === 200 && blocked.has(E.hema.id) && blocked.has(E.anil.id) && !blocked.has(E.ravi.id), JSON.stringify(entries.body.meta?.blocked?.slice?.(0, 3)))
  const loans = await api('rm', 'GET', '/payroll/loans')
  check('Loans: of Sales people only', loans.status === 200 && loans.body.data.every((l) => salesIds.has(l.employee_id)))

  const runs = await api('rm', 'GET', '/payroll-runs')
  const mine = runs.body.data.find((r) => r.id === runId)
  const salesNet = Number(psql(`SELECT coalesce(sum("netPayable"), 0) FROM "Payslip" WHERE "payrollRunId" = '${runId}' AND "employeeId" IN (${SALES.map((e) => `'${e.id}'`).join(',')})`))
  check('Payroll runs: August, as Sales’s share — never the company’s totals', mine?.partial === true && mine.employee_count === 4 && Math.abs(mine.net_payable - salesNet) < 0.01 && mine.warnings.length === 0,
    JSON.stringify({ partial: mine?.partial, count: mine?.employee_count, net: mine?.net_payable, salesNet }))
  const detail = await api('rm', 'GET', `/payroll-runs/${runId}`)
  check('…its payslips: Sales’s four', detail.status === 200 && detail.body.data.payslips.length === 4 && detail.body.data.payslips.every((p) => salesIds.has(p.employee_id)))
  check('…another’s payslip, or its PDF: not found', (await api('rm', 'GET', `/payroll-runs/${runId}/payslips/${hemaSlip.id}`)).status === 404
    && (await api('rm', 'GET', `/payroll-runs/${runId}/payslips/${hemaSlip.id}/pdf`)).status === 404
    && (await api('rm', 'GET', `/payroll-runs/${runId}/payslips/${raviSlip.id}`)).status === 200)
  const readiness = await api('rm', 'GET', '/payroll-runs/readiness?year=2026&month=9')
  check('Next month’s check: Sales’s lines only', readiness.status === 200 && readiness.body.data.employees.every((e) => salesIds.has(e.employee_id)) && readiness.body.data.employees.length === 4,
    JSON.stringify(readiness.body.data?.employees?.map?.((e) => e.full_name)))
  const report = await api('rm', 'GET', '/reports/payroll-summary?year=2026&month=8')
  check('Reports → Monthly payroll: Sales’s rows, and the chart says whose', report.status === 200 && report.body.data.rows.length === 4 && /the people in your payroll/.test(report.body.data.chart.label),
    `${report.status} ${report.body?.data?.rows?.length} ${report.body?.data?.chart?.label}`)
  const home = await api('rm', 'GET', '/dashboard/payroll')
  check('Home’s payroll card: Sales’s share, marked so', home.body.data.latest?.partial === true && home.body.data.latest.employees === 4)

  section('Rekha does what her role holds — and is shown her own people throughout')
  const comp = await api('rm', 'POST', '/payroll/components', { code: `SA${STAMP}`, label: 'Sales Allowance', type: 'earning' })
  check('a salary component, as her permission allows', comp.status === 201, `${comp.status} ${JSON.stringify(comp.body).slice(0, 160)}`)
  // A day with nothing recorded for Ravi (Sales) and for Hema (HR): approving asks about the days paid on no record.
  psql(`DELETE FROM "Attendance" WHERE "employeeId" IN ('${E.ravi.id}', '${E.hema.id}') AND date = '2026-08-04'`)
  const recalc = await api('rm', 'POST', `/payroll-runs/${runId}/recalculate`, {})
  check('she recalculates August; she is shown Sales’s share', recalc.status === 200 && recalc.body.data.partial === true && recalc.body.data.employee_count === 4, `${recalc.status} ${JSON.stringify(recalc.body.data ?? recalc.body).slice(0, 160)}`)
  const asked = await api('rm', 'POST', `/payroll-runs/${runId}/approve`, {})
  const askedNames = (asked.body?.error?.details?.employees ?? []).map((e) => e.employee_id)
  check('approving asks about the days paid on no record — naming Ravi, never Hema, the rest counted',
    asked.status === 422 && askedNames.includes(E.ravi.id) && !askedNames.includes(E.hema.id) && askedNames.every((id) => salesIds.has(id)) && asked.body.error.details.others >= 1,
    `${asked.status} ${JSON.stringify(asked.body?.error?.details ?? {}).slice(0, 200)}`)
  const approved = await api('rm', 'POST', `/payroll-runs/${runId}/approve`, { confirmAssumedDays: true })
  check('…she approves it', approved.status === 200 && approved.body.data.status === 'approved', String(approved.status))
  const file = await api('rm', 'GET', `/payroll-runs/${runId}/bank-file/preview`)
  const fileLines = [...(file.body?.data?.payments ?? []), ...(file.body?.data?.excluded ?? [])]
  check('the bank file: Sales’s lines only — Ravi paid', file.status === 200 && fileLines.length === 4 && fileLines.every((l) => salesIds.has(l.employee_id)) && file.body.data.payments.some((p) => p.employee_id === E.ravi.id),
    `${file.status} ${fileLines.map((l) => l.full_name).join(', ')}`)

  section('Rekha on screen')
  const rekha = await open('rm')
  await rekha.goto(`${BASE}/payroll?tab=runs`)
  await settle(rekha)
  const main = rekha.locator('main')
  check('Payroll runs: August as her share, said so', await shown(main.getByText(/4 employees in your payroll/)) && await shown(main.getByText(/the people in your payroll only, not the company’s totals/)))
  check('…with the steps her role holds: Reopen, Mark as paid, Bank file', await shown(main.getByRole('button', { name: 'Bank file' })) && await shown(main.getByRole('button', { name: 'Mark as paid' })) && await shown(main.getByRole('button', { name: 'Reopen' })))
  await main.getByRole('button', { name: 'Bank file' }).click()
  const panel = rekha.getByRole('dialog').last()
  await shown(panel.getByText(E.ravi.name))
  const panelText = await panel.innerText().catch(() => '')
  check('…its bank file lists Ravi, and no Hema', panelText.includes(E.ravi.name) && !panelText.includes(E.hema.name), panelText.slice(0, 200))
  await rekha.keyboard.press('Escape')
  await rekha.screenshot({ path: `${SHOTS}/rekha-runs.png`, fullPage: true })
  await rekha.goto(`${BASE}/payroll?tab=salary`)
  await settle(rekha)
  await shown(main.getByText(E.ravi.name))
  const salaryText = await main.innerText()
  check('Salary structure: Ravi, and no Hema', salaryText.includes(E.ravi.name) && !salaryText.includes(E.hema.name))
  await rekha.goto(`${BASE}/payroll?tab=components`)
  await settle(rekha)
  check('Components: hers to keep, as her permission says', await shown(main.getByText('Sales Allowance', { exact: false })) && (await main.getByRole('button', { name: /add/i }).count()) >= 1)
  await rekha.goto(`${BASE}/payroll?tab=bank-format`)
  await settle(rekha)
  const layoutField = main.getByRole('textbox').first()
  check('Bank file format: hers to change too', await shown(layoutField) && !(await layoutField.isDisabled()))
  await rekha.goto(`${BASE}/payroll?tab=bank`)
  await settle(rekha)
  await shown(main.getByText(E.ravi.name))
  const bankText = await main.innerText()
  check('Bank accounts: Ravi, and no Hema', bankText.includes(E.ravi.name) && !bankText.includes(E.hema.name))
  await rekha.goto(`${BASE}/employees/${E.ravi.id}`)
  await rekha.getByRole('heading', { name: E.ravi.name, level: 1 }).waitFor({ timeout: 20_000 }).catch(() => {})
  check('Ravi’s profile has his bank account', await shown(rekha.getByRole('tab', { name: 'Bank account' })))
  await rekha.goto(`${BASE}/employees/${E.hema.id}`)
  check('…Hema’s, outside her payroll, has none — left out, not “no account”', await shown(rekha.getByRole('heading', { name: E.hema.name, level: 1 }))
    && (await rekha.getByRole('tab', { name: 'About' }).count()) === 1 && (await rekha.getByRole('tab', { name: 'Bank account' }).count()) === 0)
  await rekha.goto(`${BASE}/dashboard`)
  await settle(rekha)
  check('Home: the payroll card says it is her share', await shown(rekha.getByText(/employees in your payroll/)))
  check('…with the next step her role holds', await shown(rekha.locator('main').getByRole('link', { name: 'Bank file & mark as paid' })))
  await rekha.context().close()
  const rekhaPhone = await open('rm', PHONE)
  await rekhaPhone.goto(`${BASE}/payroll?tab=runs`)
  await settle(rekhaPhone)
  check('Payroll fits a phone for her', await shown(rekhaPhone.getByText(/in your payroll/)) && (await sideways(rekhaPhone)) <= 1, `${await sideways(rekhaPhone)}px`)
  await rekhaPhone.context().close()

  section('Accounts and HR: as before')
  const accRoster = await api('acc', 'GET', '/payroll/employees')
  check('Accounts’ salaries: everybody', accRoster.body.data.some((r) => r.employee_id === E.hema.id) && accRoster.body.data.length >= 9)
  const accRun = (await api('acc', 'GET', `/payroll-runs/${runId}`)).body.data
  check('…the run whole, its totals the company’s', accRun.partial === false && accRun.payslips.length === run.body.data.payslips.length)
  const accFile = (await api('acc', 'GET', `/payroll-runs/${runId}/bank-file/preview`)).body?.data
  check('…the bank file everybody’s', [...(accFile?.payments ?? []), ...(accFile?.excluded ?? [])].length === run.body.data.payslips.length)
  const acc = await open('acc')
  await acc.goto(`${BASE}/payroll?tab=runs`)
  await settle(acc)
  check('…and on screen the whole month, Mark as paid there', await shown(acc.locator('main').getByRole('button', { name: 'Mark as paid' })) && (await acc.locator('main').getByText(/in your payroll/).count()) === 0)
  await acc.context().close()
  const hrEntries = await api('hr', 'GET', '/payroll/monthly-entries?year=2026&month=8')
  const hrBlocked = new Map((hrEntries.body.meta?.blocked ?? []).map((b) => [b.employee_id, b]))
  check('HR’s incentives: everybody but her seniors, as her salaries', hrEntries.status === 200 && hrBlocked.has(E.sunita.id) && !hrBlocked.has(E.ravi.id),
    JSON.stringify([...hrBlocked.values()].slice(0, 3)))

  section('Whose payslips: “Their team” for Manoj — his team’s paid payslips, nobody else’s')
  const paid = await api('acc', 'POST', `/payroll-runs/${runId}/mark-paid`, { paidOn: '2026-09-01' })
  check('Accounts marks August paid', paid.status === 200, String(paid.status))
  const managerScopes = psql(`SELECT scopes::text FROM "Role" WHERE "organizationId" = '${orgId}' AND key = 'manager'`)
  psql(`UPDATE "Role" SET scopes = scopes || '{"payslip":"DIRECT_REPORTS"}'::jsonb WHERE "organizationId" = '${orgId}' AND key = 'manager'`)
  try {
    const manoj = await open('mgr')
    await manoj.goto(`${BASE}/payslips`)
    await settle(manoj)
    const peopleTab = manoj.getByRole('tab', { name: 'People’s payslips' })
    check('Payslips has his own and a “People’s payslips” tab', await shown(manoj.getByRole('tab', { name: 'My payslips' })) && await shown(peopleTab))
    await peopleTab.click()
    const list = manoj.getByRole('table', { name: 'Payslips for August 2026' })
    await shown(list)
    const listText = await list.innerText().catch(() => '')
    check('…August: Priya (his team) and himself — no Ravi, no Hema', listText.includes(E.priya.name) && listText.includes(E.manoj.name) && !listText.includes(E.ravi.name) && !listText.includes(E.hema.name), listText.slice(0, 200))
    check('…said whose: “Their team”', await shown(manoj.getByText('Whose payslips: Their team')))
    const download = manoj.waitForEvent('download', { timeout: 30_000 }).catch(() => null)
    await list.getByRole('button', { name: `PDF of ${E.priya.name}’s payslip` }).click()
    check('…Priya’s PDF opens for him', Boolean(await download))
    await login('mgr')
    const raviSlip = psql(`SELECT id FROM "Payslip" WHERE "payrollRunId" = '${runId}' AND "employeeId" = '${E.ravi.id}'`)
    check('…Ravi’s, by its address: not there for him', (await api('mgr', 'GET', `/payslips/${raviSlip}/pdf`)).status === 404)
    await manoj.context().close()
    const manojPhone = await open('mgr', PHONE)
    await manojPhone.goto(`${BASE}/payslips?tab=people`)
    await settle(manojPhone)
    check('…and it fits a phone', await shown(manojPhone.getByRole('list', { name: 'Payslips for August 2026' })) && (await sideways(manojPhone)) <= 1, `${await sideways(manojPhone)}px`)
    await manojPhone.context().close()
  } finally {
    psql(`UPDATE "Role" SET scopes = '${managerScopes}'::jsonb WHERE "organizationId" = '${orgId}' AND key = 'manager'`)
  }

  section('Bank details sent in: told to whoever’s payroll reaches the person')
  const since = new Date().toISOString()
  const ravi = await submitOwnBank('emp2', '112233445566')
  const hema = await submitOwnBank('hr', '998877665544')
  check('Ravi and Hema send in their bank details', ravi === 200 && hema === 200, `${ravi} ${hema}`)
  const told = (who, about) => psql(`SELECT count(*) FROM "Notification" n JOIN "User" u ON u.id = n."userId" WHERE u.email = '${fx.users[who]}' AND n.event = 'bank.submitted' AND n."entityId" = '${about}' AND n."createdAt" >= '${since}'`)
  check('Rekha is told of Ravi’s, not Hema’s', told('rm', E.ravi.id) === '1' && told('rm', E.hema.id) === '0', `${told('rm', E.ravi.id)} ${told('rm', E.hema.id)}`)
  check('Accounts, the whole company’s, of both', told('acc', E.ravi.id) === '1' && told('acc', E.hema.id) === '1')

  check('no page errors', pageErrors.length === 0, pageErrors.join(' | '))
  check('no server errors', serverErrors.length === 0, serverErrors.join(' | '))
} catch (err) {
  failures.push(`crashed: ${err.stack ?? err.message}`)
  console.log(`FAIL  crashed — ${err.stack ?? err.message}`)
} finally {
  // Rekha back to Reporting Manager and the role gone; the August run stays — the next suite seeds a company of its own.
  try {
    if (rekhaLogin) await api('sa', 'PUT', `/users/${rekhaLogin.id}/role`, { role: 'rm' })
    if (roleKey) await api('sa', 'DELETE', `/roles/${roleKey}`)
  } catch { /* the next seed starts its own company */ }
  await browser.close()
}

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length) {
  for (const f of failures) console.log(`  ✗ ${f}`)
  process.exit(1)
}
