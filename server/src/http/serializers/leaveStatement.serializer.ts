import { isoInstant } from '../../domain/shared/dates'
import { leaveYearLabel } from '../../domain/leave/grant'
import type { StatementLine } from '../../modules/leave/leave.service'

/**
 * A leave statement out (client, 10 Oct 2026): the type, the year, and every
 * movement in the balance with the balance after it — one shape for the
 * person's own and for HR's view of it on the profile.
 */
export function statementPayload(s: {
  type: { id: string; code: string; name: string; isPaid: boolean }
  leaveYear: number
  startMonth: number
  balance: number
  taken: number
  unlimited: boolean
  lines: StatementLine[]
}) {
  return {
    leave_type_id: s.type.id,
    code: s.type.code,
    name: s.type.name,
    is_paid: s.type.isPaid,
    unlimited: s.unlimited,
    leave_year: s.leaveYear,
    label: leaveYearLabel(s.leaveYear, s.startMonth),
    balance: s.balance,
    taken: s.taken,
    lines: s.lines.map((l) => ({
      id: l.id,
      at: isoInstant(l.at),
      reason: l.reason,
      days: l.days,
      note: l.note,
      from_date: l.fromDate,
      to_date: l.toDate,
      balance: l.balance,
    })),
  }
}
