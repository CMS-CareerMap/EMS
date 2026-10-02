import { useState } from 'react'
import { KeyRound, Loader2, Plus, X } from 'lucide-react'
import { useAuthStore } from '../../stores/authStore'
import { useAddLogin, useIssuePasswordLink, useToggleUserStatus } from '../../hooks/useUsers'
import { useAssignableRoles } from '../../hooks/useRoles'
import { PasswordLinkPanel } from '../settings/UserAccess'
import { roleLabel } from '../../lib/roles'
import { optionsNote } from '../../lib/optionsNote'

/**
 * Somebody's logins, on their page (Day 23).
 *
 * A person who holds a role has two: an employee login for their own things
 * and a role login for the role's work, each with its own email and password.
 * Both are the same person — the same record, the same place in the company
 * tree — so their own items go up the tree from either, and leaving closes
 * both.
 *
 * The Super Admin adds a login here, never as a new person. Turning one off
 * leaves the other as it is. No button is drawn on your own logins, or on a
 * login whose role is not one you could give: the server refuses both — and
 * refuses acting on any login of somebody whose other login is above you.
 */

const ACCOUNT = { active: 'Can sign in', invited: 'Invited — has not set a password', inactive: 'Turned off' }
const inp = 'w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-gray-900 placeholder:text-gray-400 bg-white'

export default function EmployeeLogins({ employee }) {
  const can = useAuthStore((state) => state.can)
  const myPersonId = useAuthStore((state) => state.profile?.id ?? null)
  const left = Boolean(employee.archived_at)
  const mayAdd = can('role:manage') && !left
  const mayToggle = can('user:status:update') && !left
  const mayLink = can('user:invite') && !left
  const assignable = useAssignableRoles({ enabled: mayAdd || mayToggle || mayLink })
  const toggle = useToggleUserStatus()
  const issueLink = useIssuePasswordLink()
  const [adding, setAdding] = useState(false)
  const [issued, setIssued] = useState(null)

  const logins = employee.logins ?? []
  const mine = employee.id === myPersonId
  const below = (role) => assignable.isSuccess && assignable.data.some((r) => r.key === role)
  // Acting on one login is acting on the person: every login of theirs must be one you could give.
  const manageable = !mine && logins.every((l) => below(l.role))

  async function newLink(login) {
    const result = await issueLink.mutateAsync({ user_id: login.id }).catch(() => null)
    if (result) setIssued({ email: result.user.email, invite: result.invite })
  }

  return (
    <div className="space-y-3">
      {issued && <PasswordLinkPanel email={issued.email} invite={issued.invite} onDone={() => setIssued(null)} />}

      {logins.length === 0 ? (
        <p className="text-sm text-gray-500 bg-slate-50 border border-slate-200 rounded-xl p-4">No login — they cannot sign in.</p>
      ) : (
        <ul className="rounded-xl border border-slate-200 divide-y divide-slate-100" aria-label="Logins">
          {logins.map((login) => (
            <li key={login.id} className="flex items-center gap-3 px-3 py-2.5">
              <div className="w-8 h-8 rounded-lg bg-gray-100 flex items-center justify-center shrink-0">
                <KeyRound className="w-4 h-4 text-gray-500" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-gray-900 truncate" title={login.email}>{login.email}</p>
                <p className="text-xs text-gray-500">{ACCOUNT[login.status] ?? login.status} · {roleLabel(login.role, login.role_name)}</p>
              </div>
              {/* The first link was lost, or ran out: the invitation again, from here. */}
              {mayLink && manageable && login.status === 'invited' && (
                <button type="button" onClick={() => newLink(login)} disabled={issueLink.isPending}
                  aria-label={`New invitation link for ${login.email}`}
                  className="shrink-0 px-2.5 py-1 rounded-lg text-xs font-semibold border border-blue-200 text-blue-700 hover:bg-blue-50 disabled:opacity-50">
                  New link
                </button>
              )}
              {mayToggle && manageable && login.status !== 'invited' && (
                <button
                  type="button"
                  onClick={() => toggle.mutate({ user_id: login.id, currentStatus: login.status })}
                  disabled={toggle.isPending}
                  aria-label={`${login.status === 'active' ? 'Turn off' : 'Turn on'} ${login.email}`}
                  className={`shrink-0 px-2.5 py-1 rounded-lg text-xs font-semibold border transition-colors disabled:opacity-50
                    ${login.status === 'active' ? 'border-amber-200 text-amber-700 hover:bg-amber-50' : 'border-emerald-200 text-emerald-700 hover:bg-emerald-50'}`}
                >
                  {login.status === 'active' ? 'Turn off' : 'Turn on'}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {logins.length > 1 && (
        <p className="text-xs text-gray-500">
          One person, {logins.length} logins. Each has its own email and password. Their own leave, salary and other items go to the person above them from every login, and leaving the company closes them all. They sign in with the email of the login they want — their Employee ID no longer chooses one.
        </p>
      )}

      {/* Their own too: a Super Admin with one login adds the employee login beside it. */}
      {mayAdd && (adding ? (
        <AddLoginForm
          employee={employee}
          assignable={assignable}
          onCancel={() => setAdding(false)}
          onAdded={(result) => { setAdding(false); setIssued({ email: result.user.email, invite: result.invite }) }}
        />
      ) : (
        <button type="button" onClick={() => setAdding(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-50 hover:bg-blue-100 text-blue-600 text-sm font-medium">
          <Plus className="w-3.5 h-3.5" /> {logins.length > 0 ? 'Add another login' : 'Add login'}
        </button>
      ))}
    </div>
  )
}

/** Another login: its own email, and a role the person does not hold yet. */
function AddLoginForm({ employee, assignable, onCancel, onAdded }) {
  const add = useAddLogin()
  const held = new Set((employee.logins ?? []).map((l) => l.role))
  const roles = assignable.isSuccess ? assignable.data.filter((r) => !held.has(r.key)) : []
  const [email, setEmail] = useState('')
  // The Employee role when they have no employee login yet; otherwise a choice
  // somebody makes, never one picked for them.
  const [role, setRole] = useState(() => (held.has('employee') ? '' : 'employee'))
  const chosen = roles.some((r) => r.key === role) ? role : ''
  const top = roles.find((r) => r.key === chosen)?.locked

  async function submit(e) {
    e.preventDefault()
    // A refusal is shown by the app-wide toast; the form stays with what was typed.
    const result = await add.mutateAsync({ employee_id: employee.id, email: email.trim(), role: chosen }).catch(() => null)
    if (result) onAdded(result)
  }

  return (
    <form onSubmit={submit} className="border border-gray-200 rounded-xl p-3 space-y-3 bg-gray-50" aria-label="Add a login">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-gray-900">A new login for {employee.full_name}</p>
          <p className="text-xs text-gray-500 mt-0.5">With its own email and password — for example an HR login beside their employee login. They get a link to set its password.</p>
        </div>
        <button type="button" onClick={onCancel} className="p-1 rounded text-gray-400 hover:text-gray-600" aria-label="Cancel">
          <X className="w-4 h-4" />
        </button>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <label className="space-y-1">
          <span className="text-xs font-medium text-gray-600">Email for this login</span>
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name.role@company.in" className={inp} />
        </label>
        <label className="space-y-1">
          <span className="text-xs font-medium text-gray-600">Role</span>
          <select value={chosen} onChange={(e) => setRole(e.target.value)} disabled={roles.length === 0} required className={inp}>
            <option value="" disabled>
              {roles.length > 0 ? 'Choose a role' : assignable.isSuccess ? 'They already hold every role you can give' : optionsNote(assignable, '')}
            </option>
            {roles.map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}
          </select>
        </label>
      </div>
      {top && (
        <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          This login will hold the Super Admin panel: everything, including users, roles and approving the payroll.
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="px-3 py-1.5 rounded-lg border border-gray-300 text-sm text-gray-700 hover:bg-white">Cancel</button>
        <button type="submit" disabled={add.isPending || !chosen}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold disabled:opacity-50">
          {add.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Add login
        </button>
      </div>
    </form>
  )
}
