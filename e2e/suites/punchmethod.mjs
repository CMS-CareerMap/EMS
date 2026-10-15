// The punch method (client, 14 Oct 2026): the Super Admin chooses exactly one
// way a punch is proved — Location, Selfie, or Location + Selfie — and one
// phone works with whichever. The punch asks for that and nothing else; a
// method that checks the office cannot be had without one; phones are
// replaced or reset by whoever holds the power (Admin to start, from the
// person's page — Admin has no Attendance pages).
// Production build on :5183 → compiled API on :4100 → local ems_e2e, Day 20 seed (with its office).
import { chromium } from 'playwright-core'
import { mkdirSync, readFileSync } from 'node:fs'
import { WORK, psql } from '../lib/env.mjs'
import { openEmployeeProfile } from '../lib/ui.mjs'

const BASE = 'http://localhost:5183'
const fx = JSON.parse(readFileSync(`${WORK}/day20-fixture.json`, 'utf8'))
const SHOTS = `${WORK}/shots/punchmethod`
mkdirSync(SHOTS, { recursive: true })
const PHONE = { width: 390, height: 844 }
const DESKTOP = { width: 1366, height: 900 }
const PHONE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36'
const AT_OFFICE = { latitude: fx.office.latitude, longitude: fx.office.longitude, accuracy: 8 }

let passed = 0
const failures = []
function check(name, ok, detail = '') {
  if (ok) { passed++; console.log(`PASS  ${name}`) } else { failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`FAIL  ${name}${detail ? `  — ${detail}` : ''}`) }
}
const section = (name) => console.log(`\n── ${name}`)

const today = psql(`SELECT to_char(now() AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD')`)
const orgId = fx.organizationId
const emp = fx.employees
const method = () => psql(`SELECT "punchMethod" FROM "Organization" WHERE id = '${orgId}'`)
const dayOf = (id) => psql(`SELECT coalesce("punchMethod"::text, '-') || ' ' || ("checkIn" IS NOT NULL)::text || ' ' || ("checkOut" IS NOT NULL)::text FROM "Attendance" WHERE "employeeId" = '${id}' AND date = '${today}'`)
const phonesOf = (id) => psql(`SELECT coalesce(string_agg(status::text, ',' ORDER BY "firstSeenAt"), '') FROM "PunchDevice" WHERE "employeeId" = '${id}'`)

// A fake camera, granted without asking.
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] })
const pageErrors = []
const serverErrors = []
/** A fresh browser — a new phone, as far as "one phone" can tell: its own storage. */
async function open(who, { viewport = PHONE, phone = true, at = AT_OFFICE, permissions = ['geolocation', 'camera'] } = {}) {
  const ctx = await browser.newContext({ viewport, ...(phone ? { userAgent: PHONE_UA } : {}), ...(at ? { geolocation: at } : {}), permissions })
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
async function until(fn, want, ms = 30_000) {
  const end = Date.now() + ms
  let got
  while (Date.now() < end) { got = fn(); if (got === want) return true; await new Promise((r) => setTimeout(r, 300)) }
  return got
}
/** Chooses a method on Settings → Attendance Security, through its "are you sure?". */
async function choose(page, label) {
  await page.getByRole('radio', { name: new RegExp(`^${label.replace('+', '\\+')} (Medium|Low|Good)`) }).click()
  const asked = page.getByRole('dialog', { name: `Change the method to ${label}?` })
  await asked.waitFor({ timeout: 20_000 })
  const text = await asked.innerText()
  await asked.getByRole('button', { name: `Use ${label}` }).click()
  await asked.waitFor({ state: 'detached', timeout: 20_000 })
  return text
}

try {
  section('Super Admin: one method, chosen — Location to start')
  const sa = await open('sa', { viewport: DESKTOP, phone: false })
  await sa.goto(`${BASE}/settings?tab=attendance-security`)
  const radios = sa.getByRole('radiogroup', { name: 'Attendance method' }).getByRole('radio')
  await radios.first().waitFor({ timeout: 20_000 })
  check('three methods, as a radio — never none', (await radios.count()) === 3)
  check('Location is chosen, to start', (await sa.getByRole('radio', { name: /^Location Medium/ }).getAttribute('aria-checked')) === 'true' && method() === 'location')
  check('…each says how strong it is: Medium, Low, Good', /Medium/.test(await radios.nth(0).innerText()) && /Low/.test(await radios.nth(1).innerText()) && /Good/.test(await radios.nth(2).innerText()))
  const flow = sa.getByRole('list', { name: 'How a check-in works now' })
  check('the flow says what a check-in asks for now', (await flow.innerText()).includes('Inside the office radius, from a phone') && (await flow.innerText()).includes('Checked in'))
  check('the switches the method replaced are gone: no “Phones only”, no “Check location at check-out”, no selfie switch',
    (await sa.getByRole('switch', { name: 'Phones only' }).count()) === 0 && (await sa.getByRole('switch', { name: 'Check location at check-out' }).count()) === 0 && (await sa.getByRole('switch', { name: 'Selfie with every punch' }).count()) === 0)
  check('…one phone is still a switch, beside the method', await shown(sa.getByRole('switch', { name: 'One phone per employee' })))
  // A radio group, as a keyboard expects: Tab on the chosen one only, the arrows move between them.
  check('only the chosen method takes Tab', (await sa.getByRole('radio', { name: /^Location Medium/ }).getAttribute('tabindex')) === '0'
    && (await sa.getByRole('radio', { name: /^Selfie Low/ }).getAttribute('tabindex')) === '-1')
  await sa.getByRole('radio', { name: /^Location Medium/ }).focus()
  await sa.keyboard.press('ArrowRight')
  check('…and the arrow moves to the next', await sa.evaluate(() => document.activeElement?.textContent?.startsWith('Selfie')))

  const asked = await choose(sa, 'Selfie')
  check('choosing Selfie asks first, saying what a check-in will ask for', asked.includes('A live photo from the front camera') && asked.includes('checks out the way their day began'))
  check('…saved, and said', await shown(sa.getByText('Check-ins now use Selfie')) && await until(method, 'selfie') === true)
  check('…the flow follows', (await flow.innerText()).includes('A live photo from the front camera') && !(await flow.innerText()).includes('Inside the office'))
  check('…and the audit log says it in words', await until(() => psql(`SELECT count(*) FROM "AuditLog" WHERE "organizationId" = '${orgId}' AND action = 'attendance_security.updated' AND details->'changes'->'punchMethod'->>'to' = 'selfie'`), '1') === true)
  await sa.screenshot({ path: `${SHOTS}/sa-method-selfie.png`, fullPage: true })

  section('Priya, Selfie, on a laptop with no location allowed: the photo is the punch')
  const priya = await open('emp', { viewport: DESKTOP, phone: false, at: null, permissions: ['camera'] })
  await priya.goto(`${BASE}/dashboard`)
  check('the card says a photo is taken — and nothing about a location', await shown(priya.getByText('A photo from your front camera is taken when you check in')) && (await priya.getByText('Your location is checked when you check in').count()) === 0)
  await priya.getByRole('button', { name: /Check In/ }).click()
  const camera = priya.getByRole('dialog', { name: 'Your photo' })
  check('Check In opens the camera — no location read, no “phones only” for a photo', await shown(camera))
  await camera.getByRole('button', { name: 'Take photo' }).click()
  check('…checked in by Selfie, the day saying so', await until(() => dayOf(emp.priya.id), 'selfie true false') === true)
  check('…the photo kept, no fence applied', psql(`SELECT ("photoKey" IS NOT NULL)::text || ' ' || "fenceApplied"::text FROM "PunchEvidence" WHERE "employeeId" = '${emp.priya.id}' AND "refusedFor" IS NULL ORDER BY at DESC LIMIT 1`) === 'true false')

  section('The company switches to Location + Selfie: Priya’s day still ends by Selfie')
  await sa.goto(`${BASE}/settings?tab=attendance-security`)
  await choose(sa, 'Location + Selfie')
  check('Location + Selfie saved', await until(method, 'location_selfie') === true)
  await priya.reload()
  await priya.getByText('A photo from your front camera is taken when you check out').waitFor({ timeout: 20_000 }).catch(() => {})
  check('her card: a photo at check-out — no location, as her day began', await shown(priya.getByText('A photo from your front camera is taken when you check out')))
  await priya.getByRole('button', { name: /Check Out/ }).click()
  await priya.getByRole('dialog', { name: 'Your photo' }).getByRole('button', { name: 'Take photo' }).click()
  check('…checked out from the laptop, by photo alone', await until(() => dayOf(emp.priya.id), 'selfie true true') === true)
  await priya.context().close()

  section('Ravi, Location + Selfie, location not allowed: no location, no camera, no punch')
  const ravi = await open('emp2', { at: null, permissions: ['camera'] })
  await ravi.goto(`${BASE}/dashboard`)
  check('his card: the location first, then a photo', await shown(ravi.getByText('Your current location is recorded when you check in, then a photo is taken')))
  await ravi.getByRole('button', { name: /Check In/ }).click()
  const blocked = errorToast(ravi)
  check('refused for the location, in words he can act on', await shown(blocked, 60_000) && /location/i.test(await blocked.innerText()), await blocked.innerText().catch(() => ''))
  check('…the camera never opened', (await ravi.getByRole('dialog', { name: 'Your photo' }).count()) === 0)
  check('…nothing recorded', psql(`SELECT count(*) FROM "Attendance" WHERE "employeeId" = '${emp.ravi.id}' AND date = '${today}' AND "checkIn" IS NOT NULL`) === '0')
  // At another site — a warehouse 3 km from the office — with "precise location" off: a vague reading.
  await ravi.context().grantPermissions(['geolocation', 'camera'])
  await ravi.context().setGeolocation({ latitude: fx.office.latitude + 0.027, longitude: fx.office.longitude, accuracy: 1500 })
  await ravi.reload()
  await ravi.getByRole('button', { name: /Check In/ }).click()
  const ravisCamera = ravi.getByRole('dialog', { name: 'Your photo' })
  check('location allowed: read first, then the camera opens', await shown(ravisCamera))
  await ravisCamera.getByRole('button', { name: 'Take photo' }).click()
  check('…checked in by Location + Selfie at the warehouse, 3 km out — no office needed, nothing refused', await until(() => dayOf(emp.ravi.id), 'location_selfie true false') === true)
  check('…where he stood kept, not fenced; the vague reading flagged', psql(`SELECT "fenceApplied"::text || ' ' || array_to_string(flags, ',') || ' ' || round("latitude"::numeric, 3)::text FROM "PunchEvidence" WHERE "employeeId" = '${emp.ravi.id}' AND "refusedFor" IS NULL ORDER BY at DESC LIMIT 1`)
    === `false location_vague ${(fx.office.latitude + 0.027).toFixed(3)}`)
  check('…the card says his location was recorded with his photo', await shown(ravi.getByText('Your location was recorded with your photo')))
  check('the card fits a phone', (await sideways(ravi)) <= 1, `${await sideways(ravi)}px`)
  await ravi.screenshot({ path: `${SHOTS}/ravi-location-selfie.png`, fullPage: true })
  await ravi.context().close()

  section('HR sees where Ravi stood: Suspicious, with the map')
  await sa.goto(`${BASE}/attendance?view=suspicious`)
  const list = sa.getByRole('list', { name: 'Suspicious punches' })
  await shown(list)
  const raviDay = list.locator('li').filter({ hasText: emp.ravi.name }).first()
  check('his punch is there: the location too vague to say where — and where it was taken', await shown(raviDay) && (await raviDay.innerText()).includes('too vague to say where')
    && /at \d+\.\d{5}, \d+\.\d{5}/.test(await raviDay.innerText()))
  const map = raviDay.getByRole('link', { name: 'Open map' }).first()
  check('…with “Open map” at the place he stood', await shown(map) && (await map.getAttribute('href')).startsWith('https://www.google.com/maps?q=') && (await map.getAttribute('target')) === '_blank')
  await raviDay.getByRole('button', { name: /^Evidence of/ }).click()
  const raviEvidence = sa.getByRole('dialog', { name: new RegExp(`^${emp.ravi.name}`) })
  check('…and the day’s evidence: taken at his coordinates, the photo, the map', await shown(raviEvidence.getByText(/Taken at \d+\.\d+, \d+\.\d+/)) && await shown(raviEvidence.getByRole('img', { name: 'Selfie taken with the punch' })) && await shown(raviEvidence.getByRole('link', { name: 'Open map' })))
  await sa.screenshot({ path: `${SHOTS}/sa-ravi-evidence.png` })
  await sa.keyboard.press('Escape')

  section('One phone, with Selfie: Manoj’s second phone is refused — “contact HR”')
  await sa.goto(`${BASE}/settings?tab=attendance-security`)
  await choose(sa, 'Selfie')
  await sa.getByRole('switch', { name: 'One phone per employee' }).click()
  check('one phone, turned on beside Selfie', await shown(sa.getByText('Each person punches from one phone')) && (await flow.innerText()).includes('from their registered phone'))
  const manojA = await open('mgr')
  await manojA.goto(`${BASE}/dashboard`)
  await manojA.getByRole('button', { name: /Check In/ }).click()
  await manojA.getByRole('dialog', { name: 'Your photo' }).getByRole('button', { name: 'Take photo' }).click()
  check('his first phone: checked in, and it is his', await until(() => dayOf(emp.manoj.id), 'selfie true false') === true && phonesOf(emp.manoj.id) === 'approved')
  const manojB = await open('mgr')
  await manojB.goto(`${BASE}/dashboard`)
  await manojB.getByRole('button', { name: /Check Out/ }).click()
  const refused = errorToast(manojB)
  check('another phone: refused before the camera, saying to contact HR', await shown(refused) && /not the one registered for you.*Contact HR/.test(await refused.innerText()), await refused.innerText().catch(() => ''))
  check('…it waits for a decision', phonesOf(emp.manoj.id) === 'approved,waiting')
  check('…and Admin — who holds the power — is told, with a link to his page',
    await until(() => psql(`SELECT count(*) FROM "Notification" WHERE "userId" = '${fx.userIds.admin}' AND event = 'attendance.device_waiting' AND link = '/employees/${emp.manoj.id}?tab=logins'`), '1') === true)

  section('Admin, with no Attendance pages: the notice → his page → Login → Punch phone → Replace')
  const admin = await open('admin', { viewport: DESKTOP, phone: false })
  check('Admin has no Attendance in the menu', (await admin.getByRole('link', { name: 'Attendance', exact: true }).count()) === 0)
  // Where the notice leads: his page, on the tab with his login — "Login" for Admin, who manages no logins.
  await admin.goto(`${BASE}/employees/${emp.manoj.id}?tab=logins`)
  check('the notice’s link opens his page on the Login tab', await shown(admin.getByRole('tab', { name: 'Login', selected: true })))
  const card = admin.locator('main').getByRole('region', { name: 'Punch phone' })
  check('the Punch phone card: his phone, and the one waiting', await shown(card) && /Their phone/.test(await card.innerText()) && /Waiting/.test(await card.innerText()))
  check('…no Reset while a phone waits — it says to replace with it, or refuse it', (await card.getByRole('button', { name: 'Reset' }).count()) === 0
    && (await card.innerText()).includes('A new phone has already tried'))
  await card.getByRole('button', { name: 'Replace with this phone' }).click()
  const replace = admin.getByRole('dialog', { name: `Replace ${emp.manoj.name}’s phone?` })
  check('asked first: the new one his, the old one off, both at once', await shown(replace) && (await replace.innerText()).includes('both at once'))
  await replace.getByRole('button', { name: 'Replace', exact: true }).click()
  check('…replaced, and said', await shown(admin.getByText(`is now ${emp.manoj.name}’s phone`)) && await until(() => phonesOf(emp.manoj.id), 'retired,approved') === true)
  await admin.screenshot({ path: `${SHOTS}/admin-replaced.png`, fullPage: true })
  await manojB.reload()
  await manojB.getByRole('button', { name: /Check Out/ }).click()
  await manojB.getByRole('dialog', { name: 'Your photo' }).getByRole('button', { name: 'Take photo' }).click()
  check('from the new phone he checks out', await until(() => dayOf(emp.manoj.id), 'selfie true true') === true)
  await manojA.reload()
  check('…the old phone shows no way to punch for him now — his day is done', await shown(manojA.getByText('Your day is recorded. See you tomorrow.')))

  section('Admin resets his phone: the next new phone becomes his by itself')
  await card.getByRole('button', { name: 'Reset' }).click()
  const reset = admin.getByRole('dialog', { name: `Reset ${emp.manoj.name}’s phone?` })
  await reset.getByRole('button', { name: 'Reset', exact: true }).click()
  check('reset, and said', await shown(admin.getByText(`Reset — the next new phone ${emp.manoj.name} checks in from becomes theirs`)) && await until(() => phonesOf(emp.manoj.id), 'retired,retired') === true)
  check('…the card says no phone yet', await shown(card.getByText(/No phone yet/)))
  check('…Manoj is told', await until(() => psql(`SELECT count(*) FROM "Notification" WHERE "userId" = '${fx.userIds.mgr}' AND event = 'attendance.device_reset'`), '1') === true)
  // A new phone: tomorrow's check-in would register it; today's day is done, so a start is enough to see it taken.
  psql(`DELETE FROM "PunchEvidence" WHERE "employeeId" = '${emp.manoj.id}' AND date = '${today}'`)
  psql(`DELETE FROM "Attendance" WHERE "employeeId" = '${emp.manoj.id}' AND date = '${today}'`)
  const manojC = await open('mgr')
  await manojC.goto(`${BASE}/dashboard`)
  await manojC.getByRole('button', { name: /Check In/ }).click()
  await manojC.getByRole('dialog', { name: 'Your photo' }).getByRole('button', { name: 'Take photo' }).click()
  check('his new phone, never seen: checked in, and his', await until(() => dayOf(emp.manoj.id), 'selfie true false') === true && phonesOf(emp.manoj.id) === 'retired,retired,approved')
  await Promise.all([manojA.context().close(), manojB.context().close(), manojC.context().close()])

  section('Whoever lacks the power sees no Punch phone card; Admin on a phone, it fits')
  const rekha = await open('rm', { viewport: DESKTOP, phone: false })
  const priyaPage = await openEmployeeProfile(rekha, BASE, emp.priya.name, 'Login').catch(() => null)
  check('a Reporting Manager — no such power — has no Punch phone card', priyaPage !== null && (await rekha.getByRole('region', { name: 'Punch phone' }).count()) === 0)
  await rekha.context().close()
  const adminPhone = await open('admin', { phone: false })
  await openEmployeeProfile(adminPhone, BASE, emp.manoj.name, 'Login')
  check('the Punch phone card fits a phone', await shown(adminPhone.getByRole('region', { name: 'Punch phone' })) && (await sideways(adminPhone)) <= 1, `${await sideways(adminPhone)}px`)
  await adminPhone.screenshot({ path: `${SHOTS}/phone-punch-phone.png`, fullPage: true })
  // One phone off: nothing is checked, so the card says so and offers nothing.
  psql(`UPDATE "Organization" SET "punchOneDevice" = false WHERE id = '${orgId}'`)
  await adminPhone.reload()
  const offCard = adminPhone.getByRole('region', { name: 'Punch phone' })
  check('with one phone off, the card says any phone checks in — and offers no Replace or Reset', await shown(offCard.getByText(/One phone per employee is off/))
    && (await offCard.getByRole('button', { name: 'Reset' }).count()) === 0)
  psql(`UPDATE "Organization" SET "punchOneDevice" = true WHERE id = '${orgId}'`)
  await adminPhone.context().close()

  section('No office saved: Location cannot be chosen; Location + Selfie can; a setup left so is said')
  psql(`UPDATE "GeofenceLocation" SET "isActive" = false WHERE "organizationId" = '${orgId}'`)
  await sa.goto(`${BASE}/settings?tab=attendance-security`)
  const both = sa.getByRole('radio', { name: /^Location \+ Selfie/ })
  await both.waitFor({ timeout: 20_000 })
  const fenced = sa.getByRole('radio', { name: /^Location Medium/ })
  check('Location is held, saying to save the office first', await fenced.isDisabled() && (await fenced.innerText()).includes('Save the office location first'))
  check('…Location + Selfie is not: it needs no office', !(await both.isDisabled()) && !(await both.innerText()).includes('Save the office location first'))
  // A company whose method came over from before, with no office: said on Settings and on the home page.
  psql(`UPDATE "Organization" SET "punchMethod" = 'location' WHERE id = '${orgId}'`)
  await sa.reload()
  check('Settings says nobody can check in at the office yet', await shown(sa.getByRole('alert').filter({ hasText: 'Nobody can check in at the office yet' })))
  await sa.goto(`${BASE}/dashboard`)
  const banner = sa.getByRole('alert').filter({ hasText: 'Attendance setup is not finished' })
  check('…and the home page, with the way to fix it', await shown(banner) && await shown(banner.getByRole('link', { name: 'Set it up' })))
  await sa.screenshot({ path: `${SHOTS}/sa-setup-banner.png`, fullPage: true })
  psql(`UPDATE "GeofenceLocation" SET "isActive" = true WHERE "organizationId" = '${orgId}'`)
  await sa.reload()
  check('…gone once the office is saved', !(await shown(sa.getByRole('alert').filter({ hasText: 'Attendance setup is not finished' }), 5_000)))

  section('The Super Admin, on a phone: Settings → Attendance Security fits')
  const saPhone = await open('sa', { phone: false })
  await saPhone.goto(`${BASE}/settings?tab=attendance-security`)
  await shown(saPhone.getByRole('radiogroup', { name: 'Attendance method' }))
  check('the method cards and the rest fit a phone', (await sideways(saPhone)) <= 1, `${await sideways(saPhone)}px`)
  await saPhone.screenshot({ path: `${SHOTS}/phone-settings.png`, fullPage: true })
  await saPhone.context().close()

  // Back as the company had them.
  psql(`UPDATE "Organization" SET "punchMethod" = 'location', "punchOneDevice" = false WHERE id = '${orgId}'`)

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
