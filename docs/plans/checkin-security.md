# Plan: check-in / check-out security

> **14 Oct 2026:** the separate "check location at check-out", "phones only" and
> "selfie" switches were replaced by one **punch method** (Location / Selfie /
> Location + Selfie), and phones are replaced or reset by whoever holds
> `user:device:manage` — see [punch-method.md](./punch-method.md).

Status: **built 11 Oct 2026 on `feat/checkin-security`** (Devesh: all five
phases on this one branch, one after the other). Five migrations; Neon must
migrate after the merge. "As built" at the end has what changed from the plan
and what the independent review found.

**What the client wants:** nobody marks attendance from home. App check-in and
check-out happen only inside the office hall, within 15–20 m, never a metre more.
Fake-location ("mock GPS") tricks must not work. The client has **no static IP**
and will **not** keep a screen at the entrance, so a rotating office QR code and
an office-network check are out. The office has a **fingerprint machine**, whose
CSV is imported later to **confirm** the app's attendance.

**The principle Devesh set:** every layer is a setting. The Super Admin turns on
what suits the company, and the whole flow follows the settings. The settings
live in Settings → Attendance Security; changing them needs `settings:update`
(the Super Admin's alone to start), and every change is audited.

## What can and cannot be done, said plainly

- A phone's GPS is not accurate to a metre. Indoors a reading is off by 5–30 m.
  What can be enforced: the reading's point must be inside the radius, the
  reading must itself be precise enough, and nothing is added on top.
- **A web page cannot detect a fake-location app.** The browser hands the page
  whatever location the phone's system reports. On a laptop, the browser's own
  developer tools can set any location without any app at all.
- So location alone can never prove presence. What catches somebody at home is:
  the **fingerprint machine** (their finger was not on it that day), the
  **selfie** (the room behind them), **one registered phone** (no punching with
  somebody else's password), and the **suspicious-sign flags**.
- A native Android app could detect fake-location apps. That is a separate
  project, after go-live, if it is ever needed.

## How it works today (checked in the code, 11 Oct 2026)

- `domain/attendance/geofence.ts` `checkGeofence`: a reading vaguer than
  `maxAccuracyMeters` is "unreliable"; otherwise **`distance − accuracy`** is
  compared with the radius. With the defaults (radius 30 in the database, 25 in
  the form; accuracy 50) a reading 74 m away passes.
- `GeofenceLocation`: one active office per company (`findActiveGeofence`).
  Validator: radius 10–50,000 m, accuracy 20–500 m. Saved from Settings →
  Organisation (`features/settings/CompanySettings.jsx`), `settings:update`,
  audited `geofence.saved` / `geofence.deleted`.
- `attendance.service.ts` `punchIn`: app-mode only; `verifyLocation` fails
  closed on a missing reading, **but with no office set, nobody is checked**
  (`geofenceVerified: null`). WFH / on duty / remote skip the office check
  (`wfhGpsRequired` asks for a reading then, unchecked).
- `punchOut`: **no location at all**, by design until now.
- The browser takes **one** reading (`hooks/usePunch.js` `getPosition`:
  high accuracy, 15 s timeout, no cache) and sends latitude, longitude and
  accuracy. The server keeps the user agent as `checkInDevice`.
- Evidence on the day: check-in latitude, longitude, distance, accuracy,
  `geofenceVerified`, `checkInDevice`. Nothing for check-out.
- Machine import (`attendanceImport.service.ts`): one line per person per day,
  columns code, date, in, out (aliases). A second line for the same person and
  day is refused. Every line **replaces** the day (`replaceDay`, source
  `biometric`), an app punch included. Matched by employee code only.
- Correction request (`attendance_correction`): the employee gives the day and
  a check-in and/or check-out time; approval writes the day.
- Files: `platform/storage` (local in development, R2 in production); the
  nightly sweeper deletes any object no row points at (`files.repository.ts`
  `referencedKeys`).
- Browser headers (`deploy/web/security-headers.caddy`):
  `Permissions-Policy: geolocation=(self), camera=()` — the camera is blocked.
- Web: `features/attendance/PunchCard.jsx` is the only Check In / Check Out
  (dashboard and Attendance → own log); errors reach the person as a toast. The
  office form is Settings → Company → "Attendance Geofence"
  (`CompanySettings.jsx`, saved with the company). HR's roster shows only the
  check-in device, as a hover; distance and accuracy are never shown to HR.
  Requests opens a new correction from `?new=attendance_correction&date=`.
- E2E: `golden` sets the office through the form (radius 50, accuracy 100) and
  punches from a desktop-sized browser with a fixed location; `liveroster` and
  `livetime` punch with no office set (the day20 seed has none), so no location
  is asked. No suite punches through the API.

## The layers

### Layer 1 — Strict location (always on)

- **Rule:** the reading's point must be within the radius (no `− accuracy`),
  and the reading must be accurate to the set number or better. A hard cap in
  the domain: **never more than 20 m**, whatever the database says.
- **Settings** (on the office location): radius **15–20 m** (default 20),
  accuracy needed **10–20 m** (default 20). A migration brings every existing
  office into range (radius and accuracy above 20 → 20, below the minimum → the
  minimum).
- **Several readings:** the phone watches its location for up to ~10 s and
  sends every reading (at most 10). The **server** picks the best one; the
  readings are kept as evidence.
- **A start token:** the app asks the server for a short-lived signed token
  when the person presses the button; the punch must carry it, within 2
  minutes, for the same person and the same action. An old request cannot be
  replayed.
- **No office set → no app punch** for anybody working from the office that
  day ("The office location is not set yet").
- **Check-out:** setting **"Check location at check-out"** (default **on**).
  Outside, or too vague: refused, with "Ask HR to record my check-out", which
  opens an attendance correction with today and the time filled in.
- **Testing a spot:** the Super Admin can stand anywhere and see "you are 12 m
  from the office, accurate to 8 m — this would be accepted". The office point
  is captured as the average of ~20 s of readings, not one.
- WFH, on-duty and remote days are untouched.

### Layer 2 — Confirmation by the fingerprint machine (setting, default on)

The app's attendance stands at once; the machine's file confirms it later.

- **Any machine's file.** One line a day (in/out) **or** one line per finger
  scan: grouped per person and day, **the first scan is the check-in and the
  last is the check-out**. Date and time in separate columns or one; the common
  machine column names (AC-No., Enroll No., Badge number, Time, CheckTime…).
  Night shifts: early-morning scans belong to the night before (the shift's own
  window, as check-out uses).
- **Machine ID per employee:** an optional "Machine ID" on the employee (the
  number the machine knows them by). A line is matched by it first, then by the
  employee code. Unique in the company.
- **What is matched:** app-mode employees' **office** days (not WFH, on duty or
  remote) inside the file's dates.

  | The machine has | Result |
  |---|---|
  | Any scan that day | **Confirmed**. The app's times stay the record; the machine's are kept beside them |
  | First scan within the set minutes of the app check-in (default 30) | Confirmed, no flag |
  | More than that apart | **Time differs** — a note for HR, never absent |
  | A later scan | Compared with the app check-out the same way; none → nothing said |
  | No scan that day | **Not on the machine**. Setting: flag only (default) or mark absent (then the absent alert and "Apply leave" follow) |
  | Scans, but no app punch that day | The day is filled from the machine (setting, default on) |

- An app-punched day is **never overwritten** by the machine while this layer
  is on. With it off, the import works as today.
- **Preview first:** how many days confirm, differ, are missing, are filled;
  and who in the file's dates is not in the file at all ("partial file?").
- **Payroll:** a warning before running a month with days not confirmed.
- Biometric-mode staff: unchanged — the machine is their record.

### Layer 3 — Phones only (setting, default on)

- A punch from a computer is refused. Decided on the server from the browser's
  description (`Mobi`, Android, iPhone/iPad, the `Sec-CH-UA-Mobile` hint) and
  the page's own hints (touch points). It stops a laptop's browser as it is.
  It does not stop somebody who knows how: a browser's developer tools can
  claim to be a phone and set a location in a few clicks. That is why the
  fingerprint machine confirms each day — and the client documents say so.

### Layer 4 — Suspicious-sign flags (always on, never block)

Kept on each punch:
- **Same every time:** every reading in the burst identical (real GPS moves a
  little; a fake one often sits still).
- **Same as before:** the same coordinates, to the last digit, as an earlier day.
- **Too precise:** 2 m or better indoors.
- **Old reading:** the reading's time far from the server's.
- **Not a phone:** a computer, when phones-only is off.
- **Another phone:** a device other than the person's usual one.
- **Not on the machine / time differs** (Layer 2).

HR sees a **Suspicious punches** list (Attendance), each with its reasons and
evidence: readings, distance, accuracy, IP address, device, selfie.

### Layer 5 — Selfie (setting, default off)

- A live photo from the front camera at check-in and check-out (never the
  gallery), made small in the browser, stored privately.
- Seen by HR and the Super Admin, and by a manager for their own team, on the
  day.
- **Kept for** a set number of days (default 60), then deleted by the nightly
  job.
- Needs the camera allowed for the site (`camera=(self)`).

### Layer 6 — One phone per employee (setting, default off)

- The first phone used is registered. Another phone is refused until HR
  approves it ("This phone is waiting for HR's approval"), and HR is told.
  Approving a new phone retires the old one.
- A random key kept by the browser identifies the phone (stored hashed). Clearing
  the browser's data, or a private window, looks like a new phone.
- The device is recorded even with the setting off, for the "another phone" flag.

**As designed for the build (11 Oct 2026):**
- `PunchDevice` rows exist only with the setting on: approved / waiting /
  retired. With it off, each punch keeps its key's hash, and a key never seen
  in the person's last 60 days of punches is flagged "another phone".
- The selfie is taken in a small dialog (front camera, live, never the
  gallery), shrunk to about 480 px and sent with the punch; stored under
  `attendance-photo`, kept by the sweeper while a punch points at it, deleted
  by the nightly job after the days set. A refused punch keeps its photo too.
- HR sees a day's punches — distance, accuracy, device, address, flags, photo —
  from the roster ("Evidence"), and waiting phones at the top of Suspicious.

## The settings

| Setting | Default | Range |
|---|---|---|
| Office location, radius | 20 m | 15–20 m |
| Location accuracy needed | 20 m | 10–20 m |
| Check location at check-out | On | |
| Confirm by the fingerprint machine | On | |
| Minutes the machine and the app may differ | 30 | 5–240 |
| Not on the machine | Flag only | Flag only / Mark absent |
| Fill a day from the machine when the app has none | On | |
| Phones only | On | |
| Selfie | Off | |
| Keep selfies for | 60 days | 7–365 |
| One phone per employee | Off | |

**Where:** a new Settings tab **Attendance Security** (seen with
`settings:read`, saved with `settings:update`). The office location moves there
from Company, with the 20-second capture and the "test this spot" tool.

## Data

- `Organization`: the settings above (columns, like the request and password rules).
- `PunchEvidence` (new, per punch): the day, in or out, the readings, the chosen
  point, distance, accuracy, address, user agent, device, photo (key, hash,
  size), flags.
- `PunchDevice` (new): employee, hashed key, label, approved / waiting / retired,
  who decided and when.
- `Attendance`: the machine's first and last scan, the match result, when.
- `Employee.machineId` (optional, unique in the company).
- `referencedKeys` includes the selfies, so the sweeper keeps them.

## Phases (all on `feat/checkin-security`)

1. Layer 1 and the Attendance Security settings page.
2. Layer 2: the machine file, matching, preview, HR list, payroll warning, Machine ID.
3. Layers 3 and 4: phones only, flags, the Suspicious punches list.
4. Layers 5 and 6: selfie, one phone.
5. Testing, independent review, documents.

## What the earlier E2E suites need

- `golden`: the office is set on the new tab, radius 20 and accuracy 20; the
  people who punch use a phone-sized browser that says it is a phone.
- `liveroster`, `livetime`: the day20 seed gets an office location; their
  punching browsers say they are phones and stand at the office.

## Testing

- Domain tests for every rule: the fence edge (20 m in, 21 m out), accuracy
  edge, best-reading choice, every flag, machine grouping (one line a day, one
  line a scan, night shift), matching outcomes, phone detection.
- API tests for every setting on and off, every refusal, every role (employee,
  manager, HR, Super Admin, one who must not).
- E2E on the isolated stack: a phone-sized browser with a fixed location (inside,
  20 m, 21 m, vague), a laptop refused, check-out outside, the machine file in
  both shapes, the selfie with a fake camera, a second phone; and every earlier
  suite.
- Independent review agents before the final E2E.

## As built (11 Oct 2026)

**Migrations** (in order): `20261010192108_checkin_security_location` (the
office clamped to 15–20 m / 10–20 m, `punchCheckOutLocation`, `PunchEvidence`),
`20261010194830_checkin_security_machine` (the machine settings,
`Attendance.machine*` + `statusBeforeMachine`, `Employee.machineId`),
`20261010201217_checkin_security_signals` (`punchPhoneOnly`, flags),
`20261010202302_checkin_security_selfie_device` (selfie settings, `PunchDevice`),
`20261011051452_checkin_security_more_flags` (`repeated_photo`, `mac_with_touch`).

**The punch:** `POST /attendance/punch-start {action, touchPoints, deviceKey}`
→ `{token, expires_in_seconds: 120, location_needed, radius_meters,
accuracy_meters, photo_needed}`; refusals that need no location (phones only,
one phone) are said here and kept. Then the selfie, then the burst
(`web/src/lib/location.js`: up to 10 readings in 10 s, each with its time; the
time starts once the browser's "Allow location?" is answered; a reading vaguer
than 10 km is dropped), then `POST /attendance/punch-in|out {token, readings,
touchPoints, deviceKey, photo}` — only the burst; a reading without its time is
refused (422). The server picks the most precise reading, checks the fence
(capped at 20 / 20 whatever is stored), keeps a `PunchEvidence` row for every
punch, refused ones included (written outside the day's transaction), and the
flags. A start older than ~105 s is begun again by the page before the punch.

**Flags:** frozen_readings (3+ identical), repeated_spot (same 7-decimal point
as another day in 60 days), too_precise (≤ 2 m), stale_reading (> 2 min from
the server), not_a_phone (phones-only off), new_device (a key not seen in 60
days — or no key at all — with one-phone off), repeated_photo (the same photo
bytes as an earlier accepted punch), mac_with_touch (a Mac with a touch screen:
an iPad, or a laptop claiming it — taken, and said).

**Selfie:** stored only with the setting on; a refused punch keeps its photo
for the first three refusals of the person's day, no more. The nightly job
(`scripts/maintenance.ts`) clears the punch's photo fields first, then deletes
the file (the sweeper takes any file left behind); one company failing no
longer stops the run for the others.

**One phone:** the very first phone is approved by itself; once there is any
history (a phone taken off, or waiting), every new phone waits for HR, who is
told. Approving and taking off go up the tree like correcting attendance
(`assertWorkGoesUp('attendance')` — never one's own, a fellow HR's or a
senior's), under the person's lock. The list puts waiting phones first.

**Who sees the evidence:** `/attendance/suspicious` (reach beyond SELF), the
day's evidence and the photo — never one's own punches, except for the Super
Admin (a person who could read the signs on their own punches could tune a fake
until none showed). The roster's Evidence button is hidden on one's own row;
Suspicious has its own Evidence button, so a refused punch's selfie can be seen.

**Machine file:** read between the file's OWN dates (its lines'). A night
shift's morning scan on the file's first day belongs to the night before —
outside them: that night is made whole with what is already recorded for it
(an earlier file's evening: `machineFirstScan` for an app day, the check-in for
a machine day), never judged or written on the morning alone; with nothing
recorded (or its month closed, or leave) it is left out and the preview says so
(`edge_nights_left_out`). An app day is one checked in on the app — source
`punch`, or an accepted 'in' `PunchEvidence` (so a day whose check-out HR
recorded is still asked about). Not on the machine is judged only for days
before today; a day not checked out is flagged, never made absent. A later file
gives back only the absent the machine made (status still absent). Approved
leave takes over a punched day the machine made absent; a reversal puts the
machine's absent back. HR's mark/correction clears the machine fields. A
line a day with only a check-out stays a check-out ("No check-in on the
machine"). Up to 10,000 lines. Making absent or giving back needs `attendance:update`.
Machine ID and Employee ID are checked under the same lock.

**Payroll warnings:** not yet checked; not on the machine (unless the machine
already made it absent — so a day flagged before the rule changed is still
warned); times differ.

**Independent review (three agents: punch security, machine import + HR
endpoints, web).** Every finding was checked against the code; all real ones
fixed and tested: the one-phone re-registration gap, one's own evidence,
selfie storage with the setting off and repeated refusals, the reused photo,
flags dodged by sending less (now refused), the Mac-with-touch pass, phones
decided by a fellow HR, the purge order and a failing company, two taps on an
existing row (now a 409), the office save race (a lock), the night-edge of a
file, corrected app days escaping the machine, today and open days made
absent, a stale give-back, the out-only line, the scan-file row cap, the
Machine ID lock, the miscounted blank lines, the location timer during the
browser's question, a refused punch's selfie unreachable, the office capture
overwriting edits, "test this spot" against an unsaved office, no "Ask HR"
when the location could not be read, the `?view=` link on an open page, phone
decisions without a confirmation, the start token outliving a slow camera, a
too-vague reading failing the punch, errors said twice, the selfie's blob
address in development, the small selfie (now "Larger"), a tiny Evidence
button, and a punch hanging when the card closed with the camera open.

**Tests:** domain (`attendance.domain.test.ts`, `machineFile.test.ts`,
`punchSignals.test.ts`), integration (`attendance.test.ts` — the review's own
describe — `attendanceAdmin.test.ts`, `settings.test.ts`, `payrollRun.test.ts`,
`leaveExtras.test.ts`, `requests.test.ts`, `lifecycle.test.ts`), E2E
`checkinsecurity` (incl. 390 px checks of the settings tab, Suspicious and the
evidence dialog) and every earlier suite; golden on an emptied ems_e2e.

## After the merge

- Neon must migrate (the five migrations above).
- Production: the camera header changes with the release; selfies need R2.
- Before go-live: import one real file from the client's machine and check the
  preview reads it.
