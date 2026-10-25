import type { ScopedDb } from '../../platform/db/scoped'
import { withTransaction } from '../../platform/db/transaction'
import { logger } from '../../platform/logger'
import { addCalendarDays, dayLabel, fromDateColumn, toDateColumn, zonedToday, zonedDateTime } from '../../domain/shared/dates'
import { dayEndsAt } from '../../domain/attendance/noCheckIn'
import { notify } from '../notifications/notify.service'
import { markNudged, openDays, timezoneOf } from './checkOutNudge.repository'

/**
 * Checked in and not out (client, 25 Oct 2026). The day stays Present, as it
 * always has — the client's choice — and HR sees it under "No out" on the
 * roster. The person is told once, two hours after their shift ended, while
 * they can still put it right: check out if they are at work, ask for a
 * correction if they left.
 *
 * Run every hour (scripts/hourly.ts): a nightly run would tell them at 3 a.m.
 */

/** How long after the shift's end the person is told. */
export const NUDGE_AFTER_MINUTES = 120

export async function nudgeCheckOuts(db: ScopedDb, organizationId: string, options: { apply: boolean; now?: Date }): Promise<{ due: number; told: number }> {
  const now = options.now ?? new Date()
  const timezone = await timezoneOf(db, organizationId)
  const today = zonedToday(now, timezone)
  // A night shift's day is yesterday's until the morning; two days back covers every shift.
  const open = await openDays(db, toDateColumn(addCalendarDays(today, -2)), toDateColumn(today))
  const due = open.filter((row) => {
    if (row.employee.archivedAt || row.employee.attendanceMode !== 'app') return false
    const ends = dayEndsAt(fromDateColumn(row.date), row.shift ?? row.employee.shift, timezone)
    return now.getTime() >= ends.getTime() + NUDGE_AFTER_MINUTES * 60_000
  })
  if (!options.apply) return { due: due.length, told: 0 }

  let told = 0
  for (const row of due) {
    await withTransaction(db, async (tx) => {
      if (!(await markNudged(tx, row.id, now))) return
      const day = fromDateColumn(row.date)
      await notify({ userId: '', organizationId }, tx, {
        event: 'attendance.no_check_out',
        to: { employee: row.employeeId },
        title: `No check-out on ${dayLabel(day)}`,
        message: `You checked in on ${dayLabel(day)} at ${zonedDateTime(row.checkIn!, timezone).slice(11, 16)} and have not checked out. If you are still at work, check out when you leave. If you left, ask for an attendance correction in Requests with the time you left — until then the day's hours are not counted.`,
        link: '/attendance',
      })
      told += 1
    })
  }
  logger.info('Check-out reminders', { organizationId, due: due.length, told })
  return { due: due.length, told }
}
