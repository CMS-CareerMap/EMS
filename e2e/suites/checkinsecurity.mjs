// Check-in security (client, 11 Oct 2026): app check-in and check-out inside
// the office, 15–20 m and not a metre more; every layer a setting of the Super
// Admin's. Phones stand at fixed places (Playwright's geolocation): the office,
// 20 m, 21 m, 40 m away.
// Production build on :5183 → compiled API on :4100 → local ems_e2e, Day 20 seed (with its office).
import { chromium } from 'playwright-core'
import { mkdirSync, readFileSync } from 'node:fs'
import { WORK, psql } from '../lib/env.mjs'
import { openEmployeeProfile } from '../lib/ui.mjs'

const BASE = 'http://localhost:5183'
const fx = JSON.parse(readFileSync(`${WORK}/day20-fixture.json`, 'utf8'))
const SHOTS = `${WORK}/shots/checkinsecurity`
mkdirSync(SHOTS, { recursive: true })
const PHONE = { width: 390, height: 844 }
const DESKTOP = { width: 1366, height: 900 }
const PHONE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36'

/** A place this many metres due north of the office. */
const north = (metres, accuracy = 6) => ({ latitude: fx.office.latitude + metres / 111_194.93, longitude: fx.office.longitude, accuracy })
const AT_OFFICE = north(0, 8)

let passed = 0
const failures = []
function check(name, ok, detail = '') {
  if (ok) { passed++; console.log(`PASS  ${name}`) } else { failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`FAIL  ${name}${detail ? `  — ${detail}` : ''}`) }
}
const section = (name) => console.log(`\n── ${name}`)

const today = psql(`SELECT to_char(now() AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD')`)
const ids = { priya: fx.employees.priya.id, ravi: fx.employees.ravi.id }
const orgId = fx.organizationId

// A fake camera, granted without asking: the selfie with a punch (Layer 5).
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] })
const pageErrors = []
const serverErrors = []
async function open(who, { viewport = PHONE, at = AT_OFFICE, phone = true } = {}) {
  const ctx = await browser.newContext({ viewport, ...(phone ? { userAgent: PHONE_UA } : {}), geolocation: at, permissions: ['geolocation', 'camera'] })
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
const errorToast = (page) => page.locator('[data-sonner-toast][data-type="error"]').last()
const setting = (page, label) => page.locator(`xpath=//p[normalize-space(.)="${label}"]/../following-sibling::div[1]`)
async function until(fn, want, ms = 30_000) {
  const end = Date.now() + ms
  let got
  while (Date.now() < end) { got = fn(); if (got === want) return true; await new Promise((r) => setTimeout(r, 300)) }
  return got
}

try {
  // ── Phase 1: the office, strict ───────────────────────────────────────────
  section('Super Admin: Settings → Attendance Security')
  const sa = await open('sa', { viewport: DESKTOP, phone: false })
  await sa.goto(`${BASE}/settings?tab=attendance-security`)
  check('the tab is there, with the office the punches are checked against', await shown(sa.getByRole('heading', { name: 'Office Location' })))
  check('…its radius and accuracy as saved: 20 m and 20 m', (await setting(sa, 'Radius').locator('input').inputValue()) === '20' && (await setting(sa, 'Location Accuracy Needed').locator('input').inputValue()) === '20')
  check('…and the Company tab points here for it', await (async () => {
    const page = await open('sa', { viewport: DESKTOP, phone: false })
    await page.goto(`${BASE}/settings?tab=company`)
    const ok = await shown(page.getByRole('link', { name: 'Attendance Security' })) && !(await page.getByText('Fence Radius').count())
    await page.context().close()
    return ok
  })())

  await setting(sa, 'Radius').locator('input').fill('21')
  await sa.getByRole('button', { name: 'Save Changes' }).click()
  check('a radius of 21 m is refused before it is sent', await shown(sa.getByText('The radius is 15 to 20 m.')))
  await setting(sa, 'Radius').locator('input').fill('14')
  await sa.getByRole('button', { name: 'Save Changes' }).click()
  check('…and so is 14 m', await shown(sa.getByText('The radius is 15 to 20 m.')))
  await setting(sa, 'Radius').locator('input').fill('20')
  await setting(sa, 'Location Accuracy Needed').locator('input').fill('25')
  await sa.getByRole('button', { name: 'Save Changes' }).click()
  check('an accuracy of 25 m is refused: 10 to 20', await shown(sa.getByText('The accuracy needed is 10 to 20 m.')))
  await setting(sa, 'Location Accuracy Needed').locator('input').fill('20')
  await sa.getByRole('button', { name: 'Save Changes' }).click()
  await shown(sa.getByRole('button', { name: 'Saved' }))
  check('20 and 20 save', psql(`SELECT "radiusMeters" || ',' || "maxAccuracyMeters" FROM "GeofenceLocation" WHERE "organizationId" = '${orgId}' AND "isActive"`) === '20,20')

  await sa.getByRole('button', { name: 'Test where I stand' }).click()
  check('“Test where I stand” at the office: a punch here would be accepted', await shown(sa.getByRole('status').filter({ hasText: 'a punch here would be accepted' })))
  await sa.context().setGeolocation(north(30))
  await sa.getByRole('button', { name: 'Test where I stand' }).click()
  check('…and 30 m away it would be refused, saying how far', await shown(sa.getByRole('status').filter({ hasText: /^30 m from the office.*would be refused/ })))
  await sa.screenshot({ path: `${SHOTS}/sa-office.png`, fullPage: true })

  const toggle = sa.getByRole('switch', { name: 'Check location at check-out' })
  check('“Check location at check-out” is on, to start', (await toggle.getAttribute('aria-checked')) === 'true')
  await toggle.click()
  check('…turned off, it says so', await shown(sa.getByText('Check-outs are no longer checked')))
  check('…and the audit log has who changed what', await until(() => psql(`SELECT count(*) FROM "AuditLog" WHERE "organizationId" = '${orgId}' AND action = 'attendance_security.updated'`), '1') === true)
  await toggle.click()
  await shown(sa.getByText('Check-outs are checked at the office'))
  check('…and back on', psql(`SELECT "punchCheckOutLocation" FROM "Organization" WHERE id = '${orgId}'`) === 't')

  section('Priya, on a phone: 21 m out is refused; at the office, in')
  const priya = await open('emp', { at: north(21) })
  await priya.goto(`${BASE}/dashboard`)
  await priya.getByRole('button', { name: /Check In/ }).click()
  const far = errorToast(priya)
  check('21 m from the office: refused, saying how far and the limit', await shown(far) && /21 m from the office\. Check in is allowed within 20 m/.test(await far.innerText()), await far.innerText().catch(() => ''))
  check('…nothing recorded for the day', psql(`SELECT count(*) FROM "Attendance" WHERE "employeeId" = '${ids.priya}' AND date = '${today}' AND "checkIn" IS NOT NULL`) === '0')
  check('…and the attempt is kept as evidence', psql(`SELECT "refusedFor" || ' ' || "distanceMeters" FROM "PunchEvidence" WHERE "employeeId" = '${ids.priya}' ORDER BY at DESC LIMIT 1`) === 'outside 21')
  await priya.context().setGeolocation(AT_OFFICE)
  await priya.getByRole('button', { name: /Check In/ }).click()
  check('at the office: checked in', await until(() => psql(`SELECT count(*) FROM "Attendance" WHERE "employeeId" = '${ids.priya}' AND date = '${today}' AND "checkIn" IS NOT NULL`), '1') === true)
  check('…with the location confirmed on the card', await shown(priya.getByText(/Location confirmed — \d+ m from the office/)))
  check('…and the card says the check-out is checked too', await shown(priya.getByText('Your location is checked when you check out too')))
  check('…the evidence: accepted, judged against the fence', psql(`SELECT "fenceApplied" || ' ' || coalesce("refusedFor"::text, 'accepted') FROM "PunchEvidence" WHERE "employeeId" = '${ids.priya}' AND action = 'in' ORDER BY at DESC LIMIT 1`) === 'true accepted')

  section('Check-out from 40 m away: refused, with the way to ask HR')
  await priya.context().setGeolocation(north(40))
  await priya.getByRole('button', { name: /Check Out/ }).click()
  const refusal = priya.getByRole('alert').filter({ hasText: 'Check out is allowed within 20 m' })
  check('the card says it: 40 m away, check-out allowed within 20 m', await shown(refusal) && (await refusal.innerText()).includes('40 m from the office'), await refusal.innerText().catch(() => ''))
  check('…still checked in', psql(`SELECT count(*) FROM "Attendance" WHERE "employeeId" = '${ids.priya}' AND date = '${today}' AND "checkOut" IS NOT NULL`) === '0')
  check('…the card fits the phone', (await sideways(priya)) <= 1, `${await sideways(priya)}px`)
  await priya.screenshot({ path: `${SHOTS}/priya-checkout-refused.png`, fullPage: true })
  await refusal.getByRole('link', { name: 'Ask HR to record your check-out' }).click()
  const form = priya.getByRole('dialog', { name: 'Attendance correction' })
  check('“Ask HR to record your check-out” opens a correction for today', await shown(form) && (await form.getByLabel('Day').inputValue()) === today)
  check('…with the time it was tried as the check-out', /^\d{2}:\d{2}$/.test(await form.getByLabel('Check-out').inputValue()), await form.getByLabel('Check-out').inputValue().catch(() => ''))
  await priya.keyboard.press('Escape')
  await priya.goto(`${BASE}/dashboard`)
  await priya.context().setGeolocation(AT_OFFICE)
  await priya.getByRole('button', { name: /Check Out/ }).click()
  check('back at the office: checked out', await until(() => psql(`SELECT count(*) FROM "Attendance" WHERE "employeeId" = '${ids.priya}' AND date = '${today}' AND "checkOut" IS NOT NULL`), '1') === true)
  check('…the check-out’s evidence kept too', psql(`SELECT count(*) FROM "PunchEvidence" WHERE "employeeId" = '${ids.priya}' AND action = 'out' AND "refusedFor" IS NULL AND "fenceApplied"`) === '1')

  section('No office set: nobody checks in at the office')
  psql(`UPDATE "GeofenceLocation" SET "isActive" = false WHERE "organizationId" = '${orgId}'`)
  const ravi = await open('emp2')
  await ravi.goto(`${BASE}/dashboard`)
  await ravi.getByRole('button', { name: /Check In/ }).click()
  const unset = errorToast(ravi)
  check('Ravi at the office, with no office set: refused, saying why', await shown(unset) && (await unset.innerText()).includes('The office location is not set yet'), await unset.innerText().catch(() => ''))
  check('…nothing recorded', psql(`SELECT count(*) FROM "Attendance" WHERE "employeeId" = '${ids.ravi}' AND date = '${today}' AND "checkIn" IS NOT NULL`) === '0')
  psql(`UPDATE "GeofenceLocation" SET "isActive" = true WHERE "organizationId" = '${orgId}'`)

  // ── Phase 2: the fingerprint machine confirms ─────────────────────────────
  section('Super Admin: the fingerprint machine’s layer')
  await sa.goto(`${BASE}/settings?tab=attendance-security`)
  const confirmSwitch = sa.getByRole('switch', { name: 'Confirm by the fingerprint machine' })
  await confirmSwitch.waitFor({ timeout: 20_000 })
  check('“Confirm by the fingerprint machine” is on, to start', (await confirmSwitch.getAttribute('aria-checked')) === 'true')
  check('…30 minutes allowed apart; a day not on it flagged; a day with no app punch filled',
    (await sa.getByLabel('Minutes allowed apart').inputValue()) === '30'
    && (await sa.getByLabel('Not on the machine').inputValue()) === 'flag'
    && (await sa.getByRole('switch', { name: 'Fill a day from the machine' }).getAttribute('aria-checked')) === 'true')
  await sa.getByLabel('Minutes allowed apart').fill('300')
  await sa.getByRole('button', { name: 'Save', exact: true }).click()
  check('300 minutes is refused: 5 to 240', await shown(sa.getByText('Between 5 and 240 minutes.')))
  await sa.getByLabel('Minutes allowed apart').fill('45')
  await sa.getByRole('button', { name: 'Save', exact: true }).click()
  check('45 saves, and says so', await shown(sa.getByText('The machine and the app may now differ by 45 minutes')) && await until(() => psql(`SELECT "punchMachineMinutes" FROM "Organization" WHERE id = '${orgId}'`), '45') === true)

  section('HR: Ravi’s Machine ID, on his page')
  const hr = await open('hr', { viewport: DESKTOP, phone: false })
  const raviPage = await openEmployeeProfile(hr, BASE, fx.employees.ravi.name)
  await raviPage.getByRole('button', { name: 'Edit', exact: true }).click()
  const edit = hr.getByRole('dialog', { name: 'Edit Employee' })
  await edit.getByLabel('Machine ID').fill('7001')
  await edit.getByRole('button', { name: 'Save Changes' }).click()
  await edit.waitFor({ state: 'detached', timeout: 20_000 })
  check('saved, and shown on his page', await shown(hr.locator('main').getByText('7001', { exact: true })) && psql(`SELECT "machineId" FROM "Employee" WHERE id = '${ids.ravi}'`) === '7001')

  section('HR imports the machine’s file: Priya confirmed, Ravi filled by his Machine ID, Neha not on the machine')
  // Neha checked in and out on the app yesterday, at the office — and never touched the machine.
  // Yesterday: today is not over, so it is never judged "not on the machine".
  const yesterday = psql(`SELECT to_char((now() AT TIME ZONE 'Asia/Kolkata')::date - 1, 'YYYY-MM-DD')`)
  psql(`INSERT INTO "Attendance" (id, "organizationId", "employeeId", date, "checkIn", "checkOut", status, source, "workMode", "updatedAt") VALUES (gen_random_uuid(), '${orgId}', '${fx.employees.neha.id}', '${yesterday}', '${yesterday} 09:30+05:30', '${yesterday} 18:30+05:30', 'present', 'punch', 'office', now())`)
  const dmy = `${today.slice(8, 10)}/${today.slice(5, 7)}/${today.slice(0, 4)}`
  const dmyBefore = `${yesterday.slice(8, 10)}/${yesterday.slice(5, 7)}/${yesterday.slice(0, 4)}`
  const [priyaIn, priyaOut] = psql(`SELECT to_char("checkIn" AT TIME ZONE 'Asia/Kolkata', 'HH24:MI') || ' ' || to_char("checkOut" AT TIME ZONE 'Asia/Kolkata', 'HH24:MI') FROM "Attendance" WHERE "employeeId" = '${ids.priya}' AND date = '${today}'`).split(' ')
  const later = (hhmm, minutes) => { const [h, m] = hhmm.split(':').map(Number); const t = Math.min(h * 60 + m + minutes, 23 * 60 + 59); return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}` }
  // One line a scan, the date and the time together — as many machines write it.
  const machineFile = (lines) => Buffer.from(['AC-No.,Name,Time', ...lines].join('\n'))
  const file = machineFile([
    `${fx.employees.priya.code},Priya,${dmy} ${later(priyaIn, -2)}`,
    `${fx.employees.priya.code},Priya,${dmy} ${priyaOut}`,
    `7001,Ravi,${dmy} 09:30`,
    `7001,Ravi,${dmy} 18:30`,
    // Ravi yesterday too: the file covers yesterday and today.
    `7001,Ravi,${dmyBefore} 09:35`,
    `7001,Ravi,${dmyBefore} 18:20`,
  ])
  await hr.goto(`${BASE}/attendance`)
  await hr.getByRole('button', { name: /^Import$/ }).first().click()
  const importer = hr.getByRole('dialog', { name: 'Import attendance' })
  await importer.getByLabel('Attendance CSV file').setInputFiles({ name: 'machine.csv', mimeType: 'text/csv', buffer: file })
  const panel = importer.getByRole('region', { name: 'The fingerprint machine and the app' })
  check('the preview says what the machine said: 1 confirmed, 1 not on it, 2 filled', await shown(panel) && /Confirmed\s*1/.test(await panel.innerText()) && /Not on the machine\s*1/.test(await panel.innerText()) && /Filled from the machine\s*2/.test(await panel.innerText()), (await panel.innerText().catch(() => '')).replace(/\s+/g, ' '))
  check('…naming Neha, flagged for HR, her day standing', (await panel.innerText()).includes(fx.employees.neha.name) && (await panel.innerText()).includes('Flagged for HR'))
  check('…and that she is not in the file at all', (await panel.innerText()).includes('Not in this file at all'))
  await hr.screenshot({ path: `${SHOTS}/hr-machine-preview.png`, fullPage: true })
  await importer.getByRole('button', { name: /^Import \d+ day/ }).click()
  check('imported, the panel said again', await shown(importer.getByText(/\d+ days? imported/)) && await shown(importer.getByRole('region', { name: 'The fingerprint machine and the app' })))
  check('Priya’s app day stands, confirmed by the machine', psql(`SELECT source || ' ' || "machineMatch" FROM "Attendance" WHERE "employeeId" = '${ids.priya}' AND date = '${today}'`) === 'punch confirmed')
  check('Ravi’s day is the machine’s, found by his Machine ID', psql(`SELECT source || ' ' || "machineMatch" FROM "Attendance" WHERE "employeeId" = '${ids.ravi}' AND date = '${today}'`) === 'biometric from_machine')
  check('Neha’s day stands, flagged not on the machine', psql(`SELECT status || ' ' || "machineMatch" FROM "Attendance" WHERE "employeeId" = '${fx.employees.neha.id}' AND date = '${yesterday}'`) === 'present not_on_machine')
  await importer.getByRole('button', { name: 'Done' }).click()
  await hr.reload()
  check('the roster says it, person by person', await shown(hr.getByText('Machine ✓').first()) && await shown(hr.getByText('From machine').first()))
  await hr.getByRole('button', { name: 'Previous day' }).first().click()
  check('…and yesterday’s, Neha not on the machine', await shown(hr.getByText('Not on machine').first()))
  await hr.getByRole('button', { name: 'Next day' }).first().click()

  section('The company’s rule: not on the machine is absent')
  await sa.getByLabel('Not on the machine').selectOption('absent')
  check('the Super Admin chooses it, and it says so', await shown(sa.getByText('Days not on the machine are made absent')))
  await hr.getByRole('button', { name: /^Import$/ }).first().click()
  const again = hr.getByRole('dialog', { name: 'Import attendance' })
  await again.getByLabel('Attendance CSV file').setInputFiles({ name: 'machine.csv', mimeType: 'text/csv', buffer: file })
  check('the preview says one day will be made absent', await shown(again.getByText('1 day will be made absent — cut from pay, and the person told.')))
  await again.getByRole('button', { name: /^Import \d+ day/ }).click()
  await shown(again.getByText(/\d+ days? imported/))
  check('Neha’s day is absent now — and what it was is kept', psql(`SELECT status || ' ' || "statusBeforeMachine" FROM "Attendance" WHERE "employeeId" = '${fx.employees.neha.id}' AND date = '${yesterday}'`) === 'absent present')
  await sa.getByLabel('Not on the machine').selectOption('flag')
  await shown(sa.getByText('Days not on the machine are flagged for HR'))
  await sa.getByLabel('Minutes allowed apart').fill('30')
  await sa.getByRole('button', { name: 'Save', exact: true }).click()
  await until(() => psql(`SELECT "punchMachineMinutes" FROM "Organization" WHERE id = '${orgId}'`), '30')

  // ── Phase 3: phones only, and the signs ───────────────────────────────────
  section('Manoj: a laptop is refused; a phone too precise is taken, and flagged')
  check('“Phones only” is on, to start', (await sa.getByRole('switch', { name: 'Phones only' }).getAttribute('aria-checked')) === 'true')
  const manojLaptop = await open('mgr', { viewport: DESKTOP, phone: false })
  await manojLaptop.goto(`${BASE}/dashboard`)
  await manojLaptop.getByRole('button', { name: /Check In/ }).click()
  const laptop = errorToast(manojLaptop)
  check('from a laptop at the office: refused, “Check in from your phone”', await shown(laptop) && (await laptop.innerText()).includes('Check in from your phone'), await laptop.innerText().catch(() => ''))
  check('…kept as evidence', psql(`SELECT "refusedFor" FROM "PunchEvidence" WHERE "employeeId" = '${fx.employees.manoj.id}' ORDER BY at DESC LIMIT 1`) === 'not_phone')
  await manojLaptop.context().close()
  const manoj = await open('mgr', { at: north(0, 1) })
  await manoj.goto(`${BASE}/dashboard`)
  await manoj.getByRole('button', { name: /Check In/ }).click()
  check('from a phone, a reading of ±1 m: checked in', await until(() => psql(`SELECT count(*) FROM "Attendance" WHERE "employeeId" = '${fx.employees.manoj.id}' AND date = '${today}' AND "checkIn" IS NOT NULL`), '1') === true)
  check('…and flagged: more precise than a phone indoors manages', psql(`SELECT array_to_string(flags, ',') FROM "PunchEvidence" WHERE "employeeId" = '${fx.employees.manoj.id}' AND "refusedFor" IS NULL ORDER BY at DESC LIMIT 1`).includes('too_precise'))

  section('HR: Attendance → Suspicious')
  await hr.goto(`${BASE}/attendance?view=suspicious`)
  const suspicious = hr.getByRole('list', { name: 'Suspicious punches' })
  check('the list is there, opened from a link', await shown(suspicious))
  const text = (await suspicious.innerText().catch(() => '')).replace(/\s+/g, ' ')
  check('…Manoj: refused from a computer, and the ±1 m reading flagged', text.includes('refused — from a computer') && text.includes('More precise than a phone indoors manages'), text.slice(0, 400))
  check('…Priya: refused 21 m from the office', text.includes('refused — 21 m from the office'))
  check('…Neha: not on the fingerprint machine', text.includes('Checked in on the app, with no scan on the machine that day'))
  await hr.screenshot({ path: `${SHOTS}/hr-suspicious.png`, fullPage: true })

  // ── Phase 4: the selfie, one phone ────────────────────────────────────────
  section('Super Admin: a selfie with every punch, one phone per employee')
  await sa.getByRole('switch', { name: 'Selfie with every punch' }).click()
  check('the selfie, turned on, says so', await shown(sa.getByText('Every punch now asks for a photo')))
  await sa.getByRole('switch', { name: 'One phone per employee' }).click()
  check('one phone, turned on, says so', await shown(sa.getByText('Each person punches from one phone')))

  section('Hema, on her phone: the photo first, then the punch')
  const hema = await open('hr')
  await hema.goto(`${BASE}/dashboard`)
  await hema.getByRole('button', { name: /Check In/ }).click()
  const camera = hema.getByRole('dialog', { name: 'Your photo' })
  check('Check In asks for her photo, the camera live', await shown(camera))
  await camera.getByRole('button', { name: 'Take photo' }).click()
  check('…and with it, she is checked in', await until(() => psql(`SELECT count(*) FROM "Attendance" WHERE "employeeId" = '${fx.employees.hema.id}' AND date = '${today}' AND "checkIn" IS NOT NULL`), '1') === true)
  check('…the photo kept with the punch', psql(`SELECT ("photoKey" IS NOT NULL)::text || ' ' || "photoBytes"::text FROM "PunchEvidence" WHERE "employeeId" = '${fx.employees.hema.id}' AND "refusedFor" IS NULL ORDER BY at DESC LIMIT 1`).startsWith('true '))
  check('…her phone, the first, is hers', psql(`SELECT status FROM "PunchDevice" WHERE "employeeId" = '${fx.employees.hema.id}'`) === 'approved')

  section('Hema, from another phone: it waits for approval')
  const hemaOther = await open('hr')
  await hemaOther.goto(`${BASE}/dashboard`)
  await hemaOther.getByRole('button', { name: /Check Out/ }).click()
  const waits = errorToast(hemaOther)
  check('refused: not the phone registered for her', await shown(waits) && (await waits.innerText()).includes('not the one registered for you'), await waits.innerText().catch(() => ''))
  await sa.goto(`${BASE}/attendance?view=suspicious`)
  const phones = sa.getByRole('region', { name: 'Phones waiting for approval' })
  check('the Super Admin sees it waiting', await shown(phones) && (await phones.innerText()).includes(fx.employees.hema.name))
  await phones.getByRole('button', { name: 'Approve' }).first().click()
  const confirmApprove = sa.getByRole('dialog').filter({ hasText: 'Their other phone is taken off' })
  check('…asked first: approving takes her other phone off', await shown(confirmApprove))
  await confirmApprove.getByRole('button', { name: 'Approve', exact: true }).click()
  check('…approves it', await shown(sa.getByText(`${fx.employees.hema.name}’s new phone is approved`)) && psql(`SELECT string_agg(status::text, ',' ORDER BY "firstSeenAt") FROM "PunchDevice" WHERE "employeeId" = '${fx.employees.hema.id}'`) === 'retired,approved')
  await hemaOther.getByRole('button', { name: /Check Out/ }).click()
  await hemaOther.getByRole('dialog', { name: 'Your photo' }).getByRole('button', { name: 'Take photo' }).click()
  check('…and from the new phone she checks out', await until(() => psql(`SELECT count(*) FROM "Attendance" WHERE "employeeId" = '${fx.employees.hema.id}' AND date = '${today}' AND "checkOut" IS NOT NULL`), '1') === true)
  check('the selfie dialog fits a phone', (await sideways(hemaOther)) <= 1)

  section('The Super Admin: a day’s evidence, from the roster')
  await sa.goto(`${BASE}/attendance`)
  await sa.getByRole('button', { name: `Evidence of ${fx.employees.hema.name}’s punches` }).first().click()
  const evidence = sa.getByRole('dialog', { name: new RegExp(`^${fx.employees.hema.name}`) })
  check('her punches, with the photos', await shown(evidence.getByRole('img', { name: 'Selfie taken with the punch' })) && (await evidence.getByRole('img', { name: 'Selfie taken with the punch' }).count()) === 2)
  check('…each accepted, metres from the office', (await evidence.innerText()).includes('— accepted') && /\d+ m from the office/.test(await evidence.innerText()))
  await evidence.getByRole('button', { name: 'Larger' }).first().click()
  const selfieWidth = await evidence.getByRole('img', { name: 'Selfie taken with the punch' }).first().evaluate((img) => img.getBoundingClientRect().width)
  check('…a selfie opens larger, to see the room behind', selfieWidth > 200, `${selfieWidth}px`)
  await sa.screenshot({ path: `${SHOTS}/sa-evidence.png`, fullPage: true })
  await sa.keyboard.press('Escape')
  // Back as the company had them.
  await sa.goto(`${BASE}/settings?tab=attendance-security`)
  await sa.getByRole('switch', { name: 'Selfie with every punch' }).click()
  await shown(sa.getByText('Punches no longer ask for a photo'))
  await sa.getByRole('switch', { name: 'One phone per employee' }).click()
  await shown(sa.getByText('Punches from another phone are only flagged'))

  section('The Super Admin, on a phone: every new screen fits')
  const saPhone = await open('sa', { phone: false })
  await saPhone.goto(`${BASE}/settings?tab=attendance-security`)
  await shown(saPhone.getByRole('heading', { name: 'Office Location' }))
  check('Settings → Attendance Security fits a phone', (await sideways(saPhone)) <= 1, `${await sideways(saPhone)}px`)
  await saPhone.screenshot({ path: `${SHOTS}/phone-settings.png`, fullPage: true })
  await saPhone.goto(`${BASE}/attendance?view=suspicious`)
  await shown(saPhone.getByRole('list', { name: 'Suspicious punches' }))
  check('Attendance → Suspicious fits a phone', (await sideways(saPhone)) <= 1, `${await sideways(saPhone)}px`)
  await saPhone.screenshot({ path: `${SHOTS}/phone-suspicious.png`, fullPage: true })
  // A day only refused has no row on the roster: its evidence opens from here.
  await saPhone.getByRole('button', { name: new RegExp(`^Evidence of ${fx.employees.priya.name}’s punches`) }).first().click()
  const refusedDay = saPhone.getByRole('dialog', { name: new RegExp(`^${fx.employees.priya.name}`) })
  check('…a refused punch’s evidence opens from Suspicious', await shown(refusedDay.getByText(/refused — 21 m from the office/)))
  await saPhone.keyboard.press('Escape')
  await saPhone.goto(`${BASE}/attendance`)
  await saPhone.getByRole('button', { name: `Evidence of ${fx.employees.hema.name}’s punches` }).first().click()
  const phoneEvidence = saPhone.getByRole('dialog', { name: new RegExp(`^${fx.employees.hema.name}`) })
  check('a day’s evidence fits a phone', await shown(phoneEvidence.getByRole('img', { name: 'Selfie taken with the punch' })) && (await sideways(saPhone)) <= 1, `${await sideways(saPhone)}px`)
  await saPhone.screenshot({ path: `${SHOTS}/phone-evidence.png` })
  await saPhone.context().close()

  section('Nothing broke along the way')
  check('no page errors', pageErrors.length === 0, pageErrors.join(' | '))
  check('no server errors', serverErrors.length === 0, serverErrors.join(' | '))
} catch (err) {
  failures.push(`stopped: ${err.message}`)
  console.log(`FAIL  stopped: ${err.stack ?? err.message}`)
} finally {
  await browser.close()
}

console.log(`\n${passed} passed, ${failures.length} failed`)
for (const f of failures) console.log(`  ✗ ${f}`)
process.exitCode = failures.length ? 1 : 0
