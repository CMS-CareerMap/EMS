import type { AppContext } from '../../platform/context'
import { BadRequest, NotFound, Conflict } from '../../platform/errors/AppError'
import { logger } from '../../platform/logger'
import * as repo from './masterData.repository'
import { withAudit } from '../audit/audit.service'

/**
 * Everything an employee form needs to offer as a choice, in one round trip.
 *
 * The forms used to carry their own lists — "Engineering", "Marketing",
 * "Design" — typed into the page, naming departments this company does not
 * have and missing the ones it does. And they sent the NAME, where the server
 * stores an id, so a new hire's department was never saved at all.
 */
export async function masterData(ctx: AppContext) {
  const [departments, designations, shifts] = await Promise.all([
    repo.listDepartments(ctx.db),
    repo.listDesignations(ctx.db),
    repo.listShifts(ctx.db),
  ])
  return { departments, designations, shifts }
}

// ── Keeping the lists ───────────────────────────────────────────────────────
//
// The seeded lists were always meant as a first day, not a fixed taxonomy: a
// company that does not use "Senior Manager" archives it, and one that has a
// "Legal" department adds it. Until this existed, the only way to change any of
// them was a database query.
//
// Nothing is ever deleted. Employees and attendance rows point at these, and a
// department that vanished would leave last year's reports naming nobody.

const LABEL: Record<repo.NamedKind, string> = { department: 'department', designation: 'designation' }

export async function addNamed(ctx: AppContext, kind: repo.NamedKind, rawName: string) {
  const name = rawName.trim()
  const existing = await repo.findNamedByName(ctx.db, kind, name)

  if (existing && !existing.archivedAt) {
    throw Conflict(`A ${LABEL[kind]} called "${existing.name}" already exists`)
  }

  if (existing) {
    // Brought back rather than duplicated. The old one still carries the
    // history of everyone who was in it; a second row with the same name would
    // split that history in two.
    const restored = await withAudit(
      ctx,
      (tx) => repo.updateNamed(tx, kind, existing.id, { archivedAt: null, name }),
      () => ({ action: 'master_data.restored', entityType: kind, entityId: existing.id, details: { kind, name } }),
    )
    logger.info('Master data restored', { by: ctx.userId, kind, id: existing.id })
    return { row: restored, restored: true }
  }

  const row = await withAudit(
    ctx,
    (tx) => repo.createNamed(tx, kind, ctx.organizationId, name),
    (created) => ({ action: 'master_data.added', entityType: kind, entityId: created.id, details: { kind, name } }),
  )
  logger.info('Master data added', { by: ctx.userId, kind, id: row.id })
  return { row, restored: false }
}

export async function renameNamed(ctx: AppContext, kind: repo.NamedKind, id: string, rawName: string) {
  const name = rawName.trim()
  const row = await repo.findNamedById(ctx.db, kind, id)
  if (!row) throw NotFound(`That ${LABEL[kind]} does not exist`)

  const clash = await repo.findNamedByName(ctx.db, kind, name)
  if (clash && clash.id !== id) {
    throw Conflict(
      clash.archivedAt
        ? `An archived ${LABEL[kind]} is called "${clash.name}". Add that name again to restore it instead.`
        : `A ${LABEL[kind]} called "${clash.name}" already exists`,
    )
  }

  return withAudit(
    ctx,
    (tx) => repo.updateNamed(tx, kind, id, { name }),
    () => ({ action: 'master_data.renamed', entityType: kind, entityId: id, details: { kind, from: row.name, to: name } }),
  )
}

export async function archiveNamed(ctx: AppContext, kind: repo.NamedKind, id: string) {
  const row = await repo.findNamedById(ctx.db, kind, id)
  if (!row) throw NotFound(`That ${LABEL[kind]} does not exist`)
  if (row.archivedAt) return row

  // People already in it stay in it. Archiving only stops it being offered to
  // the next hire.
  const archived = await withAudit(
    ctx,
    (tx) => repo.updateNamed(tx, kind, id, { archivedAt: new Date() }),
    () => ({ action: 'master_data.archived', entityType: kind, entityId: id, details: { kind, name: row.name } }),
  )
  logger.info('Master data archived', { by: ctx.userId, kind, id })
  return archived
}

/**
 * A shift's hours that add up (client §34): a full day needs no more than the
 * shift's expected hours — or nobody working it would ever be present — and a
 * half day less than a full one.
 */
function assertHoursFit(s: { expectedHours: unknown; minFullDayHours?: unknown; minHalfDayHours?: unknown }): void {
  const expected = Number(s.expectedHours)
  const full = s.minFullDayHours == null ? expected * 0.75 : Number(s.minFullDayHours)
  const half = s.minHalfDayHours == null ? expected * 0.5 : Number(s.minHalfDayHours)
  if (s.minFullDayHours != null && full > expected) {
    throw BadRequest(`A full day cannot need more than the shift's ${expected} hours.`)
  }
  if (half > full) throw BadRequest(`A half day (${half} h) cannot need more hours than a full day (${full} h).`)
}

export async function addShift(ctx: AppContext, input: Required<repo.ShiftFields> & repo.ShiftRuleFields) {
  assertHoursFit(input)
  const existing = await repo.findShiftByName(ctx.db, input.name.trim())
  if (existing && !existing.archivedAt) throw Conflict(`A shift called "${existing.name}" already exists`)

  if (existing) {
    const restored = await withAudit(
      ctx,
      (tx) => repo.updateShift(tx, existing.id, { ...input, name: input.name.trim(), archivedAt: null }),
      () => ({ action: 'master_data.restored', entityType: 'shift', entityId: existing.id, details: { kind: 'shift', ...input } }),
    )
    return { row: restored, restored: true }
  }

  const row = await withAudit(
    ctx,
    (tx) => repo.createShift(tx, ctx.organizationId, { ...input, name: input.name.trim() }),
    (created) => ({ action: 'master_data.added', entityType: 'shift', entityId: created.id, details: { kind: 'shift', ...input } }),
  )
  logger.info('Shift added', { by: ctx.userId, id: row.id })
  return { row, restored: false }
}

/**
 * Changing a shift's hours changes how FUTURE days are read. Days already
 * recorded keep the expected hours they were measured against — the attendance
 * row stores its own copy — so editing a shift never rewrites last month.
 */
export async function editShift(ctx: AppContext, id: string, input: repo.ShiftFields & repo.ShiftRuleFields) {
  const row = await repo.findShiftById(ctx.db, id)
  if (!row) throw NotFound('That shift does not exist')

  if (input.name !== undefined) {
    const clash = await repo.findShiftByName(ctx.db, input.name.trim())
    if (clash && clash.id !== id) throw Conflict(`A shift called "${clash.name}" already exists`)
  }
  // Checked against what is stored, as changed: a change to one figure can upset another.
  assertHoursFit({
    expectedHours: input.expectedHours ?? row.expectedHours,
    minFullDayHours: input.minFullDayHours !== undefined ? input.minFullDayHours : row.minFullDayHours,
    minHalfDayHours: input.minHalfDayHours !== undefined ? input.minHalfDayHours : row.minHalfDayHours,
  })

  return withAudit(
    ctx,
    (tx) => repo.updateShift(tx, id, { ...input, ...(input.name !== undefined ? { name: input.name.trim() } : {}) }),
    () => ({
      action: 'master_data.changed',
      entityType: 'shift',
      entityId: id,
      // The old value beside each new one (client §47).
      details: { kind: 'shift', name: row.name, changes: input, before: Object.fromEntries(Object.keys(input).map((k) => [k, asStored((row as Record<string, unknown>)[k])])) },
    }),
  )
}

export async function archiveShift(ctx: AppContext, id: string) {
  const row = await repo.findShiftById(ctx.db, id)
  if (!row) throw NotFound('That shift does not exist')
  if (row.archivedAt) return row
  return withAudit(
    ctx,
    (tx) => repo.updateShift(tx, id, { archivedAt: new Date() }),
    () => ({ action: 'master_data.archived', entityType: 'shift', entityId: id, details: { kind: 'shift', name: row.name } }),
  )
}

/** A stored value as the audit log keeps it — a Decimal as its number. */
function asStored(value: unknown): unknown {
  return value !== null && typeof value === 'object' && 'toNumber' in value ? (value as { toNumber(): number }).toNumber() : value
}
