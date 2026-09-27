import { useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'
import { sendNotification } from './useNotifications'
import { isoInstant } from '../lib/dates'

/**
 * Bank details and their verification — STILL ON SUPABASE.
 *
 * Moved out of useEmployees.js unchanged, so that file could move to the real
 * server without dragging these along. Bank verification is its own flow with
 * its own rules (an employee may not verify their own account), and it is
 * rebuilt on the server on Day 19 together with documents. Until then these
 * write to the old store and nothing here reaches the new API.
 */

export function useUpdateBankDetails() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({
      employeeId,
      bank_name,
      bank_account,
      bank_account_holder_name,
      ifsc,
      bank_branch,
      bank_account_type,
      bank_proof_name,
      bank_proof_url,
      employeeName,
      isHrUpdate = false
    }) => {
      const updates = {
        bank_name,
        bank_account,
        bank_account_holder_name,
        ifsc,
        bank_branch: bank_branch || 'Main Branch',
        bank_account_type: bank_account_type || 'Savings',
        bank_proof_name: bank_proof_name || 'cancelled_cheque.pdf',
        ...(bank_proof_url ? { bank_proof_url } : {}),
        bank_verification_status: isHrUpdate ? 'verified' : 'pending',
        bank_verification_remarks: isHrUpdate
          ? 'Updated and verified by HR/Finance.'
          : 'Bank details submitted by employee for salary credit. Pending verification.',
        ...(isHrUpdate ? { bank_verified_at: isoInstant() } : { bank_verified_by: null, bank_verified_at: null })
      }

      const { error } = await supabase.from('profiles').update(updates).eq('id', employeeId)
      if (error) throw error

      if (!isHrUpdate) {
        // Notify HR and Finance admins
        await sendNotification({
          userIds: ['demo-hr-admin-id', 'demo-payroll-admin-id', 'demo-super-admin-id'],
          title: 'Bank Account Verification Required',
          message: `${employeeName || 'An employee'} submitted updated bank account details for salary credit.`,
          type: 'payroll',
          link: '/payroll'
        })
      } else {
        await sendNotification({
          userId: employeeId,
          title: 'Bank Account Updated',
          message: 'Your bank account details for salary credit have been updated and verified by HR/Finance.',
          type: 'payroll',
          link: '/dashboard'
        })
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['employees'] })
      qc.invalidateQueries({ queryKey: ['notifications'] })
    },
  })
}

export function useVerifyBankAccount() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ employeeId, status, remarks, verifiedBy, employeeName }) => {
      const isApproved = status === 'verified'
      const updates = {
        bank_verification_status: status,
        bank_verification_remarks: remarks || (isApproved ? 'Verified for salary credit by HR/Finance.' : 'Rejected. Please review and update account details.'),
        bank_verified_by: verifiedBy || 'HR/Finance',
        bank_verified_at: isoInstant()
      }

      const { error } = await supabase.from('profiles').update(updates).eq('id', employeeId)
      if (error) throw error

      await sendNotification({
        userId: employeeId,
        title: isApproved ? 'Bank Account Verified' : 'Bank Account Submission Rejected',
        message: isApproved
          ? 'Your bank account details for salary credit have been successfully verified by HR/Finance.'
          : `Your bank account details submission was rejected for ${employeeName || 'account'}: ${remarks || 'Incorrect information'}. Please re-submit valid account details.`,
        type: 'payroll',
        link: '/dashboard'
      })
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['employees'] })
      qc.invalidateQueries({ queryKey: ['notifications'] })
    },
  })
}

