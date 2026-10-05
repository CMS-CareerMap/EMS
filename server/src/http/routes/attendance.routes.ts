import { Router, json } from 'express'
import { getAttendanceExport } from '../controllers/exports.controller'
import { postPunchIn, postPunchOut, getMyToday, getMyWorkplace } from '../controllers/attendance.controller'
import {
  getAttendance,
  getMonthCalendar,
  getMonthlySummary,
  getDaySummary,
  getDayRoster,
  postMark,
  patchAttendance,
  postImport,
} from '../controllers/attendanceAdmin.controller'
import { authenticate } from '../middleware/authenticate'
import { authorize } from '../middleware/authorize'

/**
 * Mounted at /api/attendance.
 *
 * `attendance:punch` is what an employee does for THEMSELVES, and is held by
 * everybody who works here. It is a different permission from
 * `attendance:mark`, which is HR recording somebody else's day — the audit
 * found the old RLS blocked an employee from updating their own row, which is
 * why nobody could ever check out.
 */
export const attendanceRouter = Router()

attendanceRouter.use(authenticate)

attendanceRouter.post('/punch-in', authorize('attendance:punch'), postPunchIn)
attendanceRouter.post('/punch-out', authorize('attendance:punch'), postPunchOut)
attendanceRouter.get('/me/today', authorize('attendance:punch'), getMyToday)
attendanceRouter.get('/me/workplace', authorize('attendance:punch'), getMyWorkplace)

// Reading other people's attendance. What "other people" means is the data
// scope — the whole company for HR, direct reports for a manager — applied in
// the repository, not here.
attendanceRouter.get('/', authorize('attendance:read'), getAttendance)
attendanceRouter.get('/monthly-summary', authorize('attendance:read'), getMonthlySummary)
// The company's days off in a month: the same for everybody who reads attendance.
attendanceRouter.get('/calendar', authorize('attendance:read'), getMonthCalendar)
attendanceRouter.get('/summary', authorize('attendance:read'), getDaySummary)
attendanceRouter.get('/day', authorize('attendance:read'), getDayRoster)
attendanceRouter.get('/export', authorize('attendance:read'), getAttendanceExport)

// Recording somebody else's day, and correcting one. Separate permissions
// from reading: a manager may see their team's attendance and may not edit it.
attendanceRouter.post('/mark', authorize('attendance:mark'), postMark)
attendanceRouter.patch('/:id', authorize('attendance:update'), patchAttendance)

// Its own body parser, for the same reason as the employee importer: a 1 MB
// CSV is larger than 1 MB once it is a JSON string.
attendanceRouter.post(
  '/import',
  json({ limit: '2mb' }),
  authorize('attendance:mark'),
  postImport,
)
