import { useState } from 'react'
import {
  Trash2, Edit2, X, Check, ToggleLeft, ToggleRight, Loader2, AlertCircle, KeyRound, UserPlus,
} from 'lucide-react'
import {
  useUsers, useUpdateUserRole,
  useToggleUserStatus, useDeleteUser, useIssuePasswordLink,
} from '../../hooks/useUsers'
import { InviteUserForm, PasswordLinkPanel } from './UserAccess'
import { Section, inpSm } from './ui'
import { ROLE_LABELS } from '../../lib/roles'

/**
 * The Users & Roles tab: sign-in accounts, their roles, and the links that
 * let somebody set a password. Moved out of Settings.jsx unchanged when each
 * tab got its own file.
 */

const ROLES = ['super_admin', 'admin', 'hr', 'manager', 'rm', 'accounts', 'employee']
const ROLE_COLORS = {
  super_admin:   'bg-purple-100 text-purple-700',
  admin:         'bg-indigo-100 text-indigo-700',
  hr:            'bg-blue-100 text-blue-700',
  manager:       'bg-amber-100 text-amber-700',
  rm:            'bg-orange-100 text-orange-700',
  accounts:      'bg-teal-100 text-teal-700',
  employee:      'bg-gray-100 text-gray-600',
}

export default function UsersSettings() {
  const [editId, setEditId] = useState(null)
  const [editRole, setEditRole] = useState('')

  const { data: users = [], isLoading, isError } = useUsers()
  const updateRole = useUpdateUserRole()
  const toggleStatus = useToggleUserStatus()
  const deleteUser = useDeleteUser()
  const issueLink = useIssuePasswordLink()

  // The invite form, and the one link most recently issued. A link is shown
  // once — the server keeps only its hash — so it stays on screen until the
  // administrator closes it.
  const [showInvite, setShowInvite] = useState(false)
  const [issued, setIssued] = useState(null)

  async function handleIssueLink(user) {
    // A reset link lets whoever holds it take over that account, so it is
    // worth one deliberate click. A repeat invitation carries no such risk.
    if (user.status === 'active' && !window.confirm(
      `Create a password reset link for ${user.email}? Whoever holds it can set a new password for this account, and their other sessions end when it is used.`,
    )) return

    const result = await issueLink.mutateAsync({ user_id: user.id }).catch(() => null)
    if (result) setIssued({ email: result.user.email, invite: result.invite })
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

  async function handleDelete(userId) {
    if (!window.confirm('Remove this user? They will lose all access immediately.')) return
    try {
      await deleteUser.mutateAsync({ user_id: userId })
    } catch (err) {
      console.error(err)
    }
  }

  const initials = (name) => (name || '?').split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase()

  return (
    <div className="space-y-6">
      <Section
        title="Manage Users"
        desc={isLoading ? 'Loading…' : `${users.length} user${users.length !== 1 ? 's' : ''} in your organisation.`}
      >
        <div className="space-y-4 mb-4">
          {issued && (
            <PasswordLinkPanel email={issued.email} invite={issued.invite} onDone={() => setIssued(null)} />
          )}

          {showInvite ? (
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

        {isLoading ? (
          <div className="flex items-center justify-center py-12 text-gray-400">
            <Loader2 className="w-6 h-6 animate-spin mr-2" /> Loading users…
          </div>
        ) : isError ? (
          <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 rounded-lg px-4 py-3">
            <AlertCircle className="w-4 h-4" /> Failed to load users.
          </div>
        ) : (
          <div className="border border-gray-200 rounded-xl overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  {['User', 'Role', 'Status', 'Actions'].map((h) => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
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
                        <div className="flex items-center gap-2">
                          <select
                            value={editRole}
                            onChange={(e) => setEditRole(e.target.value)}
                            className={`${inpSm} py-1 bg-white text-xs`}
                          >
                            {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                          </select>
                          <button
                            onClick={() => saveEdit(user.id)}
                            disabled={updateRole.isPending}
                            className="p-1 rounded bg-green-100 text-green-600 hover:bg-green-200 transition-colors"
                          >
                            {updateRole.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                          </button>
                          <button onClick={() => setEditId(null)} className="p-1 rounded bg-gray-100 text-gray-500 hover:bg-gray-200 transition-colors">
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ) : (
                        <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${ROLE_COLORS[user.role] ?? 'bg-gray-100 text-gray-600'}`}>
                          {ROLE_LABELS[user.role] ?? user.role}
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
                        <button
                          onClick={() => startEdit(user)}
                          className="p-1.5 rounded-lg hover:bg-blue-50 text-gray-400 hover:text-blue-600 transition-colors"
                          title="Edit role"
                        >
                          <Edit2 className="w-3.5 h-3.5" />
                        </button>
                        {user.status !== 'inactive' && (
                          <button
                            onClick={() => handleIssueLink(user)}
                            disabled={issueLink.isPending}
                            className="p-1.5 rounded-lg hover:bg-blue-50 text-gray-400 hover:text-blue-600 transition-colors"
                            title={user.status === 'invited' ? 'New invitation link' : 'Password reset link'}
                          >
                            <KeyRound className="w-3.5 h-3.5" />
                          </button>
                        )}
                        {user.status !== 'invited' && (
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
                        <button
                          onClick={() => handleDelete(user.id)}
                          disabled={deleteUser.isPending}
                          className="p-1.5 rounded-lg hover:bg-red-50 text-gray-400 hover:text-red-500 transition-colors"
                          title="Remove user"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  )
}
