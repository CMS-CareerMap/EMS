import { Router } from 'express'
import { getHolidays, postHoliday, patchHoliday, deleteHoliday } from '../controllers/holidays.controller'
import { authenticate } from '../middleware/authenticate'
import { authorize } from '../middleware/authorize'

/**
 * Mounted at /api/holidays.
 *
 * Read by everybody who applies for leave — they need to see which days are
 * already off. It used to live under /settings, behind settings:read, which
 * only Super Admin holds: the Leave page's Holidays tab was a permission error
 * for every employee, every time it opened.
 *
 * Kept by `holiday:manage` — Super Admin and HR.
 */
export const holidaysRouter = Router()

holidaysRouter.use(authenticate)

holidaysRouter.get('/', authorize('leave:read'), getHolidays)
holidaysRouter.post('/', authorize('holiday:manage'), postHoliday)
holidaysRouter.patch('/:id', authorize('holiday:manage'), patchHoliday)
holidaysRouter.delete('/:id', authorize('holiday:manage'), deleteHoliday)
