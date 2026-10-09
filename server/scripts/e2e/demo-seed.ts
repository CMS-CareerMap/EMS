// The demo company: CareerMap Solutions with sixteen people, all seven roles,
// a reporting tree, salaries, bank accounts, leave balances and the last two
// months' attendance — in its OWN local database, ems_demo (never Neon, never
// the test databases). What people DO with it — leave, requests, a payroll —
// is done afterwards through the API by e2e/scripts/demo.mjs, so it is exactly
// what the app itself would have written.
//
//   tsx demo-seed.ts seed     → writes demo-fixture.json (logins, ids, the dates the story uses)
//
// Run it through `npm run demo` in e2e/, which sets everything up.
import { writeFileSync, createWriteStream } from 'node:fs'
import PDFDocument from 'pdfkit'
import { assertLocalDatabase, fixturePath } from './fixture'
import { prisma } from '../../src/platform/db/prisma'
import { hashPassword } from '../../src/platform/auth/password'
import { seedForOrganization } from '../../prisma/seed/referenceData'
import { addCalendarDays, fromDateColumn, monthOfDay, toDateColumn, zonedToday, type CalendarDate } from '../../src/domain/shared/dates'
import { hoursBetween } from '../../src/domain/attendance/hours'
import { measureInstants, shiftRulesOf } from '../../src/domain/attendance/shiftRules'
import { proRatedQuota } from '../../src/domain/leave/grant'

assertLocalDatabase()
const url = new URL(process.env.DATABASE_URL ?? '')
if (!url.pathname.endsWith('/ems_demo')) {
  throw new Error(`Refusing: ${url.hostname}${url.pathname} is not the local ems_demo database`)
}

const FIXTURE = fixturePath('demo-fixture.json')
const HANDBOOK = fixturePath('demo-handbook.pdf')
/** One password for every demo login — a demo, on this machine only. */
const PASSWORD = 'Demo@12345'
const TZ = 'Asia/Kolkata'
const ORG_NAME = 'CareerMap Solutions (Demo)'

const now = new Date()
const today = zonedToday(now, TZ)
const first = (d: CalendarDate) => `${d.slice(0, 7)}-01`
const m0 = first(today)
const m1 = first(addCalendarDays(m0, -1))
const m2 = first(addCalendarDays(m1, -1))
const at = (d: CalendarDate, hhmm: string) => new Date(`${d}T${hhmm}:00+05:30`)
const hhmm = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`

type Role = 'super_admin' | 'admin' | 'hr' | 'manager' | 'rm' | 'accounts' | 'employee'

interface Person {
  key: string
  name: string
  gender: 'male' | 'female'
  dept: string
  designation: string
  manager: string | null
  /** Login emails and the role each one has. */
  logins: [string, Role][]
  salary: Record<string, number>
  ctc: number
  joined: CalendarDate
  phone: string
  pan: string | null
  uan: string | null
  bank: [string, string, string] | null
}

// The tree: Rahul (owner, Super Admin) at the top; Manoj's Sales under him with
// Rekha leading a team; Karan's Technology team; Arjun with one person of his own.
const PEOPLE: Person[] = [
  { key: 'rahul', name: 'Rahul Mehta', gender: 'male', dept: 'Operations', designation: 'Director', manager: null, logins: [['superadmin@example.com', 'super_admin']], salary: { BASIC: 60_000, HRA: 24_000, SPECIAL: 16_000 }, ctc: 1_200_000, joined: '2021-04-01', phone: '9820011001', pan: 'AJKPM1234A', uan: '100200300401', bank: ['HDFC Bank', '50100200300401', 'HDFC0000123'] },
  { key: 'arjun', name: 'Arjun Nair', gender: 'male', dept: 'Operations', designation: 'Senior Manager', manager: 'rahul', logins: [['admin@example.com', 'admin'], ['arjun@example.com', 'employee']], salary: { BASIC: 35_000, HRA: 14_000, SPECIAL: 6_000 }, ctc: 660_000, joined: '2022-06-13', phone: '9820011002', pan: 'BKLPN2345B', uan: '100200300402', bank: ['ICICI Bank', '002101500402', 'ICIC0000021'] },
  { key: 'hema', name: 'Hema Iyer', gender: 'female', dept: 'Human Resources', designation: 'Manager', manager: 'rahul', logins: [['hr@example.com', 'hr']], salary: { BASIC: 30_000, HRA: 12_000, SPECIAL: 5_000 }, ctc: 564_000, joined: '2022-01-10', phone: '9820011003', pan: 'CMNPI3456C', uan: '100200300403', bank: ['State Bank of India', '30200300403', 'SBIN0001234'] },
  { key: 'anil', name: 'Anil Kapoor', gender: 'male', dept: 'Finance', designation: 'Manager', manager: 'rahul', logins: [['accounts@example.com', 'accounts'], ['anil@example.com', 'employee']], salary: { BASIC: 32_000, HRA: 12_800, SPECIAL: 5_200 }, ctc: 600_000, joined: '2022-03-07', phone: '9820011004', pan: 'DNOPK4567D', uan: '100200300404', bank: ['Axis Bank', '917010300404', 'UTIB0000456'] },
  { key: 'manoj', name: 'Manoj Sharma', gender: 'male', dept: 'Sales', designation: 'Senior Manager', manager: 'rahul', logins: [['manager@example.com', 'manager']], salary: { BASIC: 40_000, HRA: 16_000, SPECIAL: 9_000 }, ctc: 780_000, joined: '2021-09-01', phone: '9820011005', pan: 'EPQPS5678E', uan: '100200300405', bank: ['HDFC Bank', '50100200300405', 'HDFC0000123'] },
  { key: 'rekha', name: 'Rekha Rao', gender: 'female', dept: 'Sales', designation: 'Team Lead', manager: 'manoj', logins: [['rm@example.com', 'rm']], salary: { BASIC: 26_000, HRA: 10_400, SPECIAL: 3_600 }, ctc: 480_000, joined: '2023-02-01', phone: '9820011006', pan: 'FQRPR6789F', uan: '100200300406', bank: ['Kotak Mahindra Bank', '4611300406', 'KKBK0000789'] },
  { key: 'priya', name: 'Priya Deshmukh', gender: 'female', dept: 'Sales', designation: 'Executive', manager: 'rekha', logins: [['employee@example.com', 'employee']], salary: { BASIC: 12_000, HRA: 5_000, SPECIAL: 1_000 }, ctc: 216_000, joined: '2024-07-15', phone: '9820011007', pan: 'GRSPD7890G', uan: '100200300407', bank: ['HDFC Bank', '50100200300407', 'HDFC0000123'] },
  { key: 'ravi', name: 'Ravi Patil', gender: 'male', dept: 'Sales', designation: 'Executive', manager: 'rekha', logins: [['ravi@example.com', 'employee']], salary: { BASIC: 13_000, HRA: 5_200, SPECIAL: 800 }, ctc: 228_000, joined: '2024-11-04', phone: '9820011008', pan: 'HSTPP8901H', uan: '100200300408', bank: ['State Bank of India', '30200300408', 'SBIN0001234'] },
  { key: 'sneha', name: 'Sneha Kulkarni', gender: 'female', dept: 'Sales', designation: 'Senior Executive', manager: 'rekha', logins: [['sneha@example.com', 'employee']], salary: { BASIC: 16_000, HRA: 6_400, SPECIAL: 1_600 }, ctc: 288_000, joined: '2023-08-21', phone: '9820011009', pan: 'ITUPK9012J', uan: '100200300409', bank: ['ICICI Bank', '002101500409', 'ICIC0000021'] },
  { key: 'vikram', name: 'Vikram Singh', gender: 'male', dept: 'Sales', designation: 'Senior Executive', manager: 'manoj', logins: [['vikram@example.com', 'employee']], salary: { BASIC: 18_000, HRA: 7_200, SPECIAL: 2_800 }, ctc: 336_000, joined: '2023-05-02', phone: '9820011010', pan: 'JUVPS0123K', uan: '100200300410', bank: ['Axis Bank', '917010300410', 'UTIB0000456'] },
  { key: 'amit', name: 'Amit Verma', gender: 'male', dept: 'Sales', designation: 'Executive', manager: 'manoj', logins: [['amit@example.com', 'employee']], salary: { BASIC: 14_000, HRA: 5_600, SPECIAL: 1_400 }, ctc: 252_000, joined: '2024-02-12', phone: '9820011011', pan: 'KVWPV1234L', uan: '100200300411', bank: ['HDFC Bank', '50100200300411', 'HDFC0000123'] },
  { key: 'karan', name: 'Karan Joshi', gender: 'male', dept: 'Technology', designation: 'Manager', manager: 'rahul', logins: [['karan@example.com', 'employee']], salary: { BASIC: 45_000, HRA: 18_000, SPECIAL: 12_000 }, ctc: 900_000, joined: '2022-10-03', phone: '9820011012', pan: 'LWXPJ2345M', uan: '100200300412', bank: ['Kotak Mahindra Bank', '4611300412', 'KKBK0000789'] },
  { key: 'pooja', name: 'Pooja Shah', gender: 'female', dept: 'Technology', designation: 'Senior Executive', manager: 'karan', logins: [['pooja@example.com', 'employee']], salary: { BASIC: 22_000, HRA: 8_800, SPECIAL: 4_200 }, ctc: 420_000, joined: '2023-11-06', phone: '9820011013', pan: 'MXYPS3456N', uan: '100200300413', bank: ['ICICI Bank', '002101500413', 'ICIC0000021'] },
  // Joined on the first of this month; HR has her onboarding still to finish.
  { key: 'neha', name: 'Neha Gupta', gender: 'female', dept: 'Technology', designation: 'Executive', manager: 'karan', logins: [['neha@example.com', 'employee']], salary: { BASIC: 15_000, HRA: 6_000, SPECIAL: 2_000 }, ctc: 276_000, joined: m0, phone: '9820011014', pan: null, uan: null, bank: null },
  // Left in the middle of last month: no login any more.
  { key: 'kiran', name: 'Kiran Kumar', gender: 'male', dept: 'Technology', designation: 'Executive', manager: 'karan', logins: [], salary: { BASIC: 14_000, HRA: 5_600, SPECIAL: 1_400 }, ctc: 252_000, joined: '2024-01-08', phone: '9820011015', pan: 'NYZPK4567P', uan: '100200300415', bank: ['State Bank of India', '30200300415', 'SBIN0001234'] },
  { key: 'sunil', name: 'Sunil Yadav', gender: 'male', dept: 'Operations', designation: 'Executive', manager: 'arjun', logins: [['sunil@example.com', 'employee']], salary: { BASIC: 11_000, HRA: 4_400, SPECIAL: 600 }, ctc: 192_000, joined: '2025-03-03', phone: '9820011016', pan: 'PZAPY5678Q', uan: '100200300416', bank: ['Axis Bank', '917010300416', 'UTIB0000456'] },
]

/** A tiny repeatable "random": the same demo every time it is built. */
function noise(...parts: (string | number)[]): number {
  let h = 2166136261
  for (const ch of parts.join('|')) {
    h ^= ch.charCodeAt(0)
    h = Math.imul(h, 16777619)
  }
  // FNV alone keeps similar inputs ("…-09-04", "…-09-05") close together, which
  // bunched one person's absences into a fortnight. A final mix spreads them.
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return (h >>> 0) / 4294967295
}

async function seed() {
  if (await prisma.organization.count()) throw new Error('ems_demo already has a company. Rebuild it with `npm run demo -- --fresh`.')

  const org = await prisma.organization.create({
    data: {
      name: ORG_NAME, legalName: 'CareerMap Solutions Private Limited', addressLine: 'Baner Road', city: 'Pune',
      state: 'Maharashtra', pincode: '411045', timezone: TZ, phone: '02040001000', email: 'hr@example.com',
    },
  })
  const organizationId = org.id
  await prisma.$transaction((tx) => seedForOrganization(tx, { id: organizationId, timezone: TZ }), { timeout: 60_000 })
  // Statutory rates and PT from before anybody here joined, so every month of the story has them.
  await prisma.organizationPolicy.updateMany({ where: { organizationId }, data: { effectiveFrom: toDateColumn('2021-04-01') } })
  await prisma.ptSlab.updateMany({ where: { organizationId }, data: { effectiveFrom: toDateColumn('2021-04-01') } })

  const dept = Object.fromEntries((await prisma.department.findMany({ where: { organizationId } })).map((d) => [d.name, d.id]))
  const designation = Object.fromEntries((await prisma.designation.findMany({ where: { organizationId } })).map((d) => [d.name, d.id]))
  const component = Object.fromEntries((await prisma.salaryComponent.findMany({ where: { organizationId } })).map((c) => [c.code, c.id]))
  const general = await prisma.shift.findFirstOrThrow({ where: { organizationId, name: 'General' } })
  const leaveTypes = await prisma.leaveType.findMany({ where: { organizationId } })
  const leaveType = Object.fromEntries(leaveTypes.map((t) => [t.code, t.id]))
  const policy = await prisma.organizationPolicy.findFirstOrThrow({ where: { organizationId } })
  const holidays = new Set((await prisma.holiday.findMany({ where: { organizationId } })).map((h) => fromDateColumn(h.date)))

  const weekday = (d: CalendarDate) => new Date(`${d}T00:00:00Z`).getUTCDay()
  const working = (d: CalendarDate) => !policy.weeklyOffDays.includes(weekday(d)) && !holidays.has(d)
  const onOrAfter = (d: CalendarDate) => { let x = d; while (!working(x)) x = addCalendarDays(x, 1); return x }
  const before = (d: CalendarDate) => { let x = addCalendarDays(d, -1); while (!working(x)) x = addCalendarDays(x, -1); return x }
  /** `count` working days from `from`, and the calendar range that holds them. */
  const span = (from: CalendarDate, count: number) => {
    const days: CalendarDate[] = []
    let x = onOrAfter(from)
    while (days.length < count) { if (working(x)) days.push(x); x = addCalendarDays(x, 1) }
    return { from: days[0]!, to: days[days.length - 1]!, days }
  }

  // ── The dates the story uses (demo.mjs acts on them) ─────────────────────
  const kiranLeft = before(addCalendarDays(m1, 15))
  const plan = {
    approvedLeave: {
      priya: { type: 'CL', ...span(addCalendarDays(m1, 9), 2), by: 'rekha', reason: 'Cousin’s wedding in Nagpur' },
      ravi: { type: 'SL', ...span(addCalendarDays(m2, 19), 1), by: 'rekha', reason: 'Fever' },
      hema: { type: 'CL', ...span(addCalendarDays(m1, 16), 1), by: 'rahul', reason: 'Personal work' },
      rekha: { type: 'EL', ...span(addCalendarDays(m1, 22), 2), by: 'manoj', reason: 'Family trip' },
    },
    pendingLeave: {
      sneha: { type: 'CL', ...span(addCalendarDays(today, 7), 1), reason: 'Bank work' },
      vikram: { type: 'EL', ...span(addCalendarDays(today, 14), 3), reason: 'Going home for the festival' },
      rekha: { type: 'CL', ...span(addCalendarDays(today, 10), 1), reason: 'Parent-teacher meeting' },
      manoj: { type: 'CL', ...span(addCalendarDays(today, 12), 1), reason: 'Personal work' },
    },
    rejectedLeave: {
      ravi: { type: 'CL', ...span(addCalendarDays(today, 5), 1), by: 'rekha', reason: 'Short trip', note: 'Quarter-end week — please pick another day.' },
    },
    // Priya forgot to check out on her last working day; she asks for it to be put right.
    correction: { who: 'priya', date: before(today), checkIn: '09:30', checkOut: '18:40', reason: 'Forgot to check out — was with a client till 6:40' },
    wfh: { who: 'ravi', ...span(addCalendarDays(today, 3), 1), reason: 'Internet being installed at home' },
    onDuty: { who: 'vikram', ...span(addCalendarDays(today, 4), 1), reason: 'Client visit in Nashik' },
    approvedWfh: { who: 'pooja', ...span(addCalendarDays(today, 2), 1), by: 'karan', reason: 'Plumber visit at home' },
    profileChange: { who: 'sneha', changes: { phone: '9822041234', address: 'Flat 12, Shanti Apartments, Kothrud, Pune 411038' }, reason: 'Moved to a new flat' },
    resignation: { who: 'amit', requestedLastDay: addCalendarDays(today, 30), reason: 'Moving to Bengaluru for family reasons' },
    incentives: [{ who: 'priya', amount: 2_500, note: 'Top seller of the month' }, { who: 'vikram', amount: 3_000, note: 'Closed the Nashik account' }],
    advance: { who: 'ravi', amount: 6_000, installment: 2_000, note: 'Advance for a medical bill' },
    payroll: { paid: monthOfDay(m2), waiting: monthOfDay(m1), paidOn: m1 },
    handbook: HANDBOOK,
  }
  const leaveDays = new Map<string, Set<CalendarDate>>()
  for (const [who, l] of Object.entries(plan.approvedLeave)) leaveDays.set(who, new Set(l.days))

  // ── People ────────────────────────────────────────────────────────────────
  const users: Record<string, { email: string; role: Role }> = {}
  const employees: Record<string, { id: string; code: string; name: string }> = {}
  const passwordHash = await hashPassword(PASSWORD)
  let n = 0
  for (const p of PEOPLE) {
    n += 1
    const code = `CMS${String(n).padStart(3, '0')}`
    const memberships: string[] = []
    for (const [email, role] of p.logins) {
      const user = await prisma.user.create({ data: { email, passwordHash } })
      const m = await prisma.membership.create({ data: { userId: user.id, organizationId, role, status: 'active' } })
      memberships.push(m.id)
      users[email] = { email, role }
    }
    const left = p.key === 'kiran'
    const probationEnd = addCalendarDays(p.joined, 182)
    const employee = await prisma.employee.create({
      data: {
        organizationId, employeeCode: code, fullName: p.name, gender: p.gender, phone: p.phone,
        personalEmail: `${p.key}.personal@example.com`, dateOfJoining: toDateColumn(p.joined),
        dateOfBirth: toDateColumn(`${1985 + (n % 12)}-${String((n % 12) + 1).padStart(2, '0')}-${String((n * 3) % 27 + 1).padStart(2, '0')}`),
        nationality: 'Indian', address: `${n * 7}, Baner Road, Pune 411045`,
        emergencyContactName: `${p.name.split(' ')[1]} family`, emergencyContactRelation: 'Parent', emergencyContactPhone: `98200${String(22000 + n)}`,
        departmentId: dept[p.dept], designationId: designation[p.designation], shiftId: general.id,
        ...(memberships.length ? { memberships: { connect: memberships.map((id) => ({ id })) } } : {}),
        ...(left ? { lastWorkingDate: toDateColumn(kiranLeft), status: 'inactive' as const, exitReason: 'resigned' as const } : {}),
        // The lifecycle: the long-timers confirmed, Neha just joined and not yet onboarded.
        ...(p.key === 'neha'
          ? { probationEndDate: toDateColumn(probationEnd) }
          : { onboardedOn: toDateColumn(p.joined), probationEndDate: toDateColumn(probationEnd), confirmedOn: toDateColumn(probationEnd) }),
      },
    })
    employees[p.key] = { id: employee.id, code, name: p.name }
    await prisma.employeeStatutoryIdentity.create({
      data: { organizationId, employeeId: employee.id, ptState: 'Maharashtra', pfApplicable: true, hasPriorPfMembership: Boolean(p.uan), uan: p.uan, pan: p.pan },
    })
    await prisma.employeeFinancial.create({
      data: {
        organizationId, employeeId: employee.id, ctc: p.ctc, effectiveFrom: toDateColumn(p.joined),
        components: { create: Object.entries(p.salary).map(([c, amount]) => ({ organizationId, salaryComponentId: component[c]!, amount })) },
      },
    })
    if (p.bank) {
      await prisma.employeeBankAccount.create({
        data: {
          organizationId, employeeId: employee.id, bankName: p.bank[0], accountHolderName: p.name.toUpperCase(),
          accountNumber: p.bank[1], ifsc: p.bank[2], accountType: 'Savings', verificationStatus: 'verified', verifiedAt: now,
        },
      })
    }
  }
  for (const p of PEOPLE) {
    if (p.manager) await prisma.employee.update({ where: { id: employees[p.key]!.id }, data: { reportingManagerId: employees[p.manager]!.id } })
  }
  // Rahul owns the company: nobody is above him, and his own leave is his to take.
  await prisma.organization.update({ where: { id: organizationId }, data: { ownerEmployeeId: employees.rahul!.id } })

  // ── Leave balances: the year's quota for every leave year the story touches ─
  const startMonth = policy.leaveYearStartMonth
  const leaveYearOf = (d: CalendarDate) => (monthOfDay(d).month >= startMonth ? monthOfDay(d).year : monthOfDay(d).year - 1)
  const years = [...new Set([leaveYearOf(m2), leaveYearOf(today), leaveYearOf(addCalendarDays(today, 31))])]
  const grants = []
  for (const p of PEOPLE) {
    for (const leaveYear of years) {
      for (const t of leaveTypes) {
        if (!['CL', 'SL', 'EL'].includes(t.code)) continue
        const days = proRatedQuota(Number(t.annualQuota), p.joined, leaveYear, startMonth)
        if (days > 0) grants.push({ organizationId, employeeId: employees[p.key]!.id, leaveTypeId: t.id, leaveYear, days, reason: 'opening_grant' as const })
      }
    }
  }
  await prisma.leaveLedgerEntry.createMany({ data: grants })

  // ── Attendance: every working day from two months back to yesterday ───────
  // Punched on the app, measured against the General shift by the app's own rules.
  const rules = shiftRulesOf(general)
  const rows = []
  for (const p of PEOPLE) {
    const e = employees[p.key]!
    const last = p.key === 'kiran' ? kiranLeft : addCalendarDays(today, -1)
    for (let d = p.joined > m2 ? p.joined : m2; d <= last; d = addCalendarDays(d, 1)) {
      if (!working(d) || leaveDays.get(p.key)?.has(d)) continue
      const r = noise(p.key, d)
      // About one day in fifty absent, one in fifty a short day.
      if (r < 0.02 && p.key !== 'rahul') {
        rows.push({ organizationId, employeeId: e.id, date: toDateColumn(d), status: 'absent' as const, source: 'manual' as const, note: 'No show, no call' })
        continue
      }
      const inAt = at(d, hhmm(9 * 60 + 12 + Math.floor(noise(p.key, d, 'in') * 33)))
      const forgot = p.key === plan.correction.who && d === plan.correction.date
      // Out at 18:30–18:39: with no break off (client, 8 Oct 2026), a day of
      // 8h46m to 9h27m — present, and short of the half hour that is overtime.
      const outAt = r > 0.98 ? at(d, '15:40') : at(d, hhmm(18 * 60 + 30 + Math.floor(noise(p.key, d, 'out') * 10)))
      const hours = forgot ? null : hoursBetween(inAt, outAt, general.breakMinutes).hours
      const measure = measureInstants({ rules, date: d, timezone: TZ, checkIn: inAt, checkOut: forgot ? null : outAt, hoursWorked: hours })
      rows.push({
        organizationId, employeeId: e.id, date: toDateColumn(d), source: 'punch' as const, workMode: 'office' as const,
        checkIn: inAt, checkOut: forgot ? null : outAt, hoursWorked: hours, shiftId: general.id, expectedHours: general.expectedHours,
        status: measure.classification?.status ?? ('present' as const),
        lateMinutes: measure.lateMinutes, earlyLeavingMinutes: measure.earlyLeavingMinutes, overtimeMinutes: measure.overtimeMinutes,
        checkInDevice: 'Chrome on Android',
      })
    }
    // This morning: most people are in already, if the morning has begun. Priya
    // (the Employee demo login) is left to check in herself.
    if (working(today) && !['priya', 'kiran'].includes(p.key)) {
      const inAt = at(today, hhmm(9 * 60 + 12 + Math.floor(noise(p.key, today, 'in') * 33)))
      if (inAt.getTime() < now.getTime() - 5 * 60_000) {
        const measure = measureInstants({ rules, date: today, timezone: TZ, checkIn: inAt, checkOut: null, hoursWorked: null })
        rows.push({
          organizationId, employeeId: e.id, date: toDateColumn(today), source: 'punch' as const, workMode: 'office' as const,
          checkIn: inAt, shiftId: general.id, expectedHours: general.expectedHours, status: 'present' as const,
          lateMinutes: measure.lateMinutes, checkInDevice: 'Chrome on Android',
        })
      }
    }
  }
  await prisma.attendance.createMany({ data: rows })

  // ── A handbook for HR to publish (demo.mjs uploads it) ─────────────────────
  await new Promise<void>((resolve, reject) => {
    const pdf = new PDFDocument({ size: 'A4', margin: 56 })
    const out = createWriteStream(HANDBOOK)
    out.on('finish', resolve).on('error', reject)
    pdf.pipe(out)
    pdf.fontSize(20).text('CareerMap Solutions — Employee Handbook', { align: 'left' }).moveDown()
    pdf.fontSize(11).text('A demo document. Working hours are 9:30 to 18:30, Monday to Saturday. Leave is applied for in the app and approved by the person you report to. Payslips are in the app after each month’s payroll is approved.')
    pdf.end()
  })

  const fixture = {
    organizationId, password: PASSWORD, today, months: { m0, m1, m2 },
    users, employees, leaveTypes: leaveType, plan,
  }
  writeFileSync(FIXTURE, JSON.stringify(fixture, null, 2))
  console.log(`demo company seeded: ${PEOPLE.length} people, ${Object.keys(users).length} logins, ${rows.length} attendance days`)
}

const [mode] = process.argv.slice(2)
;(mode === 'seed' ? seed() : Promise.reject(new Error('Usage: tsx demo-seed.ts seed')))
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
