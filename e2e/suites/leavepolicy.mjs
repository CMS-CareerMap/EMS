// Who gets how much leave and from when, Loss of Pay, and the rest of a short
// application as Loss of Pay (client, 9 Oct 2026) — every rule a setting, in the
// browser, as each role that uses it:
//   · the Super Admin: Leave Types shows Loss of Pay as unpaid with no limit and
//     no Work From Home; a type's joiner rule and "only after confirmation";
//     new days a year, with this year's balances changed when asked;
//   · HR: adds a joiner with their own Casual Leave and finds it granted at
//     once, pro-rated; changes it on the profile's Leave tab; Team Balances
//     shows Loss of Pay as days taken, with no correction;
//   · Priya (a phone, then a computer): one day of Casual Leave left, asks for
//     three — is offered one day of Casual Leave and two of Loss of Pay, and
//     applies like that; sees one application; Comp Off with nothing offers all
//     as Loss of Pay; Work From Home is not leave, and the form says where;
//   · Manoj, her manager: one item to decide, both parts named; approves it;
//   · payroll: the two Loss of Pay days are cut.
// Production build on :5183 → compiled API on :4100 → local ems_e2e, Day 20 seed.
import { chromium } from 'playwright-core'
import { mkdirSync, readFileSync } from 'node:fs'
import { WORK } from '../lib/env.mjs'

const BASE = 'http://localhost:5183'
const API = `${BASE}/api`
const fx = JSON.parse(readFileSync(`${WORK}/day20-fixture.json`, 'utf8'))
const SHOTS = `${WORK}/shots/leavepolicy`
mkdirSync(SHOTS, { recursive: true })
const PHONE = { width: 390, height: 844 }
const DESKTOP = { width: 1366, height: 900 }
const PRIYA = fx.employees.priya

let passed = 0
const failures = []
function check(name, ok, detail = '') {
  if (ok) { passed++; console.log(`PASS  ${name}`) } else { failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`FAIL  ${name}${detail ? `  — ${detail}` : ''}`) }
}
const section = (name) => console.log(`\n── ${name}`)

// ── The API, for setting up and for reading back ────────────────────────────
const tokens = {}
for (const who of ['sa', 'hr', 'mgr', 'emp']) {
  const res = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: fx.users[who], password: fx.password }) })
  const body = await res.json()
  if (res.status !== 200) throw new Error(`login ${who}: ${res.status} ${JSON.stringify(body).slice(0, 200)}`)
  tokens[who] = body.data.accessToken
}
async function api(who, method, path, body) {
  const res = await fetch(`${API}${path}`, { method, headers: { Authorization: `Bearer ${tokens[who]}`, 'X-Requested-With': 'ems', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { json = text }
  return { status: res.status, body: json }
}

/** Today in India, and the days of the leave asked for: the Monday after next working days, Monday to Wednesday. */
const todayIST = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10)
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)
let MON = addDays(todayIST, 2)
while (new Date(`${MON}T00:00:00Z`).getUTCDay() !== 1) MON = addDays(MON, 1)
const TUE = addDays(MON, 1)
const WED = addDays(MON, 2)
const FRI = addDays(MON, 4)

const browser = await chromium.launch({ channel: 'msedge', headless: true })
const pageErrors = []
const serverErrors = []
async function open(who, viewport) {
  const ctx = await browser.newContext({ viewport })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => pageErrors.push(`${who}: ${e.message}`))
  page.on('response', (r) => { if (r.url().includes('/api/') && r.status() >= 500) serverErrors.push(`${r.status()} ${r.url().split('/api')[1]}`) })
  await page.goto(`${BASE}/signin`)
  await page.getByLabel('Work Email or Employee ID').fill(fx.users[who])
  await page.getByPlaceholder('Enter your password').fill(fx.password)
  await page.getByRole('button', { name: 'Sign In' }).click()
  await page.waitForURL((u) => !u.pathname.startsWith('/signin'), { timeout: 20_000 })
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined)
  return page
}
const shown = (locator, timeout = 20_000) => locator.first().waitFor({ timeout }).then(() => true, () => false)
const sideways = (page) => page.evaluate(() => {
  const main = document.querySelector('main')
  return Math.max(document.documentElement.scrollWidth - window.innerWidth, main ? main.scrollWidth - main.clientWidth : 0)
})
const waitToast = (page, text) => page.locator('[data-sonner-toast]', { hasText: text }).first().waitFor({ timeout: 20_000 }).then(() => true, () => false)
/** A form field by the label above it (the Add Employee form's labels are not tied to their inputs). */
const field = (scope, label) => scope.locator(`xpath=.//label[starts-with(normalize-space(.), "${label}")]/following-sibling::*[1]`)
const flat = (s) => s.replace(/\s+/g, ' ').trim()

const balances = async (who = 'emp') => (await api(who, 'GET', '/leave-requests/balances')).body.data.balances
const typeId = async (code) => (await balances()).find((b) => b.code === code)?.leave_type_id
const lopOf = async (month) => {
  const r = await api('sa', 'GET', `/payroll-runs/readiness?year=${Number(month.slice(0, 4))}&month=${Number(month.slice(5, 7))}`)
  return r.body?.data?.employees?.find((e) => e.employee_id === PRIYA.id)?.lop_days ?? null
}

let CL = null
try {
  CL = await typeId('CL')
  const CO = await typeId('CO')
  const LOP = await typeId('LOP')
  if (!CL || !CO || !LOP) throw new Error(`leave types missing: CL ${CL}, CO ${CO}, LOP ${LOP}`)

  // ═══════════════════════════════════════════════════════════════════════
  section('Super Admin: Settings → Leave Config → Leave Types')
  const sa = await open('sa', DESKTOP)
  await sa.goto(`${BASE}/settings?tab=leave`)
  const lopRow = sa.locator('tr', { hasText: 'Loss of Pay' })
  await lopRow.first().waitFor({ timeout: 20_000 })
  const lopText = flat(await lopRow.first().innerText())
  check('Loss of Pay is a leave type: unpaid, no limit', lopText.includes('No limit') && lopText.includes('Unpaid'), lopText)
  check('Work From Home is not a leave type any more', (await sa.locator('tr', { hasText: 'Work From Home' }).count()) === 0)
  check('Comp Off reads “granted as needed”, not “0 days”', flat(await sa.locator('tr', { hasText: 'Comp Off' }).first().innerText()).includes('Granted as needed'))

  // A type's rules: what a new joiner gets, and from when it can be used.
  await sa.getByRole('button', { name: 'Rules of Casual Leave' }).click()
  const rules = sa.getByRole('dialog', { name: 'Casual Leave — rules' })
  await rules.waitFor()
  check('The rules open on “A new joiner gets”: the months left, the joining month counted', (await rules.getByLabel('A new joiner gets').inputValue()) === 'months_left')
  await rules.getByLabel('A new joiner gets').selectOption('months_after_joining')
  await rules.getByRole('switch', { name: 'Only after confirmation' }).click()
  await sa.screenshot({ path: `${SHOTS}/sa-rules.png` })
  await rules.getByRole('button', { name: 'Save rules' }).click()
  check('Saved, and said', await waitToast(sa, 'Casual Leave: rules saved'))
  const clRow = sa.locator('tr', { hasText: 'Casual Leave' }).first()
  await shown(clRow.getByText('after confirmation'))
  check('The table names both rules under the type', flat(await clRow.innerText()).includes('joiners: whole months only · after confirmation'), flat(await clRow.innerText()))
  // Back as it was, for the rest of this run.
  await api('sa', 'PATCH', `/settings/leave-types/${CL}`, { joinerGrant: 'months_left', usableAfterConfirmation: false })

  // Earned a little each month: the month's share said beside the year's (Devesh, 10 Oct 2026).
  const SL = await typeId('SL')
  await sa.getByRole('button', { name: 'Rules of Sick Leave' }).click()
  const slRules = sa.getByRole('dialog', { name: 'Sick Leave — rules' })
  await slRules.getByLabel('How it is earned').selectOption('monthly')
  check('Choosing monthly says what a month earns: 12 a year = 1 a month', await shown(slRules.getByText('Sick Leave: 12 days a year = 1 day a month.', { exact: false })))
  await slRules.getByRole('button', { name: 'Save rules' }).click()
  await waitToast(sa, 'Sick Leave: rules saved')
  const slRow = sa.locator('tr', { hasText: 'Sick Leave' }).first()
  await shown(slRow.getByText('· 1 day a month'))
  check('The table says it too: 12 days · 1 day a month', flat(await slRow.innerText()).includes('12 days · 1 day a month'), flat(await slRow.innerText()))
  await api('sa', 'PATCH', `/settings/leave-types/${SL}`, { accrual: 'yearly' })

  // New days a year, and this year's balances with them.
  await sa.reload()
  await sa.getByTitle('Change Casual Leave').click()
  const editRow = sa.locator('tr.bg-brand-50\\/40').first()
  await editRow.locator('input[type=number]').first().fill('10')
  await editRow.getByTitle('Save').click()
  const ask = sa.getByRole('dialog', { name: 'Casual Leave: 10 days a year?' })
  check('New days a year ask about this year first', await shown(ask))
  check('…saying next year follows, and people with their own days keep them', flat(await ask.innerText()).includes('From the next leave year everybody gets 10 days of Casual Leave — people given days of their own keep theirs.'))
  await ask.getByLabel(/Also change this year/).check()
  await sa.screenshot({ path: `${SHOTS}/sa-days-a-year.png` })
  await ask.getByRole('button', { name: 'Save' }).click()
  check('Saved with this year: the toast says how many balances changed', await waitToast(sa, 'Balances changed for'))
  const after = (await balances()).find((b) => b.code === 'CL')
  check('Priya’s Casual Leave is 10 now', after.available === 10, JSON.stringify(after))
  const back = await api('sa', 'PATCH', `/settings/leave-types/${CL}`, { annualQuota: 12, applyToThisYear: true })
  check('…and back to 12, balances with it', back.status === 200 && (await balances()).find((b) => b.code === 'CL').available === 12)
  await sa.context().close()

  // ═══════════════════════════════════════════════════════════════════════
  section('HR: a new joiner with their own days, granted at once')
  const hr = await open('hr', DESKTOP)
  await hr.goto(`${BASE}/employees`)
  await hr.getByRole('button', { name: 'Add Employee' }).click()
  const add = hr.getByRole('dialog', { name: 'Add New Employee' })
  await field(add, 'Full Name').fill('Isha Newjoin')
  await field(add, 'Employee Code').fill(`LP-${fx.stamp}`.slice(0, 30))
  // Leave year 2026 runs April to March; joining on the 14th of October leaves six months, October counted.
  await field(add, 'Date of Joining').fill('2026-10-14')
  await add.getByRole('button', { name: 'Their own leave days a year (optional)' }).click()
  await add.getByLabel('Casual Leave days a year').fill('24')
  await hr.screenshot({ path: `${SHOTS}/hr-add-with-own-days.png` })
  await add.getByRole('button', { name: 'Add Employee' }).click()
  await add.waitFor({ state: 'detached', timeout: 20_000 })
  const team = (await api('hr', 'GET', '/leave-balances')).body.data
  const isha = team.people.find((p) => p.full_name === 'Isha Newjoin')
  const ishaCl = isha?.balances.find((b) => b.leave_type_id === CL)
  check('Added, and her share is granted at once: 24 a year, six months of twelve — 12', ishaCl?.available === 12, JSON.stringify(ishaCl))

  // The profile's Leave tab: change her days, see the difference.
  await hr.goto(`${BASE}/employees/${isha.employee_id}?tab=leave`)
  const leaveCard = hr.locator('main').getByText('Days a year — the company’s, or their own').first()
  check('The profile has a Leave tab for HR', await shown(leaveCard))
  await shown(hr.getByRole('cell', { name: /Their own — the company’s: 12 days/ }))
  await hr.getByRole('button', { name: 'Change Casual Leave days a year' }).first().click()
  const change = hr.getByRole('dialog', { name: 'Casual Leave — Isha Newjoin' })
  await change.getByLabel('Their own days a year').fill('30')
  await change.getByPlaceholder(/Agreed in their offer letter/).fill('Revised offer')
  await hr.screenshot({ path: `${SHOTS}/hr-profile-change.png` })
  await change.getByRole('button', { name: 'Save' }).click()
  check('Changed: 30 a year, three days more for her six months', await waitToast(hr, 'Isha Newjoin: Casual Leave 30 days a year. 3 days added to the balance.'))

  // Priya down to one day of Casual Leave, for her application below.
  const cut = await api('hr', 'POST', '/leave-balances/adjustments', { employeeId: PRIYA.id, leaveTypeId: CL, days: -11, note: 'Used before the system' })
  check('(set-up) Priya has one day of Casual Leave left', cut.status === 201, JSON.stringify(cut.body).slice(0, 200))
  await hr.context().close()

  // ═══════════════════════════════════════════════════════════════════════
  section('Priya, on a phone: three days asked, one day of Casual Leave left')
  const lopBefore = await lopOf(MON)
  const priya = await open('emp', PHONE)
  await priya.goto(`${BASE}/leave?apply=1`)
  const form = priya.getByRole('dialog', { name: 'Apply for Leave' })
  await form.waitFor({ timeout: 20_000 })
  // The types arrive with the balances: read once they are there.
  await form.getByLabel('Leave type').locator('option').first().waitFor({ state: 'attached', timeout: 20_000 })
  const options = await form.getByLabel('Leave type').locator('option').allInnerTexts()
  check('The list offers Loss of Pay as unpaid, with no limit', options.some((o) => o === 'Loss of Pay — unpaid, no limit'), options.join(' | '))
  check('…after the paid types, which come first', options[0]?.startsWith('Casual Leave') && options.at(-1) === 'Loss of Pay — unpaid, no limit', options.join(' | '))
  check('Work From Home is not offered as leave', !options.some((o) => /work from home/i.test(o)))
  check('…and the form says where it is: a request', await shown(form.getByRole('link', { name: 'Requests → Work from home' })))

  // Comp Off, with nothing in it: all of it as Loss of Pay.
  await form.getByLabel('Leave type').selectOption({ label: options.find((o) => o.startsWith('Comp Off')) })
  await form.locator('input[type=date]').nth(0).fill(FRI)
  await form.locator('input[type=date]').nth(1).fill(FRI)
  const offer = form.getByRole('region', { name: 'Apply in parts' })
  check('Comp Off with nothing in it offers the day as Loss of Pay', await shown(offer.getByText('You have no Comp Off left. Apply for all 1 day as Loss of Pay? Loss of Pay is unpaid: its days are cut from pay.')))

  // Casual Leave, Monday to Wednesday: one day covered, two the rest.
  await form.getByLabel('Leave type').selectOption({ label: options.find((o) => o.startsWith('Casual Leave')) })
  await form.locator('input[type=date]').nth(0).fill(MON)
  await form.locator('input[type=date]').nth(1).fill(WED)
  await shown(offer.getByRole('button', { name: 'Apply like this' }))
  const offerText = flat(await offer.innerText())
  check('The offer: one day of Casual Leave, two of Loss of Pay, in words', /^You have 1 day of Casual Leave\. Take 1 day as Casual Leave \(.+\) and 2 days as Loss of Pay \(.+\)\? Loss of Pay is unpaid: its days are cut from pay\./.test(offerText), offerText)
  check('Submit as it is stays held: it would be refused', await form.getByRole('button', { name: 'Submit Request' }).isDisabled())
  check('The form fits a phone', (await sideways(priya)) <= 1, `${await sideways(priya)}px`)
  await priya.screenshot({ path: `${SHOTS}/priya-offer-phone.png` })
  await form.getByPlaceholder('Briefly describe the reason for your leave…').fill('Family function out of town')
  await offer.getByRole('button', { name: 'Apply like this' }).click()
  await form.waitFor({ state: 'detached', timeout: 20_000 })
  const mine = (await api('emp', 'GET', '/leave-requests')).body.data.filter((r) => r.status === 'pending')
  check('One application, in two parts: Casual Leave 1, Loss of Pay 2', mine.length === 1 && JSON.stringify(mine[0].parts?.map((p) => `${p.leave_type}:${p.days}`)) === '["CL:1","LOP:2"]', JSON.stringify(mine.map((r) => r.parts)))
  await priya.goto(`${BASE}/leave`)
  const card = priya.getByRole('list', { name: 'Leave requests' }).locator('li').first()
  await shown(card.getByText('Loss of Pay · 2'))
  check('Her list shows it once, both parts named', (await card.getByText('Casual Leave · 1').count()) === 1 && (await card.getByText('Loss of Pay · 2').count()) === 1)
  check('The list fits a phone', (await sideways(priya)) <= 1, `${await sideways(priya)}px`)
  await priya.screenshot({ path: `${SHOTS}/priya-list-phone.png` })
  await priya.context().close()

  // ═══════════════════════════════════════════════════════════════════════
  section('Manoj decides it as one')
  const mgr = await open('mgr', DESKTOP)
  await mgr.goto(`${BASE}/leave?tab=decide`)
  const row = mgr.locator('tr', { hasText: PRIYA.name }).filter({ hasText: 'Loss of Pay · 2' })
  check('One line for Priya, both parts named', await shown(row) && (await row.count()) === 1)
  const waiting = (await api('mgr', 'GET', '/dashboard/me')).body.data.waiting_for_me
  check('Waiting for him: one, not two', waiting === 1, String(waiting))
  await mgr.screenshot({ path: `${SHOTS}/manoj-decide.png` })
  await row.getByRole('button', { name: 'Approve' }).click()
  await shown(row.getByText('Approved'))
  const decided = (await api('emp', 'GET', '/leave-requests')).body.data.find((r) => r.parts?.length === 2)
  check('Both parts approved together', decided?.status === 'approved', decided?.status)
  await mgr.context().close()

  // ═══════════════════════════════════════════════════════════════════════
  section('What it did: balances, Team Balances, home, payroll')
  const now = await balances()
  check('Casual Leave: none left; Loss of Pay: two days taken', now.find((b) => b.code === 'CL').available === 0 && now.find((b) => b.code === 'LOP').taken === 2, JSON.stringify(now.map((b) => [b.code, b.available, b.taken])))

  const priyaDesk = await open('emp', DESKTOP)
  await priyaDesk.goto(`${BASE}/leave?tab=balance`)
  const lopCard = priyaDesk.getByRole('region', { name: 'Loss of Pay' })
  check('Leave Balance: Loss of Pay as its own card, days taken', await shown(lopCard.getByText('LOP · unpaid, no limit · 2 days taken this year')))
  await priyaDesk.goto(`${BASE}/dashboard`)
  check('Home: Loss of Pay named once taken', await shown(priyaDesk.getByText('Loss of Pay: 2 days taken this year — unpaid, cut from pay')))
  await priyaDesk.screenshot({ path: `${SHOTS}/priya-home.png` })
  await priyaDesk.context().close()

  const hr2 = await open('hr', DESKTOP)
  await hr2.goto(`${BASE}/leave?tab=team`)
  const priyaRow = hr2.locator('main table tr', { hasText: PRIYA.name }).first()
  await priyaRow.waitFor({ timeout: 20_000 })
  check('Team Balances: Loss of Pay as days taken', flat(await priyaRow.innerText()).includes('2 taken'), flat(await priyaRow.innerText()))
  await priyaRow.getByRole('button', { name: `Correct ${PRIYA.name}’s balance` }).click()
  const correct = hr2.getByRole('dialog', { name: new RegExp(`Correct ${PRIYA.name}’s leave`) })
  const types = await correct.locator('select').locator('option').allInnerTexts()
  check('Nothing to correct on a type with no limit', !types.includes('Loss of Pay') && types.includes('Casual Leave'), types.join(', '))
  await hr2.screenshot({ path: `${SHOTS}/hr-team-balances.png` })
  await hr2.context().close()

  const lopAfter = await lopOf(MON)
  check('Payroll: the two Loss of Pay days are cut, the Casual Leave day is paid', lopBefore !== null && lopAfter === lopBefore + 2, `${lopBefore} → ${lopAfter}`)

  section('Nothing broke along the way')
  check('no page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
  check('no server errors', serverErrors.length === 0, serverErrors.slice(0, 3).join(' | '))
} catch (err) {
  failures.push(`stopped: ${err.message}`)
  console.log(`FAIL  stopped: ${err.message}`)
} finally {
  // Casual Leave as the seed made it.
  if (CL) await api('sa', 'PATCH', `/settings/leave-types/${CL}`, { joinerGrant: 'months_left', usableAfterConfirmation: false }).catch(() => undefined)
  await browser.close()
  console.log(`\n${passed} passed, ${failures.length} failed`)
  if (failures.length) {
    console.log(failures.map((f) => `  ✗ ${f}`).join('\n'))
    process.exitCode = 1
  }
}
