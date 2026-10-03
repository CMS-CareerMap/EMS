import { useState } from 'react'
import {
  Trash2, Edit2, X, Check, ToggleLeft, ToggleRight, Loader2, KeyRound, UserPlus,
} from 'lucide-react'
import {
  useUsers, useUpdateUserRole,
  useToggleUserStatus, useDeleteUser, useIssuePasswordLink, useWithdrawInvitation,
} from '../../hooks/useUsers'
import { InviteUserForm, PasswordLinkPanel } from './UserAccess'
import { Section, inpSm } from './ui'
import { roleColor, roleLabel } from '../../lib/roles'
import { optionsNote } from '../../lib/optionsNote'
import { useAssignableRoles } from '../../hooks/useRoles'
import { useAuthStore } from '../../stores/authStore'
import DataState from '../../components/DataState'
import ConfirmDialog from '../../components/ConfirmDialog'

/**
 * The Users & Roles tab: sign-in accounts, their roles, and the links that
 * let somebody set a password.
 *
 * Since Day 21 the roles are the company's own: the role picker offers what
 * the server says this person may hand out (below their own role), and each
 * row shows its role by the name the company gave it. Each button is drawn
 * only for somebody holding its permission — a role made on the Roles screen
 * can hold some of them and not others — and only on the rows the server
 * would let them act on: never their own, and only people whose role is one
 * they could give (below their own, with nothing they cannot do). That is the
 * same rule the server applies, read from the same list.
 *
 * Since Day 23 a person can have two logins — an employee login and a role
 * login, each with its own email — and they are listed together, the person's
 * name once. Each login is turned on or off by itself; removing the person
 * closes all of them, so Remove sits on the person and needs every one of
 * their logins to be one you could manage. Your own other login is yours too.
 */

const STATUS_WORDS = { active: 'Can sign in', invited: 'Invited', inactive: 'Turned off' }
const STATUS_LOOK = { active: 'bg-green-100 text-green-700', invited: 'bg-blue-100 text-blue-700', inactive: 'bg-gray-100 text-gray-500' }

/** Logins in the list's order, each person's together under their first. */
function byPerson(rows) {
  const groups = []
  const seen = new Map()
  for (const row of rows) {
    const group = row.person_id ? seen.get(row.person_id) : undefined
    if (group) group.push(row)
    else {
      const fresh = [row]
      groups.push(fresh)
      if (row.person_id) seen.set(row.person_id, fresh)
    }
  }
  return groups
}

export default function UsersSettings() {
  const [editId, setEditId] = useState(null)
  const [editRole, setEditRole] = useState('')

  const permissions = useAuthStore((state) => state.permissions)
  const myEmail = useAuthStore((state) => state.user?.email ?? null)
  const myPersonId = useAuthStore((state) => state.profile?.id ?? null)
  const mayAssign = permissions.includes('membership:role:assign')
  const mayInvite = permissions.includes('user:invite')
  const mayToggle = permissions.includes('user:status:update')
  const mayRemove = permissions.includes('user:delete')

  const users = useUsers()
  const assignable = useAssignableRoles({ enabled: mayAssign || mayInvite || mayToggle || mayRemove })
  // Whom this person may act on: not their own logins — this one or their
  // other — and only a role they could give. Until the roles are in, nobody.
  const own = (user) => user.email === myEmail || (myPersonId !== null && user.person_id === myPersonId)
  const manageable = (user) =>
    !own(user) && assignable.isSuccess && assignable.data.some((r) => r.key === user.role)
  // Acting on one login of a person is acting on the person (Day 23): every
  // login of theirs must be one you could manage, as the server checks. And
  // somebody who has left keeps their logins closed.
  const groups = users.isSuccess ? byPerson(users.data.rows) : []
  const mayActOn = (group) => !group[0].person_left && group.every(manageable)
  const updateRole = useUpdateUserRole()
  const toggleStatus = useToggleUserStatus()
  const deleteUser = useDeleteUser()
  const issueLink = useIssuePasswordLink()

  // The invite form, and the one link most recently issued. A link is shown
  // once — the server keeps only its hash — so it stays on screen until the
  // administrator closes it.
  const [showInvite, setShowInvite] = useState(false)
  const [issued, setIssued] = useState(null)
  // Who a confirmation is open for: a reset link, removal, turning a login
  // off (it ends that login's sessions at once), or taking back an invitation.
  const [resetting, setResetting] = useState(null)
  const [removing, setRemoving] = useState(null)
  const [turningOff, setTurningOff] = useState(null)
  const [withdrawing, setWithdrawing] = useState(null)
  const withdraw = useWithdrawInvitation()

  async function issueLinkFor(user) {
    const result = await issueLink.mutateAsync({ user_id: user.id })
    setIssued({ email: result.user.email, invite: result.invite })
  }

  function handleIssueLink(user) {
    // A reset link lets whoever holds it take over that account, so it is
    // worth one deliberate click. A repeat invitation carries no such risk.
    if (user.status === 'active') setResetting(user)
    else issueLinkFor(user).catch(() => null)
  }

  function startEdit(user) { setEditId(user.id); setEditRole(user.role) }

  async function saveEdit(userId) {
    try {
      await updateRole.mutateAsync({ user_id: userId, role: editRole })
      setEditId(null)
    } catch (err) {
      console.error(err)
    }
  }

  async function handleToggleStatus(user) {
    // Turning off is asked once more; turning back on is not.
    if (user.status === 'active') {
      setTurningOff(user)
      return
    }
    try {
      await toggleStatus.mutateAsync({ user_id: user.id, currentStatus: user.status })
    } catch (err) {
      console.error(err)
    }
  }

  const initials = (name) => (name || '?').split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase()

  // A count only from an answer; a failed load says so below, not "0 users".
  const count = users.isSuccess ? users.data.rows.length : null
  // Logins, not people: somebody with a role has two (Day 23).
  const someone = (n) => `${n} login${n !== 1 ? 's' : ''}`
  // Whose logins these are: a role reaching one department lists that
  // department's, and saying "in your organisation" would not be true.
  const REACH_WORDS = {
    ORGANIZATION: (n) => `${someone(n)} in your organisation.`,
    ORGANIZATION_EXCEPT_ABOVE: (n) => `${someone(n)} in your organisation — everybody but the people above you.`,
    DEPARTMENT: (n) => `${someone(n)} in your department — the people your role reaches.`,
    ALL_REPORTS: (n) => `${someone(n)}: you and everybody under you in the company tree.`,
    DIRECT_REPORTS: (n) => `${someone(n)}: you and the people who report to you.`,
    SELF: () => 'Only your own login — your role reaches nobody else’s.',
  }
  const desc = count === 0
    ? 'Your role reaches nobody’s login yet.'
    : count !== null
      ? (REACH_WORDS[users.data.reach] ?? REACH_WORDS.ORGANIZATION)(count)
      : users.isLoading ? 'Loading…' : undefined
  // Rows listed but none to act on: the role order, not a fault — said once,
  // instead of a column of empty Actions cells.
  const mayAct = mayAssign || mayInvite || mayToggle || mayRemove
  const actsOnNobody = mayAct && users.isSuccess && assignable.isSuccess &&
    users.data.rows.some((u) => !own(u) && !u.person_left) && !groups.some(mayActOn)

  return (
    <div className="space-y-6">
      <Section
        title="Manage Users"
        desc={desc}
      >
        <div className="space-y-4 mb-4">
          {issued && (
            <PasswordLinkPanel email={issued.email} invite={issued.invite} onDone={() => setIssued(null)} />
          )}

          {/* Inviting adds somebody outside any team or department, so the server
              allows it only to a company-wide reach. A narrower one adds people
              under Employees, with a login there. */}
          {!(mayInvite && users.data?.reach === 'ORGANIZATION') ? null : showInvite ? (
            <InviteUserForm
              onCancel={() => setShowInvite(false)}
              onInvited={(result) => { setShowInvite(false); setIssued(result) }}
            />
          ) : (
            <button
              onClick={() => setShowInvite(true)}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold"
            >
              <UserPlus className="w-4 h-4" /> Invite user
            </button>
          )}
        </div>

        {actsOnNobody && (
          <p className="mb-3 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-600">
            Nobody listed here has a role under yours, so you cannot change their logins. The Super Admin decides which roles come under yours, in Roles &amp; Permissions.
          </p>
        )}

        <DataState query={users} loading="Loading users…">
          {({ rows }) => (
          // Scrolls within its box on a phone, like the other Settings tables:
          // clipped, the Status and Actions columns could not be reached.
          <div className="border border-gray-200 rounded-xl overflow-x-auto">
            <table className="w-full min-w-160">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  {['User', 'Role', 'Status', 'Actions'].map((h) => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {byPerson(rows).flatMap((group) => group.map((user, index) => (
                  <tr key={user.id} data-person={user.person_id ?? undefined}
                    className={`hover:bg-gray-50 transition-colors ${index === group.length - 1 ? 'border-b border-gray-100 last:border-0' : ''}`}>
                    <td className="px-4 py-3.5">
                      {index === 0 ? (
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center shrink-0">
                            <span className="text-blue-700 text-xs font-semibold">{initials(user.full_name)}</span>
                          </div>
                          <div>
                            <p className="text-sm font-medium text-gray-900">
                              {user.full_name || '—'}
                              {group.length > 1 && <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded bg-slate-100 text-[11px] font-medium text-slate-600">{group.length} logins</span>}
                              {user.person_left && <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded bg-rose-50 text-[11px] font-medium text-rose-700">Left</span>}
                            </p>
                            {/* The address the link belongs to — for an invited
                                person, often the only thing anybody knows yet. */}
                            <p className="text-xs text-gray-500">{user.email}</p>
                          </div>
                        </div>
                      ) : (
                        // The same person's other login: its own email, under their name.
                        <div className="pl-11">
                          <p className="text-xs text-gray-400">{group.length > 2 ? 'Another login of theirs' : 'Their other login'}</p>
                          <p className="text-xs text-gray-500">{user.email}</p>
                        </div>
                      )}
                    </td>

                    <td className="px-4 py-3.5">
                      {editId === user.id ? (
                        <div className="space-y-1">
                          <div className="flex items-center gap-2">
                            <select
                              value={editRole}
                              onChange={(e) => setEditRole(e.target.value)}
                              disabled={!assignable.isSuccess}
                              aria-label={`Role for ${user.full_name || user.email}`}
                              className={`${inpSm} py-1 bg-white text-xs`}
                            >
                              {/* Their current role stays in the list even when it is
                                  not one this person could give, so the select never
                                  shows a role the person does not hold. */}
                              {!(assignable.data ?? []).some((r) => r.key === user.role) && (
                                <option value={user.role} disabled>{roleLabel(user.role, user.role_name)}</option>
                              )}
                              {/* Less the roles their other logins hold: one login per role per person. */}
                              {assignable.isSuccess
                                ? assignable.data
                                  .filter((r) => !group.some((other) => other.id !== user.id && other.role === r.key))
                                  .map((r) => <option key={r.key} value={r.key}>{r.name}</option>)
                                : <option value="" disabled>{optionsNote(assignable, '')}</option>}
                            </select>
                            <button
                              onClick={() => saveEdit(user.id)}
                              disabled={updateRole.isPending || !assignable.isSuccess || editRole === user.role}
                              aria-label="Save role"
                              className="p-1 rounded bg-green-100 text-green-600 hover:bg-green-200 disabled:opacity-40 transition-colors"
                            >
                              {updateRole.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                            </button>
                            <button onClick={() => setEditId(null)} aria-label="Cancel" className="p-1 rounded bg-gray-100 text-gray-500 hover:bg-gray-200 transition-colors">
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </div>
                          {assignable.isError && <p className="text-xs text-red-600">{optionsNote(assignable, '')}</p>}
                        </div>
                      ) : (
                        <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${roleColor(user.role)}`}>
                          {roleLabel(user.role, user.role_name)}
                        </span>
                      )}
                    </td>

                    <td className="px-4 py-3.5">
                      {/* In words, the same as the person's page; never a made-up "active". */}
                      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium
                        ${STATUS_LOOK[user.status] ?? 'bg-gray-100 text-gray-500'}`}>
                        {STATUS_WORDS[user.status] ?? user.status}
                      </span>
                    </td>

                    <td className="px-4 py-3.5">
                      <div className="flex items-center gap-1">
                        {/* Each icon is named for a screen reader, and for a phone, which has no tooltip. */}
                        {mayAssign && mayActOn(group) && (
                          <button
                            onClick={() => startEdit(user)}
                            className="p-1.5 rounded-lg hover:bg-blue-50 text-gray-400 hover:text-blue-600 transition-colors"
                            title="Edit role"
                            aria-label={`Edit the role of ${user.email}`}
                          >
                            <Edit2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                        {mayInvite && mayActOn(group) && user.status !== 'inactive' && (
                          <button
                            onClick={() => handleIssueLink(user)}
                            disabled={issueLink.isPending}
                            className="p-1.5 rounded-lg hover:bg-blue-50 text-gray-400 hover:text-blue-600 transition-colors"
                            title={user.status === 'invited' ? 'New invitation link' : 'Password reset link'}
                            aria-label={`${user.status === 'invited' ? 'New invitation link' : 'Password reset link'} for ${user.email}`}
                          >
                            <KeyRound className="w-3.5 h-3.5" />
                          </button>
                        )}
                        {/* An invitation nobody used — a mistyped address — is taken back, not switched off. */}
                        {mayInvite && mayActOn(group) && user.status === 'invited' && (
                          <button
                            onClick={() => setWithdrawing(user)}
                            disabled={withdraw.isPending}
                            className="p-1.5 rounded-lg hover:bg-red-50 text-gray-400 hover:text-red-500 transition-colors"
                            title="Withdraw invitation"
                            aria-label={`Withdraw the invitation for ${user.email}`}
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        )}
                        {mayToggle && mayActOn(group) && user.status !== 'invited' && (
                          <button
                            onClick={() => handleToggleStatus(user)}
                            disabled={toggleStatus.isPending}
                            className={`p-1.5 rounded-lg transition-colors text-gray-400
                              ${user.status === 'active' ? 'hover:bg-amber-50 hover:text-amber-600' : 'hover:bg-green-50 hover:text-green-600'}`}
                            title={user.status === 'active' ? 'Turn off' : 'Turn on'}
                            aria-label={`${user.status === 'active' ? 'Turn off' : 'Turn on'} ${user.email}`}
                          >
                            {user.status === 'active' ? <ToggleRight className="w-4 h-4" /> : <ToggleLeft className="w-4 h-4" />}
                          </button>
                        )}
                        {/* Removing is the person's: on their first row, when every login of theirs is one you could close. */}
                        {mayRemove && index === 0 && mayActOn(group) && (
                          <button
                            onClick={() => setRemoving(group)}
                            disabled={deleteUser.isPending}
                            className="p-1.5 rounded-lg hover:bg-red-50 text-gray-400 hover:text-red-500 transition-colors"
                            title="Remove user"
                            aria-label={`Remove ${user.full_name || user.email}`}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                )))}
              </tbody>
            </table>
          </div>
          )}
        </DataState>

        {resetting && (
          <ConfirmDialog title={`Create a password reset link for ${resetting.email}?`} confirmLabel="Create link"
            onConfirm={() => issueLinkFor(resetting)}
            onClose={() => setResetting(null)}>
            <p>Whoever holds it can set a new password for this account.</p>
            <p>Their other sessions end when it is used.</p>
          </ConfirmDialog>
        )}

        {removing && (
          <ConfirmDialog title={`Remove ${removing[0].full_name || removing[0].email}?`} confirmLabel="Remove" danger
            onConfirm={() => deleteUser.mutateAsync({ user_id: removing[0].id })}
            onClose={() => setRemoving(null)}>
            {removing.length > 1 ? (
              <p>All {removing.length} of their logins close together — {removing.map((u, i) => <span key={u.id}>{i > 0 && ' and '}<strong>{u.email}</strong></span>)} — and lose all access immediately.</p>
            ) : (
              <p><strong>{removing[0].email}</strong> will lose all access immediately.</p>
            )}
            {removing[0].person_id && <p>Their employee record is kept, marked as left.</p>}
          </ConfirmDialog>
        )}

        {turningOff && (
          <ConfirmDialog title={`Turn off ${turningOff.email}?`} confirmLabel="Turn off" danger
            onConfirm={() => toggleStatus.mutateAsync({ user_id: turningOff.id, currentStatus: turningOff.status })}
            onClose={() => setTurningOff(null)}>
            <p>It is signed out everywhere at once and cannot sign in until it is turned back on.</p>
            <p>Any other login of theirs keeps working.</p>
          </ConfirmDialog>
        )}

        {withdrawing && (
          <ConfirmDialog title={`Withdraw the invitation for ${withdrawing.email}?`} confirmLabel="Withdraw" danger
            onConfirm={() => withdraw.mutateAsync({ user_id: withdrawing.id })}
            onClose={() => setWithdrawing(null)}>
            <p>Its link stops working and the login is taken away, so the right one can be added in its place.</p>
          </ConfirmDialog>
        )}
      </Section>
    </div>
  )
}
