/**
 * How each role is named on screen — one list, so every page says the same.
 * There used to be four copies of this map, and they disagreed ("HR" here,
 * "HR Lead" there). Who may do what is never decided from these names; that
 * is the permissions, from the server.
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

/** A role's name as people read it; an unknown one is shown as it came. */
export const roleLabel = (role) => ROLE_LABELS[role] ?? role
