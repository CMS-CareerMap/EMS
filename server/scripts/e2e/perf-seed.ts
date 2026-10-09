// A company the size CareerMap could grow to, for timing the heavy screens:
// 200 people, a year of attendance each, salaries and bank accounts. In its own
// LOCAL database, ems_perf — never Neon, never the test or demo databases.
//
//   tsx perf-seed.ts seed     (run through `node scripts/perf.mjs` in e2e/)
import { writeFileSync } from 'node:fs'
import type { Prisma } from '@prisma/client'
import { assertLocalDatabase, fixturePath } from './fixture'
import { prisma } from '../../src/platform/db/prisma'
import { hashPassword } from '../../src/platform/auth/password'
import { seedForOrganization } from '../../prisma/seed/referenceData'
import { addCalendarDays, fromDateColumn, toDateColumn, zonedToday, type CalendarDate } from '../../src/domain/shared/dates'

assertLocalDatabase()
if (!new URL(process.env.DATABASE_URL ?? '').pathname.endsWith('/ems_perf')) {
  throw new Error('Refusing: this seed writes only to the local ems_perf database')
}

const PEOPLE = 200
const PASSWORD = 'PerfTest2026!'
const TZ = 'Asia/Kolkata'
const at = (d: CalendarDate, hhmm: string) => new Date(`${d}T${hhmm}:00+05:30`)

async function seed() {
  if (await prisma.organization.count()) throw new Error('ems_perf already has a company')
  const today = zonedToday(new Date(), TZ)
  const org = await prisma.organization.create({ data: { name: 'Perf Co', timezone: TZ, state: 'Maharashtra' } })
  const organizationId = org.id
  await prisma.$transaction((tx) => seedForOrganization(tx, { id: organizationId, timezone: TZ }), { timeout: 60_000 })
  await prisma.organizationPolicy.updateMany({ where: { organizationId }, data: { effectiveFrom: toDateColumn('2024-04-01') } })
  await prisma.ptSlab.updateMany({ where: { organizationId }, data: { effectiveFrom: toDateColumn('2024-04-01') } })

  const user = await prisma.user.create({ data: { email: 'perf-admin@example.com', passwordHash: await hashPassword(PASSWORD) } })
  await prisma.membership.create({ data: { userId: user.id, organizationId, role: 'super_admin', status: 'active' } })

  const departments = await prisma.department.findMany({ where: { organizationId } })
  const component = Object.fromEntries((await prisma.salaryComponent.findMany({ where: { organizationId } })).map((c) => [c.code, c.id]))
  const general = await prisma.shift.findFirstOrThrow({ where: { organizationId, name: 'General' } })
  const leaveTypes = await prisma.leaveType.findMany({ where: { organizationId, code: { in: ['CL', 'SL', 'EL'] } } })
  const holidays = new Set((await prisma.holiday.findMany({ where: { organizationId } })).map((h) => fromDateColumn(h.date)))
  const joined = '2025-01-01'

  const ids: string[] = []
  for (let i = 1; i <= PEOPLE; i++) {
    const basic = 10_000 + (i % 20) * 2_000
    const e = await prisma.employee.create({
      data: {
        organizationId, employeeCode: `P${String(i).padStart(4, '0')}`, fullName: `Person ${i}`, gender: i % 3 ? 'male' : 'female',
        dateOfJoining: toDateColumn(joined), departmentId: departments[i % departments.length]!.id, shiftId: general.id,
        onboardedOn: toDateColumn(joined), confirmedOn: toDateColumn('2025-07-01'),
        statutoryIdentity: { create: { organizationId, ptState: 'Maharashtra', pfApplicable: true, hasPriorPfMembership: true } },
        financials: {
          create: {
            organizationId, ctc: (basic * 1.6) * 12, effectiveFrom: toDateColumn(joined),
            components: { create: [['BASIC', basic], ['HRA', basic * 0.4], ['SPECIAL', basic * 0.2]].map(([code, amount]) => ({ organizationId, salaryComponentId: component[code as string]!, amount: amount as number })) },
          },
        },
        bankAccount: { create: { organizationId, bankName: 'State Bank of India', accountHolderName: `PERSON ${i}`, accountNumber: `3020${String(i).padStart(8, '0')}`, ifsc: 'SBIN0001234', verificationStatus: 'verified', verifiedAt: new Date() } },
      },
    })
    ids.push(e.id)
  }

  // Leave balances for the leave years the year of attendance touches.
  const years = new Set<number>()
  for (let d = addCalendarDays(today, -366); d <= today; d = addCalendarDays(d, 30)) years.add(Number(d.slice(5, 7)) >= 4 ? Number(d.slice(0, 4)) : Number(d.slice(0, 4)) - 1)
  await prisma.leaveLedgerEntry.createMany({
    data: ids.flatMap((employeeId) => [...years].flatMap((leaveYear) => leaveTypes.map((t) => ({ organizationId, employeeId, leaveTypeId: t.id, leaveYear, days: Number(t.annualQuota), reason: 'opening_grant' as const })))),
  })

  // A year of attendance: every working day, a punch in and out; one day in forty absent.
  let rows: Prisma.AttendanceCreateManyInput[] = []
  let total = 0
  for (const [n, employeeId] of ids.entries()) {
    for (let d = addCalendarDays(today, -365); d < today; d = addCalendarDays(d, 1)) {
      if (new Date(`${d}T00:00:00Z`).getUTCDay() === 0 || holidays.has(d)) continue
      const absent = (n * 31 + Number(d.slice(8, 10)) * 7 + Number(d.slice(5, 7))) % 40 === 0
      rows.push(absent
        ? { organizationId, employeeId, date: toDateColumn(d), status: 'absent', source: 'biometric' }
        : { organizationId, employeeId, date: toDateColumn(d), status: 'present', source: 'biometric', checkIn: at(d, '09:25'), checkOut: at(d, '18:40'), hoursWorked: 9.25, shiftId: general.id, expectedHours: 9, lateMinutes: 0, earlyLeavingMinutes: 0, overtimeMinutes: 0 })
      if (rows.length >= 5_000) {
        total += (await prisma.attendance.createMany({ data: rows })).count
        rows = []
      }
    }
  }
  if (rows.length) total += (await prisma.attendance.createMany({ data: rows })).count

  writeFileSync(fixturePath('perf-fixture.json'), JSON.stringify({ email: 'perf-admin@example.com', password: PASSWORD, people: PEOPLE, attendanceDays: total }, null, 2))
  console.log(`perf company seeded: ${PEOPLE} people, ${total} attendance days`)
}

const [mode] = process.argv.slice(2)
;(mode === 'seed' ? seed() : Promise.reject(new Error('Usage: tsx perf-seed.ts seed')))
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
