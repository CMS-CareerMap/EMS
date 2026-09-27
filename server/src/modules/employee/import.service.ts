import Papa from 'papaparse'
import type { AppContext } from '../../platform/context'
import { BadRequest } from '../../platform/errors/AppError'
import { withTransaction } from '../../platform/db/transaction'
import { logger } from '../../platform/logger'
import { importRowSchema } from '../../http/validators/employeeImport.validator'
import { isCalendarDate, isoInstant, toDateColumn } from '../../domain/shared/dates'
import { createLoginInTransaction } from '../user/user.service'
import { listDepartments, listDesignations } from '../organization/masterData.repository'
import * as repo from './employee.repository'

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
  employmentType: ['employment_type', 'type'],
  department: ['department', 'dept'],
  designation: ['designation', 'title', 'job_title'],
  pan: ['pan', 'pan_number'],
  gender: ['gender', 'sex'],
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

export async function importEmployees(
  ctx: AppContext,
  input: ImportInput,
): Promise<ImportResult> {
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
  const [departments, designations] = await Promise.all([listDepartments(ctx.db), listDesignations(ctx.db)])

  const departmentByName = new Map(departments.map((d) => [d.name.toLowerCase(), d.id]))
  const designationByName = new Map(designations.map((d) => [d.name.toLowerCase(), d.id]))

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

  if (input.dryRun) {
    return { dryRun: true, summary, rows, invites: [] }
  }

  // Nothing is written while any row is bad. The dry run has already listed
  // them, so reaching here with errors means the file changed in between.
  if (invalid > 0) {
    throw BadRequest(
      `${invalid} of ${rows.length} rows have problems. Fix them and run the preview again.`,
    )
  }

  const invites: ImportResult['invites'] = []

  await withTransaction(ctx.db, async (tx) => {
    for (const row of prepared) {
      const data = row.data as Record<string, string | undefined>
      let membershipId: string | null = null

      if (row.email) {
        const login = await createLoginInTransaction(tx, {
          email: row.email,
          // Always `employee`. The CSV has no role column, and promoting
          // anyone is a separate deliberate act through the role endpoint —
          // not something that happens because of a spreadsheet.
          role: 'employee',
          organizationId: ctx.organizationId,
          invitedByUserId: ctx.userId,
        })
        membershipId = login.membershipId

        invites.push({
          employeeCode: data.employeeCode!,
          email: row.email,
          token: login.inviteToken,
          expiresAt: isoInstant(login.expiresAt),
        })
      }

      const employee = await repo.createEmployee(tx, {
        organizationId: ctx.organizationId,
        membershipId,
        employeeCode: data.employeeCode!,
        fullName: data.fullName!,
        personalEmail: data.personalEmail ?? null,
        phone: data.phone ?? null,
        dateOfJoining: data.dateOfJoining ? toDateColumn(data.dateOfJoining) : null,
        ...(data.employmentType
          ? { employmentType: data.employmentType as 'full_time' }
          : {}),
        departmentId: data.departmentId ?? null,
        designationId: data.designationId ?? null,
        ...(data.gender ? { gender: data.gender as 'male' | 'female' | 'other' } : {}),
      })

      if (data.pan) {
        await repo.createStatutoryIdentity(tx, {
          organizationId: ctx.organizationId,
          employeeId: employee.id,
          pan: data.pan,
        })
      }
    }
  })

  summary.imported = prepared.length

  logger.info('Employees imported', {
    by: ctx.userId,
    count: prepared.length,
    withLogin,
  })

  return { dryRun: false, summary, rows, invites }
}
