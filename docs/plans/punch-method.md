# The punch method (client, 14 Oct 2026)

The client's first of three changes after go-live. Today, check-in on an office day **always** needs the office location. With no office saved, every punch is refused ("The office location is not set yet…"), even when the Super Admin has switched the selfie on and wants punching by selfie alone.

What the client asked for:

- **The punch follows whatever the Super Admin turns on.** Turn on Selfie and nothing else, and the punch is by selfie alone. No layer may be required that the Super Admin did not choose.
- **At least one way is always on**, so attendance is never unproved by mistake.
- **Location + Selfie** must take the location first. Without the location permission, there is no punch, whatever the photo.
- **Precise location only (client, 25 Oct 2026):** "ekdm strict rule rhe … current location hi uthaye … koyi approximate nahi". The phone's Approximate choice (Android, iPhone) cannot be hidden by a website, so a reading vaguer than the company's metres is refused: no camera, no punch, at check-in and at check-out. See "Precise location" below.
- **One phone per employee** works with whichever way is chosen, and only when it is switched on.
  - The first phone a person checks in from becomes theirs, by itself.
  - Any other phone is refused, and the person is told to contact HR.
  - HR, Admin or the Super Admin can **replace** the phone (the old one stops in the same step), so nobody is stuck.
  - Who may do this is a permission the Super Admin gives, never a role's name.
- **Nothing can be set wrong.** No setting may lock people out or weaken security without the Super Admin choosing it.

**Later the same day, after a demo:** the client has two or three warehouses.

- **Location + Selfie** must not need a saved office. It reads the person's *current* location wherever they stand, then takes the selfie, and keeps both. No office is checked.
- The office fence stays only in **Location**.
- HR sees the place on a map. A reading too vague to say where is flagged, not refused.
- Phones only, as for any punch that reads the location.

## As built

### Two settings

- **Attendance Method** (`Organization.punchMethod`):
  - It is a radio group, so exactly one method is always chosen, never none.
  - The three methods are `location`, `selfie` and `location_selfie`.
  - The default is `location`, as before.
  - The migration starts every company on `location`, keeping its office fence. A company that had the selfie on is not moved to `location_selfie`, which never checks the office; its Super Admin chooses a selfie method.
- **What each method needs** (`methodNeeds`):

  | Method | Reads the location | Checks the office fence | Takes a selfie |
  |---|---|---|---|
  | `location` | yes | yes | no |
  | `selfie` | no | no | yes |
  | `location_selfie` | yes | **no** | yes |

- **What Location + Selfie keeps:**
  - The location is read on every day, office or away.
  - It is stored on the day (`checkInLatitude`/`Longitude`, `geofenceVerified` null) and in the evidence (`fenceApplied` false).
  - Nothing is refused for where the person stands.
  - A reading vaguer than 100 m gets the new flag `location_vague` (migration `20261014173144_punch_location_vague`).
  - Evidence and Suspicious show "Taken at lat, lng · accurate to N m" and **Open map** (Google Maps, new tab).
- **One phone per employee** (`punchOneDevice`):
  - Off by default, as before.
  - When on, it works with whichever method is chosen.

### Fixed rules (no setting, so nothing to set wrong)

- **Check-out follows its day's method.** Check-out uses the method the day was checked in with (`Attendance.punchMethod`), and the company's method for a day the app did not begin.
  - If the day began by the fence and the office has since been removed, the company's method closes the day, which then cannot check the office.
  - So changing the method, or removing the office, never leaves a day nobody can close.
- **A punch that reads the location comes from a phone.** "Phones only" is no longer a switch.
- **With one phone on, every punch comes from a phone.** A computer is never registered as somebody's phone.
- **Location + Selfie reads the location first.** The page reads the location before it opens the camera; with no reading, the camera never opens. The server refuses a punch that lacks either.
- **The office comes first, for Location only.**
  - Location cannot be saved while no office is saved (409).
  - The active office cannot be removed or switched off while the method is Location (409).
  - Both take the same lock.
  - Location + Selfie needs no office.
- **Setup banner.** When the method is Location and no office is saved (a new company, or a company migrated that way), Settings and the home page tell whoever changes settings.
- **The refused-photo cap.** It applies only when the fence refuses after a photo is taken, and no method now takes both. It is kept for a future method that might.
- **Unchanged:** the server clock, the signed 120 s start token, evidence of every punch (refused ones too), and the 20 m fence.

### Phones (`punchDevices.service.ts`)

- **Registration.** A phone never seen registers itself when the person has no approved phone: their first phone, or the first after a reset.
  - A phone that was taken off comes back as **waiting**.
  - Any other phone waits too.
  - The people who may decide are told, with a link to the person's page.
- **Replace.** A waiting phone becomes theirs, and every other phone is taken off, in one transaction.
- **Reset.** Their phone is taken off, and the person is told. It is refused while another phone is waiting: that phone is replaced with, or refused, first. Otherwise a reset would promise a registration that does not happen.
- **Who may decide:** whoever holds the new permission **`user:device:manage`**.
  - It reaches through the **employee** scope (`reaches: 'employee'`), like the login permissions.
  - The migration gives it to the built-in Super Admin, HR and Admin roles only. A role the Super Admin made is not given it, because its employee reach may be wider than its attendance reach was.
  - A person's own phone, or a fellow phone-keeper's, goes up the tree (WorkKind `phone`).
  - A senior's phone is never decided by a junior (`checkPhoneWork`, `assertMayDecidePhone`).
- **Where.** On the person's page, Login(s) tab, in the **Punch phone** card (Admin has no Attendance pages). HR's Attendance → Suspicious list stays.
  - With one phone off, the card says any phone checks in and offers nothing.
  - While a phone is waiting, Reset is not offered.
- **Notices:**
  - `attendance.device_waiting` goes to the people who may decide;
  - `attendance.device_reset` goes to the person, but only while one phone is on.

### Rollback (expand and contract)

- The old columns stay for one release:
  - `punchCheckOutLocation`, `punchPhoneOnly` and `punchSelfie` are read by nothing new;
  - `punchSelfie` is still written in step with the method, so a rollback keeps the photo.
- Drop them in a later migration.
- On a rollback, a company that chose Selfie and removed its office would be fenced again with no office (the old code). Restore the office before rolling back.

### Live (v1.0 → this)

The method becomes Location for every company (a selfie switched on is not carried over: Location + Selfie never checks the office), and one phone stays off. Two switches become fixed rules, which only makes things stricter:

- **Check location at check-out:** if a company had it off, it is now always on.
- **Phones only:** the same.

Look at the live values before deploying.

## Tests

- **Server**, `attendance.test.ts` "the punch method":
  - Selfie with no office;
  - Location + Selfie at a warehouse 3 km out, with no office: no location or no photo is refused, both is taken and kept unfenced, and out the same way;
  - a vague reading is flagged, and shows on Suspicious with its coordinates;
  - an away day reads the location too;
  - a computer under Location;
  - check-out following the day's method, both ways round;
  - one phone with Selfie, and a computer refused;
  - a reset waiting while a phone waits;
  - the guard against removing the office, with a day closed by the company's method afterwards;
  - who may decide (Admin; not Manager; the power taken away and given) and the senior rule;
  - one phone off.
- **Server, elsewhere:** `settings.test.ts`, `punchMethod.test.ts`, and `catalogue.test.ts` (method and reset wording).
- **E2E** `punchmethod`, and the updated `checkinsecurity`. In `punchmethod`, Ravi checks in at a warehouse 3 km out with a vague reading; HR sees the flag, Open map and the evidence.

## Precise location (25 Oct 2026)

The client saw Android ask "Precise / Approximate" on the live site and asked that only the current, precise location be taken: at check-in, then the camera; at check-out the same.

- **What a website can do.** The Precise / Approximate choice is the phone's (Android 12+, iOS 14+) and cannot be hidden. Approximate gives a reading 1–3 km wide; a precise one indoors is usually 10–65 m (an iPhone indoors often reports 65 m). So the reading's own accuracy decides.
- **The rule.** Where a punch reads the location and does not judge it against the office — Location + Selfie, check-in and check-out, or a day away that asks for it — a reading vaguer than `Organization.punchPreciseMeters` (100 m to start, 20–500, Super Admin, Settings → Attendance Security → Precise Location) is refused. The Location method keeps its fence's own accuracy (20 m).
- **Order.** The page reads the location; a reading too vague and the camera does not open — the punch is sent without a photo, the server refuses it (`LOCATION_IMPRECISE`, 403, with the reading's accuracy and the limit) before it asks about the photo, and keeps the try as evidence (`refusedFor: unreliable`, the reading kept, no photo). The server refuses the same whatever the page does.
- **Said on the card**, not as a toast: the message and how to turn precise location on (Android: reset the site's permission and choose Precise, or the Chrome app's "Use precise location"; iPhone: Safari Websites → Precise Location). On a check-out, with the way to ask HR to record it.
- **Between 100 m and a higher limit** a Location + Selfie reading is taken and still flagged `location_vague` for HR (a day away under another method keeps it, unflagged). Whole metres throughout: 100.4 m is 100 m, on the page, the server and the evidence.
- **Kilometres out** (over 10 km — some phones on Approximate): the page keeps no such reading, and with none left says it is an approximate location, with the same help, rather than "move near a window". Until a reading as precise as the limit comes, the page keeps reading for its whole 10 seconds (a GPS warming up), not stopping at ten readings.
- **The iPhone help** names Safari (Safari Websites) and other browsers (their own Location setting).
- Migration `20261025181827_punch_precise_location` (every company starts at 100 m). Tests: `attendance.test.ts` (refused in and out, the edge 100/101 m, the setting and its bounds, evidence without the photo), E2E `punchmethod` (approximate refused with no camera and the help on the card; precise taken; check-out the same, with "Ask HR").

**"On time" (point 4 of the 25 Oct check-in audit).** The card said "on time" whenever lateness was not above zero — also when it was not measured: a check-in more than twelve hours from the shift's start (23:07 on a 09:30 shift) or with no shift at all. It now says "on time" only when lateness was measured as 0, "outside your shift hours" when a shift exists but the check-in was too far from it to measure, and nothing with no shift. E2E `livetime`.
