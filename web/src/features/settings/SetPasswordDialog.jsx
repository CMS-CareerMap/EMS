import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import Dialog from '../../components/Dialog'
import PasswordFields from '../../components/PasswordFields'
import { btn } from '../../components/ui/styles'
import { useSetPassword } from '../../hooks/useUsers'
import { useAuthStore } from '../../stores/authStore'
import { loginName, passwordPairProblem } from '../../lib/logins'

/**
 * Setting somebody's password for them (client, 6 Oct 2026): HR an employee
 * login's, the Super Admin anybody's. Whoever sets it tells the person — it
 * is not shown again, nor sent anywhere. Everything signed in with the old one
 * is signed out, and the person is told in the app.
 *
 * `idOpensIt`: whether their Employee ID signs in to this login — their
 * employee login, or their only one. `yours`: a Super Admin setting the
 * password of their own employee login.
 */
export default function SetPasswordDialog({ login, personName, employeeCode, idOpensIt = false, yours = false, onClose }) {
  const minLength = useAuthStore((state) => state.passwords.rules.passwordMinLength)
  const setPassword = useSetPassword()
  const [value, setValue] = useState({ password: '', again: '' })
  const [problem, setProblem] = useState('')
  const name = loginName(login, employeeCode)
  const first = login.has_password === false

  async function submit(e) {
    e.preventDefault()
    const wrong = passwordPairProblem(value, minLength)
    setProblem(wrong)
    if (wrong) return
    // A refusal is shown by the app-wide toast; the dialog stays with what was typed.
    const done = await setPassword.mutateAsync({ user_id: login.id, password: value.password }).catch(() => null)
    if (!done) return
    toast.success(yours
      ? `${first ? 'Password set' : 'New password set'} for your ${name} login.`
      : `${first ? 'Password set' : 'New password set'} for ${personName || name}. Tell them yourself — it is not shown again.`)
    onClose()
  }

  const strong = (text) => <strong className="font-semibold text-gray-900">{text}</strong>
  const orId = login.email && employeeCode && idOpensIt ? <> or {yours ? 'your' : 'their'} Employee ID {strong(employeeCode)}</> : null

  return (
    <Dialog title={yours ? `Set a new password for your ${name} login` : `${first ? 'Set the password' : 'Set a new password'} for ${personName || name}`}
      onClose={setPassword.isPending ? () => {} : onClose}>
      <form onSubmit={submit} className="space-y-4" aria-label="Set a password">
        <p className="text-sm text-gray-600">
          {yours ? 'You sign in to it with ' : 'They sign in with '}{strong(name)}{orId} and this password.
          {first ? (yours ? ' It works as soon as it is set.' : ' Their login works as soon as it is set.')
            : yours ? ' Every device signed in to it with the old password is signed out.'
              : ' Every device signed in with the old password is signed out, and they are told in the app.'}
        </p>
        <PasswordFields value={value} onChange={(next) => { setValue(next); setProblem('') }} minLength={minLength} label="New password" autoFocus />
        {problem && <p role="alert" className="text-sm text-red-600">{problem}</p>}
        <p className="text-xs text-gray-500">
          {yours ? 'It is not shown again, and nobody can read it afterwards.' : 'Tell them the password yourself. It is not shown again, and nobody can read it afterwards — not even the Super Admin.'}
        </p>
        <div className="flex flex-wrap justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} disabled={setPassword.isPending} className={btn.secondary}>Cancel</button>
          <button type="submit" disabled={setPassword.isPending} className={btn.primary}>
            {setPassword.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />} Set password
          </button>
        </div>
      </form>
    </Dialog>
  )
}
