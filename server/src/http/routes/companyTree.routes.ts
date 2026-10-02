import { Router } from 'express'
import { getApprovalSettings, getCompanyTree, putApprovalSettings, putOwner } from '../controllers/companyTree.controller'
import { authenticate } from '../middleware/authenticate'
import { authorize } from '../middleware/authorize'

/**
 * Mounted at /api/company-tree (Day 22). The Super Admin's: the client put
 * "who reports to whom" and the approval rules with them, and `role:manage`
 * is held by the Super Admin and nobody else.
 */
export const companyTreeRouter = Router()

companyTreeRouter.use(authenticate)
companyTreeRouter.get('/', authorize('role:manage'), getCompanyTree)
companyTreeRouter.put('/owner', authorize('role:manage'), putOwner)
companyTreeRouter.get('/approvals', authorize('role:manage'), getApprovalSettings)
companyTreeRouter.put('/approvals', authorize('role:manage'), putApprovalSettings)
