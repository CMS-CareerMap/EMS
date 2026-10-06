import { useState } from 'react'
import { KeyRound, Loader2, Plus, X } from 'lucide-react'
import { toast } from 'sonner'
import { useAuthStore } from '../../stores/authStore'
import { useAddLogin, useIssuePasswordLink, useToggleUserStatus, useWithdrawInvitation } from '../../hooks/useUsers'
import { useAssignableRoles } from '../../hooks/useRoles'
import { PasswordLinkPanel } from '../settings/UserAccess'
import SetPasswordDialog from '../settings/SetPasswordDialog'
import ConfirmDialog from '../../components/ConfirmDialog'
import PasswordFields from '../../components/PasswordFields'
import { IconBox } from '../../components/ui/bits'
import { btn, field } from '../../components/ui/styles'
import { roleLabel } from '../../lib/roles'
import { optionsNote } from '../../lib/optionsNote'
import { loginName, loginStatusWords, maySetPasswordOf, passwordPairProblem, passwordSetBy, passwordSetterName } from '../../lib/logins'

/**
 * Somebody's logins, on their page (Day 23).
 *
 * A person who holds a role has two: an employee login for their own things
 * and a role login for the role's work, each with its own password. Both are
 * the same person — the same record, the same place in the company tree — so
 * their own items go up the tree from either, and leaving closes both.
 *
 * Passwords (client, 6 Oct 2026): where the company sets them, HR gives an
 * employee their login with a password and sets a new one when asked; a role
 * login's is the Super Admin's to set. An employee login needs no email — the
 * person signs in with their Employee ID. Where people set their own, a login
 * starts with a link, as before.
 *
 * The Super Admin adds any login here, never as a new person; HR adds the
 * employee login. Turning one off leaves the other as it is. No button is
 * drawn on your own logins, or on a login whose role is not one you could
 * give: the server refuses both — and refuses acting on any login of somebody
 * whose other login is above you.
 */

const inp = `w-full ${field}`


export default function EmployeeLogins({ employee }) {
  const can = useAuthStore((state) => state.can)
  const rules = useAuthStore((state) => state.passwords.rules)
  const myPersonId = useAuthStore((state) => state.profile?.id ?? null)
  const left = Boolean(employee.archived_at)
  const isSuperAdmin = can('role:manage')
  const holdsPasswords = can('user:password:set')
  const logins = employee.logins ?? []
  const mine = employee.id === myPersonId
  // The Super Admin adds any login; HR the employee login, to somebody who has none — never to themselves.
  const offersAdd = !left && (isSuperAdmin || (holdsPasswords && !mine && !logins.some((l) => l.login_kind === 'employee')))
  const mayToggle = can('user:status:update') && !left
  const mayLink = can('user:invite') && !left
  const assignable = useAssignableRoles({ enabled: offersAdd || mayToggle || mayLink || holdsPasswords })
  const toggle = useToggleUserStatus()
  const issueLink = useIssuePasswordLink()
  const withdraw = useWithdrawInvitation()
  const [adding, setAdding] = useState(false)
  const [issued, setIssued] = useState(null)
  const [settingFor, setSettingFor] = useState(null)
  // Asked once more: turning a login off signs it out everywhere, and taking
  // back an invitation deletes the login.
  const [turningOff, setTurningOff] = useState(null)
  const [withdrawing, setWithdrawing] = useState(null)

  const below = (role) => assignable.isSuccess && assignable.data.some((r) => r.key === role)
  // Acting on one login is acting on the person: every login of theirs must be one you could give.
  const manageable = !mine && logins.every((l) => below(l.role))
  // HR adds one only where it could act on the person afterwards: the server refuses somebody with a login above HR.
  const mayAdd = offersAdd && (isSuperAdmin || manageable)
  const nameOf = (login) => loginName(login, employee.employee_id)
  // The Employee ID opens this login: it is their employee login, or their only one.
  const idOpens = (login) => login.login_kind === 'employee' || logins.length === 1

  async function newLink(login) {
    const result = await issueLink.mutateAsync({ user_id: login.id }).catch(() => null)
    if (result) setIssued({ email: nameOf(result.user), invite: result.invite })
  }

  function added(result) {
    setAdding(false)
    const who = nameOf(result.user)
    if (result.login_start === 'link') setIssued({ email: who, invite: result.invite })
    else if (result.login_start === 'password') toast.success(`Login ready: ${employee.full_name} signs in with ${who} and the password you set. Tell them the password yourself.`)
    else toast.success(`Login added. It waits for its password — ${passwordSetterName(result.user.login_kind)} sets it here.`)
  }

  return (
    <div className="space-y-3">
      {issued && <PasswordLinkPanel email={issued.email} invite={issued.invite} onDone={() => setIssued(null)} />}

      {logins.length === 0 ? (
        <p className="text-sm text-gray-500 bg-gray-50 border border-gray-200 rounded-xl p-4">No login — they cannot sign in.</p>
      ) : (
        <ul className="rounded-xl border border-gray-200 divide-y divide-gray-100" aria-label="Logins">
          {logins.map((login) => {
            const own = passwordSetBy(login.login_kind, rules)
            // A Super Admin's passwords are all their own: the one of their employee
            // login is theirs to set, from the Super Admin login they are using.
            const ownOther = mine && isSuperAdmin && login.login_kind !== 'super_admin'
            const maySet = login.status !== 'inactive' &&
              (ownOther || (manageable && own === 'company' && maySetPasswordOf(login.login_kind, { isSuperAdmin, holds: holdsPasswords })))
            return (
              <li key={login.id} className="flex flex-wrap sm:flex-nowrap items-center gap-3 px-3 py-2.5">
                <IconBox icon={KeyRound} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-gray-900 truncate" title={nameOf(login)}>{nameOf(login)}</p>
                  <p className="text-xs text-gray-500">{loginStatusWords(login, rules)} · {roleLabel(login.role, login.role_name)}</p>
                </div>
                {/* The company sets this password: HR an employee login's, the Super Admin a role login's. */}
                {maySet && (
                  <button type="button" onClick={() => setSettingFor(login)}
                    aria-label={`${login.has_password ? 'Set a new password for' : 'Set the password for'} ${nameOf(login)}`}
                    className={`shrink-0 ${login.has_password ? btn.secondarySm : btn.softSm}`}>
                    {login.has_password ? 'Set new password' : 'Set password'}
                  </button>
                )}
                {/* The person sets their own: the first link was lost, or ran out — the invitation again, from here. */}
                {mayLink && manageable && own === 'self' && login.status === 'invited' && (
                  <button type="button" onClick={() => newLink(login)} disabled={issueLink.isPending}
                    aria-label={`New invitation link for ${nameOf(login)}`}
                    className={`shrink-0 ${btn.softSm}`}>
                    New link
                  </button>
                )}
                {/* A mistyped address, or the wrong person, is taken back, so the right login can be added. */}
                {mayLink && manageable && login.status === 'invited' && (
                  <button type="button" onClick={() => setWithdrawing(login)} disabled={withdraw.isPending}
                    aria-label={`Withdraw the login ${nameOf(login)}`}
                    className={`shrink-0 ${btn.dangerSm}`}>
                    Withdraw
                  </button>
                )}
                {mayToggle && manageable && login.status !== 'invited' && (
                  <button
                    type="button"
                    onClick={() => (login.status === 'active' ? setTurningOff(login) : toggle.mutate({ user_id: login.id, currentStatus: login.status }))}
                    disabled={toggle.isPending}
                    aria-label={`${login.status === 'active' ? 'Turn off' : 'Turn on'} ${nameOf(login)}`}
                    className={`shrink-0 ${login.status === 'active' ? btn.secondarySm : btn.okSm}`}
                  >
                    {login.status === 'active' ? 'Turn off' : 'Turn on'}
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {logins.length > 1 && (
        <p className="text-xs text-gray-500">
          One person, {logins.length} logins, each with its own password. Their own leave, salary and other items go to the person above them from every login, and leaving the company closes them all. Their Employee ID opens the employee login; every other login signs in with its own email.
        </p>
      )}

      {/* Their own too: a Super Admin with one login adds the employee login beside it. */}
      {mayAdd && (adding ? (
        <AddLoginForm
          employee={employee}
          assignable={assignable}
          employeeOnly={!isSuperAdmin}
          onCancel={() => setAdding(false)}
          onAdded={added}
        />
      ) : (
        <button type="button" onClick={() => setAdding(true)} className={btn.soft}>
          <Plus className="w-4 h-4" aria-hidden="true" /> {logins.length > 0 ? 'Add another login' : 'Add login'}
        </button>
      ))}

      {settingFor && (
        <SetPasswordDialog login={settingFor} personName={employee.full_name} employeeCode={employee.employee_id}
          idOpensIt={idOpens(settingFor)} yours={mine} onClose={() => setSettingFor(null)} />
      )}
      {turningOff && (
        <ConfirmDialog title={`Turn off ${nameOf(turningOff)}?`} confirmLabel="Turn off" danger
          onConfirm={() => toggle.mutateAsync({ user_id: turningOff.id, currentStatus: turningOff.status })}
          onClose={() => setTurningOff(null)}>
          <p>It is signed out everywhere at once and cannot sign in until it is turned back on.</p>
          {logins.length > 1 && <p>Their other login keeps working.</p>}
        </ConfirmDialog>
      )}
      {withdrawing && (
        <ConfirmDialog title={`Withdraw the login ${nameOf(withdrawing)}?`} confirmLabel="Withdraw" danger
          onConfirm={() => withdraw.mutateAsync({ user_id: withdrawing.id })}
          onClose={() => setWithdrawing(null)}>
          <p>It has never been used. It is taken away — any link with it stops working — so the right one can be added in its place.</p>
        </ConfirmDialog>
      )}
    </div>
  )
}

/**
 * A login for somebody already here: a role they do not hold yet — only the
 * Employee role, for HR — its email (optional for an employee login, which
 * signs in with the Employee ID), and its password where the company sets it
 * and this person may set it.
 */
function AddLoginForm({ employee, assignable, employeeOnly, onCancel, onAdded }) {
  const add = useAddLogin()
  const rules = useAuthStore((state) => state.passwords.rules)
  const isSuperAdmin = useAuthStore((state) => state.can('role:manage'))
  const holdsPasswords = useAuthStore((state) => state.can('user:password:set'))
  const held = new Set((employee.logins ?? []).map((l) => l.role))
  const roles = assignable.isSuccess
    ? assignable.data.filter((r) => !held.has(r.key) && (!employeeOnly || r.login_kind === 'employee'))
    : []
  const [email, setEmail] = useState('')
  // The Employee role when they have no employee login yet; otherwise a choice
  // somebody makes, never one picked for them.
  const [role, setRole] = useState(() => (held.has('employee') ? '' : 'employee'))
  const [pair, setPair] = useState({ password: '', again: '' })
  const [problem, setProblem] = useState('')
  const chosen = roles.find((r) => r.key === role) ?? null
  const kind = chosen ? chosen.login_kind : null
  // A password is typed here only where the company sets it and this person may.
  const typed = kind !== null && passwordSetBy(kind, rules) === 'company' && maySetPasswordOf(kind, { isSuperAdmin, holds: holdsPasswords })
  const emailOptional = kind === 'employee'

  async function submit(e) {
    e.preventDefault()
    if (typed) {
      const wrong = passwordPairProblem(pair, rules.passwordMinLength)
      setProblem(wrong)
      if (wrong) return
    }
    // A refusal is shown by the app-wide toast; the form stays with what was typed.
    const result = await add.mutateAsync({
      employee_id: employee.id,
      email: email.trim(),
      role: chosen.key,
      ...(typed ? { password: pair.password } : {}),
    }).catch(() => null)
    if (result) onAdded(result)
  }

  return (
    <form onSubmit={submit} className="border border-brand-100 rounded-xl p-4 space-y-3 bg-brand-50/40" aria-label="Add a login">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-gray-900">A login for {employee.full_name}</p>
          <p className="text-xs text-gray-500 mt-0.5">
            {kind === null ? 'Choose its role.'
              : typed ? `It works as soon as it is added, with the password you set here. ${emailOptional ? `Without an email they sign in with their Employee ID${employee.employee_id ? ` (${employee.employee_id})` : ''}.` : ''}`
                : passwordSetBy(kind, rules) === 'self' ? 'They get a link to set its password.'
                  : `It waits for its password — ${passwordSetterName(kind)} sets it.`}
          </p>
        </div>
        <button type="button" onClick={onCancel} className="p-1 rounded text-gray-400 hover:text-gray-600" aria-label="Cancel">
          <X className="w-4 h-4" />
        </button>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <label className="space-y-1">
          <span className="text-xs font-medium text-gray-600">Role</span>
          <select value={chosen?.key ?? ''} onChange={(e) => setRole(e.target.value)} disabled={roles.length === 0} required className={inp}>
            <option value="" disabled>
              {roles.length > 0 ? 'Choose a role' : assignable.isSuccess ? 'They already hold every role you can give' : optionsNote(assignable, '')}
            </option>
            {roles.map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}
          </select>
        </label>
        <label className="space-y-1">
          <span className="text-xs font-medium text-gray-600">{emailOptional ? 'Email (optional)' : 'Email for this login'}</span>
          <input type="email" required={!emailOptional} value={email} onChange={(e) => setEmail(e.target.value)}
            placeholder={emailOptional ? 'Leave empty to use the Employee ID' : 'name.role@company.in'} className={inp} />
        </label>
      </div>
      {typed && (
        <>
          <PasswordFields value={pair} onChange={(next) => { setPair(next); setProblem('') }} minLength={rules.passwordMinLength} />
          {problem && <p role="alert" className="text-sm text-red-600">{problem}</p>}
        </>
      )}
      {chosen?.locked && (
        <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          This login will hold the Super Admin panel: everything, including users, roles and approving the payroll.
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" onClick={onCancel} className={btn.secondary}>Cancel</button>
        <button type="submit" disabled={add.isPending || !chosen} className={btn.primary}>
          {add.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Add login
        </button>
      </div>
    </form>
  )
}
