import { useState } from 'react'
import { toast } from 'sonner'
import { Section, Field, SaveBar, inp } from './ui'
import DataState from '../../components/DataState'
import { usePasswordRules, useSavePasswordRules } from '../../hooks/useUsers'

/**
 * Settings → Users & Roles → Passwords (client, 6 Oct 2026): who sets each
 * kind of login's password, and how long one must be. The client's choice is
 * the default: HR gives an employee their password, and the Super Admin a role
 * login's; neither can change their own. Either can be handed back to the
 * person, who then sets it from a link and may change it — without a code
 * change. A Super Admin's own password is always theirs. Shown to whoever
 * holds role:manage: the Super Admin alone.
 */
export default function PasswordRules() {
  const rules = usePasswordRules()
  return (
    <DataState query={rules}>
      {(data) => <Form data={data} />}
    </DataState>
  )
}

const MIN = 8
const MAX = 64

function Form({ data }) {
  const save = useSavePasswordRules()
  const [form, setForm] = useState(data)
  const [saved, setSaved] = useState(false)
  const changed = Object.keys(data).some((key) => form[key] !== data[key])
  const lengthOk = Number.isInteger(form.password_min_length) && form.password_min_length >= MIN && form.password_min_length <= MAX

  const set = (key, value) => {
    setForm({ ...form, [key]: value })
    setSaved(false)
  }

  async function handleSave() {
    const ok = await save.mutateAsync(form).then(() => true, () => false)
    if (ok) {
      setSaved(true)
      toast.success('Password rules saved')
    }
  }

  return (
    <div className="space-y-4">
      <Section title="Passwords" desc="Who sets the password of each kind of login, and how long a password must be. A Super Admin can always change their own.">
        <Field label="Employee logins" hint="The login for somebody’s own attendance, leave and payslips. Set by HR: HR types it when giving the login and sets a new one when asked — the employee cannot change it. Set by the employee: they get a link to choose their own, and change it whenever they like.">
          <select className={inp} value={form.employee_passwords} onChange={(e) => set('employee_passwords', e.target.value)} aria-label="Who sets employee logins’ passwords">
            <option value="company">Set by HR — the employee cannot change it</option>
            <option value="self">Set by the employee, from a link</option>
          </select>
        </Field>
        <Field label="Role logins" hint="Logins for a role’s work: HR, Accounts, a manager’s and the rest. Set by the Super Admin: nobody else sets it, and the person cannot change it. Set by the person: they get a link, and change it whenever they like.">
          <select className={inp} value={form.role_passwords} onChange={(e) => set('role_passwords', e.target.value)} aria-label="Who sets role logins’ passwords">
            <option value="company">Set by the Super Admin — the person cannot change it</option>
            <option value="self">Set by the person, from a link</option>
          </select>
        </Field>
        <Field label="Shortest password" hint={`At least this many characters, from ${MIN} to ${MAX}. Longer is safer: 10 is the default. A password already set stays until it is next changed.`}>
          <input type="number" min={MIN} max={MAX} className={inp} value={Number.isNaN(form.password_min_length) ? '' : form.password_min_length}
            onChange={(e) => set('password_min_length', e.target.value === '' ? Number.NaN : Number(e.target.value))}
            aria-label="Shortest password, in characters" />
          {!lengthOk && <p role="alert" className="text-xs text-red-600 mt-1">Between {MIN} and {MAX} characters.</p>}
        </Field>
      </Section>
      <SaveBar onSave={handleSave} saving={save.isPending} saved={saved && !changed} disabled={!changed || !lengthOk} />
    </div>
  )
}
