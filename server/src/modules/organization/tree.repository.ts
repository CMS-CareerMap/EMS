import type { TxDb } from '../../platform/db/transaction'
import type { TreePerson } from '../../domain/org/companyTree'
import { canSignIn, holdsSuperAdmin, permissionsOf } from '../../domain/org/logins'

/**
 * Everybody's place in the company tree: who they report to, and whether they
 * have left. One small read — the whole company, two columns — that the tree
 * is then walked over in memory.
 *
 * A person can have more than one login (Day 23); each read below takes all
 * of them, so the person, not the login they last used, is what counts.
 */
export async function treePeople(db: TxDb): Promise<TreePerson[]> {
  const rows = await db.employee.findMany({ select: { id: true, reportingManagerId: true, archivedAt: true, memberships: { select: loginFacts } } })
  return rows.map((r) => ({
    id: r.id,
    managerId: r.reportingManagerId,
    left: r.archivedAt !== null,
    canSignIn: canSignIn(r.memberships),
  }))
}

/** What every read here needs to know about each login. */
const loginFacts = { status: true, roleDef: { select: { locked: true } } } as const

/**
 * The people at the top whatever the reporting lines say: the owner and
 * everybody holding the Super Admin panel — counted as "above" for the scope
 * "the whole company, except seniors".
 */
export async function topPeople(db: TxDb): Promise<string[]> {
  const rows = await db.employee.findMany({
    where: { archivedAt: null, memberships: { some: { status: 'active', roleDef: { locked: true } } } },
    select: { id: true },
  })
  return rows.map((r) => r.id)
}

/** Everybody's place, and what their live logins' roles do — for "your own work goes up" (Day 22). */
export async function workPeople(db: TxDb) {
  const rows = await db.employee.findMany({
    select: {
      id: true,
      fullName: true,
      reportingManagerId: true,
      archivedAt: true,
      memberships: { select: { status: true, roleDef: { select: { permissions: true, locked: true } } } },
    },
  })
  return rows.map((r) => {
    // Somebody who has left does no work, whatever their logins say.
    const logins = r.archivedAt ? [] : r.memberships
    return {
      id: r.id,
      name: r.fullName,
      managerId: r.reportingManagerId,
      left: r.archivedAt !== null,
      permissions: permissionsOf(logins),
      isSuperAdmin: holdsSuperAdmin(logins),
    }
  })
}

/** Everybody still here, as the company tree chart shows them. */
export async function chartPeople(db: TxDb) {
  return db.employee.findMany({
    where: { archivedAt: null },
    select: {
      id: true,
      fullName: true,
      employeeCode: true,
      reportingManagerId: true,
      department: { select: { name: true } },
      designation: { select: { name: true } },
      memberships: { select: { status: true, roleDef: { select: { name: true, locked: true } } }, orderBy: { createdAt: 'asc' } },
    },
    orderBy: { fullName: 'asc' },
  })
}

/** One person, for marking the owner or naming who decides for "nobody above". */
export async function personForTree(db: TxDb, id: string) {
  return db.employee.findFirst({
    where: { id },
    select: {
      id: true,
      fullName: true,
      reportingManagerId: true,
      archivedAt: true,
      memberships: { select: loginFacts },
    },
  })
}

/** Takes somebody's reporting manager away — the owner is placed at the top. */
export async function clearManager(db: TxDb, id: string): Promise<void> {
  await db.employee.update({ where: { id }, data: { reportingManagerId: null } })
}

/** The people in the tree, by name, for "ask the person above you (name)". */
export async function namesOf(db: TxDb, ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map()
  const rows = await db.employee.findMany({ where: { id: { in: [...ids] } }, select: { id: true, fullName: true } })
  return new Map(rows.map((r) => [r.id, r.fullName]))
}
