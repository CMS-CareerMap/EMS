/**
 * Leave requests as the applications people made (client, 9 Oct 2026).
 *
 * An application whose paid balance runs out is saved in parts — the days the
 * paid type covers, and the rest as unpaid leave — each a request of its own
 * type, sharing a group id. Everywhere a person reads requests, the parts are
 * one application: one line to approve, one count of what waits.
 *
 * Parts are put together while they stand alike. They are decided together,
 * so they always do — except when a last working day cancels the part after
 * it (leaveApproval.service settleLeaveAfter); then each is shown as it stands.
 */

export interface GroupedRow {
  id: string
  groupId: string | null
  status: string
}

export interface Application<T> {
  /** The earliest part — whose id the screens act on; the server acts on every part. */
  lead: T
  /** Every part, earliest first. One for an application of one type. */
  parts: T[]
}

/**
 * The rows as applications, in the order the rows came — each at its first
 * part's place. `startOf` gives a part's first day, to put the parts in order.
 */
export function asApplications<T extends GroupedRow>(rows: readonly T[], startOf: (row: T) => string): Application<T>[] {
  const out: Application<T>[] = []
  const byGroup = new Map<string, Application<T>>()
  for (const row of rows) {
    if (!row.groupId) {
      out.push({ lead: row, parts: [row] })
      continue
    }
    const key = `${row.groupId}|${row.status}`
    const found = byGroup.get(key)
    if (found) {
      found.parts.push(row)
      continue
    }
    const application = { lead: row, parts: [row] }
    byGroup.set(key, application)
    out.push(application)
  }
  for (const application of byGroup.values()) {
    application.parts.sort((a, b) => startOf(a).localeCompare(startOf(b)))
    application.lead = application.parts[0]!
  }
  return out
}

/** A teammate's leave, waiting or approved, as read to say who is away. */
export interface TeamLeaveRow {
  id: string
  employeeId: string
  groupId: string | null
  status: 'pending' | 'approved'
  from: string
  to: string
  typeName: string
}

/** One teammate away during a range: one line an application, its types joined. */
export interface AwayLine {
  employeeId: string
  fullName: string
  typeName: string
  status: 'pending' | 'approved'
  from: string
  to: string
}

/**
 * Who of a team is away on any day of a range (client, 10 Oct 2026): their
 * leave waiting or approved that touches it — one line an application, an
 * application in parts as one — for whoever decides a request to see before
 * they decide it. `team` maps each teammate to their name; the person asking
 * is left out by the caller.
 */
export function awayDuring(range: { from: string; to: string }, team: ReadonlyMap<string, string>, leave: readonly TeamLeaveRow[]): AwayLine[] {
  // Each application whole first — a part outside the range still says what the application is — then those touching it.
  const byApplication = new Map<string, AwayLine>()
  for (const l of leave.filter((row) => team.has(row.employeeId))) {
    const key = `${l.groupId ?? l.id}|${l.status}`
    const line = byApplication.get(key)
    if (line) {
      if (!line.typeName.split(' + ').includes(l.typeName)) line.typeName = `${line.typeName} + ${l.typeName}`
      if (l.from < line.from) line.from = l.from
      if (l.to > line.to) line.to = l.to
      continue
    }
    byApplication.set(key, { employeeId: l.employeeId, fullName: team.get(l.employeeId)!, typeName: l.typeName, status: l.status, from: l.from, to: l.to })
  }
  return [...byApplication.values()]
    .filter((a) => a.from <= range.to && a.to >= range.from)
    .sort((a, b) => a.from.localeCompare(b.from) || a.fullName.localeCompare(b.fullName))
}

/** How many applications are among these rows: the parts of one count once. */
export function applicationCount(rows: readonly { id: string; groupId: string | null }[]): number {
  return new Set(rows.map((r) => r.groupId ?? r.id)).size
}
