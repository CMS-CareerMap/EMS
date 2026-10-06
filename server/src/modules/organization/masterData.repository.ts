import type { ScopedDb } from '../../platform/db/scoped'
import type { TxDb } from '../../platform/db/transaction'
import { equalsInsensitive } from '../../platform/db/insensitive'

/**
 * The company's own lists: departments, designations, shifts.
 *
 * Archived entries are left out. They stay in the database because employees
 * and attendance rows still point at them, but nobody should be able to put a
 * new hire into a department the company has closed.
 */

export async function listDepartments(db: ScopedDb) {
  return db.department.findMany({
    where: { archivedAt: null },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  })
}

export async function listDesignations(db: ScopedDb) {
  return db.designation.findMany({
    where: { archivedAt: null },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  })
}

export async function listShifts(db: ScopedDb) {
  return db.shift.findMany({
    where: { archivedAt: null },
    select: {
      id: true,
      name: true,
      startTime: true,
      endTime: true,
      breakMinutes: true,
      expectedHours: true,
      graceMinutes: true,
      lateThresholdMinutes: true,
      earlyLeavingMinutes: true,
      minFullDayHours: true,
      minHalfDayHours: true,
      overtimeAfterMinutes: true,
    },
    orderBy: { name: 'asc' },
  })
}

// ── Writing ─────────────────────────────────────────────────────────────────

export type NamedKind = 'department' | 'designation'

interface NamedRow {
  id: string
  name: string
  archivedAt: Date | null
}

/**
 * Departments and designations are the same shape — a name, and whether it is
 * still in use — so one set of functions serves both. Typed down to what those
 * functions use, because Prisma's two delegates cannot be called as a union.
 */
interface NamedDelegate {
  findFirst(args: { where: Record<string, unknown> }): Promise<NamedRow | null>
  create(args: { data: { organizationId: string; name: string } }): Promise<NamedRow>
  update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<NamedRow>
}

function named(db: TxDb, kind: NamedKind): NamedDelegate {
  return (kind === 'department' ? db.department : db.designation) as unknown as NamedDelegate
}

export async function findNamedById(db: ScopedDb, kind: NamedKind, id: string) {
  return named(db, kind).findFirst({ where: { id } })
}

/** Case-insensitively, archived or not — "Sales" and "sales" are one department. */
export async function findNamedByName(db: ScopedDb, kind: NamedKind, name: string) {
  return named(db, kind).findFirst({ where: { name: equalsInsensitive(name) } })
}

export async function createNamed(db: TxDb, kind: NamedKind, organizationId: string, name: string) {
  return named(db, kind).create({ data: { organizationId, name } })
}

export async function updateNamed(db: TxDb, kind: NamedKind, id: string, data: { name?: string; archivedAt?: Date | null }) {
  return named(db, kind).update({ where: { id }, data })
}

export interface ShiftFields {
  name?: string
  startTime?: string
  endTime?: string
  breakMinutes?: number
  expectedHours?: number
}

/** The shift's rules (client §34); left out, a new shift takes the defaults. */
export interface ShiftRuleFields {
  graceMinutes?: number | undefined
  lateThresholdMinutes?: number | null | undefined
  earlyLeavingMinutes?: number | null | undefined
  minFullDayHours?: number | null | undefined
  minHalfDayHours?: number | null | undefined
  overtimeAfterMinutes?: number | undefined
}

export async function findShiftById(db: ScopedDb, id: string) {
  return db.shift.findFirst({ where: { id } })
}

export async function findShiftByName(db: ScopedDb, name: string) {
  return db.shift.findFirst({ where: { name: equalsInsensitive(name) } })
}

export async function createShift(
  db: TxDb,
  organizationId: string,
  data: Required<ShiftFields> & ShiftRuleFields,
) {
  return db.shift.create({ data: { organizationId, ...data } })
}

export async function updateShift(db: TxDb, id: string, data: ShiftFields & ShiftRuleFields & { archivedAt?: Date | null }) {
  return db.shift.update({ where: { id }, data })
}
