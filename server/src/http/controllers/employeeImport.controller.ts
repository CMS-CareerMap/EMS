import type { RequestHandler } from 'express'
import { importEmployees } from '../../modules/employee/import.service'
import { importRequestSchema } from '../validators/employeeImport.validator'
import { parseBody } from '../validators/parse'
import { appContext } from '../context'

/**
 * POST /api/employees/import
 *
 * Preview by default; committing needs `dryRun: false` in the body.
 *
 * The response shape is the same either way, so the page renders one table and
 * the only difference is whether `summary.imported` is zero. A preview that
 * looked different from the real thing would defeat the point of previewing.
 */
export const postImport: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const { csv, dryRun } = parseBody(importRequestSchema, req.body)

  const result = await importEmployees(ctx, { csv, dryRun })

  res.status(dryRun ? 200 : 201).json({
    data: {
      dry_run: result.dryRun,
      summary: {
        total_rows: result.summary.totalRows,
        valid: result.summary.valid,
        invalid: result.summary.invalid,
        with_login: result.summary.withLogin,
        imported: result.summary.imported,
      },
      rows: result.rows.map((row) => ({
        line: row.line,
        employee_code: row.employeeCode,
        full_name: row.fullName,
        email: row.email,
        // Empty means the row is fine. The page colours on length, not on a
        // separate status field that could disagree with the list.
        issues: row.issues,
      })),
      // Only ever populated on a real import, and only once — the tokens are
      // stored hashed, so this response is the only chance to distribute them.
      invites: result.invites.map((invite) => ({
        employee_code: invite.employeeCode,
        email: invite.email,
        token: invite.token,
        expires_at: invite.expiresAt,
      })),
      // Logins made with no password yet, where the company sets employees'
      // passwords: HR sets each from the person's page (client, 6 Oct 2026).
      waiting_for_password: result.waitingForPassword,
    },
    meta: { requestId: res.locals.requestId },
  })
}
