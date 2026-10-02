/**
 * WHOSE rows an action covers, once a permission has established that the
 * action is allowed at all.
 *
 * This is the half that role checks always get wrong. A manager and an employee
 * both hold `leave:read`; the difference is that one means "my team's leave"
 * and the other means "mine". Encoding that as a scope rather than as two
 * permissions is what stops the list in permissions.ts from doubling every time
 * a role is added.
 *
 * It is also where the classic hole lives. Scope gets applied to list
 * endpoints, because a list obviously needs filtering — and then forgotten on
 * GET /employees/:id, because "they asked for one row by id". That is IDOR, and
 * it is how an employee reads the managing director's salary by changing a
 * number in the URL. Repository functions therefore REQUIRE a scope argument on
 * every read, by id or otherwise.
 *
 * And when a row falls outside scope, the answer is 404, never 403. A 403 says
 * "this exists and you may not see it", which confirms the row exists — enough
 * to enumerate the employee table one id at a time.
 *
 * Since Day 21 the scope of each role is the Super Admin's choice, stored with
 * the role (Settings → Roles & Permissions); the starting values are in
 * defaultRoles.ts. Every choice offered there is implemented in scopeWhere.ts.
 * None is approximated.
 *
 * Two follow the company tree (Day 22): everybody under the person at every
 * level, and the whole company except the people above them — the second is
 * how HR sees salaries but never a senior's.
 */
export type DataScope = 'SELF' | 'DIRECT_REPORTS' | 'ALL_REPORTS' | 'DEPARTMENT' | 'ORGANIZATION_EXCEPT_ABOVE' | 'ORGANIZATION'

/** Every scope, widest last — the order the Roles screen offers them in. */
export const DATA_SCOPES: readonly DataScope[] = ['SELF', 'DIRECT_REPORTS', 'ALL_REPORTS', 'DEPARTMENT', 'ORGANIZATION_EXCEPT_ABOVE', 'ORGANIZATION']

/** The scopes decided by where the person sits in the company tree, beyond their direct reports. */
export const TREE_SCOPES: ReadonlySet<DataScope> = new Set<DataScope>(['ALL_REPORTS', 'ORGANIZATION_EXCEPT_ABOVE'])

export function isDataScope(value: unknown): value is DataScope {
  return typeof value === 'string' && (DATA_SCOPES as readonly string[]).includes(value)
}

/**
 * The resources whose rows belong to a particular person.
 *
 * `compensation` is a person's salary, scoped on its own since Day 21: who may
 * see a salary is a narrower question than who may see the person's record,
 * and the client wants HR to see salaries but never those of their seniors.
 */
export type ScopedResource = 'employee' | 'attendance' | 'leave' | 'payslip' | 'document' | 'compensation'

export const SCOPED_RESOURCES: readonly ScopedResource[] = ['employee', 'compensation', 'attendance', 'leave', 'payslip', 'document']

/**
 * What a repository needs in order to filter. Built by the http layer from the
 * authenticated request and passed down; nothing below http constructs one, so
 * a service cannot quietly widen its own scope.
 */
export interface ScopeContext {
  scope: DataScope
  /** The caller's own Employee row, when they have one. Null for an operator. */
  employeeId: string | null
  /**
   * The caller's department, for the DEPARTMENT scope. Optional so the many
   * places that build an ORGANIZATION or SELF scope need not invent one;
   * absent means "no department", which DEPARTMENT treats as their own rows.
   */
  departmentId?: string | null | undefined
  /**
   * The caller's place in the company tree, for ALL_REPORTS and
   * ORGANIZATION_EXCEPT_ABOVE: everybody under them at every level, and
   * everybody above them up to the top. Loaded only when the scope needs it;
   * absent, those two scopes reach the caller's own rows and nobody else's.
   */
  tree?: TreePlace | undefined
}

export interface TreePlace {
  below: readonly string[]
  above: readonly string[]
}
