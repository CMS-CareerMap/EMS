import { Router, json } from 'express'
import { getAttendanceExport } from '../controllers/exports.controller'
import { postPunchIn, postPunchOut, postPunchStart, getMyToday, getMyWorkplace, getMyPayDays } from '../controllers/attendance.controller'
import { punchLimiter } from '../middleware/rateLimit'
import {
  getAttendance,
  getMonthCalendar,
  getMonthlySummary,
  getDaySummary,
  getDayRoster,
  postMark,
  patchAttendance,
  postImport,
  getSuspicious,
  getDayEvidence,
  getPunchPhoto,
  getDevices,
  postApproveDevice,
  postRetireDevice,
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

// Pressing the button starts a punch; the punch carries its token back (client, 11 Oct 2026).
attendanceRouter.post('/punch-start', authorize('attendance:punch'), punchLimiter, postPunchStart)
attendanceRouter.post('/punch-in', authorize('attendance:punch'), punchLimiter, postPunchIn)
attendanceRouter.post('/punch-out', authorize('attendance:punch'), punchLimiter, postPunchOut)
attendanceRouter.get('/me/today', authorize('attendance:punch'), getMyToday)
attendanceRouter.get('/me/workplace', authorize('attendance:punch'), getMyWorkplace)
// One's own month in pay terms — days paid and unpaid, leave by type, absent days (client, 10 Oct 2026).
// Read with attendance: somebody marked by HR or the machine has a month too.
attendanceRouter.get('/me/pay-days', authorize('attendance:read'), getMyPayDays)

// Reading other people's attendance. What "other people" means is the data
// scope — the whole company for HR, direct reports for a manager — applied in
// the repository, not here.
attendanceRouter.get('/', authorize('attendance:read'), getAttendance)
attendanceRouter.get('/monthly-summary', authorize('attendance:read'), getMonthlySummary)
// The company's days off in a month: the same for everybody who reads attendance.
attendanceRouter.get('/calendar', authorize('attendance:read'), getMonthCalendar)
attendanceRouter.get('/summary', authorize('attendance:read'), getDaySummary)
attendanceRouter.get('/day', authorize('attendance:read'), getDayRoster)
// Punches worth a second look (client, 11 Oct 2026): beyond one's own reach only.
attendanceRouter.get('/suspicious', authorize('attendance:read'), getSuspicious)
// A day's punches with their evidence, and a punch's selfie: whoever's reach covers the person.
attendanceRouter.get('/evidence', authorize('attendance:read'), getDayEvidence)
attendanceRouter.get('/evidence/:id/photo', authorize('attendance:read'), getPunchPhoto)
// One phone per employee: whoever corrects attendance approves a new phone or takes one off.
attendanceRouter.get('/devices', authorize('attendance:update'), getDevices)
attendanceRouter.post('/devices/:id/approve', authorize('attendance:update'), postApproveDevice)
attendanceRouter.post('/devices/:id/retire', authorize('attendance:update'), postRetireDevice)
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
