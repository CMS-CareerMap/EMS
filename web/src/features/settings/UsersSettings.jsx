import { useState } from 'react'
import {
  Trash2, Edit2, X, Check, ToggleLeft, ToggleRight, Loader2, KeyRound, UserPlus,
} from 'lucide-react'
import {
  useUsers, useUpdateUserRole,
  useToggleUserStatus, useDeleteUser, useIssuePasswordLink,
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
 */

export default function UsersSettings() {
  const [editId, setEditId] = useState(null)
  const [editRole, setEditRole] = useState('')

  const permissions = useAuthStore((state) => state.permissions)
  const myEmail = useAuthStore((state) => state.user?.email ?? null)
  const mayAssign = permissions.includes('membership:role:assign')
  const mayInvite = permissions.includes('user:invite')
  const mayToggle = permissions.includes('user:status:update')
  const mayRemove = permissions.includes('user:delete')

  const users = useUsers()
  const assignable = useAssignableRoles({ enabled: mayAssign || mayInvite || mayToggle || mayRemove })
  // Whom this person may act on. Until the list of roles is in, nobody.
  const manageable = (user) =>
    user.email !== myEmail && assignable.isSuccess && assignable.data.some((r) => r.key === user.role)
  const updateRole = useUpdateUserRole()
  const toggleStatus = useToggleUserStatus()
  const deleteUser = useDeleteUser()
  const issueLink = useIssuePasswordLink()

  // The invite form, and the one link most recently issued. A link is shown
  // once — the server keeps only its hash — so it stays on screen until the
  // administrator closes it.
  const [showInvite, setShowInvite] = useState(false)
  const [issued, setIssued] = useState(null)
  // Who a confirmation is open for: a reset link, or removal.
  const [resetting, setResetting] = useState(null)
  const [removing, setRemoving] = useState(null)

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
    try {
      await toggleStatus.mutateAsync({ user_id: user.id, currentStatus: user.status })
    } catch (err) {
      console.error(err)
    }
  }

  const initials = (name) => (name || '?').split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase()

  // A count only from an answer; a failed load says so below, not "0 users".
  const count = users.isSuccess ? users.data.rows.length : null
  const someone = (n) => `${n} user${n !== 1 ? 's' : ''}`
  // Whose logins these are: a role reaching one department lists that
  // department's, and saying "in your organisation" would not be true.
  const REACH_WORDS = {
    ORGANIZATION: (n) => `${someone(n)} in your organisation.`,
    DEPARTMENT: (n) => `${someone(n)} in your department — the people your role reaches.`,
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
    users.data.rows.some((u) => u.email !== myEmail) && !users.data.rows.some(manageable)

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
                {rows.map((user) => (
                  <tr key={user.id} className="border-b border-gray-100 last:border-0 hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3.5">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center shrink-0">
                          <span className="text-blue-700 text-xs font-semibold">{initials(user.full_name)}</span>
                        </div>
                        <div>
                          <p className="text-sm font-medium text-gray-900">{user.full_name || '—'}</p>
                          {/* The address the link belongs to — for an invited
                              person, often the only thing anybody knows yet. */}
                          <p className="text-xs text-gray-500">{user.email}</p>
                        </div>
                      </div>
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
                              {assignable.isSuccess
                                ? assignable.data.map((r) => <option key={r.key} value={r.key}>{r.name}</option>)
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
                      {user.status === 'invited'
                        ? <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700">Invited</span>
                        : <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium
                            ${user.status === 'active' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                            {user.status ?? 'active'}
                          </span>
                      }
                    </td>

                    <td className="px-4 py-3.5">
                      <div className="flex items-center gap-1">
                        {mayAssign && manageable(user) && (
                          <button
                            onClick={() => startEdit(user)}
                            className="p-1.5 rounded-lg hover:bg-blue-50 text-gray-400 hover:text-blue-600 transition-colors"
                            title="Edit role"
                          >
                            <Edit2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                        {mayInvite && manageable(user) && user.status !== 'inactive' && (
                          <button
                            onClick={() => handleIssueLink(user)}
                            disabled={issueLink.isPending}
                            className="p-1.5 rounded-lg hover:bg-blue-50 text-gray-400 hover:text-blue-600 transition-colors"
                            title={user.status === 'invited' ? 'New invitation link' : 'Password reset link'}
                          >
                            <KeyRound className="w-3.5 h-3.5" />
                          </button>
                        )}
                        {mayToggle && manageable(user) && user.status !== 'invited' && (
                          <button
                            onClick={() => handleToggleStatus(user)}
                            disabled={toggleStatus.isPending}
                            className={`p-1.5 rounded-lg transition-colors text-gray-400
                              ${user.status === 'active' ? 'hover:bg-amber-50 hover:text-amber-600' : 'hover:bg-green-50 hover:text-green-600'}`}
                            title={user.status === 'active' ? 'Deactivate' : 'Activate'}
                          >
                            {user.status === 'active' ? <ToggleRight className="w-4 h-4" /> : <ToggleLeft className="w-4 h-4" />}
                          </button>
                        )}
                        {mayRemove && manageable(user) && (
                          <button
                            onClick={() => setRemoving(user)}
                            disabled={deleteUser.isPending}
                            className="p-1.5 rounded-lg hover:bg-red-50 text-gray-400 hover:text-red-500 transition-colors"
                            title="Remove user"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
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
          <ConfirmDialog title={`Remove ${removing.full_name || removing.email}?`} confirmLabel="Remove" danger
            onConfirm={() => deleteUser.mutateAsync({ user_id: removing.id })}
            onClose={() => setRemoving(null)}>
            <p><strong>{removing.email}</strong> will lose all access immediately.</p>
          </ConfirmDialog>
        )}
      </Section>
    </div>
  )
}
