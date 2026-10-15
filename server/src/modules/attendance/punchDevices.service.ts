import { createHash } from 'node:crypto'
import type { AppContext } from '../../platform/context'
import { Conflict, NotFound } from '../../platform/errors/AppError'
import { withTransaction, type TxDb } from '../../platform/db/transaction'
import { lockFor } from '../../platform/db/locks'
import { audit } from '../audit/audit.service'
import { notify } from '../notifications/notify.service'
import { personBrief } from '../notifications/notification.repository'
import { assertMayDecidePhone, checkPhoneWork, loadWork } from '../organization/workRules.service'
import { attendanceSecurityOf } from '../settings/settings.repository'
import * as repo from './attendance.repository'

/**
 * One phone per employee (client, 11 and 14 Oct 2026), a setting of the
 * Super Admin's that works with whichever punch method is chosen.
 *
 * A phone is known by a random key its browser keeps (lib/deviceKey.js), held
 * here only as a hash. With the setting on, the first phone a person punches
 * from is theirs, by itself. A punch from another is refused — the person is
 * told to ask HR, and whoever may replace their phone is told too. Approving
 * the new one takes the old one off in the same step (Replace), so nobody is
 * ever left with neither. Resetting takes their phone off, and the next new
 * phone they punch from becomes theirs, as the first one did.
 *
 * Who may do either is a permission like any other — `user:device:manage`,
 * given to whichever roles the Super Admin chooses, reaching the people their
 * employee records reach — never a role's name.
 *
 * Clearing the browser's data, or a private window, looks like a new phone:
 * refused while the person has a phone, and the person asks HR.
 */

export function hashDeviceKey(key: string | null | undefined): string | null {
  const trimmed = key?.trim()
  return trimmed ? createHash('sha256').update(trimmed).digest('hex') : null
}

export type DeviceVerdict = 'ok' | 'waiting' | 'no_key'

/**
 * Whether a punch from this phone is taken, with "one phone" on. Under the
 * person's own lock, so two first punches at once from two phones do not both
 * become theirs.
 *
 *   - their phone: taken;
 *   - a phone never seen for them, while they have none — their very first,
 *     or the first since HR reset theirs: theirs from now on, by itself;
 *   - any other: it waits for a decision, and whoever may make it is told the
 *     first time it waits (and again when a phone taken off comes back).
 */
export async function deviceVerdict(ctx: AppContext, employeeId: string, keyHash: string | null, label: string | null): Promise<DeviceVerdict> {
  if (!keyHash) return 'no_key'
  return withTransaction(ctx.db, async (tx) => {
    await lockFor(tx, `punch-device:${employeeId}`)
    const devices = await repo.devicesOf(tx, employeeId)
    const now = new Date()
    const mine = devices.find((d) => d.keyHash === keyHash)
    if (mine?.status === 'approved') {
      await repo.updateDevice(tx, mine.id, { lastSeenAt: now })
      return 'ok'
    }
    // A phone never seen, and no phone of theirs: the first, or the first since a reset.
    // A phone taken off before is never one of these: it waits, as it did.
    if (!mine && !devices.some((d) => d.status === 'approved')) {
      await repo.createDevice(tx, { organizationId: ctx.organizationId, employeeId, keyHash, label, status: 'approved' })
      return 'ok'
    }
    if (!mine) {
      const waiting = await repo.createDevice(tx, { organizationId: ctx.organizationId, employeeId, keyHash, label, status: 'waiting' })
      await tellWaiting(ctx, tx, employeeId, waiting.label)
    } else {
      const wasRetired = mine.status === 'retired'
      await repo.updateDevice(tx, mine.id, { lastSeenAt: now, ...(wasRetired ? { status: 'waiting', decidedByUserId: null, decidedAt: null } : {}) })
      if (wasRetired) await tellWaiting(ctx, tx, employeeId, mine.label)
    }
    return 'waiting'
  })
}

/** Where a person's phones are decided: their page, Logins tab — Admin opens it too, without the Attendance pages. */
const phonesOf = (employeeId: string) => `/employees/${employeeId}?tab=logins`

async function tellWaiting(ctx: AppContext, tx: TxDb, employeeId: string, label: string | null) {
  const person = await personBrief(tx, employeeId)
  const name = person?.fullName ?? 'Somebody'
  await notify(ctx, tx, {
    event: 'attendance.device_waiting',
    to: { reaching: { permission: 'user:device:manage', resource: 'employee', employeeId, work: 'phone' } },
    title: `${name} punched from a new phone`,
    message: `${name} tried to punch from ${label ?? 'a phone'} that is not their registered phone. If it is theirs now, replace their phone with it on their page, under Punch phone.`,
    link: phonesOf(employeeId),
    entity: { type: 'employee', id: employeeId },
  })
}

const STATUS_ORDER = { waiting: 0, approved: 1, retired: 2 } as const

export interface DeviceRow {
  id: string
  employeeId: string
  fullName: string
  employeeCode: string
  label: string | null
  status: 'waiting' | 'approved' | 'retired'
  firstSeenAt: Date
  lastSeenAt: Date
  decidedAt: Date | null
  /** Whether the caller may replace or reset it — and if not, who may. */
  mayDecide: boolean
  ask: string | null
}

/**
 * Phones of the people the caller's employee records reach — waiting first,
 * then the most recently used — for whoever may replace them; one person's
 * when `employeeId` is given (their page). Never the caller's own (their own
 * work goes up), unless they are the Super Admin. Each says whether the caller
 * may decide it: a fellow phone-keeper's, or a senior's, goes up.
 */
export async function listDevices(ctx: AppContext, filter: { status: 'waiting' | 'all'; employeeId?: string | undefined }): Promise<{ oneDevice: boolean; phones: DeviceRow[] }> {
  const [devices, loaded, security] = await Promise.all([
    repo.devicesInScope(ctx.db, ctx.scopeFor('employee'), filter.status, notOwn(ctx), filter.employeeId),
    loadWork(ctx.db, ctx.organizationId, 'phone'),
    attendanceSecurityOf(ctx.db, ctx.organizationId),
  ])
  // Whether phones are checked at all: with the switch off nothing waits and nothing is refused,
  // and the person's page says so rather than promise a registration that does not happen.
  const oneDevice = security?.punchOneDevice === true
  const phones = devices
    .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.lastSeenAt.getTime() - a.lastSeenAt.getTime())
    .map((d) => {
      const check = checkPhoneWork(ctx, loaded, d.employeeId)
      return {
        id: d.id,
        employeeId: d.employeeId,
        fullName: d.employee.fullName,
        employeeCode: d.employee.employeeCode,
        label: d.label,
        status: d.status,
        firstSeenAt: d.firstSeenAt,
        lastSeenAt: d.lastSeenAt,
        decidedAt: d.decidedAt,
        mayDecide: check.allowed,
        ask: check.allowed ? null : check.ask,
      }
    })
  return { oneDevice, phones }
}

/** The caller's own employee row, to leave out of what they look after — none for the Super Admin, who has nobody above. */
export const notOwn = (ctx: AppContext): string | null => (ctx.can('role:manage') ? null : ctx.employeeId)

/**
 * A phone in reach, for a decision on it: never one's own, a fellow
 * phone-keeper's or a senior's; those go up the tree. Read again under the
 * person's lock, so two decisions at once are taken one after the other.
 */
async function deviceToDecide(ctx: AppContext, tx: TxDb, id: string) {
  const found = await repo.deviceInScope(ctx.db, ctx.scopeFor('employee'), id)
  if (!found) throw NotFound('That phone is not one of the people you look after.')
  await assertMayDecidePhone(ctx, tx, found.employeeId)
  await lockFor(tx, `punch-device:${found.employeeId}`)
  const device = await repo.deviceById(tx, id)
  if (!device) throw NotFound('That phone is not one of the people you look after.')
  return { ...device, employee: found.employee }
}

/**
 * Replace: this phone becomes the person's, and their others are taken off —
 * in one step, so they are never left with neither. The person is told.
 */
export async function approveDevice(ctx: AppContext, id: string) {
  return withTransaction(ctx.db, async (tx) => {
    const device = await deviceToDecide(ctx, tx, id)
    if (device.status === 'approved') throw Conflict('That phone is already the one they punch from.')
    const now = new Date()
    const saved = await repo.updateDevice(tx, id, { status: 'approved', decidedByUserId: ctx.userId, decidedAt: now })
    const retired = await repo.retireOtherDevices(tx, device.employeeId, id, ctx.userId, now)
    await audit(ctx, { action: 'attendance.device_approved', entityType: 'punch_device', entityId: id, details: { employeeId: device.employeeId, label: device.label, retired } }, tx)
    await notify(ctx, tx, {
      event: 'attendance.device_approved',
      to: { employee: device.employeeId },
      title: 'Your new phone is approved',
      message: `${device.label ?? 'Your new phone'} is approved for checking in and out${retired > 0 ? '; your old one no longer is' : ''}.`,
      link: '/attendance',
      entity: { type: 'punch_device', id },
    })
    return saved
  })
}

/**
 * Taking a phone off. Their phone: a reset — the next new phone they punch
 * from becomes theirs, as their first did, and they are told so. A phone that
 * waited: refused — punches from it stay refused.
 */
export async function retireDevice(ctx: AppContext, id: string) {
  return withTransaction(ctx.db, async (tx) => {
    const device = await deviceToDecide(ctx, tx, id)
    if (device.status === 'retired') throw Conflict('That phone is already off.')
    // A reset lets only a phone never seen register itself: one already waiting would stay refused,
    // against what the person is told. It is replaced with, or refused, first.
    if (device.status === 'approved') {
      const waiting = (await repo.devicesOf(tx, device.employeeId)).find((d) => d.status === 'waiting')
      if (waiting) {
        throw Conflict(`${waiting.label ?? 'Another phone'} is waiting for ${device.employee.fullName}: replace their phone with it, or refuse it first. A reset lets only a phone never used before become theirs.`)
      }
    }
    const saved = await repo.updateDevice(tx, id, { status: 'retired', decidedByUserId: ctx.userId, decidedAt: new Date() })
    await audit(ctx, { action: 'attendance.device_retired', entityType: 'punch_device', entityId: id, details: { employeeId: device.employeeId, label: device.label, was: device.status } }, tx)
    // Told only while phones are checked: with "one phone" off, any phone punches, and the notice would mislead.
    if (device.status === 'approved' && (await attendanceSecurityOf(tx, ctx.organizationId))?.punchOneDevice === true) {
      await notify(ctx, tx, {
        event: 'attendance.device_reset',
        to: { employee: device.employeeId },
        title: 'Your punch phone was reset',
        message: `${device.label ?? 'Your phone'} is no longer the phone you punch from. The next new phone you check in from becomes yours.`,
        link: '/attendance',
        entity: { type: 'punch_device', id },
      })
    }
    return saved
  })
}
