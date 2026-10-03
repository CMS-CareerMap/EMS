import type { RequestHandler } from 'express'
import {
  approvalSettings,
  companyTree,
  markOwner,
  updateApprovalSettings,
  type ApprovalSettings,
} from '../../modules/organization/companyTree.service'
import { approvalSettingsSchema, markOwnerSchema } from '../validators/companyTree.validator'
import { parseBody } from '../validators/parse'
import { appContext } from '../context'

/**
 * GET /api/company-tree            who reports to whom, the owner, and who has nobody above
 * PUT /api/company-tree/owner      mark the owner
 * GET /api/company-tree/approvals  Settings → Approvals
 * PUT /api/company-tree/approvals
 *
 * Moving a person is PATCH /api/employees/:id with their reporting manager.
 */

export const getCompanyTree: RequestHandler = async (_req, res) => {
  const ctx = appContext(res)
  const view = await companyTree(ctx)
  res.status(200).json({
    data: {
      people: view.people.map((p) => ({
        id: p.id,
        name: p.name,
        code: p.code,
        department: p.department,
        designation: p.designation,
        role: p.role,
        manager_id: p.managerId,
        manager_who_left: p.managerWhoLeft,
        is_owner: p.isOwner,
        can_be_owner: p.canBeOwner,
        can_sign_in: p.canSignIn,
      })),
      owner_id: view.ownerId,
      unplaced: view.unplaced,
      version: view.version,
    },
    meta: { requestId: res.locals.requestId },
  })
}

export const putOwner: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const { employeeId, version } = parseBody(markOwnerSchema, req.body)
  await markOwner(ctx, employeeId, version)
  res.status(204).end()
}

const settingsOut = (s: ApprovalSettings) => ({
  no_manager_approver_id: s.noManagerApproverId,
  no_manager_approver_name: s.noManagerApproverName,
  no_manager_approver_can_sign_in: s.noManagerApproverCanSignIn,
  backup: s.backup,
  reversal: s.reversal,
  version: s.version,
})

export const getApprovalSettings: RequestHandler = async (_req, res) => {
  const ctx = appContext(res)
  res.status(200).json({ data: settingsOut(await approvalSettings(ctx)), meta: { requestId: res.locals.requestId } })
}

export const putApprovalSettings: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const input = parseBody(approvalSettingsSchema, req.body)
  res.status(200).json({ data: settingsOut(await updateApprovalSettings(ctx, input)), meta: { requestId: res.locals.requestId } })
}
