import type { RequestHandler } from 'express'
import * as holidays from '../../modules/holidays/holidays.service'
import { fromDateColumn } from '../../domain/shared/dates'
import {
  holidayQuerySchema,
  holidayIdSchema,
  holidaySchema,
  holidayUpdateSchema,
} from '../validators/holidays.validator'
import { parseBody } from '../validators/parse'
import { appContext } from '../context'

function holiday(row: { id: string; name: string; date: Date; type: string }) {
  return { id: row.id, name: row.name, date: fromDateColumn(row.date), type: row.type }
}

const reply = (res: Parameters<RequestHandler>[1], status: number, data: unknown, extra: object = {}) =>
  res.status(status).json({ data, meta: { requestId: res.locals.requestId, ...extra } })

/** GET /api/holidays?year= — the calendar, for everybody who applies for leave. */
export const getHolidays: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const { year } = parseBody(holidayQuerySchema, req.query)
  reply(res, 200, (await holidays.list(ctx, year)).map(holiday))
}

/**
 * POST /api/holidays
 *
 * `approved_leave_affected` in meta: approved leave covering that day, which is
 * NOT recalculated. Said so the page can tell the person making the change.
 */
export const postHoliday: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const input = parseBody(holidaySchema, req.body)
  const result = await holidays.add(ctx, input)
  reply(res, 201, holiday(result.holiday), { approved_leave_affected: result.approvedLeaveAffected })
}

/** PATCH /api/holidays/:id */
export const patchHoliday: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const { id } = parseBody(holidayIdSchema, req.params)
  const input = parseBody(holidayUpdateSchema, req.body)
  const result = await holidays.edit(ctx, id, input)
  reply(res, 200, holiday(result.holiday), { approved_leave_affected: result.approvedLeaveAffected })
}

/** DELETE /api/holidays/:id */
export const deleteHoliday: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const { id } = parseBody(holidayIdSchema, req.params)
  const result = await holidays.remove(ctx, id)
  reply(res, 200, null, { approved_leave_affected: result.approvedLeaveAffected })
}
