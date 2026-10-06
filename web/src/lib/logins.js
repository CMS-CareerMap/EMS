/**
 * Logins and their passwords, as the screens show them (client, 6 Oct 2026;
 * Settings → Users & Roles → Passwords). The server decides every one of
 * these again; this only decides what is drawn.
 *
 * A login is an employee login (the Employee role — the person's own things),
 * a role login (any other role) or a Super Admin's. The company chooses who
 * sets each kind's password: `company` — HR for an employee login, the Super
 * Admin alone for a role login, and the person cannot change it — or `self`,
 * the person, from a link. A Super Admin's own is always theirs.
 */

/**
 * How a login is named on screen: its email, or — an employee login with none —
 * the Employee ID it signs in with.
 */
export function loginName(login, employeeCode = login?.employee_id) {
  if (login?.email) return login.email
  return employeeCode ? `Employee ID ${employeeCode}` : 'Employee ID login'
}

/** Whose this kind of login's password is: 'company' or 'self'. */
export function passwordSetBy(kind, rules) {
  if (kind === 'super_admin') return 'self'
  return kind === 'employee' ? rules.employeePasswords : rules.rolePasswords
}

/**
 * Whether this person may set a login's password for its owner: the Super
 * Admin anybody's, a holder of the permission an employee login's. (Never
 * their own, and only somebody below them — the screens check that apart.)
 */
export function maySetPasswordOf(kind, { isSuperAdmin, holds }) {
  if (isSuperAdmin) return true
  return holds && kind === 'employee'
}

/** Who sets this kind of login's password, in words. */
export function passwordSetterName(kind) {
  return kind === 'employee' ? 'HR' : 'the Super Admin'
}

/**
 * What is wrong with a password typed twice for somebody, if anything — the
 * server's rule for its length, said first; the server checks again.
 */
export function passwordPairProblem({ password, again }, minLength) {
  if (!password) return 'Enter the password'
  if (password.length < minLength) return `The password must be at least ${minLength} characters`
  if (password.length > 200) return 'That is too long to be a password'
  if (/^\s|\s$/.test(password)) return 'The password must not start or end with a space'
  if (password !== again) return 'The two passwords are not the same'
  return ''
}

/**
 * A login's state in words. One waiting for its first password says so: where
 * the company sets it, "No password yet"; where the person does, "Invited".
 */
export function loginStatusWords(login, rules) {
  if (login.status === 'active') return 'Can sign in'
  if (login.status === 'inactive') return 'Turned off'
  if (login.status === 'invited') {
    return passwordSetBy(login.login_kind, rules) === 'company' ? 'No password yet' : 'Invited — has not set a password'
  }
  return login.status
}
