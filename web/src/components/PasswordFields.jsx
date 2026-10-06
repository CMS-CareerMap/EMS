import { useId, useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { field } from './ui/styles'

/**
 * A password typed for somebody else, twice (client, 6 Oct 2026): HR giving an
 * employee their first password, or setting a new one. Nothing is generated —
 * the person typing chooses it and tells them. Shown on request, so it can be
 * read back before it is passed on.
 *
 * Controlled: `value` is { password, again }; lib/logins `passwordPairProblem`
 * says what is wrong with it before the server is asked.
 */
export default function PasswordFields({ value, onChange, minLength, label = 'Password', autoFocus = false }) {
  const [shown, setShown] = useState(false)
  const id = useId()
  const inp = `w-full ${field} pr-10`
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <div className="space-y-1">
        <label htmlFor={`${id}-password`} className="block text-xs font-medium text-gray-600">{label}</label>
        <div className="relative">
          <input id={`${id}-password`} type={shown ? 'text' : 'password'} autoComplete="new-password" autoFocus={autoFocus}
            value={value.password} onChange={(e) => onChange({ ...value, password: e.target.value })} className={inp} />
          <button type="button" onClick={() => setShown(!shown)} aria-label={shown ? 'Hide the password' : 'Show the password'}
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded text-gray-400 hover:text-gray-600">
            {shown ? <EyeOff className="w-4 h-4" aria-hidden="true" /> : <Eye className="w-4 h-4" aria-hidden="true" />}
          </button>
        </div>
        <p className="text-[11px] text-gray-400">At least {minLength} characters.</p>
      </div>
      <div className="space-y-1">
        <label htmlFor={`${id}-again`} className="block text-xs font-medium text-gray-600">Type it again</label>
        <input id={`${id}-again`} type={shown ? 'text' : 'password'} autoComplete="new-password"
          value={value.again} onChange={(e) => onChange({ ...value, again: e.target.value })} className={`w-full ${field}`} />
      </div>
    </div>
  )
}
