import type { TxDb } from '../../platform/db/transaction'
import { dayLabel, type CalendarDate } from '../../domain/shared/dates'
import { notify, type NoticeActor } from '../notifications/notify.service'
import { usersOfEmployeeHolding } from '../notifications/notification.repository'

/**
 * An absent day, told to the person (client, 10 Oct 2026): HR marked it, the
 * machine's file had no times, a correction or a check-out came short of a
 * half day. The day stays Absent — and is cut from pay — unless they apply
 * for leave for it; with leave left, the day is paid. The notice carries the
 * way to: the leave form on that day.
 *
 * Told when a day BECOMES absent, not every time an absent day is touched:
 * the callers compare with what was there before. In the caller's transaction.
 * A check-out is the person's own act: `includeActor` tells them all the same.
 * Told on the logins they apply for leave from — the link is the way to; on
 * another (an Accounts role login beside theirs, Day 23) it would lead nowhere.
 */
export async function tellAbsent(actor: NoticeActor, tx: TxDb, employeeId: string, days: readonly CalendarDate[], options: { includeActor?: boolean } = {}): Promise<void> {
  const sorted = [...new Set(days)].sort()
  if (sorted.length === 0) return
  const one = sorted.length === 1 ? sorted[0]! : null
  await notify(actor, tx, {
    event: 'attendance.absent',
    to: { users: await usersOfEmployeeHolding(tx, employeeId, 'leave:apply') },
    title: one ? `Marked absent on ${dayLabel(one)}` : `Marked absent on ${sorted.length} days`,
    message: `${one ? `You were marked absent on ${dayLabel(one)}.` : `You were marked absent on ${sorted.map((d) => dayLabel(d)).join(', ')}.`} An absent day is cut from pay. If you were on leave, apply for it — with leave left, the day is paid. Attendance shows each absent day with "Apply leave".`,
    link: one ? `/leave?apply=1&from=${one}&to=${one}` : '/attendance',
    ...(options.includeActor ? { includeActor: true } : {}),
  })
}
