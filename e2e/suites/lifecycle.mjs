// Employee lifecycle E2E (client §43) — joining to exit, in the browser, on a
// desktop and on a 390px phone.
// Production build on :5183 → compiled API on :4100 → local ems_e2e.
// Fixture: the Day 20 seed (reset20.sh), fresh. Priya reports to Manoj
// (Manager), Ravi to Rekha (RM); Neha joined this month and is not onboarded.
import { chromium } from 'playwright-core'
import { WORK, REPO, STORAGE as STORE, psql } from '../lib/env.mjs'
import { openMyProfile, openEmployeeProfile, signOutVia, menuLinks, menuLink } from '../lib/ui.mjs'
import { readFileSync, mkdirSync } from 'node:fs'

const BASE = 'http://localhost:5183'
const API = `${BASE}/api`
const DIR = WORK
const fx = JSON.parse(readFileSync(`${DIR}/day20-fixture.json`, 'utf8'))
const SHOTS = `${DIR}/shots/lifecycle`
mkdirSync(SHOTS, { recursive: true })
const E = fx.employees

const results = []
function check(label, ok, detail = '') {
  results.push({ label, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`)
  if (!ok) throw new Error(`FAILED: ${label} ${detail}`)
}
const section = (name) => console.log(`\n── ${name} ──`)

const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
function addDays(day, n) {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const label = (d) => `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`

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
const lifecycleOf = async (id) => (await api('hr', 'GET', `/lifecycle/employees/${id}`)).body.data

// ── The browser ─────────────────────────────────────────────────────────────
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const pageErrors = []
const serverErrors = []
const PHONE = { width: 390, height: 844 }
async function open(who, viewport = { width: 1366, height: 900 }) {
  const ctx = await browser.newContext({ viewport })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => pageErrors.push(`${who}: ${e.message}`))
  page.on('response', (r) => { if (r.status() >= 500 && r.url().includes('/api/')) serverErrors.push(`${who} ${r.request().method()} ${r.url().split('/api')[1]} ${r.status()}`) })
  await page.goto(`${BASE}/signin`)
  await page.getByLabel('Work Email or Employee ID').fill(fx.users[who])
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
/** Somebody's profile page (a drawer before the new look), on its Employment tab. */
async function openDrawer(page, name) {
  await openEmployeeProfile(page, BASE, name, 'Employment')
  const employment = page.getByRole('region', { name: 'Employment', exact: true })
  await employment.waitFor({ timeout: 20_000 })
  // The card is drawn at once; its record arrives after.
  await employment.getByText('Loading…').waitFor({ state: 'detached', timeout: 20_000 }).catch(() => undefined)
  return employment
}
const dialog = (page) => page.getByRole('dialog')
async function myProfile(page, name) {
  await openMyProfile(page, 'My employment')
  const mine = page.getByRole('region', { name: 'My employment' })
  await mine.waitFor({ timeout: 20_000 })
  await mine.getByText('Loading…').waitFor({ state: 'detached', timeout: 20_000 }).catch(() => undefined)
  return mine
}
async function signedOut(page) {
  await page.goto(`${BASE}/dashboard`)
  return page.waitForURL((url) => url.pathname.startsWith('/signin'), { timeout: 20_000 }).then(() => true, () => false)
}

try {
  for (const who of Object.keys(fx.users)) await login(who)

  section('Setup')
  const lead = await api('sa', 'POST', '/master-data/designations', { name: 'Team Lead' })
  check('a designation to promote to (made, or already there)', lead.status === 201 || lead.status === 409, JSON.stringify(lead.body).slice(0, 160))
  check('the seed: Neha is being onboarded, Priya and Ravi are confirmed',
    (await lifecycleOf(E.neha.id)).stage === 'onboarding' && (await lifecycleOf(E.priya.id)).stage === 'confirmed' && (await lifecycleOf(E.ravi.id)).stage === 'confirmed')

  section('HR’s dashboard shows who needs a step')
  const hr = await open('hr')
  await settle(hr)
  // The home page's "Joining to exit" card (it was "Employee lifecycle" before the new look).
  const card = hr.getByRole('region', { name: 'Joining to exit' })
  await card.getByText('Neha Joshi').waitFor({ timeout: 20_000 })
  // The words as written: the group names are drawn in capitals, which innerText would return.
  const cardText = await card.textContent()
  check('the lifecycle card lists Neha under Onboarding', cardText.includes('Onboarding') && cardText.includes('Neha Joshi'), cardText.replace(/\n/g, ' | '))
  check('…and nobody who has left', !cardText.includes('Kiran Kumar'))
  await shot(hr, '01-hr-dashboard')

  section('Onboarding')
  await card.getByRole('link', { name: /Neha Joshi/ }).click()
  // Her profile, on its Employment tab — where the step is taken.
  await hr.waitForURL(/\/employees\/[0-9a-f-]{36}\?tab=employment$/)
  const neha = hr.getByRole('region', { name: 'Employment', exact: true })
  await neha.getByText('No login yet').waitFor({ timeout: 20_000 })
  check('the card’s link opens her profile, at Onboarding with the checklist', (await neha.innerText()).includes('Onboarding'))
  await shot(hr, '02-neha-onboarding')
  await neha.getByRole('button', { name: 'Complete onboarding' }).click()
  await dialog(hr).getByRole('button', { name: 'Complete onboarding' }).click()
  await toast(hr, 'Neha Joshi\'s onboarding is complete')
  await neha.getByText('On probation').first().waitFor({ timeout: 20_000 })
  const afterOnboarding = await lifecycleOf(E.neha.id)
  check('she is on probation, onboarded today', afterOnboarding.stage === 'probation' && afterOnboarding.onboarded_on === today, JSON.stringify(afterOnboarding).slice(0, 200))

  section('Probation: extended, then confirmed')
  await neha.getByRole('button', { name: 'Extend probation' }).click()
  await dialog(hr).getByLabel('New end of probation').fill(addDays(today, 60))
  await dialog(hr).getByLabel('Why').fill('One more review needed')
  await dialog(hr).getByRole('button', { name: 'Extend probation' }).click()
  await toast(hr, `probation now ends on ${label(addDays(today, 60))}`)
  await neha.getByText(`Probation extended to ${label(addDays(today, 60))}`).waitFor({ timeout: 20_000 })
  check('the history says so, with the reason', (await neha.innerText()).includes('One more review needed'))
  await neha.getByRole('button', { name: 'Confirm', exact: true }).click()
  await dialog(hr).getByRole('button', { name: 'Confirm', exact: true }).click()
  await toast(hr, 'Neha Joshi is confirmed')
  await neha.getByText('Confirmed', { exact: true }).first().waitFor({ timeout: 20_000 })
  check('she is confirmed from today', (await lifecycleOf(E.neha.id)).confirmed_on === today)
  await shot(hr, '03-neha-confirmed')

  section('The employee list: a stage column and filter')
  await hr.keyboard.press('Escape')
  await hr.goto(`${BASE}/employees`)
  await settle(hr)
  check('Neha’s row says Confirmed', (await hr.locator('tr', { hasText: 'Neha Joshi' }).innerText()).includes('Confirmed'))
  check('Kiran’s row says Left', (await hr.locator('tr', { hasText: 'Kiran Kumar' }).innerText()).includes('Left'))
  await hr.getByLabel('Stage').selectOption('onboarding')
  // Said by the phone list and the table alike; the one on screen counts.
  await hr.getByText('No employees found.').filter({ visible: true }).waitFor({ timeout: 10_000 })
  check('filtering by Onboarding shows nobody now', true)
  await hr.getByLabel('Stage').selectOption('confirmed')
  // The list asks the server again for the new stage: wait for it, as for "No employees found." above.
  const listed = (name) => hr.locator('tr', { hasText: name }).first().waitFor({ timeout: 10_000 }).then(() => true, () => false)
  check('filtering by Confirmed keeps Neha and Priya', await listed('Neha Joshi') && await listed('Priya Deshmukh'))
  check('…and leaves out Kiran, who left', (await hr.locator('tr', { hasText: 'Kiran Kumar' }).count()) === 0)
  await shot(hr, '04-list-stage')

  section('A transfer and a promotion')
  const ravi = await openDrawer(hr, 'Ravi Patil')
  await ravi.getByRole('button', { name: 'Transfer' }).click()
  check('HR is told the reporting line is the Super Admin’s', await dialog(hr).getByText('Who they report to is changed by the Super Admin').isVisible())
  await dialog(hr).getByLabel('Department').selectOption({ label: 'Technology' })
  await dialog(hr).getByLabel('Note (optional)').fill('Moving to the product team')
  await dialog(hr).getByRole('button', { name: 'Transfer' }).click()
  await toast(hr, 'Ravi Patil is transferred')
  await ravi.getByText('Transferred: Sales → Technology').waitFor({ timeout: 20_000 })
  check('the history shows the move', true)
  await ravi.getByRole('button', { name: 'Promote' }).click()
  await dialog(hr).getByLabel('New designation').selectOption({ label: 'Team Lead' })
  await dialog(hr).getByRole('button', { name: 'Promote' }).click()
  await toast(hr, 'Ravi Patil is now Team Lead')
  await ravi.getByText('→ Team Lead').waitFor({ timeout: 20_000 })
  const raviNow = (await api('hr', 'GET', `/employees/${E.ravi.id}`)).body.data
  check('Ravi is in Technology, as Team Lead', raviNow.department === 'Technology' && raviNow.designation === 'Team Lead', `${raviNow.department} / ${raviNow.designation}`)
  await shot(hr, '05-ravi-moved')

  section('HR’s own record goes up')
  const own = await openDrawer(hr, 'Hema Hiremath')
  const ownText = await own.innerText()
  check('her own employment record offers no steps, and says who makes them', ownText.includes('Changes to this employment record are made by the Super Admin') && (await own.getByRole('button', { name: 'Transfer' }).count()) === 0, ownText.replace(/\n/g, ' | '))

  section('A senior’s record is the Super Admin’s')
  check('Hema is placed under Manoj', (await api('sa', 'PATCH', `/employees/${E.hema.id}`, { reportingManagerId: E.manoj.id })).status === 200)
  const senior = await openDrawer(hr, 'Manoj Manager')
  const seniorText = await senior.innerText()
  check('HR is offered no step on the manager above them, and is told who makes them',
    seniorText.includes('Changes to this employment record are made by the Super Admin') && (await senior.getByRole('button', { name: 'Promote' }).count()) === 0, seniorText.replace(/\n/g, ' | '))

  section('Priya hands in her resignation')
  const priya = await open('emp')
  let mine = await myProfile(priya, 'Priya Deshmukh')
  check('her profile shows Confirmed, with a way to resign', (await mine.innerText()).includes('Confirmed') && await mine.getByRole('button', { name: 'Hand in resignation' }).isVisible())
  await mine.getByRole('button', { name: 'Hand in resignation' }).click()
  check('the notice period is offered as the default', await dialog(priya).getByText(`30 days' notice — ${label(addDays(today, 30))}`).isVisible())
  await dialog(priya).getByLabel('Reason').fill('Moving to Pune for family')
  await dialog(priya).getByRole('button', { name: 'Hand it in' }).click()
  await toast(priya, 'Your resignation is handed in')
  await mine.getByText('Waiting for Manoj Manager to accept it.').waitFor({ timeout: 20_000 })
  check('…and it waits for Manoj, the person she reports to', await mine.getByRole('button', { name: 'Withdraw resignation' }).isVisible())
  await shot(priya, '06-priya-resigned')
  const told = (await api('mgr', 'GET', '/notifications')).body.data
  check('Manoj is told', JSON.stringify(told).includes('Priya Deshmukh has handed in their resignation'))

  const arjun = await open('admin')
  const priyaForAdmin = await openDrawer(arjun, 'Priya Deshmukh')
  const adminText = await priyaForAdmin.innerText()
  check('the Admin, who reads every record, is not shown her resignation before it is accepted',
    adminText.includes('Confirmed') && !adminText.includes('Moving to Pune') && adminText.includes('shown to whoever looks after their employment record, the person they report to and the Super Admin'), adminText.replace(/\n/g, ' | '))

  section('Manoj accepts it from his dashboard')
  const manoj = await open('mgr')
  await settle(manoj)
  // The home page's "Waiting for you" card, which holds leave and requests too;
  // her resignation is the row with the Resignation chip.
  const waiting = manoj.getByRole('region', { name: 'Waiting for you' })
  const resignationOf = (card, name) => card.getByRole('listitem').filter({ hasText: name }).filter({ hasText: 'Resignation' })
  const priyaRow = resignationOf(waiting, 'Priya Deshmukh')
  await priyaRow.waitFor({ timeout: 20_000 })
  check('the card shows her reason, and when she handed it in', (await priyaRow.innerText()).includes('Moving to Pune for family') && (await priyaRow.innerText()).includes(`handed in ${label(today)}`), await priyaRow.innerText())
  await shot(manoj, '07-manoj-waiting')
  await priyaRow.getByRole('button', { name: 'Accept' }).click()
  await dialog(manoj).getByLabel('Last working day').fill(today)
  await dialog(manoj).getByRole('button', { name: 'Accept' }).click()
  await toast(manoj, `Priya Deshmukh's last working day is ${label(today)}`)
  await priyaRow.waitFor({ state: 'detached', timeout: 20_000 })
  check('her resignation leaves the card once accepted', true)
  await priya.reload()
  mine = await myProfile(priya, 'Priya Deshmukh')
  const accepted = await mine.innerText()
  check('Priya sees it accepted, with her last working day, and can no longer withdraw it',
    accepted.includes('Accepted by Manoj Manager') && accepted.includes(label(today)) && (await mine.getByRole('button', { name: 'Withdraw resignation' }).count()) === 0, accepted.replace(/\n/g, ' | '))

  section('HR records Ravi’s letter; Rekha calls it off')
  const ravi2 = await openDrawer(hr, 'Ravi Patil')
  await ravi2.getByRole('button', { name: 'Record resignation' }).click()
  await dialog(hr).getByLabel('Reason they gave').fill('Letter handed in at reception')
  await dialog(hr).getByRole('button', { name: 'Record resignation' }).click()
  await toast(hr, 'Ravi Patil\'s resignation is recorded')
  await ravi2.getByText('recorded by Hema Hiremath').waitFor({ timeout: 20_000 })
  check('HR may not accept it — Rekha does', (await ravi2.getByRole('button', { name: 'Accept' }).count()) === 0 && (await ravi2.innerText()).includes('Goes to Rekha Rao to accept'))
  const rekha = await open('rm')
  await settle(rekha)
  const raviRow = resignationOf(rekha.getByRole('region', { name: 'Waiting for you' }), 'Ravi Patil')
  await raviRow.waitFor({ timeout: 20_000 })
  await raviRow.getByRole('button', { name: 'Call off' }).click()
  await dialog(rekha).getByLabel('Why').fill('We talked it over; he is staying')
  await dialog(rekha).getByRole('button', { name: 'Call it off' }).click()
  await toast(rekha, 'Ravi Patil\'s resignation is called off')
  check('Ravi is confirmed again', (await lifecycleOf(E.ravi.id)).stage === 'confirmed')

  section('HR completes Priya’s exit on her last day')
  const priyaRecord = await openDrawer(hr, 'Priya Deshmukh')
  check('she is serving notice, and the exit can be completed today', (await priyaRecord.innerText()).includes('Serving notice') && await priyaRecord.getByRole('button', { name: 'Complete exit' }).isVisible())
  await priyaRecord.getByRole('button', { name: 'Complete exit' }).click()
  const exitWords = await dialog(hr).innerText()
  check('the dialog says what happens: logins close, payroll pays to the last day', exitWords.includes('closes every login') && exitWords.includes('up to the last working day'), exitWords.replace(/\n/g, ' | '))
  await shot(hr, '08-exit-dialog')
  await dialog(hr).getByRole('button', { name: 'Complete the exit' }).click()
  await toast(hr, 'Priya Deshmukh has left the company')
  // HR still reads her record — it is kept — and it says she has left.
  // The profile's own line, in <main> — the toast says the same words.
  check('her profile says she has left', await hr.locator('main').getByText('Priya Deshmukh has left the company').first().waitFor({ timeout: 20_000 }).then(() => true, () => false))
  check('…and offers no Edit: the record she left with is kept as it was', !(await hr.getByRole('button', { name: 'Edit', exact: true }).count()))
  await hr.goto(`${BASE}/employees`)
  await settle(hr)
  check('…and she is off the list', (await hr.locator('main').getByRole('link', { name: /^Priya Deshmukh\b/ }).count()) === 0)
  const left = await lifecycleOf(E.priya.id)
  check('her record: left, resigned, last day today', left.stage === 'left' && left.exit_reason === 'resigned' && left.last_working_date === today && left.resignation.status === 'completed')
  check('her session ends', await signedOut(priya))
  check('…and she cannot sign in again', (await signIn(fx.users.emp)).status === 401)
  const audit = JSON.stringify((await api('sa', 'GET', '/audit-log')).body)
  check('the audit log has the exit and the acceptance', audit.includes('lifecycle.exited') && audit.includes('lifecycle.resignation_accepted'))

  section('Somebody who was to join and is not coming')
  const fut = await api('hr', 'POST', '/employees', { employeeCode: `NJ-${fx.stamp}`, fullName: 'Nikhil Notcoming', dateOfJoining: addDays(today, 10) })
  check('a joiner for next week', fut.status === 201, JSON.stringify(fut.body).slice(0, 160))
  const nikhil = await openDrawer(hr, 'Nikhil Notcoming')
  check('they show as Joining soon', (await nikhil.innerText()).includes('Joining soon'))
  await nikhil.getByRole('button', { name: 'Complete exit' }).click()
  check('the dialog says when they were to join, and asks no last working day',
    await dialog(hr).getByText(`They were to join on ${label(addDays(today, 10))}`).isVisible() && (await dialog(hr).getByLabel('Last working day').count()) === 0)
  await dialog(hr).getByLabel('Why they are leaving').selectOption('other')
  await dialog(hr).getByRole('button', { name: 'Complete the exit' }).click()
  await toast(hr, 'Nikhil Notcoming will not join')
  const gone = await lifecycleOf(fut.body.data.id)
  check('their record is closed, with no last working day', gone.stage === 'left' && gone.last_working_date === null, JSON.stringify(gone).slice(0, 200))

  section('Settings → Employee Lifecycle')
  await hr.goto(`${BASE}/settings?tab=lifecycle`)
  await settle(hr)
  check('HR reads the rules but cannot change them', await hr.getByText('Set by the Super Admin.').isVisible() && await hr.getByLabel('Probation in months').isDisabled())
  const sa = await open('sa')
  await sa.goto(`${BASE}/settings?tab=lifecycle`)
  await settle(sa)
  await sa.getByLabel('Probation in months').fill('3')
  await sa.getByRole('button', { name: 'Save Changes' }).click()
  await toast(sa, 'Lifecycle rules saved')
  check('the Super Admin saves a 3-month probation', (await api('sa', 'GET', '/lifecycle/settings')).body.data.probation_months === 3)
  await shot(sa, '09-settings')
  await sa.goto(`${BASE}/settings?tab=notifications`)
  await settle(sa)
  check('Notifications has an Employment group', await sa.getByText('Employment', { exact: true }).first().isVisible())

  section('Adding somebody already working here')
  await hr.goto(`${BASE}/employees`)
  await settle(hr)
  await hr.getByRole('button', { name: 'Add Employee' }).click()
  await hr.getByText('a 3-month probation').waitFor({ timeout: 10_000 })
  check('the hint names the company’s probation', true)
  await hr.getByPlaceholder('e.g. Priya Sharma').fill('Old Timer')
  await hr.getByPlaceholder('e.g. CMS-1042').fill(`LC-${fx.stamp}`)
  await hr.locator('input[type="date"]').first().fill('2024-04-01')
  await hr.getByLabel('Confirmed On').fill('2024-10-01')
  await hr.getByRole('button', { name: 'Add Employee' }).last().click()
  await hr.locator('tr', { hasText: 'Old Timer' }).waitFor({ timeout: 20_000 })
  check('they are listed as Confirmed', (await hr.locator('tr', { hasText: 'Old Timer' }).innerText()).includes('Confirmed'))
  check('reset the probation to 6 months', (await api('sa', 'PUT', '/lifecycle/settings', { probationMonths: 6, noticePeriodDays: 30 })).status === 200)

  section('On a phone')
  const hrPhone = await open('hr', PHONE)
  await settle(hrPhone)
  await hrPhone.getByRole('region', { name: 'Joining to exit' }).waitFor({ timeout: 20_000 })
  check('HR’s dashboard fits the phone', (await sideways(hrPhone)) <= 0, `${await sideways(hrPhone)}px`)
  await shot(hrPhone, '10-phone-dashboard')
  const raviPhone = await openDrawer(hrPhone, 'Ravi Patil')
  check('the Employment section fits', (await sideways(hrPhone)) <= 0)
  await raviPhone.getByRole('button', { name: 'Promote' }).click()
  await dialog(hrPhone).getByLabel('New designation').waitFor()
  check('a step’s dialog fits the phone', (await sideways(hrPhone)) <= 0)
  await shot(hrPhone, '11-phone-promote')
  await dialog(hrPhone).getByRole('button', { name: 'Cancel' }).click()

  check('Ravi hands in a resignation (API)', (await api('emp2', 'POST', '/lifecycle/resignations', { reason: 'Further studies' })).status === 201)
  const rekhaPhone = await open('rm', PHONE)
  await settle(rekhaPhone)
  await resignationOf(rekhaPhone.getByRole('region', { name: 'Waiting for you' }), 'Ravi Patil').waitFor({ timeout: 20_000 })
  check('Rekha’s waiting card fits the phone', (await sideways(rekhaPhone)) <= 0)
  await shot(rekhaPhone, '12-phone-waiting')

  const raviSelf = await open('emp2', PHONE)
  const raviMine = await myProfile(raviSelf, 'Ravi Patil')
  check('Ravi’s own profile shows his resignation waiting for Rekha', (await raviMine.innerText()).includes('Waiting for Rekha Rao to accept it.'))
  check('My employment fits the phone', (await sideways(raviSelf)) <= 0)
  await shot(raviSelf, '13-phone-my-employment')
  await raviMine.getByRole('button', { name: 'Withdraw resignation' }).click()
  await dialog(raviSelf).getByRole('button', { name: 'Withdraw it' }).click()
  await toast(raviSelf, 'Your resignation is withdrawn')
  await raviMine.getByRole('button', { name: 'Hand in resignation' }).waitFor({ timeout: 20_000 })
  check('he withdraws it from his phone, and may hand one in again', (await lifecycleOf(E.ravi.id)).stage === 'confirmed')

  const saPhone = await open('sa', PHONE)
  await saPhone.goto(`${BASE}/settings?tab=lifecycle`)
  await settle(saPhone)
  await saPhone.getByLabel('Probation in months').waitFor()
  check('Settings → Employee Lifecycle fits the phone', (await sideways(saPhone)) <= 0)
  await shot(saPhone, '14-phone-settings')

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
