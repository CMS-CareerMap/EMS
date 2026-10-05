import { useState } from 'react'
import { MapPin, LocateFixed, Loader2, AlertCircle } from 'lucide-react'
import { useCompanySettings, useSaveCompany, useGeofences, useSaveGeofence } from '../../hooks/useSettings'
import DataState from '../../components/DataState'
import { Section, Field, SaveBar, inp, inpSm } from './ui'

/**
 * The Company tab.
 *
 * What was wrong with the version this replaces, each of which looked saved:
 *   · The time zone options had no values, so the LABEL was the value —
 *     "Asia/Kolkata (IST)" — and it was never sent anyway. The company's time
 *     zone decides which day "today" is for attendance and leave.
 *   · "Financial Year" was a dropdown nobody read. It is a payroll rule, and
 *     lives on the Payroll tab now, where it is saved.
 *   · The geofence radius was in KILOMETRES in steps of 100 m. The client asked
 *     for 15–30 m, which that box could not express. And the accuracy gate the
 *     client's fence depends on was not on the page at all.
 *   · Clearing the latitude saved 0 — a real point in the Atlantic.
 *   · The map promised a "manager override" that does not exist.
 */

/** IANA names as values; the label says the offset people know them by. */
const TIME_ZONES = [
  ['Asia/Kolkata', 'India — Asia/Kolkata (IST, UTC+5:30)'],
  ['Asia/Dubai', 'UAE — Asia/Dubai (UTC+4)'],
  ['Asia/Singapore', 'Singapore — Asia/Singapore (UTC+8)'],
  ['Europe/London', 'United Kingdom — Europe/London'],
  ['America/New_York', 'United States (Eastern) — America/New_York'],
  ['UTC', 'UTC'],
]

/** The three payslip formats the client asked for (§A1.5). */
const COUNTRIES = [['IN', 'India'], ['GB', 'United Kingdom'], ['US', 'United States']]
const CURRENCIES = [['INR', '₹ Indian Rupee'], ['GBP', '£ Pound Sterling'], ['USD', '$ US Dollar']]

const EMPTY_COMPANY = {
  name: '', legal_name: '', gstin: '', pan: '', address: '',
  city: '', state: '', pincode: '', phone: '', email: '', website: '',
  timezone: 'Asia/Kolkata', country: 'IN', currency: 'INR',
}

/** The client's fence is 15–30 m; 25 m is a starting point inside it. */
const EMPTY_GEOFENCE = { name: 'Head Office', latitude: '', longitude: '', radiusMeters: '25', maxAccuracyMeters: '50' }

const blank = (value) => (value === '' || value == null ? null : value)

export default function CompanySettings() {
  const company = useCompanySettings()
  const geofences = useGeofences()

  // The form only over what is stored. Drawn over a failed load, its blanks —
  // and an empty office location — would be what Save writes back.
  return (
    <DataState queries={[company, geofences]} loading="Loading company settings…">
      {([companyData, geofenceData]) => <CompanyForm company={companyData} geofences={geofenceData} />}
    </DataState>
  )
}

function CompanyForm({ company, geofences }) {
  const saveCompany = useSaveCompany()
  const saveGeofence = useSaveGeofence()

  const [saved, setSaved] = useState(false)
  const [problem, setProblem] = useState('')

  // Server values until somebody types; their edits after. Derived during
  // render, so a refetch never overwrites a half-typed field.
  const [companyDraft, setCompanyDraft] = useState(null)
  const form = companyDraft ?? { ...EMPTY_COMPANY, ...(company ?? {}) }

  const office = geofences?.[0]
  const [geoDraft, setGeoDraft] = useState(null)
  const geo = geoDraft ?? (office
    ? {
        name: office.name,
        latitude: String(office.latitude),
        longitude: String(office.longitude),
        radiusMeters: String(office.radius_meters),
        maxAccuracyMeters: String(office.max_accuracy_meters),
      }
    : EMPTY_GEOFENCE)

  const [locating, setLocating] = useState(false)
  const [geoMsg, setGeoMsg] = useState('')

  function set(key, value) {
    setCompanyDraft({ ...form, [key]: value })
    setSaved(false)
  }
  function setGeo(key, value) {
    setGeoDraft({ ...geo, [key]: value })
    setSaved(false)
  }

  function captureLocation() {
    if (!navigator.geolocation) {
      setGeoMsg('This browser cannot read a location.')
      return
    }
    setLocating(true)
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGeoDraft({
          ...geo,
          latitude: pos.coords.latitude.toFixed(6),
          longitude: pos.coords.longitude.toFixed(6),
        })
        // Said, because it matters: a desk reading can be tens of metres out,
        // and the fence is drawn around whatever was captured.
        setGeoMsg(`Captured, accurate to about ${Math.round(pos.coords.accuracy)} m. Capture it standing at the office entrance for the best result.`)
        setLocating(false)
      },
      (err) => {
        setGeoMsg(`Could not read your location: ${err.message}`)
        setLocating(false)
      },
      { enableHighAccuracy: true, timeout: 15 * 1000 },
    )
  }

  const geoTouched = geo.latitude !== '' || geo.longitude !== ''
  const lat = Number(geo.latitude)
  const lng = Number(geo.longitude)
  const geoValid = geo.latitude !== '' && geo.longitude !== '' && Number.isFinite(lat) && Number.isFinite(lng)

  async function handleSave() {
    setProblem('')
    if (geoTouched && !geoValid) {
      setProblem('Enter both the latitude and the longitude of the office, or leave both empty.')
      return
    }

    try {
      await saveCompany.mutateAsync({
        name: form.name,
        legalName: blank(form.legal_name),
        gstin: blank(form.gstin),
        pan: blank(form.pan),
        address: blank(form.address),
        city: blank(form.city),
        state: blank(form.state),
        pincode: blank(form.pincode),
        phone: blank(form.phone),
        email: blank(form.email),
        website: blank(form.website),
        timezone: form.timezone,
        country: form.country,
        currency: form.currency,
      })

      if (geoValid) {
        await saveGeofence.mutateAsync({
          name: geo.name.trim() || 'Head Office',
          latitude: lat,
          longitude: lng,
          radiusMeters: Math.round(Number(geo.radiusMeters)),
          maxAccuracyMeters: Math.round(Number(geo.maxAccuracyMeters)),
        })
      }
    } catch {
      // The app-wide toast has said what was refused; the drafts stay so
      // nothing typed is lost.
      return
    }

    // Back to the server's values, so what shows is what was stored.
    setCompanyDraft(null)
    setGeoDraft(null)
    setSaved(true)
  }

  const radius = Number(geo.radiusMeters) || 0

  return (
    <div className="space-y-6">
      <Section title="Company Identity" desc="Basic information about your organisation.">
        <Field label="Company Name" hint="Display name across the platform">
          <input className={inp} value={form.name ?? ''} onChange={(e) => set('name', e.target.value)} />
        </Field>
        <Field label="Legal Name" hint="As registered with authorities">
          <input className={inp} value={form.legal_name ?? ''} onChange={(e) => set('legal_name', e.target.value)} />
        </Field>
        <Field label="GSTIN">
          <input className={inp} value={form.gstin ?? ''} maxLength={15} onChange={(e) => set('gstin', e.target.value.toUpperCase())} />
        </Field>
        <Field label="PAN">
          <input className={inp} value={form.pan ?? ''} maxLength={10} onChange={(e) => set('pan', e.target.value.toUpperCase())} />
        </Field>
      </Section>

      <Section title="Address & Contact" desc="Registered office address and contact details.">
        <Field label="Address">
          <input className={inp} value={form.address ?? ''} onChange={(e) => set('address', e.target.value)} />
        </Field>
        <Field label="City / State / PIN">
          <div className="grid grid-cols-3 gap-2">
            <input className={inp} value={form.city ?? ''} onChange={(e) => set('city', e.target.value)} placeholder="City" />
            <input className={inp} value={form.state ?? ''} onChange={(e) => set('state', e.target.value)} placeholder="State" />
            <input className={inp} value={form.pincode ?? ''} onChange={(e) => set('pincode', e.target.value)} placeholder="PIN" />
          </div>
        </Field>
        <Field label="Phone">
          <input className={inp} value={form.phone ?? ''} onChange={(e) => set('phone', e.target.value)} />
        </Field>
        <Field label="HR Email">
          <input type="email" className={inp} value={form.email ?? ''} onChange={(e) => set('email', e.target.value)} />
        </Field>
        <Field label="Website">
          <input className={inp} value={form.website ?? ''} onChange={(e) => set('website', e.target.value)} />
        </Field>
      </Section>

      <Section title="Attendance Geofence" desc="Where the office is, and how close an app punch-in must be. Applies to employees on app attendance only.">
        <Field label="Office Name" hint="e.g. Head Office, BKC">
          <input className={inp} value={geo.name} onChange={(e) => setGeo('name', e.target.value)} />
        </Field>

        <Field label="Office Location" hint="Latitude and longitude of the entrance">
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <input type="number" step="0.000001" className={inp} value={geo.latitude} placeholder="Latitude, e.g. 19.065700"
                onChange={(e) => setGeo('latitude', e.target.value)} />
              <input type="number" step="0.000001" className={inp} value={geo.longitude} placeholder="Longitude, e.g. 72.868600"
                onChange={(e) => setGeo('longitude', e.target.value)} />
            </div>
            <button type="button" onClick={captureLocation} disabled={locating}
              className="px-3.5 py-2 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold flex items-center gap-1.5">
              {locating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <LocateFixed className="w-3.5 h-3.5 text-brand-400" />}
              {locating ? 'Reading location…' : 'Use my current location'}
            </button>
            {geoMsg && <p className="text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5">{geoMsg}</p>}
          </div>
        </Field>

        <Field label="Fence Radius" hint="How far from the office a punch-in is accepted. The client asked for 15–30 m.">
          <div className="flex items-center gap-2">
            <input type="number" min="10" max="50000" step="1" className={`${inpSm} w-28`} value={geo.radiusMeters}
              onChange={(e) => setGeo('radiusMeters', e.target.value)} />
            <span className="text-sm text-gray-600">metres</span>
          </div>
        </Field>

        <Field label="Location Accuracy Needed" hint="A reading vaguer than this is refused rather than guessed at — the person is asked to move near a window.">
          <div className="flex items-center gap-2">
            <input type="number" min="20" max="500" step="1" className={`${inpSm} w-28`} value={geo.maxAccuracyMeters}
              onChange={(e) => setGeo('maxAccuracyMeters', e.target.value)} />
            <span className="text-sm text-gray-600">metres</span>
          </div>
          {radius > 0 && radius < 50 && (
            <p className="text-xs text-amber-700 mt-2">
              A {radius} m fence is tighter than a phone can always measure indoors, so some people at their desks will be asked to try again.
              If that happens daily, widen the fence rather than loosening the accuracy.
            </p>
          )}
        </Field>

        {geoValid && (
          <div className="py-3">
            <div className="p-4 bg-slate-900 rounded-2xl text-white">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <MapPin className="w-4 h-4 text-red-400" />
                  <span className="font-semibold text-sm">{geo.name || 'Office'}</span>
                </div>
                <span className="text-xs font-mono text-brand-300">{lat.toFixed(6)}, {lng.toFixed(6)}</span>
              </div>
              <p className="text-xs text-slate-300 mt-2">
                App punch-ins are accepted within <strong className="text-white">{radius} m</strong> of this point, from a reading accurate to{' '}
                <strong className="text-white">{Number(geo.maxAccuracyMeters) || 0} m</strong> or better. Outside it, the punch-in is refused.
              </p>
            </div>
          </div>
        )}
      </Section>

      {/* No date format: it was saved and never used. Every screen shows dates one way, as "5 Oct 2026". */}
      <Section title="Regional Settings" desc="Time zone, and the country and currency payslips are shown in.">
        <Field label="Time Zone" hint="Decides which day 'today' is for attendance and leave">
          <select className={inp} value={form.timezone} onChange={(e) => set('timezone', e.target.value)}>
            {!TIME_ZONES.some(([value]) => value === form.timezone) && <option value={form.timezone}>{form.timezone}</option>}
            {TIME_ZONES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </Field>
        <Field label="Country" hint="Which payslip format is used">
          <select className={inp} value={form.country} onChange={(e) => set('country', e.target.value)}>
            {COUNTRIES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </Field>
        <Field label="Currency" hint="How amounts are shown. Statutory calculation stays India-only.">
          <select className={inp} value={form.currency} onChange={(e) => set('currency', e.target.value)}>
            {CURRENCIES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </Field>
      </Section>

      {problem && (
        <p className="flex items-start gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" /> {problem}
        </p>
      )}

      <SaveBar onSave={handleSave} saving={saveCompany.isPending || saveGeofence.isPending} saved={saved} />
    </div>
  )
}
