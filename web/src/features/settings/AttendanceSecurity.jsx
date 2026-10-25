import { useState } from 'react'
import { toast } from 'sonner'
import { MapPin, LocateFixed, Loader2, AlertCircle, Crosshair, CheckCircle2, XCircle, Info, Camera, ArrowRight, Smartphone } from 'lucide-react'
import { useGeofences, useSaveGeofence, useTestGeofenceSpot, useAttendanceSecurity, useSaveAttendanceSecurity } from '../../hooks/useSettings'
import { useAuthStore } from '../../stores/authStore'
import { readLocationBurst, averageReadings, isPhoneBrowser } from '../../lib/location'
import { PUNCH_METHODS } from '../../lib/attendance'
import DataState from '../../components/DataState'
import ConfirmDialog from '../../components/ConfirmDialog'
import { Chip } from '../../components/ui/bits'
import { Section, Field, SaveBar, Toggle, inp, inpSm } from './ui'
import AbsentRuleSection from './AbsentRuleSection'

/**
 * Settings → Attendance Security (client, 11 and 14 Oct 2026). The Super
 * Admin chooses how an app punch is proved — exactly one method, never none —
 * and whether each person punches from one phone; the whole punch follows,
 * nothing more and nothing less. Nothing here can be set so that nobody can
 * punch: a method that checks the office needs the office saved first, and
 * the office cannot be removed while it is in use (the server refuses both).
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
  const office = offices?.find((o) => o.is_active) ?? null
  const needsOffice = PUNCH_METHODS[security.method]?.needs.fence === true
  return (
    <div className="space-y-6">
      {needsOffice && !security.office_set && (
        <div role="alert" className="flex items-start gap-2 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-800">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
          <p>
            <b>Nobody can check in at the office yet:</b> the method checks the office location, and none is saved. Save it below under
            Office Location — or choose Selfie, or Location + Selfie, as the method.
          </p>
        </div>
      )}
      <div className="flex items-start gap-2 p-3 rounded-lg bg-sky-50 border border-sky-100 text-sm text-sky-900">
        <Info className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
        <p>
          Every punch is judged on the server. A website cannot tell when a phone is using a fake-location app, so the method, one phone
          and the fingerprint machine’s file work together.
        </p>
      </div>
      <MethodSection security={security} canEdit={canEdit} />
      <PreciseLocation security={security} canEdit={canEdit} />
      <AbsentRuleSection canEdit={canEdit} />
      <OnePhoneLayer security={security} canEdit={canEdit} />
      <OfficeLocation office={office} canEdit={canEdit} />
      <SelfieKeep security={security} canEdit={canEdit} />
      <MachineLayer security={security} canEdit={canEdit} />
    </div>
  )
}

/** "Inside the office → photo → punched", and from which phone — what a check-in asks for now. */
function FlowLine({ method, oneDevice }) {
  const steps = PUNCH_METHODS[method]?.steps ?? []
  return (
    <ol className="flex flex-wrap items-center gap-1.5 text-xs text-gray-700" aria-label="How a check-in works now">
      {steps.map((step, i) => (
        <li key={step.text} className="inline-flex items-center gap-1.5">
          {i > 0 && <ArrowRight className="w-3.5 h-3.5 text-gray-400" aria-hidden="true" />}
          <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-gray-100">
            {step.icon === 'location' ? <MapPin className="w-3.5 h-3.5 text-brand-600" aria-hidden="true" /> : <Camera className="w-3.5 h-3.5 text-brand-600" aria-hidden="true" />}
            {step.text}
          </span>
        </li>
      ))}
      <li className="inline-flex items-center gap-1.5">
        <ArrowRight className="w-3.5 h-3.5 text-gray-400" aria-hidden="true" />
        <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-emerald-50 text-emerald-800">
          <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />Checked in{oneDevice ? ', from their registered phone' : ''}
        </span>
      </li>
    </ol>
  )
}

/**
 * The punch method (client, 14 Oct 2026): exactly one — a radio, never empty.
 * A method that checks the office cannot be chosen until the office is saved.
 * Asked first, saying what a check-in will ask for from then on.
 */
function MethodSection({ security, canEdit }) {
  const save = useSaveAttendanceSecurity()
  const [asking, setAsking] = useState(null)
  const current = security.method
  // A radio group as a keyboard expects one: Tab stops on the chosen card only, the arrows move between them
  // (skipping one that cannot be chosen); Space or Enter asks to choose it.
  function onArrows(event) {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key]
    if (!step) return
    event.preventDefault()
    const cards = [...event.currentTarget.querySelectorAll('[role="radio"]:not([disabled])')]
    const at = cards.indexOf(document.activeElement)
    cards[(at + step + cards.length) % cards.length]?.focus()
  }
  return (
    <Section title="Attendance Method" desc="How a check-in and check-out on the app is proved. Exactly one is always chosen; a check-out is proved the way its day was checked in.">
      <div className="py-4 space-y-3">
        <div role="radiogroup" aria-label="Attendance method" onKeyDown={onArrows} className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {Object.entries(PUNCH_METHODS).map(([key, m]) => {
            const chosen = key === current
            const blocked = m.needs.fence && !security.office_set
            return (
              <button key={key} type="button" role="radio" aria-checked={chosen} tabIndex={chosen ? 0 : -1} disabled={!canEdit || save.isPending || (blocked && !chosen)}
                onClick={() => { if (!chosen) setAsking(key) }}
                className={`text-left rounded-xl border p-3 space-y-1.5 transition-colors disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500
                  ${chosen ? 'border-brand-500 bg-brand-50 ring-1 ring-brand-500' : 'border-gray-200 bg-white hover:bg-gray-50 disabled:hover:bg-white disabled:opacity-60'}`}>
                <span className="flex items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-1.5 text-sm font-bold text-gray-900">
                    {m.needs.location && <MapPin className="w-4 h-4 text-brand-600" aria-hidden="true" />}
                    {m.needs.selfie && <Camera className="w-4 h-4 text-brand-600" aria-hidden="true" />}
                    {m.label}
                  </span>
                  <Chip tone={m.strength.tone}>{m.strength.label}</Chip>
                </span>
                <span className="block text-xs text-gray-600">{m.said}</span>
                {blocked && <span className="block text-xs font-medium text-amber-700">Save the office location first (below).</span>}
                {chosen && <span className="block text-xs font-semibold text-brand-700">Chosen</span>}
              </button>
            )
          })}
        </div>
        <FlowLine method={current} oneDevice={security.one_device} />
      </div>
      {asking && (
        <ConfirmDialog
          title={`Change the method to ${PUNCH_METHODS[asking].label}?`}
          confirmLabel={`Use ${PUNCH_METHODS[asking].label}`}
          onConfirm={() => save.mutateAsync({ punchMethod: asking }).then(() => toast.success(`Check-ins now use ${PUNCH_METHODS[asking].label}`))}
          onClose={() => setAsking(null)}
        >
          <p>From now on, a check-in asks for:</p>
          <ol className="list-decimal pl-5 space-y-0.5">
            {PUNCH_METHODS[asking].steps.map((s) => <li key={s.text}>{s.text}</li>)}
            {security.one_device && <li>From the person’s registered phone</li>}
          </ol>
          <p>Anybody already checked in today checks out the way their day began.</p>
          {PUNCH_METHODS[asking].needs.selfie && <p>Tell the staff before it starts: the photos are seen by HR and the person’s manager.</p>}
        </ConfirmDialog>
      )}
    </Section>
  )
}

/**
 * One phone per employee (client, 11 and 14 Oct 2026), with whichever method:
 * the first phone a person punches from is theirs; another is refused, and
 * whoever may replace phones is told — on the person's page, Logins: Replace
 * (the new phone on, the old off, in one step) or Reset (the next new phone
 * becomes theirs).
 */
function OnePhoneLayer({ security, canEdit }) {
  const save = useSaveAttendanceSecurity()
  return (
    <Section title="One Phone per Employee" desc="Works with the method above.">
      <Field label="One Phone per Employee" hint="On: the first phone a person checks in from is theirs, by itself. A punch from any other phone is refused — they are told to contact HR, and HR is told. On the person’s page, under Punch phone, Replace makes the new phone theirs and takes the old one off in one step; Reset lets the next new phone they use become theirs. Clearing the browser’s data, or a private window, counts as a new phone. Off: another phone is only flagged.">
        <div className="flex items-center gap-3">
          <Smartphone className="w-4 h-4 text-gray-500" aria-hidden="true" />
          <Toggle label="One phone per employee" checked={security.one_device} disabled={!canEdit || save.isPending}
            onChange={(on) => save.mutate({ punchOneDevice: on }, { onSuccess: () => toast.success(on ? 'Each person punches from one phone' : 'Punches from another phone are only flagged') })} />
          <span className="text-sm text-gray-700">{security.one_device ? 'On' : 'Off'}</span>
        </div>
      </Field>
    </Section>
  )
}

/**
 * Precise location only (client, 25 Oct 2026): where a punch reads the location and does not judge
 * it against the office — Location + Selfie, or a day away that asks for it — the vaguest reading taken.
 */
function PreciseLocation({ security, canEdit }) {
  const save = useSaveAttendanceSecurity()
  const [metres, setMetres] = useState(null)
  const shown = metres ?? String(security.precise_meters)
  const locked = !canEdit || save.isPending
  function saveMetres() {
    const value = Number(shown)
    if (!Number.isInteger(value) || value < 20 || value > 500) {
      toast.error('Between 20 and 500 metres.')
      return
    }
    // The figure already saved, typed again: nothing to save, and no Save left showing.
    if (value === security.precise_meters) {
      setMetres(null)
      return
    }
    save.mutate({ punchPreciseMeters: value }, { onSuccess: () => { setMetres(null); toast.success(`Locations up to ${value} m are taken`) } })
  }
  return (
    <Section title="Precise Location" desc="Where a punch reads the location without checking it against the office — Location + Selfie, or a day away that asks for it — only a precise one is taken. A phone set to “Approximate” gives 1–3 km: it is refused, no camera opens, and the person is told how to turn precise location on.">
      <Field label="Most Vague Location Taken" hint="Precise locations indoors are usually 10–65 m. 20 to 500 m.">
        <div className="flex items-center gap-2 flex-wrap">
          <input type="number" min="20" max="500" step="1" className={`${inpSm} w-24`} value={shown} aria-label="Most vague location taken, in metres"
            onChange={(e) => setMetres(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && metres !== null) saveMetres() }} disabled={locked} />
          <span className="text-sm text-gray-600">metres</span>
          {canEdit && metres !== null && (
            <button type="button" onClick={saveMetres} disabled={save.isPending} className="px-3 py-1.5 rounded-lg bg-slate-900 text-white text-xs font-semibold disabled:opacity-60">Save</button>
          )}
        </div>
      </Field>
    </Section>
  )
}

/** How long a punch's selfie is kept — those taken while the method had one, too. */
function SelfieKeep({ security, canEdit }) {
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
    <Section title="Selfies" desc="A live photo from the front camera, never one from the gallery — taken when the method has a selfie. Seen by HR and the person’s manager.">
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

  // Where the office is, from ~10–20 s of readings averaged — a better centre than any one. On a phone only,
  // and only from readings as precise as a punch needs: a centre in the wrong place refuses everybody (14 Oct 2026).
  async function captureHere() {
    if (!isPhoneBrowser()) {
      setCapture({ busy: false, message: 'Capture the office from a phone, standing in the middle of the hall: a computer has no GPS, and its location can be tens of metres out. Or type the point in.', failed: true })
      return
    }
    setCapture({ busy: true, message: '', failed: false })
    try {
      const readings = await readLocationBurst({ target: 0, maxMs: 20_000 })
      const centre = averageReadings(readings)
      if (centre.accuracyMeters > ACCURACY.max) {
        setCapture({
          busy: false,
          message: `The best reading was accurate to only about ${Math.round(centre.accuracyMeters)} m; ${ACCURACY.max} m or better is needed for the office’s point. Stand in the middle of the hall — near a window if you can — wait a few seconds, and capture again.`,
          failed: true,
        })
        return
      }
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
    <Section title="Office Location" desc="Where the office is. Needed for the Location method: a check-in on an office day — and its check-out — must be inside it. Location + Selfie needs none.">
      <Field label="Office Name" hint="e.g. Head Office">
        <input className={inp} value={geo.name} onChange={(e) => set('name', e.target.value)} disabled={!canEdit} />
      </Field>

      <Field label="Office Location" hint="Latitude and longitude of the middle of the office hall — captured on a phone standing there, or typed in">
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
