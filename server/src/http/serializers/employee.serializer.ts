import type { Prisma } from '@prisma/client'
import type { EmployeeRow } from '../../modules/employee/employee.repository'
import type { FieldAccess } from '../../modules/employee/employee.repository'
import { fromDateColumn, isoInstant } from '../../domain/shared/dates'
import { isInScope } from '../../platform/authz/scopeWhere'
import { stageOf } from '../../domain/org/lifecycle'

/**
 * What an employee looks like over the wire.
 *
 * SNAKE_CASE, deliberately. The pages were written against the original backend and read
 * `full_name`, `employee_id`, `date_of_joining`. Emitting camelCase would mean
 * editing every page in the same commit that changes where the data comes
 * from — two risky changes at once, and no way to tell which one broke a
 * screen. The v1 contract is snake_case; a rename is its own task, later.
 *
 * ALLOW-LIST, always. Every field is named. Nothing is spread, nothing is
 * deleted. A column added to the Employee table next month does not appear in
 * an API response until somebody writes it here on purpose.
 *
 * The three sensitive blocks are merged in only when the caller holds the
 * permission — and the repository has not even fetched them otherwise, so
 * there is nothing here to leak by accident.
 */

/**
 * Prisma Decimal to a JSON number.
 *
 * The browser gets a number because the pages already do arithmetic on these
 * values, and a string would break them. That is safe for DISPLAY: salaries
 * are far below the point where a double loses whole rupees.
 *
 * It is not safe for calculation, which is why no calculation happens here.
 * Payroll arithmetic runs on the server in Decimal, and the browser is shown
 * the result rather than deriving it. If a screen ever needs to add these up
 * for anything that matters, that sum belongs in an endpoint.
 */
function money(value: Prisma.Decimal | null | undefined): number | null {
  return value == null ? null : Number(value)
}

/** The fields anyone who may read an employee at all can see. */
function base(employee: EmployeeRow) {
  // Their first login. Since Day 23 a person can have two — the full list is
  // `logins` — and the single fields below, which every screen read before
  // that, describe the one they had first.
  const first = employee.memberships[0]
  return {
    id: employee.id,
    employee_id: employee.employeeCode,
    full_name: employee.fullName,

    // The login address lives on User; the personal one on Employee. They are
    // different things and the UI shows the work address, so `email` is the
    // login and `personal_email` is separate rather than one field guessing.
    email: first?.user.email ?? null,
    personal_email: employee.personalEmail,
    phone: employee.phone,

    department: employee.department?.name ?? null,
    department_id: employee.departmentId,
    designation: employee.designation?.name ?? null,
    designation_id: employee.designationId,

    date_of_joining: fromDateColumn(employee.dateOfJoining),
    // Null while they still work here.
    last_working_date: fromDateColumn(employee.lastWorkingDate),
    // Null is "not recorded", which payroll reports rather than guesses around.
    gender: employee.gender,
    employment_type: employee.employmentType,
    status: employee.status,

    attendance_mode: employee.attendanceMode,
    // Office, hybrid or remote (client §33).
    work_arrangement: employee.workArrangement,
    shift_id: employee.shiftId,
    shift: employee.shift
      ? {
          id: employee.shift.id,
          name: employee.shift.name,
          start_time: employee.shift.startTime,
          end_time: employee.shift.endTime,
          expected_hours: money(employee.shift.expectedHours),
        }
      : null,

    country: employee.country,
    currency: employee.currency,

    reporting_manager_id: employee.reportingManagerId,
    reporting_manager_name: employee.reportingManager?.fullName ?? null,
    reporting_manager_designation: employee.reportingManager?.designation?.name ?? null,
    // The manager has left the company: in effect nobody is above this person
    // until the Super Admin places them (Day 22).
    reporting_manager_left: Boolean(employee.reportingManager?.archivedAt),

    // Access-related, not HR data: whether this person can sign in, and as what.
    role: first?.role ?? null,
    role_name: first?.roleDef.name ?? null,
    account_status: first?.status ?? null,

    archived_at: isoInstant(employee.archivedAt),

    // The employee lifecycle (client §43): where they stand, and its dates.
    onboarded_on: fromDateColumn(employee.onboardedOn),
    probation_end_date: fromDateColumn(employee.probationEndDate),
    confirmed_on: fromDateColumn(employee.confirmedOn),
  }
}

/**
 * Where somebody stands in the lifecycle today — worked out, never stored. A
 * resignation not yet accepted is not announced: only whoever runs that
 * person's employment record, the person and the one they report to see
 * "Resigned" (and an exit reason) — not a fellow HR person, whose own record
 * goes up the tree; anybody else reading the directory sees where they stood.
 */
function lifecycle(employee: EmployeeRow, access: FieldAccess) {
  const { everybody, employeeId, notTheirs } = access.lifecycleOf
  const sees = (everybody && !notTheirs.includes(employee.id)) || (employeeId !== null && (employee.id === employeeId || employee.reportingManagerId === employeeId))
  const today = access.today
  const open = employee.resignations[0]
  const shown = open && (open.status === 'accepted' || (open.status === 'submitted' && sees)) ? { status: open.status } : null
  return {
    exit_reason: sees ? employee.exitReason : null,
    lifecycle_stage: stageOf(
      {
        dateOfJoining: fromDateColumn(employee.dateOfJoining),
        onboardedOn: fromDateColumn(employee.onboardedOn),
        confirmedOn: fromDateColumn(employee.confirmedOn),
        lastWorkingDate: fromDateColumn(employee.lastWorkingDate),
        left: employee.archivedAt !== null || employee.status === 'inactive',
        resignation: shown,
      },
      today,
    ),
  }
}

/** For whoever manages logins: every login, oldest first, each with its own email, role and status (Day 23). */
function logins(employee: EmployeeRow) {
  return {
    logins: employee.memberships.map((m) => ({
      id: m.id,
      email: m.user.email,
      role: m.role,
      role_name: m.roleDef.name,
      status: m.status,
    })),
  }
}

/** Requires `employee:compensation:read`. */
function compensation(employee: EmployeeRow) {
  // financials is an effective-dated list; the repository asked for the current
  // one only. No current record is null, NOT zero — "we do not know this
  // person's salary" and "this person earns nothing" are different facts.
  const current = employee.financials?.[0]
  if (!current) {
    return {
      ctc: null,
      basic: null,
      hra: null,
      da: null,
      conveyance: null,
      special_allowance: null,
      components: [],
      salary_effective_from: null,
    }
  }

  // Amounts are rows now, keyed by component code. The flat keys below are the
  // shape every screen already reads; they are DERIVED from the rows, never
  // stored beside them, so there is still exactly one source for each figure.
  const byCode = new Map(current.components.map((row) => [row.component.code, row.amount]))

  // A component this person is not paid is null, not zero — "no HRA on this
  // salary" and "HRA of nothing" read the same on a screen and differently to
  // an auditor.
  const amount = (code: string) => {
    const value = byCode.get(code)
    return value === undefined ? null : money(value)
  }

  return {
    ctc: money(current.ctc),
    basic: amount('BASIC'),
    hra: amount('HRA'),
    da: amount('DA'),
    conveyance: amount('CONV'),
    special_allowance: amount('SPECIAL'),
    // No `incentive`. It is entered per month, so a salary record never holds
    // one, and a key here would always read null — which a screen would show
    // as "no incentive" when the truth is "not decided on this record".
    // Every component, including ones added after these keys were chosen. A
    // screen that renders this list shows "Shift Allowance" the day somebody
    // adds it, without a deploy.
    components: current.components.map((row) => ({
      code: row.component.code,
      label: row.component.label,
      type: row.component.type,
      amount: money(row.amount),
    })),
    salary_effective_from: fromDateColumn(current.effectiveFrom),
  }
}

/** Requires `employee:bank:read`. */
function bank(employee: EmployeeRow) {
  const account = employee.bankAccount
  if (!account) {
    return {
      bank_name: null,
      bank_account_holder_name: null,
      bank_account: null,
      ifsc: null,
      bank_branch: null,
      bank_account_type: null,
      bank_verification_status: 'unverified',
      bank_verification_remarks: null,
      verified_at: null,
      bank_proof_name: null,
    }
  }

  return {
    bank_name: account.bankName,
    bank_account_holder_name: account.accountHolderName,
    bank_account: account.accountNumber,
    ifsc: account.ifsc,
    bank_branch: account.branch,
    bank_account_type: account.accountType,
    bank_verification_status: account.verificationStatus,
    bank_verification_remarks: account.verificationRemarks,
    verified_at: isoInstant(account.verifiedAt),
    bank_proof_name: account.proofFileName,
    // Note what is absent: proofKey. The storage key is never sent to a
    // browser — the file is fetched through GET /payroll/employees/:id/
    // bank-account/proof, which checks the permission and records who took it.
  }
}

/** Requires `employee:identity:read`. */
function identity(employee: EmployeeRow) {
  const record = employee.statutoryIdentity
  return {
    pan: record?.pan ?? null,
    // Null means EPFO has not issued one. It is NEVER derived from the PAN,
    // which the old app did — producing a number that looks right and is not.
    uan: record?.uan ?? null,
    pf_acc_no: record?.pfAccountNumber ?? null,
    esi_number: record?.esiNumber ?? null,
    pt_state: record?.ptState ?? null,
    // Null only when there is no statutory record at all. Not shown as true
    // even though payroll then applies PF by default: the screen reports what
    // is stored, and nothing is.
    pf_applicable: record?.pfApplicable ?? null,
    // Null means nobody has asked. Kept distinct from false, because payroll
    // treats "unknown" as a warning and "no" as an answer.
    has_prior_pf_membership: record?.hasPriorPfMembership ?? null,
    // A member of the pension scheme as recorded from their PF record; null is
    // "payroll works it out from what they joined on".
    eps_member: record?.epsMember ?? null,
  }
}

function personal(employee: EmployeeRow) {
  return {
    date_of_birth: fromDateColumn(employee.dateOfBirth),
    nationality: employee.nationality,
    address: employee.address,
    emergency_contact_name: employee.emergencyContactName,
    emergency_contact_relation: employee.emergencyContactRelation,
    emergency_contact_phone: employee.emergencyContactPhone,
  }
}

export function serializeEmployee(employee: EmployeeRow, access: FieldAccess) {
  // A salary outside the caller's salary scope is left OUT, never sent as
  // nulls — nulls would read as "no salary recorded", which is not the truth.
  const seesSalary = access.includeCompensation && isInScope(access.compensationScope, employee)
  return {
    ...base(employee),
    ...lifecycle(employee, access),
    ...(seesSalary ? compensation(employee) : {}),
    ...(access.includeBank ? bank(employee) : {}),
    ...(access.includeIdentity ? identity(employee) : {}),
    // Personal details (client §42): to whoever reads statutory details, and to the person.
    ...(access.includeIdentity || employee.id === access.lifecycleOf.employeeId ? personal(employee) : {}),
    ...(access.includeLogins ? logins(employee) : {}),
  }
}

export function serializeEmployees(employees: EmployeeRow[], access: FieldAccess) {
  return employees.map((employee) => serializeEmployee(employee, access))
}
