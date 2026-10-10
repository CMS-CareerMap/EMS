import type { Prisma } from '@prisma/client'
import { zonedToday } from '../../src/domain/shared/dates'

/**
 * Reference data — what a company needs before anybody can use it: departments,
 * shifts, leave types, salary components, statutory rates, the fixed holidays.
 *
 * Written by `npm run bootstrap` inside the transaction that creates the
 * company, and by `npx prisma db seed` for companies that already exist.
 *
 * SAFE TO RUN AGAIN ON A COMPANY IN USE. Each starting list is written only if
 * the company has nothing of that kind yet, archived rows included. The old
 * version upserted by name, so re-running it after somebody renamed "Sales"
 * brought "Sales" back — and in a later financial year it opened a second
 * Maharashtra PT table beside the one the company had set, and every salary
 * matched two slabs.
 *
 * Demo data — fake employees for a walkthrough — is deliberately NOT here.
 */

/**
 * Starting lists for a new company. Every one of these is EDITABLE in Settings
 * — a sensible first day, not a fixed taxonomy. A company that does not use
 * "Intern" archives it; it is not stuck with ours.
 */
const DEPARTMENTS = ['Human Resources', 'Sales', 'Operations', 'Finance', 'Technology']

// Director for the owner: their record shows their post, not their login's role
// (8 Oct 2026). Founder, CEO or any other is added in Settings → Organisation.
const DESIGNATIONS = ['Executive', 'Senior Executive', 'Team Lead', 'Manager', 'Senior Manager', 'Head', 'Director']

/**
 * The client's stated working day is nine hours (§A1.5), which is what makes
 * "did they work their shift?" answerable. Their day (8 Oct 2026): eight hours
 * worked is a full day, from four and a half a half day, under that absent —
 * with no break taken off, as lunch is whenever a person likes. All of it is
 * editable in Settings → Organisation → Shifts.
 */
const DAY = { breakMinutes: 0, expectedHours: 9, minFullDayHours: 8, minHalfDayHours: 4.5 }
const SHIFTS = [
  { name: 'General', startTime: '09:30', endTime: '18:30', ...DAY },
  { name: 'Early', startTime: '08:00', endTime: '17:00', ...DAY },
  { name: 'Late', startTime: '11:00', endTime: '20:00', ...DAY },
]

/**
 * The compliance checklist — what HR collects from everybody. The old screen's
 * list, with its "required" marks. Editable in Settings → Documents.
 */
export const DOCUMENT_TYPES = [
  { code: 'offer_letter', label: 'Offer Letter', required: true },
  { code: 'aadhaar', label: 'Aadhaar Card', required: true },
  { code: 'pan', label: 'PAN Card', required: true },
  { code: 'resume', label: 'Resume / CV', required: true },
  { code: 'passport', label: 'Passport', required: false },
  { code: 'edu_certificate', label: 'Education Certificate', required: false },
  { code: 'exp_letter', label: 'Experience Letter', required: false },
  { code: 'other', label: 'Other Document', required: false },
]

/**
 * The types a company starts with, with their short codes — each one the
 * company's to change, rename or archive (Settings → Leave Config).
 *
 * Loss of Pay is unpaid with no days a year, which means no limit: it needs no
 * balance, and every day of it is cut from pay (client, 9 Oct 2026). Work From
 * Home is not here: it is a request (Requests → Work from home), not leave.
 */
const LEAVE_TYPES = [
  { code: 'CL', name: 'Casual Leave', annualQuota: 12, isPaid: true, carryForward: false },
  { code: 'SL', name: 'Sick Leave', annualQuota: 12, isPaid: true, carryForward: false },
  { code: 'EL', name: 'Earned Leave', annualQuota: 15, isPaid: true, carryForward: true, carryForwardCap: 30 },
  { code: 'CO', name: 'Comp Off', annualQuota: 0, isPaid: true, carryForward: false },
  { code: 'LOP', name: 'Loss of Pay', annualQuota: 0, isPaid: false, carryForward: false },
]

/**
 * The client's confirmed salary structure (§A13): Basic, HRA, DA, Conveyance,
 * Special Allowance, Incentive.
 *
 * ROWS, NOT COLUMNS: a company can rename, reorder or archive any of them, and
 * adding a seventh is an insert rather than a migration. Upserted by code, not
 * written once: the salary engine knows these codes, so each must exist — and
 * the upsert changes nothing about one the company has renamed or archived.
 *
 * `countsForPf` is true only for Basic and DA. Per the 2019 Supreme Court
 * ruling an allowance paid ordinarily and universally to everybody DOES form
 * part of PF wages, so a special allowance everyone receives may belong in the
 * base. That is the accountant's judgement; these are a starting point.
 */
const SALARY_COMPONENTS = [
  { code: 'BASIC', label: 'Basic', type: 'earning', countsForPf: true, taxable: true, displayOrder: 1 },
  { code: 'DA', label: 'Dearness Allowance', type: 'earning', countsForPf: true, taxable: true, displayOrder: 2 },
  { code: 'HRA', label: 'House Rent Allowance', type: 'earning', countsForPf: false, taxable: true, displayOrder: 3 },
  { code: 'CONV', label: 'Conveyance', type: 'earning', countsForPf: false, taxable: true, displayOrder: 4 },
  { code: 'SPECIAL', label: 'Special Allowance', type: 'earning', countsForPf: false, taxable: true, displayOrder: 5 },
  // Entered per employee per month, never on a salary record (§A1.5).
  { code: 'INCENTIVE', label: 'Incentive', type: 'earning', countsForPf: false, taxable: true, displayOrder: 6, entry: 'monthly' },
  // Client §40, entered monthly like an incentive. A bonus is outside ESI wages.
  { code: 'BONUS', label: 'Bonus', type: 'earning', countsForPf: false, countsForEsi: false, taxable: true, displayOrder: 7, entry: 'monthly' },
  { code: 'COMMISSION', label: 'Commission', type: 'earning', countsForPf: false, taxable: true, displayOrder: 8, entry: 'monthly' },
  // The difference a salary that starts inside a month leaves unpaid for its
  // days — the payslip's warning gives the figure. Arrears of Basic are PF
  // wages; whether this line counts is the accountant's call, switched in
  // Settings → Payroll Config like any earning.
  { code: 'ARREARS', label: 'Arrears', type: 'earning', countsForPf: false, taxable: true, displayOrder: 9, entry: 'monthly' },
] as const

/**
 * Maharashtra professional tax — statutory, published and stable, so seeded
 * rather than left for payroll to deduct nothing.
 *
 * GENDERED, because the state is: women pay nothing up to ₹25,000 where men pay
 * from ₹7,500. ₹200 for eleven months and ₹300 in February is how the state
 * reaches ₹2,500 a year, the constitutional cap. Other states are entered in
 * Settings → Payroll Config.
 */
const MAHARASHTRA_PT = [
  { gender: 'male', minGross: 0, maxGross: 7500, amount: 0, februaryAmount: null },
  { gender: 'male', minGross: 7500.01, maxGross: 10000, amount: 175, februaryAmount: null },
  { gender: 'male', minGross: 10000.01, maxGross: null, amount: 200, februaryAmount: 300 },

  { gender: 'female', minGross: 0, maxGross: 25000, amount: 0, februaryAmount: null },
  { gender: 'female', minGross: 25000.01, maxGross: null, amount: 200, februaryAmount: 300 },
] as const

/**
 * Only the three fixed-date national holidays. Diwali, Holi and Eid move with
 * the lunar calendar and states add their own; a guessed date would sit in the
 * leave calendar looking authoritative. The company enters those.
 */
const FIXED_HOLIDAYS = [
  { name: 'Republic Day', month: 1, day: 26 },
  { name: 'Independence Day', month: 8, day: 15 },
  { name: 'Gandhi Jayanti', month: 10, day: 2 },
]

/** The client of whatever kind — the plain one, or a transaction on it. */
type Db = Prisma.TransactionClient

export interface SeedTarget {
  id: string
  /** The company's zone decides which year and financial year "now" is. */
  timezone: string
}

export async function seedForOrganization(db: Db, organization: SeedTarget, now: Date = new Date()): Promise<void> {
  const organizationId = organization.id
  const today = zonedToday(now, organization.timezone)
  const year = Number(today.slice(0, 4))
  const month = Number(today.slice(5, 7))
  // 1 April of the current financial year — when seeded rules take effect.
  const financialYearStart = new Date(Date.UTC(month >= 4 ? year : year - 1, 3, 1))

  if ((await db.department.count({ where: { organizationId } })) === 0) {
    await db.department.createMany({ data: DEPARTMENTS.map((name) => ({ organizationId, name })) })
  }

  if ((await db.designation.count({ where: { organizationId } })) === 0) {
    await db.designation.createMany({ data: DESIGNATIONS.map((name) => ({ organizationId, name })) })
  }

  if ((await db.shift.count({ where: { organizationId } })) === 0) {
    await db.shift.createMany({ data: SHIFTS.map((shift) => ({ organizationId, ...shift })) })
  }

  if ((await db.leaveType.count({ where: { organizationId } })) === 0) {
    await db.leaveType.createMany({ data: LEAVE_TYPES.map((type) => ({ organizationId, ...type })) })
  }

  if ((await db.documentType.count({ where: { organizationId } })) === 0) {
    await db.documentType.createMany({
      data: DOCUMENT_TYPES.map((type, i) => ({ organizationId, ...type, displayOrder: i + 1 })),
    })
  }

  for (const component of SALARY_COMPONENTS) {
    await db.salaryComponent.upsert({
      where: { organizationId_code: { organizationId, code: component.code } },
      update: {},
      create: { organizationId, ...component },
    })
  }

  // Any Maharashtra slab at all — open or closed — means the company already
  // has a table, and its own revisions are the ones that count.
  if ((await db.ptSlab.count({ where: { organizationId, state: 'Maharashtra' } })) === 0) {
    await db.ptSlab.createMany({
      data: MAHARASHTRA_PT.map((slab) => ({
        organizationId,
        state: 'Maharashtra',
        effectiveFrom: financialYearStart,
        ...slab,
      })),
    })
  }

  // This year's and next year's, so January does not arrive with an empty
  // calendar. Only on a day the company has nothing entered for — one that has
  // renamed its Gandhi Jayanti keeps its own name, not a second entry.
  for (const calendarYear of [year, year + 1]) {
    for (const holiday of FIXED_HOLIDAYS) {
      const date = new Date(Date.UTC(calendarYear, holiday.month - 1, holiday.day))
      if ((await db.holiday.count({ where: { organizationId, date } })) === 0) {
        await db.holiday.create({ data: { organizationId, name: holiday.name, date, type: 'public' } })
      }
    }
  }

  // The statutory defaults, so payroll has rates before anyone opens Settings.
  if (!(await db.organizationPolicy.findFirst({ where: { organizationId, effectiveTo: null } }))) {
    await db.organizationPolicy.create({ data: { organizationId, effectiveFrom: financialYearStart } })
  }
}
