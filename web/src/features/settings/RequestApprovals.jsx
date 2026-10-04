import { useState } from 'react'
import { toast } from 'sonner'
import { Section, Field, SaveBar, Toggle, inp } from './ui'
import DataState from '../../components/DataState'
import { useRequestRules, useSaveRequestRules } from '../../hooks/useRequests'

/**
 * Who decides each kind of request (client §28–29), beside the leave settings
 * on the Approvals tab: the person somebody reports to, as with leave — or HR,
 * whoever does that kind of work. And whether working from home still needs a
 * location reading at check-in (client §32). The Super Admin's.
 */
export default function RequestApprovals() {
  const rules = useRequestRules()
  return (
    <DataState query={rules}>
      {(data) => <Form data={data} />}
    </DataState>
  )
}

const KINDS = [
  ['correction_approver', 'Attendance corrections', 'HR means whoever corrects attendance.'],
  ['wfh_approver', 'Work from home and on duty', 'HR means whoever keeps attendance.'],
  ['overtime_approver', 'Overtime', 'HR means whoever keeps attendance.'],
  ['profile_approver', 'Profile changes', 'HR means whoever keeps employee records. The client asked for HR here.'],
  ['encashment_approver', 'Leave encashment', 'HR means whoever keeps leave balances.'],
]

function Form({ data }) {
  const save = useSaveRequestRules()
  const [form, setForm] = useState(data)
  const [saved, setSaved] = useState(false)
  const changed = Object.keys(data).some((key) => form[key] !== data[key])

  const set = (key, value) => {
    setForm({ ...form, [key]: value })
    setSaved(false)
  }

  async function handleSave() {
    const ok = await save
      .mutateAsync({
        correctionApprover: form.correction_approver,
        wfhApprover: form.wfh_approver,
        overtimeApprover: form.overtime_approver,
        profileApprover: form.profile_approver,
        encashmentApprover: form.encashment_approver,
        wfhGpsRequired: form.wfh_gps_required,
      })
      .then(() => true, () => false)
    if (ok) {
      setSaved(true)
      toast.success('Request settings saved')
    }
  }

  return (
    <div className="space-y-4">
      <Section title="Other requests" desc="Who decides each kind of request an employee sends. One level only: whoever it goes to approves or rejects, and that is the end of it. Nobody decides their own.">
        {KINDS.map(([key, label, hint]) => (
          <Field key={key} label={label} hint={hint}>
            <select className={inp} value={form[key]} onChange={(e) => set(key, e.target.value)} aria-label={`Who decides ${label.toLowerCase()}`}>
              <option value="manager">The person they report to (as with leave)</option>
              <option value="hr">HR</option>
            </select>
          </Field>
        ))}
        <Field label="Location when away" hint="On: somebody working from home or on duty still gives a location reading at check-in (not checked against the office). Off: the approved request is enough.">
          <Toggle checked={form.wfh_gps_required} onChange={(v) => set('wfh_gps_required', v)} label="Ask for a location when working from home or on duty" />
        </Field>
      </Section>
      <SaveBar onSave={handleSave} saving={save.isPending} saved={saved && !changed} disabled={!changed} />
    </div>
  )
}
