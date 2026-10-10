import Papa from 'papaparse'
import type { AppContext } from '../../platform/context'
import { BadRequest, Forbidden } from '../../platform/errors/AppError'
import { withTransaction } from '../../platform/db/transaction'
import { logger } from '../../platform/logger'
import { importRowSchema } from '../../http/validators/employeeImport.validator'
import { isCalendarDate, isoInstant, toDateColumn } from '../../domain/shared/dates'
import { createLoginInTransaction, freeEmployeeCode, loginStartFor, rolesForGrant, rolesLock } from '../user/user.service'
import { passwordRules } from '../user/user.repository'
import { lifecycleStart } from './employee.service'
import { companyToday } from '../organization/organization.service'
import { mayGive } from '../user/user.policy'
import { lockFor } from '../../platform/db/locks'
import type { TxDb } from '../../platform/db/transaction'
import { EMPLOYEE_ROLE } from '../../platform/authz/defaultRoles'
import { listDepartments, listDesignations, listShifts } from '../organization/masterData.repository'
import * as repo from './employee.repository'
import { audit } from '../audit/audit.service'
import { grantOnJoining } from '../leave/leaveEntitlement.service'

/**
 * Bulk employee import from CSV.
 *
 * Three decisions shape this file.
 *
 * 1. DRY RUN IS THE DEFAULT. Committing requires saying so explicitly. An
 *    import is the one operation where a mistake is five hundred rows wide, and
 *    HR should see exactly what will happen before it happens — not find out
 *    afterwards and ask whether it can be undone.
 *
 * 2. THE REAL IMPORT IS ALL OR NOTHING. Partial success reads as "47 of 50
 *    imported" and leaves somebody working out which three. The dry run has
 *    already listed every problem by line number, so by the time a commit runs
 *    there is nothing left to be partial about.
 *
 * 3. ROWS GO THROUGH THE SAME VALIDATION AS THE FORM. A CSV is not a trusted
 *    input just because it came from a spreadsheet. No role column, no status,
 *    no salary, no password — the same three exclusions as POST /employees, for
 *    the same reason.
 */

/** 1 MB and 500 rows. A roster is not a database dump. */
const MAX_BYTES = 1_000_000
const MAX_ROWS = 500

export interface RowIssue {
  field: string
  message: string
}

export interface ImportRow {
  /** 1-based line in the file, counting the header — what the spreadsheet shows. */
  line: number
  employeeCode: string
  fullName: string
  email: string | null
  issues: RowIssue[]
}

export interface ImportResult {
  dryRun: boolean
  summary: {
    totalRows: number
    valid: number
    invalid: number
    withLogin: number
    imported: number
  }
  rows: ImportRow[]
  /**
   * Invitation tokens, returned ONCE, only on a real import.
   *
   * There is no email sending, so HR distributes these. Keyed by employee code
   * so a spreadsheet can be built from the response.
   */
  invites: { employeeCode: string; email: string; token: string; expiresAt: string }[]
  /**
   * Logins made with no password yet, where the company sets employees'
   * passwords (Settings → Passwords): HR sets each from the person's page.
   */
  waitingForPassword: number
}

/**
 * Header names accepted for each field.
 *
 * Several spellings each, because the file comes from whatever the client's
 * previous system exported and rejecting a roster over "Employee ID" versus
 * "employee_code" wastes an afternoon for no safety gained.
 */
const HEADER_ALIASES: Record<string, string[]> = {
  employeeCode: ['employee_code', 'employee_id', 'emp_code', 'emp_id', 'code'],
  fullName: ['full_name', 'name', 'employee_name'],
  email: ['email', 'work_email', 'official_email'],
  personalEmail: ['personal_email'],
  phone: ['phone', 'mobile', 'contact', 'phone_number'],
  dateOfJoining: ['date_of_joining', 'doj', 'joining_date'],
  confirmedOn: ['confirmed_on', 'confirmation_date', 'date_of_confirmation'],
  employmentType: ['employment_type', 'type'],
  department: ['department', 'dept'],
  shift: ['shift', 'shift_name'],
  designation: ['designation', 'title', 'job_title'],
  pan: ['pan', 'pan_number'],
  gender: ['gender', 'sex'],
  dateOfBirth: ['date_of_birth', 'dob', 'birth_date'],
}

/**
 * The spellings a previous system is likely to have exported. M and F are
 * unambiguous; anything else is passed through as typed so the validator can
 * name it in the row's error rather than it being silently dropped.
 */
function normaliseGender(value: string | undefined): string | undefined {
  const cleaned = (value ?? '').trim().toLowerCase()
  if (!cleaned) return undefined
  if (cleaned === 'm') return 'male'
  if (cleaned === 'f') return 'female'
  return cleaned
}

function normaliseHeader(header: string): string {
  const cleaned = header
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/[^a-z0-9_]/g, '')

  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    if (aliases.includes(cleaned)) return field
  }
  return cleaned
}

/**
 * Accepts DD/MM/YYYY as well as ISO.
 *
 * Excel writes whatever the machine's locale says, and a roster exported in
 * India will be day-first. Parsing that as month-first turns 05/11/2026 into
 * 11 May — a silent, plausible, wrong answer, which is the worst kind.
 */
function parseDate(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null

  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return isCalendarDate(trimmed) ? trimmed : null

  const dmy = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(trimmed)
  if (dmy) {
    const [, d, m, y] = dmy
    const iso = `${y}-${m!.padStart(2, '0')}-${d!.padStart(2, '0')}`
    // 31/02/2026 has the right SHAPE and is not a real day. Checking that the
    // date survives a round trip catches it here, where the message can name
    // the value the person actually typed — rather than in zod, which would
    // only say "Invalid ISO date" about a string they never wrote.
    return isCalendarDate(iso) ? iso : null
  }

  return null
}

export interface ImportInput {
  csv: string
  dryRun: boolean
}

/**
 * The logins a roster makes are Employee logins, so the importer must be one
 * who may give that role — the rule for adding one employee with a login.
 * Said in the import's words: nobody chose a role here, they chose a file.
 */
async function assertMayGiveLogins(tx: TxDb, ctx: AppContext): Promise<void> {
  const { actor, next, order } = await rolesForGrant(tx, ctx, EMPLOYEE_ROLE, ['employee:create'])
  if (!mayGive(actor, next, order)) {
    throw Forbidden(
      'Your role cannot give Employee logins, so this file cannot be imported with its email column. Remove the email column to add the records without logins, or ask somebody who gives logins, such as HR, to import it.',
    )
  }
}

export async function importEmployees(
  ctx: AppContext,
  input: ImportInput,
): Promise<ImportResult> {
  // A roster names departments and no managers, so the people it adds are
  // placed company-wide. Importing one is therefore for a company-wide reach
  // (Day 21): somebody who adds people only to their team adds them one by one.
  if (ctx.scopeFor('employee').scope !== 'ORGANIZATION') {
    throw Forbidden('Importing a roster adds people anywhere in the company, so it needs a company-wide reach. Add people one at a time under Employees instead.')
  }
  if (Buffer.byteLength(input.csv, 'utf8') > MAX_BYTES) {
    throw BadRequest('That file is larger than 1 MB. Split the roster and import it in parts.')
  }

  const parsed = Papa.parse<Record<string, string>>(input.csv.trim(), {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: normaliseHeader,
  })

  if (parsed.data.length === 0) {
    throw BadRequest('That file has no rows. Check it has a header line and at least one employee.')
  }

  if (parsed.data.length > MAX_ROWS) {
    throw BadRequest(`That file has ${parsed.data.length} rows. The limit is ${MAX_ROWS}.`)
  }

  // Names, not ids. HR has a spreadsheet with "Sales" in it, not a uuid.
  const [departments, designations, shifts, today] = await Promise.all([listDepartments(ctx.db), listDesignations(ctx.db), listShifts(ctx.db), companyToday(ctx)])

  const departmentByName = new Map(departments.map((d) => [d.name.toLowerCase(), d.id]))
  const designationByName = new Map(designations.map((d) => [d.name.toLowerCase(), d.id]))
  const shiftByName = new Map(shifts.map((s) => [s.name.toLowerCase(), s.id]))

  const existingCodes = new Set(
    (await repo.listEmployeeCodes(ctx.db)).map((e) =>
      e.employeeCode.toLowerCase(),
    ),
  )

  const seenCodes = new Map<string, number>()
  const seenEmails = new Map<string, number>()

  const rows: ImportRow[] = []
  const prepared: {
    line: number
    data: Record<string, unknown>
    email: string | null
  }[] = []

  parsed.data.forEach((raw, index) => {
    // +2: one for the header line, one because spreadsheets count from 1. The
    // number here must match what HR sees when they open the file.
    const line = index + 2
    const issues: RowIssue[] = []

    const employeeCode = (raw.employeeCode ?? '').trim()
    const fullName = (raw.fullName ?? '').trim()
    const email = (raw.email ?? '').trim().toLowerCase() || null

    const candidate: Record<string, unknown> = {
      employeeCode,
      fullName,
      email: email ?? undefined,
      personalEmail: (raw.personalEmail ?? '').trim() || undefined,
      phone: (raw.phone ?? '').trim() || undefined,
      employmentType: (raw.employmentType ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_') || undefined,
      pan: (raw.pan ?? '').trim().toUpperCase() || undefined,
      gender: normaliseGender(raw.gender),
    }

    // A PAN changes tax, and is entered by somebody who can see it (as on the
    // Add Employee form) — a file is no way round that.
    if (candidate.pan && !ctx.can('employee:identity:read')) {
      issues.push({ field: 'pan', message: 'PAN is entered by somebody who can see it. Leave this column out, or ask HR to import the file.' })
    }

    // The date of birth — a personal detail, entered by somebody who can see
    // them, as on the Add Employee form. Payroll needs it to stop the pension
    // (EPS) at 58, and a roster is how a whole company's arrive at once.
    const rawBirth = (raw.dateOfBirth ?? '').trim()
    if (rawBirth) {
      const iso = parseDate(rawBirth)
      if (!ctx.can('employee:identity:read')) {
        issues.push({ field: 'date_of_birth', message: 'A date of birth is entered by somebody who can see personal details. Leave this column out, or ask HR to import the file.' })
      } else if (!iso) {
        issues.push({ field: 'date_of_birth', message: `"${rawBirth}" is not a date this can read. Use DD/MM/YYYY or YYYY-MM-DD.` })
      } else if (iso >= today) {
        issues.push({ field: 'date_of_birth', message: `The date of birth (${rawBirth}) is not in the past.` })
      } else {
        candidate.dateOfBirth = iso
      }
    }

    const rawDate = (raw.dateOfJoining ?? '').trim()
    if (rawDate) {
      const iso = parseDate(rawDate)
      if (iso) {
        candidate.dateOfJoining = iso
      } else {
        issues.push({
          field: 'date_of_joining',
          message: `"${rawDate}" is not a date this can read. Use DD/MM/YYYY or YYYY-MM-DD.`,
        })
      }
    }

    // Somebody already working here: confirmed on this day.
    const rawConfirmed = (raw.confirmedOn ?? '').trim()
    if (rawConfirmed) {
      const iso = parseDate(rawConfirmed)
      if (!iso) {
        issues.push({ field: 'confirmed_on', message: `"${rawConfirmed}" is not a date this can read. Use DD/MM/YYYY or YYYY-MM-DD.` })
      } else if (typeof candidate.dateOfJoining === 'string' && iso < candidate.dateOfJoining) {
        issues.push({ field: 'confirmed_on', message: `The confirmation date (${rawConfirmed}) is before the joining date.` })
      } else if (iso > today) {
        issues.push({ field: 'confirmed_on', message: `The confirmation date (${rawConfirmed}) is in the future. Leave it empty for somebody still on probation.` })
      } else {
        candidate.confirmedOn = iso
      }
    }

    const result = importRowSchema.safeParse(candidate)
    if (!result.success) {
      for (const issue of result.error.issues) {
        issues.push({ field: issue.path.join('.') || '(row)', message: issue.message })
      }
    }

    // Duplicates, both against the database and within the file itself. The
    // second matters more: a file that repeats a code would otherwise fail
    // halfway through with a constraint error and no useful message.
    const codeKey = employeeCode.toLowerCase()
    if (codeKey) {
      if (existingCodes.has(codeKey)) {
        issues.push({
          field: 'employee_code',
          message: `${employeeCode} already exists in the system`,
        })
      }
      const firstSeen = seenCodes.get(codeKey)
      if (firstSeen !== undefined) {
        issues.push({
          field: 'employee_code',
          message: `${employeeCode} also appears on line ${firstSeen}`,
        })
      } else {
        seenCodes.set(codeKey, line)
      }
    }

    if (email) {
      const firstSeen = seenEmails.get(email)
      if (firstSeen !== undefined) {
        issues.push({ field: 'email', message: `${email} also appears on line ${firstSeen}` })
      } else {
        seenEmails.set(email, line)
      }
    }

    // Department and designation are matched by name and must already exist.
    // Creating them silently from a typo is how a company ends up with "Sales",
    // "sales " and "Salse" as three departments.
    const departmentName = (raw.department ?? '').trim()
    if (departmentName) {
      const id = departmentByName.get(departmentName.toLowerCase())
      if (id) {
        candidate.departmentId = id
      } else {
        issues.push({
          field: 'department',
          message: `There is no department called "${departmentName}". Add it in Settings first.`,
        })
      }
    }

    const designationName = (raw.designation ?? '').trim()
    if (designationName) {
      const id = designationByName.get(designationName.toLowerCase())
      if (id) {
        candidate.designationId = id
      } else {
        issues.push({
          field: 'designation',
          message: `There is no designation called "${designationName}". Add it in Settings first.`,
        })
      }
    }

    // The shift their day is measured against — its break, its hours, late
    // and early. Matched by name, as departments are; without one, nobody's
    // day is graded and every imported person needed it set by hand.
    const shiftName = (raw.shift ?? '').trim()
    if (shiftName) {
      const id = shiftByName.get(shiftName.toLowerCase())
      if (id) {
        candidate.shiftId = id
      } else {
        issues.push({
          field: 'shift',
          message: `There is no shift called "${shiftName}". Use one of: ${shifts.map((s) => s.name).join(', ') || 'none yet — add one in Settings'}.`,
        })
      }
    }

    rows.push({ line, employeeCode, fullName, email, issues })
    if (issues.length === 0) prepared.push({ line, data: candidate, email })
  })

  const invalid = rows.filter((r) => r.issues.length > 0).length
  const withLogin = prepared.filter((p) => p.email).length

  const summary = {
    totalRows: rows.length,
    valid: prepared.length,
    invalid,
    withLogin,
    imported: 0,
  }

  // The preview promises what the commit will do, so it refuses the logins
  // the commit would refuse. Read only; the commit checks again under the lock.
  if (input.dryRun && withLogin > 0) {
    await withTransaction(ctx.db, (tx) => assertMayGiveLogins(tx, ctx))
  }

  if (input.dryRun) {
    return { dryRun: true, summary, rows, invites: [], waitingForPassword: 0 }
  }

  // Nothing is written while any row is bad. The dry run has already listed
  // them, so reaching here with errors means the file changed in between.
  if (invalid > 0) {
    throw BadRequest(
      `${invalid} of ${rows.length} rows have problems. Fix them and run the preview again.`,
    )
  }

  const invites: ImportResult['invites'] = []
  let waitingForPassword = 0

  await withTransaction(ctx.db, async (tx) => {
    await lockFor(tx, rolesLock(ctx.organizationId))
    // The reach as the role stands under the lock, not as the request found
    // it: a role narrowed a moment ago must not import company-wide.
    const { actor } = await rolesForGrant(tx, ctx, EMPLOYEE_ROLE, ['employee:create'])
    if (!actor.locked && actor.grant.scopes.employee !== 'ORGANIZATION') {
      throw Forbidden('Importing a roster adds people anywhere in the company, so it needs a company-wide reach. Add people one at a time under Employees instead.')
    }
    if (withLogin > 0) await assertMayGiveLogins(tx, ctx)
    // A roster carries no passwords — a file of them would travel between
    // laptops and inboxes (client, 6 Oct 2026). Where the company sets
    // employees' passwords, each login waits for HR to set it; where they set
    // their own, each gets its invitation link.
    const start = loginStartFor('employee', await passwordRules(tx, ctx.organizationId), actor, false)
    // Each Employee ID once more, under its lock — in one order, so two imports
    // never wait on each other — as somebody may have been added since the
    // preview, in other letters too (signing in matches either case).
    const codes = prepared.map((row) => (row.data as Record<string, string | undefined>).employeeCode!)
    for (const code of [...codes].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))) {
      await freeEmployeeCode(tx, ctx.organizationId, code)
    }
    const added: string[] = []
    for (const row of prepared) {
      const data = row.data as Record<string, string | undefined>

      const employee = await repo.createEmployee(tx, {
        organizationId: ctx.organizationId,
        employeeCode: data.employeeCode!,
        fullName: data.fullName!,
        personalEmail: data.personalEmail ?? null,
        phone: data.phone ?? null,
        dateOfJoining: data.dateOfJoining ? toDateColumn(data.dateOfJoining) : null,
        ...(data.dateOfBirth ? { dateOfBirth: toDateColumn(data.dateOfBirth) } : {}),
        ...(data.employmentType
          ? { employmentType: data.employmentType as 'full_time' }
          : {}),
        departmentId: data.departmentId ?? null,
        designationId: data.designationId ?? null,
        shiftId: data.shiftId ?? null,
        ...(data.gender ? { gender: data.gender as 'male' | 'female' | 'other' } : {}),
        // Where they start in the lifecycle: confirmed, or a new joiner.
        ...(await lifecycleStart(ctx, { dateOfJoining: data.dateOfJoining ?? null, confirmedOn: data.confirmedOn ?? null })),
      })
      added.push(employee.id)

      if (row.email) {
        const login = await createLoginInTransaction(tx, {
          email: row.email,
          // Always `employee`. The CSV has no role column, and promoting
          // anyone is a separate deliberate act through the role endpoint —
          // not something that happens because of a spreadsheet.
          role: EMPLOYEE_ROLE,
          organizationId: ctx.organizationId,
          invitedByUserId: ctx.userId,
          employeeId: employee.id,
          start,
          passwordHash: null,
        })

        if (login.inviteToken && login.expiresAt) {
          invites.push({
            employeeCode: data.employeeCode!,
            email: row.email,
            token: login.inviteToken,
            expiresAt: isoInstant(login.expiresAt),
          })
        } else {
          waitingForPassword++
        }
      }

      if (data.pan) {
        await repo.createStatutoryIdentity(tx, {
          organizationId: ctx.organizationId,
          employeeId: employee.id,
          pan: data.pan,
        })
      }
    }

    await audit(ctx, {
      action: 'employee.imported',
      entityType: 'import',
      details: { employees: prepared.length, withLogin },
    }, tx)
    // Each one's share of this leave year at once, as when added by hand
    // (client, 9 Oct 2026) — those with a joining date in the file.
    await grantOnJoining(ctx, tx, added)
  })

  summary.imported = prepared.length

  logger.info('Employees imported', {
    by: ctx.userId,
    count: prepared.length,
    withLogin,
  })

  return { dryRun: false, summary, rows, invites, waitingForPassword }
}
