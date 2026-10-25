import type { ScopedDb } from '../../platform/db/scoped'
import { withTransaction } from '../../platform/db/transaction'
import { lockFor } from '../../platform/db/locks'
import { fromDateColumn, zonedToday, type CalendarDate } from '../../domain/shared/dates'
import { auditSystem } from '../audit/audit.service'
import { notify } from '../notifications/notify.service'
import { FIXED_HOLIDAYS } from './fixedHolidays'
import * as repo from './holidayYear.repository'

/**
 * The holiday calendar from one year to the next (client, 25 Oct 2026).
 *
 * The three fixed national holidays were written for the year a company
 * started and the one after, and then by nobody: the third year arrived
 * without Republic Day. The nightly job now adds the next year's three from
 * October — ONCE a year, so one the company removed is not put back — and
 * never on a day already gone. In December, whoever keeps the calendar is told
 * once if the next year has none of the festivals yet, which move every year
 * and only a person can enter.
 */

/** From this month on the next year's fixed holidays are added. */
const ADD_FROM_MONTH = 10
/** In this month the reminder is sent. */
const REMIND_IN_MONTH = 12

const FIXED_DAYS = new Set(FIXED_HOLIDAYS.map((h) => `${String(h.month).padStart(2, '0')}-${String(h.day).padStart(2, '0')}`))

export async function keepHolidayYear(db: ScopedDb, organizationId: string, options: { apply: boolean; now?: Date }) {
  const markers = await repo.markersOf(db, organizationId)
  if (!markers) return { added: 0, years: [] as number[], reminded: false }
  const today: CalendarDate = zonedToday(options.now ?? new Date(), markers.timezone)
  const year = Number(today.slice(0, 4))
  const month = Number(today.slice(5, 7))

  // Up to next year from October; this year's, if a year was ever missed.
  const target = month >= ADD_FROM_MONTH ? year + 1 : year
  const from = (markers.fixedHolidaysThrough ?? year - 1) + 1
  const years: number[] = []
  for (let y = from; y <= target; y++) years.push(y)

  let added = 0
  if (years.length > 0 && options.apply) {
    await withTransaction(db, async (tx) => {
      // One run at a time, and the marker read again under it: two runs add once.
      await lockFor(tx, `fixed-holidays:${organizationId}`)
      const again = await repo.markersOf(tx, organizationId)
      const start = (again?.fixedHolidaysThrough ?? year - 1) + 1
      for (let y = start; y <= target; y++) {
        let addedThisYear = 0
        let skipped = 0
        for (const h of FIXED_HOLIDAYS) {
          const date = `${y}-${String(h.month).padStart(2, '0')}-${String(h.day).padStart(2, '0')}`
          // A day already gone is not made a holiday after the fact; a day with anything entered is the company's.
          if (date < today || (await repo.enteredOn(tx, date))) {
            skipped += 1
            continue
          }
          await repo.addPublic(tx, organizationId, date, h.name)
          addedThisYear += 1
        }
        added += addedThisYear
        await auditSystem(tx, organizationId, { action: 'holiday.fixed_added', entityType: 'organization', entityId: organizationId, details: { year: y, added: addedThisYear, skipped } })
      }
      if (start <= target) await repo.setMarkers(tx, organizationId, { fixedHolidaysThrough: target })
    })
  } else if (years.length > 0) {
    added = years.length * FIXED_HOLIDAYS.length
  }

  // December: next year with nothing but the fixed three — told once.
  let reminded = false
  if (month === REMIND_IN_MONTH && markers.holidayReminderYear !== year) {
    const next = await repo.holidaysOfYear(db, year + 1)
    const festivals = next.filter((h) => !FIXED_DAYS.has(fromDateColumn(h.date).slice(5)))
    if (festivals.length === 0) {
      reminded = true
      if (options.apply) {
        await withTransaction(db, async (tx) => {
          await lockFor(tx, `holiday-reminder:${organizationId}`)
          const again = await repo.markersOf(tx, organizationId)
          if (again?.holidayReminderYear === year) return
          await notify({ userId: '', organizationId }, tx, {
            event: 'holidays.next_year_missing',
            to: { holding: 'holiday:manage' },
            title: `${year + 1}’s holidays are not entered yet`,
            message: `Diwali, Holi, Eid and the other festivals move every year, so ${year + 1}’s have to be entered by hand. Until they are, those days count as working days — leave is charged for them and, with “no check-in means absent” on, nobody who stays home is paid for them. Add them in Settings → Leave Config → Holidays.`,
            link: '/settings?tab=leave#holidays',
          })
          await repo.setMarkers(tx, organizationId, { holidayReminderYear: year })
        })
      }
    }
  }
  return { added, years, reminded }
}
