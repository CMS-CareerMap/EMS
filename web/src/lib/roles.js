/**
 * How a role is named on screen.
 *
 * Since Day 21 roles are the company's own: the Super Admin can rename the
 * seven EMS starts with and make new ones, so the server sends each role's
 * name with it (`roleName`, `role_name`) and that is what a screen shows.
 * The labels below are only for the seven built-in keys when no name came —
 * never a decision about what anybody may do; that is the permissions.
 */
export const ROLE_LABELS = {
  super_admin: 'Super Admin',
  admin: 'Admin',
  hr: 'HR',
  manager: 'Manager',
  rm: 'Reporting Manager',
  accounts: 'Accounts',
  employee: 'Employee',
}

/** A role's name as people read it: the name the server sent, else a built-in label, else the key as it came. */
export const roleLabel = (role, name) => name || ROLE_LABELS[role] || role || ''

/** A colour per built-in role, so the Users list reads at a glance; a role somebody made is grey. */
export const ROLE_COLORS = {
  super_admin: 'bg-purple-100 text-purple-700',
  admin: 'bg-indigo-100 text-indigo-700',
  hr: 'bg-blue-100 text-blue-700',
  manager: 'bg-amber-100 text-amber-700',
  rm: 'bg-orange-100 text-orange-700',
  accounts: 'bg-teal-100 text-teal-700',
  employee: 'bg-gray-100 text-gray-600',
}

export const roleColor = (role) => ROLE_COLORS[role] ?? 'bg-slate-100 text-slate-700'
