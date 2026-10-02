import type { TxDb } from '../../platform/db/transaction'
import type { TreePerson } from '../../domain/org/companyTree'

/**
 * Everybody's place in the company tree: who they report to, and whether they
 * have left. One small read — the whole company, two columns — that the tree
 * is then walked over in memory.
 */
export async function treePeople(db: TxDb): Promise<TreePerson[]> {
  const rows = await db.employee.findMany({ select: { id: true, reportingManagerId: true, archivedAt: true, membership: { select: { status: true } } } })
  return rows.map((r) => ({
    id: r.id,
    managerId: r.reportingManagerId,
    left: r.archivedAt !== null,
    canSignIn: r.membership?.status === 'active',
  }))
}

/**
 * The people at the top whatever the reporting lines say: the owner and
 * everybody holding the Super Admin panel — counted as "above" for the scope
 * "the whole company, except seniors".
 */
export async function topPeople(db: TxDb): Promise<string[]> {
  const rows = await db.employee.findMany({
    where: { archivedAt: null, membership: { status: 'active', roleDef: { locked: true } } },
    select: { id: true },
  })
  return rows.map((r) => r.id)
}

/** Everybody's place, and what their live login's role does — for "your own work goes up" (Day 22). */
export async function workPeople(db: TxDb) {
  const rows = await db.employee.findMany({
    select: {
      id: true,
      fullName: true,
      reportingManagerId: true,
      archivedAt: true,
      membership: { select: { status: true, roleDef: { select: { permissions: true, locked: true } } } },
    },
  })
  return rows.map((r) => {
    const live = r.membership && r.membership.status === 'active' && !r.archivedAt ? r.membership.roleDef : null
    return {
      id: r.id,
      name: r.fullName,
      managerId: r.reportingManagerId,
      left: r.archivedAt !== null,
      permissions: new Set(live?.permissions ?? []),
      isSuperAdmin: Boolean(live?.locked),
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
      membership: { select: { status: true, roleDef: { select: { name: true, locked: true } } } },
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
      membership: { select: { status: true, roleDef: { select: { locked: true } } } },
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
