import { prisma, disconnect } from '../src/platform/db/prisma'
import { logger } from '../src/platform/logger'
import { fromDateColumn, zonedToday } from '../src/domain/shared/dates'
import { leaveYearLabel, planGrant, type GrantEntry } from '../src/domain/leave/grant'

/**
 * Grants the year's leave to everybody who has not had it yet.
 *
 *   npm run grant-leave              this leave year
 *   npm run grant-leave -- 2025      a specific one
 *
 * HR does this from the app now (Leave → Team Balances → Grant leave); this is
 * the same grant from the terminal, for a server with nobody signed in. Both
 * use domain/leave/grant.ts, so they cannot grant by different rules: a full
 * year for everybody here from the start, the months that are left for a
 * joiner, nothing for anybody who has already left, and last
 * year's unused days carried in up to each type's cap.
 *
 * IDEMPOTENT, and that matters more here than anywhere else. Running it twice
 * would otherwise grant the year twice, and the error would show up as
 * everybody mysteriously having double their entitlement — which nobody
 * reports, because who complains about extra leave? The grant takes the same
 * lock as the button, so the two cannot overlap either.
 */

/** Which leave year a date falls in, given the month the year starts. */
function leaveYearOf(date: string, startMonth: number): number {
  const [year, month] = date.split('-').map(Number)
  return month! >= startMonth ? year! : year! - 1
}

interface GrantSummary {
  organization: string
  label: string
  employeesConsidered: number
  entriesCreated: number
  proRated: number
  carriedForward: number
}

async function grantForOrganization(organizationId: string, organizationName: string, requestedYear?: number): Promise<GrantSummary> {
  const [organization, policy] = await Promise.all([
    prisma.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { timezone: true } }),
    prisma.organizationPolicy.findFirst({ where: { organizationId, effectiveTo: null } }),
  ])
  const startMonth = policy?.leaveYearStartMonth ?? 4
  const today = zonedToday(new Date(), organization.timezone)
  const leaveYear = requestedYear ?? leaveYearOf(today, startMonth)

  return prisma.$transaction(async (tx) => {
    // The same lock as the Leave page's button (leaveBalances.service.ts).
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`leave-grant:${organizationId}:${leaveYear}`}))`

    const employees = await tx.employee.findMany({
      where: { organizationId, archivedAt: null },
      select: { id: true, dateOfJoining: true, lastWorkingDate: true, status: true },
    })
    const ids = employees.map((e) => e.id)
    const [leaveTypes, already, lastYear, lastYearPending] = await Promise.all([
      tx.leaveType.findMany({ where: { organizationId, archivedAt: null } }),
      tx.leaveLedgerEntry.findMany({
        where: { organizationId, leaveYear, reason: { in: ['opening_grant', 'carry_forward'] } },
        select: { employeeId: true, leaveTypeId: true, reason: true },
      }),
      tx.leaveLedgerEntry.groupBy({
        by: ['employeeId', 'leaveTypeId'],
        where: { organizationId, employeeId: { in: ids }, leaveYear: leaveYear - 1 },
        _sum: { days: true },
      }),
      tx.leaveRequest.groupBy({
        by: ['employeeId', 'leaveTypeId'],
        where: { organizationId, employeeId: { in: ids }, leaveYear: leaveYear - 1, status: 'pending' },
        _sum: { days: true },
      }),
    ])
    // Last year's balance less what is still applied for in it, as the app counts it.
    const left = new Map(lastYear.map((t) => [`${t.employeeId}|${t.leaveTypeId}`, Number(t._sum.days ?? 0)]))
    for (const p of lastYearPending) {
      const key = `${p.employeeId}|${p.leaveTypeId}`
      left.set(key, (left.get(key) ?? 0) - Number(p._sum.days ?? 0))
    }

    const entries = planGrant({
      leaveYear,
      startMonth,
      today,
      employees: employees.map((e) => ({ id: e.id, dateOfJoining: fromDateColumn(e.dateOfJoining), lastWorkingDate: fromDateColumn(e.lastWorkingDate), active: e.status === 'active' })),
      leaveTypes: leaveTypes.map((t) => ({ id: t.id, annualQuota: Number(t.annualQuota), carryForward: t.carryForward, carryForwardCap: Number(t.carryForwardCap) })),
      already: already.map((a) => ({ employeeId: a.employeeId, leaveTypeId: a.leaveTypeId, reason: a.reason as GrantEntry['reason'] })),
      lastYearLeft: (employeeId, leaveTypeId) => left.get(`${employeeId}|${leaveTypeId}`) ?? 0,
    })

    if (entries.length > 0) {
      await tx.leaveLedgerEntry.createMany({
        data: entries.map((e) => ({ organizationId, employeeId: e.employeeId, leaveTypeId: e.leaveTypeId, leaveYear: e.leaveYear, days: e.days, reason: e.reason, note: e.note })),
      })
      await tx.auditLog.create({
        data: {
          organizationId,
          actorUserId: null,
          action: 'leave.granted',
          entityType: 'leave_year',
          details: {
            leaveYear,
            label: leaveYearLabel(leaveYear, startMonth),
            entries: entries.filter((e) => e.leaveYear === leaveYear).length,
            people: new Set(entries.filter((e) => e.leaveYear === leaveYear).map((e) => e.employeeId)).size,
            days: entries.filter((e) => e.leaveYear === leaveYear).reduce((a, e) => a + e.days, 0),
            via: 'terminal',
          },
        },
      })
    }

    return {
      organization: organizationName,
      label: leaveYearLabel(leaveYear, startMonth),
      employeesConsidered: employees.length,
      entriesCreated: entries.filter((e) => e.reason === 'opening_grant').length,
      proRated: entries.filter((e) => e.reason === 'opening_grant' && e.note).length,
      carriedForward: entries.filter((e) => e.reason === 'carry_forward' && e.leaveYear === leaveYear).length,
    }
  })
}

async function main(): Promise<void> {
  const requested = process.argv[2] ? Number(process.argv[2]) : undefined

  if (requested !== undefined && (Number.isNaN(requested) || requested < 2000 || requested > 2100)) {
    console.error('\n  Usage: npm run grant-leave -- [year]\n')
    process.exitCode = 1
    return
  }

  const organizations = await prisma.organization.findMany({ select: { id: true, name: true } })

  if (organizations.length === 0) {
    logger.info('No organizations yet; run npm run bootstrap first')
    return
  }

  for (const organization of organizations) {
    const summary = await grantForOrganization(organization.id, organization.name, requested)

    console.log('')
    console.log(`  ${summary.organization} — leave year ${summary.label}`)
    console.log(`    employees            ${summary.employeesConsidered}`)
    console.log(`    opening grants made  ${summary.entriesCreated} (${summary.proRated} pro-rated)`)
    console.log(`    carried forward      ${summary.carriedForward}`)
  }

  console.log('')
  console.log('  Safe to run again — nobody is granted twice.')
  console.log('')
}

main()
  .catch((err: unknown) => {
    logger.error('Leave grant failed', { error: err instanceof Error ? err.message : String(err) })
    process.exitCode = 1
  })
  .finally(disconnect)
