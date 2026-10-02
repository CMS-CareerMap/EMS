import { Router, json } from 'express'
import {
  getEmployees,
  getEmployeeById,
  postEmployee,
  patchEmployee,
} from '../controllers/employee.controller'
import { authenticate } from '../middleware/authenticate'
import { authorize } from '../middleware/authorize'
import { postImport } from '../controllers/employeeImport.controller'
import { getEmployeeImportTemplate, getEmployeesExport } from '../controllers/exports.controller'
import { postLogin } from '../controllers/user.controller'

/**
 * Mounted at /api/employees.
 *
 * `authorize('employee:read')` answers "may this person read employees at all".
 * It does NOT answer "may they read THIS one" — that is the data scope, applied
 * in the repository. A route guarded here and unscoped there is still an IDOR
 * hole, which is why the repository requires a scope argument to compile.
 *
 * POST and PATCH are gated on their own permissions, not on employee:read —
 * being able to see the directory is not being able to change it.
 */
export const employeeRouter = Router()

employeeRouter.use(authenticate)

employeeRouter.get('/', authorize('employee:read'), getEmployees)
// Before '/:id', or 'export' would be read as an id.
employeeRouter.get('/export', authorize('employee:read'), getEmployeesExport)
employeeRouter.get('/import/template', authorize('employee:create'), getEmployeeImportTemplate)
employeeRouter.get('/:id', authorize('employee:read'), getEmployeeById)

employeeRouter.post('/', authorize('employee:create'), postEmployee)

// A 1 MB CSV becomes more than 1 MB once it is a JSON string — quotes and
// newlines are escaped — so this route gets its own limit. The real cap is
// enforced on the decoded CSV in the service, where the number means what
// the person uploading thinks it means.
employeeRouter.post(
  '/import',
  json({ limit: '2mb' }),
  authorize('employee:create'),
  postImport,
)
employeeRouter.patch('/:id', authorize('employee:update'), patchEmployee)
// Another login for this person — a role login beside their employee login
// (Day 23). The Super Admin's: it decides who holds which role.
employeeRouter.post('/:id/logins', authorize('role:manage'), postLogin)
