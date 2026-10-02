import { z } from 'zod'

/** PUT /api/company-tree/owner */
export const markOwnerSchema = z.object({
  employeeId: z.uuid(),
  /** The settings' `version` as last read, so two tabs cannot overwrite each other. */
  version: z.string().min(1),
})

/** PUT /api/company-tree/approvals — Settings → Approvals. */
export const approvalSettingsSchema = z.object({
  /** Who decides for somebody with nobody above them; null is the Super Admin. */
  noManagerApproverId: z.uuid().nullable(),
  backup: z.enum(['super_admin', 'next_up', 'none']),
  reversal: z.enum(['manager_or_super_admin', 'super_admin_only']),
  version: z.string().min(1),
})
