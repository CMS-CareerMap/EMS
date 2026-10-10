import type { Prisma, RequestApprover, RequestStatus, RequestType } from '@prisma/client'
import type { ScopedDb } from '../../platform/db/scoped'
import type { TxDb } from '../../platform/db/transaction'

/**
 * Requests (client §28–29): attendance corrections, working from home or on
 * duty, overtime and profile changes — their rows, and what deciding them
 * needs to read and write.
 */

type Db = ScopedDb | TxDb

const requestSelect = {
  id: true,
  number: true,
  employeeId: true,
  type: true,
  status: true,
  fromDate: true,
  toDate: true,
  details: true,
  reason: true,
  submittedByUserId: true,
  decidedByUserId: true,
  decidedAt: true,
  decisionNote: true,
  attachmentKey: true,
  attachmentName: true,
  attachmentType: true,
  attachmentBytes: true,
  attachmentSha256: true,
  createdAt: true,
  employee: {
    select: {
      fullName: true,
      employeeCode: true,
      reportingManagerId: true,
      departmentId: true,
      archivedAt: true,
      department: { select: { name: true } },
    },
  },
} as const

export type RequestRow = Prisma.EmployeeRequestGetPayload<{ select: typeof requestSelect }>

/** Somebody away from the office location on approved days. */
const AWAY: RequestType[] = ['work_from_home', 'on_duty']
const OPEN: RequestStatus[] = ['pending', 'approved']

export async function createRequest(
  tx: TxDb,
  values: {
    organizationId: string
    employeeId: string
    type: RequestType
    status: RequestStatus
    fromDate: Date | null
    toDate: Date | null
    details: Prisma.InputJsonValue
    reason: string
    submittedByUserId: string
    decidedByUserId?: string | null
    decidedAt?: Date | null
    decisionNote?: string | null
  },
): Promise<RequestRow> {
  return tx.employeeRequest.create({ data: values, select: requestSelect })
}

export async function findRequest(db: Db, id: string): Promise<RequestRow | null> {
  return db.employeeRequest.findFirst({ where: { id }, select: requestSelect })
}

/** One person's requests, newest first. */
export async function requestsOf(db: Db, employeeId: string): Promise<RequestRow[]> {
  return db.employeeRequest.findMany({ where: { employeeId }, orderBy: { createdAt: 'desc' }, select: requestSelect, take: 250 })
}

/** Every request still waiting, oldest first — for "waiting for you". */
export async function pendingRequests(db: Db): Promise<RequestRow[]> {
  return db.employeeRequest.findMany({
    where: { status: 'pending', employee: { archivedAt: null } },
    orderBy: { createdAt: 'asc' },
    select: requestSelect,
  })
}

/** Requests matching `where`, newest first — the caller builds the reach into it. */
export async function listRequests(db: Db, where: Prisma.EmployeeRequestWhereInput): Promise<RequestRow[]> {
  return db.employeeRequest.findMany({ where, orderBy: { createdAt: 'desc' }, select: requestSelect, take: 500 })
}

/** Moves a request on, only from the status it was read in. Returns how many moved. */
export async function moveRequest(
  tx: TxDb,
  id: string,
  from: RequestStatus[],
  data: { status: RequestStatus; decidedByUserId?: string; decidedAt?: Date; decisionNote?: string | null },
): Promise<number> {
  return (await tx.employeeRequest.updateMany({ where: { id, status: { in: from } }, data })).count
}

export async function setAttachment(
  tx: TxDb,
  id: string,
  data: { attachmentKey: string; attachmentName: string; attachmentType: string; attachmentBytes: number; attachmentSha256: string },
): Promise<void> {
  await tx.employeeRequest.update({ where: { id }, data })
}

/** Another away request (pending or approved) of theirs covering any of these days. */
export async function overlappingAway(db: Db, employeeId: string, from: Date, to: Date): Promise<RequestRow | null> {
  return db.employeeRequest.findFirst({
    where: { employeeId, type: { in: AWAY }, status: { in: OPEN }, fromDate: { lte: to }, toDate: { gte: from } },
    select: requestSelect,
  })
}

/** A correction of theirs for this day still waiting. */
export async function pendingRequestOn(db: Db, employeeId: string, type: RequestType, date: Date): Promise<RequestRow | null> {
  return db.employeeRequest.findFirst({ where: { employeeId, type, status: 'pending', fromDate: date }, select: requestSelect })
}

/** Working from home or on duty today, by an approved request — checked at check-in. */
export async function awayOn(db: Db, employeeId: string, day: Date): Promise<'work_from_home' | 'on_duty' | null> {
  const row = await db.employeeRequest.findFirst({
    where: { employeeId, type: { in: AWAY }, status: 'approved', fromDate: { lte: day }, toDate: { gte: day } },
    select: { type: true },
  })
  return row ? (row.type as 'work_from_home' | 'on_duty') : null
}

export interface RequestRules {
  correctionApprover: RequestApprover
  wfhApprover: RequestApprover
  overtimeApprover: RequestApprover
  profileApprover: RequestApprover
  encashmentApprover: RequestApprover
  wfhGpsRequired: boolean
}

export async function requestRules(db: Db, organizationId: string): Promise<RequestRules | null> {
  return db.organization.findUnique({
    where: { id: organizationId },
    select: { correctionApprover: true, wfhApprover: true, overtimeApprover: true, profileApprover: true, encashmentApprover: true, wfhGpsRequired: true },
  })
}

export async function updateRequestRules(tx: TxDb, organizationId: string, data: RequestRules): Promise<void> {
  await tx.organization.update({ where: { id: organizationId }, data })
}

const personSelect = {
  id: true,
  fullName: true,
  status: true,
  archivedAt: true,
  dateOfJoining: true,
  lastWorkingDate: true,
  reportingManagerId: true,
  departmentId: true,
  workArrangement: true,
  phone: true,
  personalEmail: true,
  dateOfBirth: true,
  nationality: true,
  address: true,
  emergencyContactName: true,
  emergencyContactRelation: true,
  emergencyContactPhone: true,
} as const

export type PersonRow = Prisma.EmployeeGetPayload<{ select: typeof personSelect }>

export async function personOf(db: Db, employeeId: string): Promise<PersonRow | null> {
  return db.employee.findFirst({ where: { id: employeeId }, select: personSelect })
}

/** A person's details, as an approved profile change sets them. */
export async function updatePersonal(tx: TxDb, employeeId: string, data: Prisma.EmployeeUpdateInput): Promise<void> {
  await tx.employee.update({ where: { id: employeeId }, data })
}

/** What is recorded for a day — a correction never overwrites approved leave. */
export async function attendanceOn(db: Db, employeeId: string, date: Date) {
  return db.attendance.findFirst({ where: { employeeId, date }, select: { status: true, checkIn: true, checkOut: true, source: true, overtimeMinutes: true } })
}

/** Overtime of theirs already claimed for a day — waiting or approved. */
export async function overtimeClaimOn(db: Db, employeeId: string, date: Date): Promise<RequestRow | null> {
  return db.employeeRequest.findFirst({ where: { employeeId, type: 'overtime', status: { in: OPEN }, fromDate: date }, select: requestSelect })
}

/** Whether overtime may be claimed for a day, and the payroll rules in force on it. */
export async function payPolicyOn(db: Db, day: Date) {
  return db.organizationPolicy.findFirst({
    where: { effectiveFrom: { lte: day }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: day } }] },
    orderBy: { effectiveFrom: 'desc' },
    select: { overtimeEnabled: true, leaveYearStartMonth: true },
  })
}

/** A leave type somebody may ask to encash. */
export async function leaveTypeOf(db: Db, id: string) {
  // The joiner rule too: a monthly type earns from the joining month or the one after (unearnedDays).
  return db.leaveType.findFirst({ where: { id, archivedAt: null }, select: { id: true, name: true, code: true, accrual: true, joinerGrant: true, encashable: true, encashMaxDaysPerYear: true } })
}

/** Days of a type waiting to be encashed in a leave year — held, like leave applied for. */
export async function pendingEncashDays(db: Db, employeeId: string, leaveTypeId: string, leaveYear: number, exceptId?: string): Promise<number> {
  const rows = await db.employeeRequest.findMany({
    where: { employeeId, type: 'leave_encashment', status: 'pending', ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { details: true },
  })
  return rows
    .map((r) => r.details as { leaveTypeId?: string; leaveYear?: number; days?: number })
    .filter((d) => d.leaveTypeId === leaveTypeId && d.leaveYear === leaveYear)
    .reduce((sum, d) => sum + Number(d.days ?? 0), 0)
}

/** Writes what an approval settled into the request (the month an encashment is paid in). */
export async function setDetails(tx: TxDb, id: string, details: Prisma.InputJsonObject): Promise<void> {
  await tx.employeeRequest.update({ where: { id }, data: { details } })
}

/** Days taken off a leave balance by an approved encashment. */
export async function encashFromBalance(tx: TxDb, data: Prisma.LeaveLedgerEntryUncheckedCreateInput): Promise<void> {
  await tx.leaveLedgerEntry.create({ data })
}

export async function uploadLimit(db: Db, organizationId: string): Promise<number> {
  return (await db.organization.findUnique({ where: { id: organizationId }, select: { maxUploadMb: true } }))?.maxUploadMb ?? 2
}

/** Somebody has left: what of theirs still waits is closed, with why. Returns how many. */
export async function closePendingOf(tx: TxDb, employeeId: string, userId: string): Promise<number> {
  return (await tx.employeeRequest.updateMany({
    where: { employeeId, status: 'pending' },
    data: { status: 'rejected', decidedByUserId: userId, decidedAt: new Date(), decisionNote: 'Closed: they left the company.' },
  })).count
}

/** Overtime and encashments approved for a payroll month after it was calculated — the payroll would leave them out. */
export async function payDecidedSince(db: Db, year: number, month: number, since: Date): Promise<number> {
  return db.employeeRequest.count({
    where: {
      type: { in: ['overtime', 'leave_encashment'] },
      status: 'approved',
      decidedAt: { gt: since },
      AND: [{ details: { path: ['payYear'], equals: year } }, { details: { path: ['payMonth'], equals: month } }],
    },
  })
}

/** Days of a type waiting to be encashed in a leave year, for every employee at once (the yearly carry-forward). */
export async function pendingEncashments(db: Db, leaveYear: number) {
  const rows = await db.employeeRequest.findMany({ where: { type: 'leave_encashment', status: 'pending' }, select: { employeeId: true, details: true } })
  return rows
    .map((row) => ({ employeeId: row.employeeId, ...(row.details as { leaveTypeId?: string; leaveYear?: number; days?: number }) }))
    .filter((row) => row.leaveYear === leaveYear)
}
