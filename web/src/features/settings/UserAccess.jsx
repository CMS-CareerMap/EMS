import { useRef, useState } from 'react'
import { Copy, Check, KeyRound, Loader2, UserPlus, X } from 'lucide-react'
import { useInviteUser } from '../../hooks/useUsers'
import { useInvitableRoles } from '../../hooks/useRoles'
import { formatInstant } from '../../lib/dates'
import { optionsNote } from '../../lib/optionsNote'

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

const inp = 'w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-gray-900 placeholder:text-gray-400'


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
    <div className="border border-blue-200 bg-blue-50 rounded-xl p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          <KeyRound className="w-4 h-4 text-blue-600 mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-semibold text-blue-900">
              {isReset ? 'Password reset link' : 'Invitation link'} for {email}
            </p>
            <p className="text-xs text-blue-700 mt-0.5">
              No email is sent. Share this link with them yourself. It works once, expires{' '}
              {formatExpiry(invite.expires_at)}, and will not be shown again.
              {isReset && ' When they use it, they are signed out everywhere else.'}
            </p>
          </div>
        </div>
        <button onClick={onDone} className="p-1 rounded text-blue-400 hover:text-blue-700" title="Close">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex items-center gap-2">
        <input
          ref={inputRef}
          readOnly
          value={url}
          onFocus={(e) => e.target.select()}
          className="flex-1 min-w-0 font-mono text-xs bg-white border border-blue-200 rounded-lg px-3 py-2 text-gray-700"
        />
        <button
          onClick={copy}
          className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold shrink-0"
        >
          {copied ? <><Check className="w-3.5 h-3.5" /> Copied</> : <><Copy className="w-3.5 h-3.5" /> Copy</>}
        </button>
      </div>
      {copyFailed && (
        <p className="text-xs text-blue-700">Copying was blocked by the browser — the link is selected, press Ctrl+C.</p>
      )}
    </div>
  )
}

/** Invites somebody by email and reports the link it produced. */
export function InviteUserForm({ onInvited, onCancel }) {
  const invite = useInviteUser()
  const { query: rolesQuery, roles } = useInvitableRoles()
  const [form, setForm] = useState({ email: '', full_name: '', role: '', employee_code: '' })
  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }))
  // Until somebody picks, the Employee role if it may be given, else the first.
  const role = form.role || (roles.some((r) => r.key === 'employee') ? 'employee' : roles[0]?.key ?? '')

  async function handleSubmit(e) {
    e.preventDefault()
    // A failure is already shown by the app-wide error toast; the form simply
    // stays open with what was typed, so it can be corrected.
    const result = await invite.mutateAsync({
      email: form.email.trim(),
      role,
      full_name: form.full_name.trim(),
      employee_code: form.employee_code.trim(),
    }).catch(() => null)

    if (result) onInvited({ email: result.user.email, invite: result.invite })
  }

  return (
    <form onSubmit={handleSubmit} className="border border-gray-200 rounded-xl p-4 space-y-4 bg-gray-50">
      <div className="flex items-center gap-2">
        <UserPlus className="w-4 h-4 text-blue-600" />
        <p className="text-sm font-semibold text-gray-900">Invite a user</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="space-y-1">
          <label className="text-xs font-medium text-gray-600">Work email</label>
          <input type="email" required value={form.email} onChange={(e) => set('email', e.target.value)}
            placeholder="name@company.in" className={inp} />
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium text-gray-600">Full name</label>
          <input value={form.full_name} onChange={(e) => set('full_name', e.target.value)}
            placeholder="Optional" className={inp} />
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium text-gray-600">Role</label>
          <select value={role} onChange={(e) => set('role', e.target.value)} disabled={!rolesQuery.isSuccess || roles.length === 0}
            className={`${inp} bg-white`}>
            {rolesQuery.isSuccess && roles.length > 0
              ? roles.map((r) => <option key={r.key} value={r.key}>{r.name}</option>)
              : <option value="">{optionsNote(rolesQuery, 'No role you may give')}</option>}
          </select>
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium text-gray-600">Employee code</label>
          <input value={form.employee_code} onChange={(e) => set('employee_code', e.target.value)}
            placeholder="Optional — also creates their HR record" className={inp} />
        </div>
      </div>

      <div className="flex items-center justify-end gap-2">
        <button type="button" onClick={onCancel}
          className="px-4 py-2 rounded-lg text-sm font-medium text-gray-600 hover:bg-gray-100">
          Cancel
        </button>
        <button type="submit" disabled={invite.isPending || !role}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white text-sm font-semibold">
          {invite.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserPlus className="w-4 h-4" />}
          Create invitation
        </button>
      </div>
    </form>
  )
}
