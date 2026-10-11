import { useState } from 'react'
import { Link } from 'react-router-dom'
import { MapPin } from 'lucide-react'
import { useCompanySettings, useSaveCompany } from '../../hooks/useSettings'
import DataState from '../../components/DataState'
import { Section, Field, SaveBar, inp } from './ui'

/**
 * The Company tab.
 *
 * What was wrong with the version this replaces, each of which looked saved:
 *   · The time zone options had no values, so the LABEL was the value —
 *     "Asia/Kolkata (IST)" — and it was never sent anyway. The company's time
 *     zone decides which day "today" is for attendance and leave.
 *   · "Financial Year" was a dropdown nobody read. It is a payroll rule, and
 *     lives on the Payroll tab now, where it is saved.
 *
 * The office location was here; it is on Settings → Attendance Security now,
 * with every other layer of check-in security (client, 11 Oct 2026).
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

const blank = (value) => (value === '' || value == null ? null : value)

export default function CompanySettings() {
  const company = useCompanySettings()

  // The form only over what is stored. Drawn over a failed load, its blanks
  // would be what Save writes back.
  return (
    <DataState query={company} loading="Loading company settings…">
      {(companyData) => <CompanyForm company={companyData} />}
    </DataState>
  )
}

function CompanyForm({ company }) {
  const saveCompany = useSaveCompany()

  const [saved, setSaved] = useState(false)

  // Server values until somebody types; their edits after. Derived during
  // render, so a refetch never overwrites a half-typed field.
  const [companyDraft, setCompanyDraft] = useState(null)
  const form = companyDraft ?? { ...EMPTY_COMPANY, ...(company ?? {}) }

  function set(key, value) {
    setCompanyDraft({ ...form, [key]: value })
    setSaved(false)
  }

  async function handleSave() {
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
    } catch {
      // The app-wide toast has said what was refused; the drafts stay so
      // nothing typed is lost.
      return
    }

    // Back to the server's values, so what shows is what was stored.
    setCompanyDraft(null)
    setSaved(true)
  }

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

      <p className="flex items-center gap-2 text-sm text-gray-600 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
        <MapPin className="w-4 h-4 text-gray-400 shrink-0" aria-hidden="true" />
        <span>The office location is on <Link to="/settings?tab=attendance-security" className="font-semibold text-brand-700 underline">Attendance Security</Link>, with the other check-in rules.</span>
      </p>

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

      <SaveBar onSave={handleSave} saving={saveCompany.isPending} saved={saved} />
    </div>
  )
}
