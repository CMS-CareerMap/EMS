import { Router } from 'express'
import {
  getCompany,
  putCompany,
  getPolicy,
  putPolicy,
  getPolicyHistory,
  getGeofences,
  putGeofence,
  deleteGeofence,
  getLeaveTypes,
  postLeaveType,
  patchLeaveType,
  deleteLeaveType,
  getPtSlabs,
  putPtSlabs,
} from '../controllers/settings.controller'
import { authenticate } from '../middleware/authenticate'
import { authorize } from '../middleware/authorize'

/**
 * Mounted at /api/settings.
 *
 * Reads and writes are separated: `settings:read` opens the page,
 * `settings:update` saves it. Today only super_admin holds either, but keeping
 * them apart means a company that wants HR to SEE the leave configuration
 * without being able to change it can have that without a code change.
 *
 * PT slabs are statutory settings: read and set here, by Super Admin. Holidays
 * moved to /api/holidays — everybody who applies for leave needs to read them,
 * and behind settings:read only Super Admin could.
 */
export const settingsRouter = Router()

settingsRouter.use(authenticate)

settingsRouter.get('/company', authorize('settings:read'), getCompany)
settingsRouter.put('/company', authorize('settings:update'), putCompany)

settingsRouter.get('/payroll', authorize('settings:read'), getPolicy)
settingsRouter.put('/payroll', authorize('settings:update'), putPolicy)
settingsRouter.get('/payroll/history', authorize('settings:read'), getPolicyHistory)

settingsRouter.get('/geofence', authorize('settings:read'), getGeofences)
settingsRouter.put('/geofence', authorize('settings:update'), putGeofence)
settingsRouter.delete('/geofence/:id', authorize('settings:update'), deleteGeofence)

// Leave configuration is gated on its own permission, so HR can manage leave
// without also being handed statutory rates and user management.
settingsRouter.get('/leave-types', authorize('leave:type:manage'), getLeaveTypes)
settingsRouter.post('/leave-types', authorize('leave:type:manage'), postLeaveType)
settingsRouter.patch('/leave-types/:id', authorize('leave:type:manage'), patchLeaveType)
settingsRouter.delete('/leave-types/:id', authorize('leave:type:manage'), deleteLeaveType)

settingsRouter.get('/pt-slabs', authorize('settings:read'), getPtSlabs)
settingsRouter.put('/pt-slabs', authorize('settings:update'), putPtSlabs)
