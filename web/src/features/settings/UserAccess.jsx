import { btn } from '../../components/ui/styles'
import { useRef, useState } from 'react'
import { Copy, Check, KeyRound, Loader2, UserPlus, X } from 'lucide-react'
import { useInviteUser } from '../../hooks/useUsers'
import { useInvitableRoles } from '../../hooks/useRoles'
import { useAuthStore } from '../../stores/authStore'
import PasswordFields from '../../components/PasswordFields'
import { formatInstant } from '../../lib/dates'
import { optionsNote } from '../../lib/optionsNote'
import { maySetPasswordOf, passwordPairProblem, passwordSetBy, passwordSetterName } from '../../lib/logins'

/**
 * Inviting somebody, and handing them their link.
 *
 * The server has issued single-use links since the invite endpoint was built —
 * and this page threw every one of them away, so an administrator could create
 * an account that nobody could ever open. This is where the link is shown.
 *
 * There is no email in v1. The panel says so, instead of implying a message
 * went out: the administrator copies the link and sends it themselves.
 */

const inp = 'w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent text-gray-900 placeholder:text-gray-400'


/**
 * The link goes in the URL fragment — after the `#` — which browsers never
 * send to a server. So it stays out of access logs and Referer headers, and
 * the set-password page reads it from there.
 */
function linkFor(token) {
  return `${window.location.origin}/set-password#token=${encodeURIComponent(token)}`
}

/** When a link stops working — on this device's clock, where the person reading it is. */
function formatExpiry(iso) {
  return formatInstant(iso)
}

/** Shows a freshly issued link, once. */
export function PasswordLinkPanel({ email, invite, onDone }) {
  const inputRef = useRef(null)
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)
  const url = linkFor(invite.token)
  const isReset = invite.purpose === 'reset'

  async function copy() {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setCopyFailed(false)
    } catch {
      // The clipboard API needs a secure page. Where it is refused, select the
      // text so a plain Ctrl+C still works, and say that.
      inputRef.current?.select()
      setCopyFailed(true)
    }
  }

  return (
    <div className="border border-brand-200 bg-brand-50 rounded-xl p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          <KeyRound className="w-4 h-4 text-brand-600 mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-semibold text-brand-900">
              {isReset ? 'Password reset link' : 'Invitation link'} for {email}
            </p>
            <p className="text-xs text-brand-700 mt-0.5">
              No email is sent. Share this link with them yourself. It works once, expires{' '}
              {formatExpiry(invite.expires_at)}, and will not be shown again.
              {isReset && ' When they use it, they are signed out everywhere else.'}
            </p>
          </div>
        </div>
        <button onClick={onDone} className="p-1 rounded text-brand-400 hover:text-brand-700" title="Close" aria-label="Close the link">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex items-center gap-2">
        <input
          ref={inputRef}
          aria-label={`${isReset ? 'Password reset' : 'Invitation'} link for ${email}`}
          readOnly
          value={url}
          onFocus={(e) => e.target.select()}
          className="flex-1 min-w-0 font-mono text-xs bg-white border border-brand-200 rounded-lg px-3 py-2 text-gray-700"
        />
        <button
          onClick={copy}
          className={`${btn.primarySm} shrink-0`}
        >
          {copied ? <><Check className="w-3.5 h-3.5" /> Copied</> : <><Copy className="w-3.5 h-3.5" /> Copy</>}
        </button>
      </div>
      {copyFailed && (
        <p className="text-xs text-brand-700">Copying was blocked by the browser — the link is selected, press Ctrl+C.</p>
      )}
    </div>
  )
}

/**
 * Adds somebody's login, and reports how it started (client, 6 Oct 2026):
 * with the password typed here, where the company sets this kind of login's
 * and this person may set it; with a link, where the person sets their own;
 * or waiting for its password. The raw result goes back to the page.
 */
export function InviteUserForm({ onInvited, onCancel }) {
  const invite = useInviteUser()
  const { query: rolesQuery, roles } = useInvitableRoles()
  const rules = useAuthStore((state) => state.passwords.rules)
  const isSuperAdmin = useAuthStore((state) => state.can('role:manage'))
  const holdsPasswords = useAuthStore((state) => state.can('user:password:set'))
  const [form, setForm] = useState({ email: '', full_name: '', role: '', employee_code: '' })
  const [pair, setPair] = useState({ password: '', again: '' })
  const [problem, setProblem] = useState('')
  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }))
  // Until somebody picks, the Employee role if it may be given, else the first.
  const role = form.role || (roles.some((r) => r.key === 'employee') ? 'employee' : roles[0]?.key ?? '')
  const chosen = roles.find((r) => r.key === role)
  const kind = chosen ? chosen.login_kind : null
  const typed = kind !== null && passwordSetBy(kind, rules) === 'company' && maySetPasswordOf(kind, { isSuperAdmin, holds: holdsPasswords })
  // An employee login made with an employee record signs in with its Employee ID.
  const emailOptional = kind === 'employee' && form.employee_code.trim() !== ''

  async function handleSubmit(e) {
    e.preventDefault()
    if (typed) {
      const wrong = passwordPairProblem(pair, rules.passwordMinLength)
      setProblem(wrong)
      if (wrong) return
    }
    // A failure is already shown by the app-wide error toast; the form simply
    // stays open with what was typed, so it can be corrected.
    const result = await invite.mutateAsync({
      email: form.email.trim(),
      role,
      full_name: form.full_name.trim(),
      employee_code: form.employee_code.trim(),
      ...(typed ? { password: pair.password } : {}),
    }).catch(() => null)

    if (result) onInvited(result)
  }

  return (
    <form onSubmit={handleSubmit} className="border border-gray-200 rounded-xl p-4 space-y-4 bg-gray-50">
      <div className="flex items-center gap-2">
        <UserPlus className="w-4 h-4 text-brand-600" />
        <p className="text-sm font-semibold text-gray-900">Add a user</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="space-y-1">
          <label htmlFor="invite-email" className="text-xs font-medium text-gray-600">{emailOptional ? 'Work email (optional)' : 'Work email'}</label>
          <input id="invite-email" type="email" required={!emailOptional} value={form.email} onChange={(e) => set('email', e.target.value)}
            placeholder={emailOptional ? 'Leave empty to use the employee code' : 'name@company.in'} className={inp} />
        </div>
        <div className="space-y-1">
          <label htmlFor="invite-name" className="text-xs font-medium text-gray-600">Full name</label>
          <input id="invite-name" value={form.full_name} onChange={(e) => set('full_name', e.target.value)}
            placeholder="Optional" className={inp} />
        </div>
        <div className="space-y-1">
          <label htmlFor="invite-role" className="text-xs font-medium text-gray-600">Role</label>
          <select id="invite-role" value={role} onChange={(e) => set('role', e.target.value)} disabled={!rolesQuery.isSuccess || roles.length === 0}
            className={`${inp} bg-white`}>
            {rolesQuery.isSuccess && roles.length > 0
              ? roles.map((r) => <option key={r.key} value={r.key}>{r.name}</option>)
              : <option value="">{optionsNote(rolesQuery, 'No role you may give')}</option>}
          </select>
        </div>
        <div className="space-y-1">
          <label htmlFor="invite-code" className="text-xs font-medium text-gray-600">Employee code</label>
          <input id="invite-code" value={form.employee_code} onChange={(e) => set('employee_code', e.target.value)}
            placeholder="Optional — also creates their HR record" className={inp} />
        </div>
      </div>

      {typed && (
        <>
          <PasswordFields value={pair} onChange={(next) => { setPair(next); setProblem('') }} minLength={rules.passwordMinLength} />
          {problem && <p role="alert" className="text-sm text-red-600">{problem}</p>}
        </>
      )}
      {kind !== null && !typed && (
        <p className="text-xs text-gray-500">
          {passwordSetBy(kind, rules) === 'self'
            ? 'They get a link to set their own password.'
            : `The login waits for its password — ${passwordSetterName(kind)} sets it.`}
        </p>
      )}

      {/* A login invited without an employee code belongs to no person (an
          operator), so it sits outside the company tree and the rule that one's
          own work goes up. Somebody already on the staff gets theirs on their page. */}
      <p className="text-xs text-gray-500">
        Already an employee? Give them their login on their page instead (Employees → their name → Logins), so it is the same person.
        Without an employee code this login belongs to nobody on the staff.
      </p>

      <div className="flex flex-wrap items-center justify-end gap-2">
        <button type="button" onClick={onCancel}
          className="px-4 py-2 rounded-lg text-sm font-medium text-gray-600 hover:bg-gray-100">
          Cancel
        </button>
        <button type="submit" disabled={invite.isPending || !role}
          className={btn.primary}>
          {invite.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserPlus className="w-4 h-4" />}
          {kind !== null && passwordSetBy(kind, rules) === 'self' ? 'Create invitation' : 'Add login'}
        </button>
      </div>
    </form>
  )
}
