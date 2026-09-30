import type { AppContext } from '../../platform/context'
import { zonedToday, type CalendarDate } from '../../domain/shared/dates'
import * as repo from './organization.repository'
import { MAX_UPLOAD_MB_CEILING, MIN_UPLOAD_MB } from '../../domain/files/fileRules'

/**
 * The company's clock.
 *
 * Which day "today" is decides whose attendance is late, which leave year a
 * request falls in and the date a rate change takes effect. Seven services used
 * to read the time zone themselves, each with its own copy of the default.
 */

/**
 * The company's time zone. Asia/Kolkata only if the company row cannot be
 * read — the column itself always holds a value.
 */
export async function companyTimezone(ctx: AppContext): Promise<string> {
  return (await repo.findTimezone(ctx.db, ctx.organizationId)) ?? 'Asia/Kolkata'
}

/** Today on the company's calendar. */
export async function companyToday(ctx: AppContext, now: Date = new Date()): Promise<CalendarDate> {
  return zonedToday(now, await companyTimezone(ctx))
}

/**
 * The largest file this company accepts, in MB — its own setting (2 MB unless
 * changed), never above the system's ceiling.
 */
export async function uploadLimitMb(ctx: AppContext): Promise<number> {
  const saved = (await repo.findUploadLimit(ctx.db, ctx.organizationId)) ?? 2
  return Math.min(Math.max(saved, MIN_UPLOAD_MB), MAX_UPLOAD_MB_CEILING)
}
