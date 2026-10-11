import { useState } from 'react'
import { toast } from 'sonner'
import { MapPin, LocateFixed, Loader2, AlertCircle, Crosshair, CheckCircle2, XCircle, Info } from 'lucide-react'
import { useGeofences, useSaveGeofence, useTestGeofenceSpot, useAttendanceSecurity, useSaveAttendanceSecurity } from '../../hooks/useSettings'
import { useAuthStore } from '../../stores/authStore'
import { readLocationBurst, averageReadings } from '../../lib/location'
import DataState from '../../components/DataState'
import { Section, Field, SaveBar, Toggle, inp, inpSm } from './ui'

/**
 * Settings → Attendance Security (client, 11 Oct 2026): nobody marks attendance
 * from home. App check-ins — and check-outs, when the company says so — happen
 * inside the office, within 15–20 m. Every layer is the Super Admin's to turn
 * on or off; the whole flow follows.
 *
 * The office location moved here from the Company tab, with two things it
 * lacked: a capture over several readings (one reading is a guess), and a way
 * to try the fence where one stands before anybody punches.
 */

/** The client's limits (domain/attendance/geofence.ts FENCE_LIMITS). */
const RADIUS = { min: 15, max: 20 }
const ACCURACY = { min: 10, max: 20 }

const EMPTY_OFFICE = { name: 'Head Office', latitude: '', longitude: '', radiusMeters: String(RADIUS.max), maxAccuracyMeters: String(ACCURACY.max) }

export default function AttendanceSecurity() {
  const offices = useGeofences()
  const security = useAttendanceSecurity()
  return (
    <DataState queries={[offices, security]} loading="Loading attendance security…">
      {([officeData, securityData]) => <SecurityForm offices={officeData} security={securityData} />}
    </DataState>
  )
}

function SecurityForm({ offices, security }) {
  const canEdit = useAuthStore((state) => state.can('settings:update'))
  return (
    <div className="space-y-6">
      <div className="flex items-start gap-2 p-3 rounded-lg bg-sky-50 border border-sky-100 text-sm text-sky-900">
        <Info className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
        <p>
          A phone’s location is checked on the server, against the office below. A website cannot tell when a phone is using a
          fake-location app, so the layers here work together — and the fingerprint machine’s file confirms each office day.
        </p>
      </div>
      <OfficeLocation office={offices?.find((o) => o.is_active) ?? null} canEdit={canEdit} />
      <CheckOutLayer security={security} canEdit={canEdit} />
      <MachineLayer security={security} canEdit={canEdit} />
      <PhoneLayer security={security} canEdit={canEdit} />
      <SelfieLayer security={security} canEdit={canEdit} />
      <OnePhoneLayer security={security} canEdit={canEdit} />
    </div>
  )
}

/**
 * Layer 5 (client, 11 Oct 2026): a live photo from the front camera with every
 * app punch — so somebody punching from home shows the room behind them, and a
 * friend punching with somebody's password shows their own face.
 */
function SelfieLayer({ security, canEdit }) {
  const save = useSaveAttendanceSecurity()
  const [days, setDays] = useState(null)
  const shownDays = days ?? String(security.selfie_keep_days)
  const locked = !canEdit || save.isPending
  function saveDays() {
    const value = Number(shownDays)
    if (!Number.isInteger(value) || value < 7 || value > 365) {
      toast.error('Between 7 and 365 days.')
      return
    }
    if (value === security.selfie_keep_days) return
    save.mutate({ punchSelfieKeepDays: value }, { onSuccess: () => { setDays(null); toast.success(`Selfies are kept for ${value} days`) } })
  }
  return (
    <Section title="Selfie" desc="A live photo with every punch — never one from the gallery. Seen by HR and the person’s manager; tell the staff before turning it on.">
      <Field label="Selfie With Every Punch" hint="On: check-in and check-out ask for a photo from the front camera; without it the punch is not made.">
        <div className="flex items-center gap-3">
          <Toggle label="Selfie with every punch" checked={security.selfie} disabled={locked}
            onChange={(on) => save.mutate({ punchSelfie: on }, { onSuccess: () => toast.success(on ? 'Every punch now asks for a photo' : 'Punches no longer ask for a photo') })} />
          <span className="text-sm text-gray-700">{security.selfie ? 'On' : 'Off'}</span>
        </div>
      </Field>
      <Field label="Keep Selfies For" hint="Then the nightly job deletes them. 7 to 365 days.">
        <div className="flex items-center gap-2 flex-wrap">
          <input type="number" min="7" max="365" step="1" className={`${inpSm} w-24`} value={shownDays} aria-label="Days to keep selfies"
            onChange={(e) => setDays(e.target.value)} disabled={locked} />
          <span className="text-sm text-gray-600">days</span>
          {canEdit && days !== null && (
            <button type="button" onClick={saveDays} disabled={save.isPending} className="px-3 py-1.5 rounded-lg bg-slate-900 text-white text-xs font-semibold disabled:opacity-60">Save</button>
          )}
        </div>
      </Field>
    </Section>
  )
}

/**
 * Layer 6 (client, 11 Oct 2026): one phone per employee. The first phone is
 * theirs; another waits for HR (Attendance → Suspicious), so a password lent to
 * a friend does not lend the punch with it.
 */
function OnePhoneLayer({ security, canEdit }) {
  const save = useSaveAttendanceSecurity()
  return (
    <Section title="One Phone per Employee" desc="Punches only from the phone a person first punched from, or one HR approved since.">
      <Field label="One Phone per Employee" hint="On: a punch from another phone is refused and HR is asked to approve it (Attendance → Suspicious); approving it takes the old one off. Clearing the browser’s data, or a private window, looks like a new phone. Off: another phone is only flagged.">
        <div className="flex items-center gap-3">
          <Toggle label="One phone per employee" checked={security.one_device} disabled={!canEdit || save.isPending}
            onChange={(on) => save.mutate({ punchOneDevice: on }, { onSuccess: () => toast.success(on ? 'Each person punches from one phone' : 'Punches from another phone are only flagged') })} />
          <span className="text-sm text-gray-700">{security.one_device ? 'On' : 'Off'}</span>
        </div>
      </Field>
    </Section>
  )
}

/**
 * Layer 3 (client, 11 Oct 2026): a punch that needs the location, from a phone
 * only. A computer's browser can be told any location with its own developer
 * tools — no app needed — so that is the trick this stops. Off: a computer's
 * punch is let through and flagged for HR.
 */
function PhoneLayer({ security, canEdit }) {
  const save = useSaveAttendanceSecurity()
  return (
    <Section title="Phones Only" desc="Where the punch is made from.">
      <Field label="Phones Only" hint="On: an office-day check-in or check-out from a computer is refused. Off: it is allowed, and flagged for HR. Somebody determined can still make a computer look like a phone; the machine’s file and the flags catch what this does not.">
        <div className="flex items-center gap-3">
          <Toggle label="Phones only" checked={security.phone_only} disabled={!canEdit || save.isPending}
            onChange={(on) => save.mutate({ punchPhoneOnly: on }, { onSuccess: () => toast.success(on ? 'Punches from a computer are refused' : 'Punches from a computer are flagged for HR') })} />
          <span className="text-sm text-gray-700">{security.phone_only ? 'On' : 'Off'}</span>
        </div>
      </Field>
    </Section>
  )
}

/**
 * Layer 2 (client, 11 Oct 2026): the app's attendance stands at once; the
 * fingerprint machine's file, imported later, confirms it. Somebody who checked
 * in on the app from home has no finger on the machine that day.
 */
function MachineLayer({ security, canEdit }) {
  const save = useSaveAttendanceSecurity()
  const [minutes, setMinutes] = useState(null)
  const shownMinutes = minutes ?? String(security.machine_minutes)
  const on = security.machine_match
  const locked = !canEdit || save.isPending
  function change(body, said) {
    save.mutate(body, { onSuccess: () => toast.success(said) })
  }
  function saveMinutes() {
    const value = Number(shownMinutes)
    if (!Number.isInteger(value) || value < 5 || value > 240) {
      toast.error('Between 5 and 240 minutes.')
      return
    }
    if (value === security.machine_minutes) return
    save.mutate({ punchMachineMinutes: value }, { onSuccess: () => { setMinutes(null); toast.success(`The machine and the app may now differ by ${value} minutes`) } })
  }
  return (
    <Section title="Fingerprint Machine" desc="The app’s attendance stands at once; the machine’s file, imported later (Attendance → Import), confirms it.">
      <Field label="Confirm by the Fingerprint Machine" hint="On: an import keeps every day the app recorded and checks it against the machine’s scans. Off: an import writes the machine’s days, as before.">
        <div className="flex items-center gap-3">
          <Toggle label="Confirm by the fingerprint machine" checked={on} disabled={locked}
            onChange={(next) => change({ punchMachineMatch: next }, next ? 'App days are confirmed by the machine' : 'The machine’s file no longer confirms app days')} />
          <span className="text-sm text-gray-700">{on ? 'On' : 'Off'}</span>
        </div>
      </Field>
      <Field label="Minutes Allowed Apart" hint="The machine’s first scan may be this far from the app’s check-in (and its last from the check-out) and still confirm the day. Further apart is a note for HR — never absent.">
        <div className="flex items-center gap-2 flex-wrap">
          <input type="number" min="5" max="240" step="1" className={`${inpSm} w-24`} value={shownMinutes} aria-label="Minutes allowed apart"
            onChange={(e) => setMinutes(e.target.value)} disabled={locked || !on} />
          <span className="text-sm text-gray-600">minutes</span>
          {canEdit && on && minutes !== null && (
            <button type="button" onClick={saveMinutes} disabled={save.isPending} className="px-3 py-1.5 rounded-lg bg-slate-900 text-white text-xs font-semibold disabled:opacity-60">Save</button>
          )}
        </div>
      </Field>
      <Field label="Not on the Machine" hint="An app office day with no scan at all that day — the person checked in on the app and never touched the machine.">
        <select className={`${inpSm} w-full sm:w-auto`} value={security.machine_missing} aria-label="Not on the machine" disabled={locked || !on}
          onChange={(e) => change({ punchMachineMissing: e.target.value }, e.target.value === 'absent' ? 'Days not on the machine are made absent' : 'Days not on the machine are flagged for HR')}>
          <option value="flag">Flag it for HR — the day stands</option>
          <option value="absent">Mark the day absent — cut from pay, and the person told</option>
        </select>
      </Field>
      <Field label="Fill From the Machine" hint="A day with scans and no app punch — the phone forgotten — is written from the machine’s scans.">
        <div className="flex items-center gap-3">
          <Toggle label="Fill a day from the machine" checked={security.machine_fills} disabled={locked || !on}
            onChange={(next) => change({ punchMachineFills: next }, next ? 'Days with no app punch are filled from the machine' : 'Days with no app punch are left alone')} />
          <span className="text-sm text-gray-700">{security.machine_fills ? 'On' : 'Off'}</span>
        </div>
      </Field>
    </Section>
  )
}

function OfficeLocation({ office, canEdit }) {
  const save = useSaveGeofence()
  const testSpot = useTestGeofenceSpot()
  const [draft, setDraft] = useState(null)
  const geo = draft ?? (office
    ? {
        name: office.name,
        latitude: String(office.latitude),
        longitude: String(office.longitude),
        radiusMeters: String(office.radius_meters),
        maxAccuracyMeters: String(office.max_accuracy_meters),
      }
    : EMPTY_OFFICE)
  const [saved, setSaved] = useState(false)
  const [problem, setProblem] = useState('')
  const [capture, setCapture] = useState({ busy: false, message: '', failed: false })
  const [spot, setSpot] = useState({ busy: false, result: null, error: '' })

  function set(key, value) {
    setDraft({ ...geo, [key]: value })
    setSaved(false)
  }

  const lat = Number(geo.latitude)
  const lng = Number(geo.longitude)
  const radius = Number(geo.radiusMeters)
  const accuracy = Number(geo.maxAccuracyMeters)
  const pointValid = geo.latitude !== '' && geo.longitude !== '' && Number.isFinite(lat) && Number.isFinite(lng)

  // Where the office is, from ~10–20 s of readings averaged — a better centre than any one.
  async function captureHere() {
    setCapture({ busy: true, message: '', failed: false })
    try {
      const readings = await readLocationBurst({ target: 0, maxMs: 20_000 })
      const centre = averageReadings(readings)
      // Onto the form as it is now: a name or radius typed while it read is kept.
      setDraft((current) => ({ ...(current ?? geo), latitude: centre.latitude.toFixed(7), longitude: centre.longitude.toFixed(7) }))
      setSaved(false)
      setCapture({
        busy: false,
        message: `Captured from ${readings.length} reading${readings.length === 1 ? '' : 's'}, the best accurate to about ${Math.round(centre.accuracyMeters)} m. Stand in the middle of the hall for the best centre, then save.`,
        failed: false,
      })
    } catch (err) {
      setCapture({ busy: false, message: err.message, failed: true })
    }
  }

  async function handleSave() {
    setProblem('')
    if (!pointValid) return setProblem('Enter the latitude and the longitude of the office, or capture them standing there.')
    if (!Number.isInteger(radius) || radius < RADIUS.min || radius > RADIUS.max) return setProblem(`The radius is ${RADIUS.min} to ${RADIUS.max} m.`)
    if (!Number.isInteger(accuracy) || accuracy < ACCURACY.min || accuracy > ACCURACY.max) return setProblem(`The accuracy needed is ${ACCURACY.min} to ${ACCURACY.max} m.`)
    try {
      await save.mutateAsync({ name: geo.name.trim() || 'Head Office', latitude: lat, longitude: lng, radiusMeters: radius, maxAccuracyMeters: accuracy })
    } catch {
      return // the toast has said why; the draft stays
    }
    setDraft(null)
    setSaved(true)
  }

  // The fence tried where the Super Admin stands — the same rule and the same choice of reading as a punch.
  async function tryHere() {
    setSpot({ busy: true, result: null, error: '' })
    try {
      const readings = await readLocationBurst({ target: office?.max_accuracy_meters ?? ACCURACY.max })
      const result = await testSpot.mutateAsync(readings)
      setSpot({ busy: false, result, error: '' })
    } catch (err) {
      setSpot({ busy: false, result: null, error: err.message })
    }
  }

  return (
    <Section title="Office Location" desc="Where the office is. App check-ins on an office day — and check-outs, when checked below — must be inside it.">
      <Field label="Office Name" hint="e.g. Head Office">
        <input className={inp} value={geo.name} onChange={(e) => set('name', e.target.value)} disabled={!canEdit} />
      </Field>

      <Field label="Office Location" hint="Latitude and longitude of the middle of the office hall">
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <input type="number" step="0.0000001" className={inp} value={geo.latitude} placeholder="Latitude, e.g. 18.5590000" aria-label="Latitude"
              onChange={(e) => set('latitude', e.target.value)} disabled={!canEdit} />
            <input type="number" step="0.0000001" className={inp} value={geo.longitude} placeholder="Longitude, e.g. 73.7868000" aria-label="Longitude"
              onChange={(e) => set('longitude', e.target.value)} disabled={!canEdit} />
          </div>
          {canEdit && (
            <button type="button" onClick={captureHere} disabled={capture.busy}
              className="px-3.5 py-2 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold flex items-center gap-1.5 disabled:opacity-60">
              {capture.busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <LocateFixed className="w-3.5 h-3.5 text-brand-400" />}
              {capture.busy ? 'Reading the location — stay still…' : 'Capture where I stand (about 20 seconds)'}
            </button>
          )}
          {capture.message && (capture.failed
            ? <p role="alert" className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-1.5">{capture.message}</p>
            : <p role="status" className="text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5">{capture.message}</p>)}
        </div>
      </Field>

      <Field label="Radius" hint={`${RADIUS.min} to ${RADIUS.max} m from the office point. Never more is applied.`}>
        <div className="flex items-center gap-2">
          <input type="number" min={RADIUS.min} max={RADIUS.max} step="1" className={`${inpSm} w-28`} value={geo.radiusMeters} aria-label="Radius in metres"
            onChange={(e) => set('radiusMeters', e.target.value)} disabled={!canEdit} />
          <span className="text-sm text-gray-600">metres</span>
        </div>
      </Field>

      <Field label="Location Accuracy Needed" hint={`${ACCURACY.min} to ${ACCURACY.max} m. A reading vaguer than this is refused, and the person asked to move near a window.`}>
        <div className="flex items-center gap-2">
          <input type="number" min={ACCURACY.min} max={ACCURACY.max} step="1" className={`${inpSm} w-28`} value={geo.maxAccuracyMeters} aria-label="Accuracy needed in metres"
            onChange={(e) => set('maxAccuracyMeters', e.target.value)} disabled={!canEdit} />
          <span className="text-sm text-gray-600">metres</span>
        </div>
        <p className="text-xs text-amber-700 mt-2">
          Indoors a phone is often unsure by 10–30 m, so some people inside will now and then be asked to try again near a window.
        </p>
      </Field>

      {pointValid && (
        <div className="py-3">
          <div className="p-4 bg-slate-900 rounded-2xl text-white">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-2">
                <MapPin className="w-4 h-4 text-red-400" />
                <span className="font-semibold text-sm">{geo.name || 'Office'}</span>
              </div>
              <span className="text-xs font-mono text-brand-300">{lat.toFixed(6)}, {lng.toFixed(6)}</span>
            </div>
            <p className="text-xs text-slate-300 mt-2">
              App punches are accepted within <strong className="text-white">{Number.isFinite(radius) ? radius : '—'} m</strong> of this point, from a reading
              accurate to <strong className="text-white">{Number.isFinite(accuracy) ? accuracy : '—'} m</strong> or better. Anything else is refused.
            </p>
          </div>
        </div>
      )}

      {office && canEdit && (
        <Field label="Test This Spot" hint="Stand anywhere — a corner of the hall, the door, the car park — and see whether a punch there would be accepted.">
          <div className="space-y-2">
            {/* The test is against the office as saved — what punches are checked against — not the form. */}
            {draft !== null && <p className="text-xs text-amber-700">Save the changes first: the test checks against the saved office.</p>}
            <button type="button" onClick={tryHere} disabled={spot.busy || draft !== null}
              className="px-3.5 py-2 rounded-lg border border-gray-200 bg-white hover:bg-gray-50 text-gray-800 text-xs font-semibold flex items-center gap-1.5 disabled:opacity-60">
              {spot.busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Crosshair className="w-3.5 h-3.5 text-brand-600" />}
              {spot.busy ? 'Reading the location…' : 'Test where I stand'}
            </button>
            {spot.result && (
              <p role="status" className={`flex items-start gap-2 text-sm rounded-lg px-3 py-2 border ${spot.result.result === 'inside' ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-red-50 border-red-200 text-red-800'}`}>
                {spot.result.result === 'inside' ? <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" /> : <XCircle className="w-4 h-4 shrink-0 mt-0.5" />}
                <span>
                  {spot.result.distance_meters} m from the office, accurate to about {spot.result.accuracy_meters} m —{' '}
                  {spot.result.result === 'inside' ? 'a punch here would be accepted.' : `a punch here would be refused. ${spot.result.message}`}
                </span>
              </p>
            )}
            {spot.error && <p role="alert" className="text-xs text-red-700">{spot.error}</p>}
          </div>
        </Field>
      )}

      {problem && (
        <p className="flex items-start gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2 my-2">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" /> {problem}
        </p>
      )}
      {canEdit && <SaveBar onSave={handleSave} saving={save.isPending} saved={saved} />}
    </Section>
  )
}

/** A layer's switch is saved as it is turned, and the toast says so. */
function CheckOutLayer({ security, canEdit }) {
  const save = useSaveAttendanceSecurity()
  function change(body, said) {
    save.mutate(body, { onSuccess: () => toast.success(said) })
  }
  return (
    <Section title="Check-out" desc="Whether leaving is checked at the office too.">
      <Field label="Check Location at Check-out" hint="On: an office day’s check-out must be inside the office too. Somebody who has already left asks HR to record it.">
        <div className="flex items-center gap-3">
          <Toggle label="Check location at check-out" checked={security.check_out_location} disabled={!canEdit || save.isPending}
            onChange={(on) => change({ punchCheckOutLocation: on }, on ? 'Check-outs are checked at the office' : 'Check-outs are no longer checked')} />
          <span className="text-sm text-gray-700">{security.check_out_location ? 'On' : 'Off'}</span>
        </div>
      </Field>
    </Section>
  )
}
