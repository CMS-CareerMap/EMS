import { Router } from 'express'
import {
  deleteCompanyDocument,
  deleteEmployeeDocument,
  getCompanyDocumentFile,
  getCompanyDocuments,
  getCompliance,
  getDocumentTypes,
  getEmployeeDocumentFile,
  getEmployeeDocuments,
  patchDocumentType,
  postCompanyDocument,
  postDocumentDecision,
  postDocumentType,
  postEmployeeDocument,
} from '../controllers/documents.controller'
import { authenticate } from '../middleware/authenticate'
import { authorize } from '../middleware/authorize'
import { singleFile } from '../upload'

/**
 * Mounted at /api/document-types, /api/employee-documents and
 * /api/company-documents.
 *
 * Whose documents a caller reaches is the data scope (scope.ts): the whole
 * company for Super Admin, Admin and HR; one's own for everybody else.
 * Managers, RMs and Accounts hold no employee-document permission at all —
 * the client's matrix (§3.1) — but read the company's documents (§5).
 */
export const documentTypesRouter = Router()
documentTypesRouter.use(authenticate)
documentTypesRouter.get('/', authorize(['document:read', 'document:type:manage']), getDocumentTypes)
documentTypesRouter.post('/', authorize('document:type:manage'), postDocumentType)
documentTypesRouter.patch('/:id', authorize('document:type:manage'), patchDocumentType)

export const employeeDocumentsRouter = Router()
employeeDocumentsRouter.use(authenticate)
employeeDocumentsRouter.get('/', authorize('document:read'), getEmployeeDocuments)
employeeDocumentsRouter.get('/compliance', authorize('document:verify'), getCompliance)
employeeDocumentsRouter.post('/', authorize('document:upload'), singleFile('file'), postEmployeeDocument)
employeeDocumentsRouter.get('/:id/file', authorize('document:read'), getEmployeeDocumentFile)
employeeDocumentsRouter.post('/:id/decision', authorize('document:verify'), postDocumentDecision)
// The owner withdrawing an unchecked upload, or HR removing any; the service decides which.
employeeDocumentsRouter.delete('/:id', authorize(['document:upload', 'document:verify']), deleteEmployeeDocument)

export const companyDocumentsRouter = Router()
companyDocumentsRouter.use(authenticate)
companyDocumentsRouter.get('/', authorize('document:company:read'), getCompanyDocuments)
companyDocumentsRouter.post('/', authorize('document:company:manage'), singleFile('file'), postCompanyDocument)
companyDocumentsRouter.get('/:id/file', authorize('document:company:read'), getCompanyDocumentFile)
companyDocumentsRouter.delete('/:id', authorize('document:company:manage'), deleteCompanyDocument)
