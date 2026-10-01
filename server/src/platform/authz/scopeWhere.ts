import type { Prisma } from '@prisma/client'
import type { ScopeContext } from './scope'

/**
 * Data scope as a database filter — the ONE place each scope is defined.
 *
 * Before Day 21 every repository carried its own copy of this switch, and the
 * copies had drifted: documents and payslips knew only "the whole company" or
 * "your own", so a team scope there quietly meant your own. Once the Super
 * Admin can give any role any scope, every module has to honour every choice
 * the screen offers, and one definition is how that stays true.
 *
 * The switches are exhaustive. A scope that fell through to "no filter" would
 * widen access silently, and every test would still pass because the rows come
 * back.
 *
 * "Their team" and "their department" both include the person themselves:
 * a manager's own leave is in the list they see, as it always was.
 */

/** A uuid column can never hold this, so it matches nothing. */
export const NOBODY_ID = '00000000-0000-0000-0000-000000000000'

/** The employees a scope reaches, as a filter on Employee. */
export function employeesInScope(scope: ScopeContext): Prisma.EmployeeWhereInput {
  switch (scope.scope) {
    case 'ORGANIZATION':
      // forOrg() has already confined this to one company.
      return {}

    case 'DIRECT_REPORTS':
      // Somebody with no employee record of their own manages nobody. Without
      // this guard `reportingManagerId: null` would match every unmanaged
      // employee in the company.
      if (!scope.employeeId) return { id: NOBODY_ID }
      return { OR: [{ reportingManagerId: scope.employeeId }, { id: scope.employeeId }] }

    case 'DEPARTMENT':
      if (!scope.employeeId) return { id: NOBODY_ID }
      // No department of their own: their own record only, never "everybody
      // else with no department".
      if (!scope.departmentId) return { id: scope.employeeId }
      return { OR: [{ departmentId: scope.departmentId }, { id: scope.employeeId }] }

    case 'SELF':
      if (!scope.employeeId) return { id: NOBODY_ID }
      return { id: scope.employeeId }
  }
}

/**
 * Rows that belong to a person — attendance, leave, payslips, documents — as a
 * filter on any table with an `employeeId` column and an `employee` relation.
 *
 * SELF filters on the column itself rather than through the relation, so the
 * commonest case — somebody looking at their own rows — uses the index and
 * needs no join.
 */
export interface OwnedRowsWhere {
  employeeId?: string
  employee?: Prisma.EmployeeWhereInput
  OR?: OwnedRowsWhere[]
}

export function ownedRowsInScope(scope: ScopeContext): OwnedRowsWhere {
  switch (scope.scope) {
    case 'ORGANIZATION':
      return {}

    case 'DIRECT_REPORTS':
      if (!scope.employeeId) return { employeeId: NOBODY_ID }
      return { OR: [{ employee: { reportingManagerId: scope.employeeId } }, { employeeId: scope.employeeId }] }

    case 'DEPARTMENT':
      if (!scope.employeeId) return { employeeId: NOBODY_ID }
      if (!scope.departmentId) return { employeeId: scope.employeeId }
      return { OR: [{ employee: { departmentId: scope.departmentId } }, { employeeId: scope.employeeId }] }

    case 'SELF':
      if (!scope.employeeId) return { employeeId: NOBODY_ID }
      return { employeeId: scope.employeeId }
  }
}

/** The facts about a person a scope is decided on. */
export interface PersonPlace {
  id: string
  reportingManagerId: string | null
  departmentId: string | null
}

/**
 * Whether one person already in hand falls within a scope — the same rule as
 * employeesInScope, for a row that has been read for another reason (a salary
 * on an employee record the caller may see, say).
 */
export function isInScope(scope: ScopeContext, person: PersonPlace): boolean {
  switch (scope.scope) {
    case 'ORGANIZATION':
      return true
    case 'DIRECT_REPORTS':
      return Boolean(scope.employeeId) && (person.id === scope.employeeId || person.reportingManagerId === scope.employeeId)
    case 'DEPARTMENT':
      if (!scope.employeeId) return false
      if (person.id === scope.employeeId) return true
      return Boolean(scope.departmentId) && person.departmentId === scope.departmentId
    case 'SELF':
      return Boolean(scope.employeeId) && person.id === scope.employeeId
  }
}
