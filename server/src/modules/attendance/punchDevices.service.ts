import { createHash } from 'node:crypto'
import type { AppContext } from '../../platform/context'
import { Conflict, NotFound } from '../../platform/errors/AppError'
import { withTransaction, type TxDb } from '../../platform/db/transaction'
import { lockFor } from '../../platform/db/locks'
import { audit } from '../audit/audit.service'
import { notify } from '../notifications/notify.service'
import { personBrief } from '../notifications/notification.repository'
import { assertWorkGoesUp } from '../organization/workRules.service'
import * as repo from './attendance.repository'

/**
 * One phone per employee (client, 11 Oct 2026), a setting of the Super Admin's.
 *
 * A phone is known by a random key its browser keeps (lib/deviceKey.js), held
 * here only as a hash. With the setting on, the first phone a person punches
 * from is theirs; a punch from another waits for HR — who is told — and
 * approving the new one takes the old one off. So a password lent to a friend
 * does not lend the punch with it. Clearing the browser's data, or a private
 * window, looks like a new phone: the person asks HR again.
 */

export function hashDeviceKey(key: string | null | undefined): string | null {
  const trimmed = key?.trim()
  return trimmed ? createHash('sha256').update(trimmed).digest('hex') : null
}

export type DeviceVerdict = 'ok' | 'waiting' | 'no_key'

/**
 * Whether a punch from this phone is taken, with "one phone" on. Under the
 * person's own lock, so two first punches at once from two phones do not both
 * become theirs. HR is told once, when a phone first starts waiting.
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
    // The very first phone is theirs, by itself. Once HR has taken one off, every
    // new one waits for them: clearing the browser's data never re-registers.
    if (devices.length === 0) {
      await repo.createDevice(tx, { organizationId: ctx.organizationId, employeeId, keyHash, label, status: 'approved' })
      return 'ok'
    }
    // Another phone: it waits for HR — who are told the first time it does.
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

async function tellWaiting(ctx: AppContext, tx: TxDb, employeeId: string, label: string | null) {
  const person = await personBrief(tx, employeeId)
  await notify(ctx, tx, {
    event: 'attendance.device_waiting',
    to: { reaching: { permission: 'attendance:update', resource: 'attendance', employeeId } },
    title: `${person?.fullName ?? 'Somebody'} punched from a new phone`,
    message: `${person?.fullName ?? 'Somebody'} tried to punch from ${label ?? 'a phone'} that is not approved for them. Approve it under Attendance → Suspicious if it is theirs now.`,
    link: '/attendance?view=suspicious',
    entity: { type: 'employee', id: employeeId },
  })
}

const STATUS_ORDER = { waiting: 0, approved: 1, retired: 2 } as const

/**
 * Phones of the people in reach — waiting first, then the most recently used —
 * for whoever corrects their attendance. Never the caller's own (their own
 * work goes up), unless they are the Super Admin.
 */
export async function listDevices(ctx: AppContext, status: 'waiting' | 'all') {
  const devices = await repo.devicesInScope(ctx.db, ctx.scopeFor('attendance'), status, notOwn(ctx))
  return devices.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.lastSeenAt.getTime() - a.lastSeenAt.getTime())
}

/** The caller's own employee row, to leave out of what they look after — none for the Super Admin, who has nobody above. */
export const notOwn = (ctx: AppContext): string | null => (ctx.can('role:manage') ? null : ctx.employeeId)

/**
 * A phone in reach, for a decision on it: the same rule as correcting the
 * person's attendance — never one's own, a fellow HR's or a senior's; those
 * go up the tree. Read again under the person's lock, so two decisions at
 * once are taken one after the other.
 */
async function deviceToDecide(ctx: AppContext, tx: TxDb, id: string) {
  const found = await repo.deviceInScope(ctx.db, ctx.scopeFor('attendance'), id)
  if (!found) throw NotFound('That phone is not one of the people you look after.')
  await assertWorkGoesUp(ctx, tx, 'attendance', found.employeeId)
  await lockFor(tx, `punch-device:${found.employeeId}`)
  const device = await repo.deviceById(tx, id)
  if (!device) throw NotFound('That phone is not one of the people you look after.')
  return { ...device, employee: found.employee }
}

/** Approving a phone takes the person's others off: one phone. The person is told. */
export async function approveDevice(ctx: AppContext, id: string) {
  return withTransaction(ctx.db, async (tx) => {
    const device = await deviceToDecide(ctx, tx, id)
    if (device.status === 'approved') throw Conflict('That phone is already approved.')
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

/** Taking a phone off: punches from it wait for HR again. */
export async function retireDevice(ctx: AppContext, id: string) {
  return withTransaction(ctx.db, async (tx) => {
    const device = await deviceToDecide(ctx, tx, id)
    if (device.status === 'retired') throw Conflict('That phone is already off.')
    const saved = await repo.updateDevice(tx, id, { status: 'retired', decidedByUserId: ctx.userId, decidedAt: new Date() })
    await audit(ctx, { action: 'attendance.device_retired', entityType: 'punch_device', entityId: id, details: { employeeId: device.employeeId, label: device.label } }, tx)
    return saved
  })
}
