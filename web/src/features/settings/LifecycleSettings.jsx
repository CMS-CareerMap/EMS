import { useState } from 'react'
import { toast } from 'sonner'
import { Section, Field, SaveBar, inpSm } from './ui'
import { useAuthStore } from '../../stores/authStore'
import { useLifecycleSettings, useSaveLifecycleSettings } from '../../hooks/useLifecycle'
import DataState from '../../components/DataState'

/**
 * The employee lifecycle's two company rules (client §43): how long probation
 * runs for a new joiner, and the notice a resignation asks for when it names
 * no last day. HR reads them; Settings changes them.
 */
export default function LifecycleSettings() {
  const query = useLifecycleSettings()
  return (
    <DataState query={query}>
      {(data) => <Form data={data} />}
    </DataState>
  )
}

function Form({ data }) {
  const canEdit = useAuthStore((s) => s.can('settings:update'))
  const save = useSaveLifecycleSettings()
  const [months, setMonths] = useState(String(data.probation_months))
  const [days, setDays] = useState(String(data.notice_period_days))
  const [saved, setSaved] = useState(false)

  const valid = /^\d+$/.test(months) && Number(months) <= 24 && /^\d+$/.test(days) && Number(days) <= 180
  const changed = Number(months) !== data.probation_months || Number(days) !== data.notice_period_days

  async function submit() {
    const ok = await save.mutateAsync({ probationMonths: Number(months), noticePeriodDays: Number(days) }).then(() => true, () => false)
    if (ok) {
      setSaved(true)
      toast.success('Lifecycle rules saved')
    }
  }

  return (
    <div className="space-y-6">
      <Section title="Employee lifecycle" desc="Joining soon → onboarding → probation → confirmed → resigned → serving notice → exit. HR takes each step from the employee's profile.">
        <Field label="Probation" hint="For a new joiner, counted from the joining date. Changing it does not move anybody's probation already set; HR extends or confirms each person.">
          <div className="flex items-center gap-2">
            <input className={`${inpSm} w-24`} type="number" min={0} max={24} value={months} disabled={!canEdit}
              onChange={(e) => { setMonths(e.target.value); setSaved(false) }} aria-label="Probation in months" />
            <span className="text-sm text-gray-600">months (0 to 24)</span>
          </div>
        </Field>
        <Field label="Notice period" hint="The last working day a resignation asks for when it names none: this many days after it is handed in. The person accepting it sets the real day.">
          <div className="flex items-center gap-2">
            <input className={`${inpSm} w-24`} type="number" min={0} max={180} value={days} disabled={!canEdit}
              onChange={(e) => { setDays(e.target.value); setSaved(false) }} aria-label="Notice period in days" />
            <span className="text-sm text-gray-600">days (0 to 180)</span>
          </div>
        </Field>
        {!valid && <p className="text-xs text-red-600 pb-3">Probation is 0 to 24 whole months; the notice period 0 to 180 whole days.</p>}
      </Section>
      {canEdit ? (
        <SaveBar onSave={submit} saving={save.isPending} saved={saved && !changed} disabled={!valid || !changed} />
      ) : (
        <p className="text-xs text-gray-500">Set by the Super Admin.</p>
      )}
    </div>
  )
}
