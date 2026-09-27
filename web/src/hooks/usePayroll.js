import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api, saveFromApi } from '../api/http'

/**
 * Payroll, from the server — runs, payslips, the month's inputs, bank accounts
 * and the bank transfer file.
 *
 * This file used to write payroll runs to Supabase with figures the BROWSER
 * had worked out: an estimate built from CTC by fixed percentages, sent up as
 * the payslip. Nothing here calculates anything now. Every figure is the
 * server's, from domain/payroll, and a screen only shows what it is sent.
 */

const keys = {
  runs: ['payroll', 'runs'],
  run: (id) => ['payroll', 'run', id],
  readiness: (year, month) => ['payroll', 'readiness', year, month],
  payslip: (runId, payslipId) => ['payroll', 'payslip', runId, payslipId],
  entries: (year, month) => ['payroll', 'entries', year, month],
  tds: (fy) => ['payroll', 'tds', fy],
  bankAccounts: ['payroll', 'bank-accounts'],
  bankTemplate: ['payroll', 'bank-template'],
  bankPreview: (runId, payDate) => ['payroll', 'bank-preview', runId, payDate],
  mine: ['payslips', 'mine'],
  myBank: ['payslips', 'my-bank-account'],
}

// ── Runs ────────────────────────────────────────────────────────────────────

export function usePayrollRuns({ enabled = true } = {}) {
  return useQuery({ queryKey: keys.runs, queryFn: async () => (await api.get('/payroll-runs')).data, enabled })
}

export function usePayrollRun(id) {
  return useQuery({
    queryKey: keys.run(id),
    queryFn: async () => (await api.get(`/payroll-runs/${id}`)).data,
    enabled: Boolean(id),
  })
}

/** What a run for this month would find — who is in it, what blocks it. Writes nothing. */
export function useRunReadiness(year, month, enabled = true) {
  return useQuery({
    queryKey: keys.readiness(year, month),
    queryFn: async () => (await api.get(`/payroll-runs/readiness?year=${year}&month=${month}`)).data,
    enabled: Boolean(year && month) && enabled,
  })
}

/** Everything a run touches, refreshed after any move it makes. */
function useRunMutation(mutationFn, meta) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn,
    meta,
    onSuccess: (run) => {
      qc.invalidateQueries({ queryKey: keys.runs })
      qc.invalidateQueries({ queryKey: ['payroll', 'readiness'] })
      qc.invalidateQueries({ queryKey: ['payroll', 'payslip'] })
      qc.invalidateQueries({ queryKey: ['payroll', 'bank-preview'] })
      if (run?.id) qc.setQueryData(keys.run(run.id), run)
    },
  })
}

export function useCreateRun() {
  return useRunMutation(async ({ year, month }) => (await api.post('/payroll-runs', { year, month })).data)
}

export function useRecalculateRun() {
  return useRunMutation(async (id) => (await api.post(`/payroll-runs/${id}/recalculate`)).data)
}

export function useDiscardRun() {
  return useRunMutation(async (id) => {
    await api.del(`/payroll-runs/${id}`)
    return null
  })
}

/** `confirmAssumedDays` only once somebody has read which days were counted as paid on no record. */
export function useApproveRun() {
  return useRunMutation(
    async ({ id, confirmAssumedDays }) =>
      (await api.post(`/payroll-runs/${id}/approve`, confirmAssumedDays ? { confirmAssumedDays: true } : {})).data,
    // The approval screen answers these itself: the days to confirm, or the
    // records that changed since the draft.
    { quietCodes: ['BUSINESS_RULE'] },
  )
}

export function useReopenRun() {
  return useRunMutation(async (id) => (await api.post(`/payroll-runs/${id}/reopen`)).data)
}

export function useMarkRunPaid() {
  return useRunMutation(async ({ id, paidOn }) => (await api.post(`/payroll-runs/${id}/mark-paid`, { paidOn })).data)
}

export function usePayslipDetail(runId, payslipId) {
  return useQuery({
    queryKey: keys.payslip(runId, payslipId),
    queryFn: async () => (await api.get(`/payroll-runs/${runId}/payslips/${payslipId}`)).data,
    enabled: Boolean(runId && payslipId),
  })
}

/** The stored PDF once paid; before that, a preview stamped as not a payslip. */
export function downloadRunPayslip(runId, payslipId) {
  return saveFromApi(`/payroll-runs/${runId}/payslips/${payslipId}/pdf`)
}

// ── What people enter for a month ───────────────────────────────────────────

export function useMonthlyEntries(year, month) {
  return useQuery({
    queryKey: keys.entries(year, month),
    queryFn: async () => (await api.get(`/payroll/monthly-entries?year=${year}&month=${month}`)).data,
    enabled: Boolean(year && month),
  })
}

export function useSetMonthlyEntry() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (entry) => (await api.put('/payroll/monthly-entries', entry)).data,
    onSuccess: (_d, { year, month }) => {
      qc.invalidateQueries({ queryKey: keys.entries(year, month) })
      qc.invalidateQueries({ queryKey: ['payroll', 'readiness'] })
    },
  })
}

export function useDeleteMonthlyEntry() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ id }) => api.del(`/payroll/monthly-entries/${id}`),
    onSuccess: (_d, { year, month }) => {
      qc.invalidateQueries({ queryKey: keys.entries(year, month) })
      qc.invalidateQueries({ queryKey: ['payroll', 'readiness'] })
    },
  })
}

/** Directives of one financial year, and whether TDS is deducted at all. */
export function useTdsDirectives(financialYear) {
  return useQuery({
    queryKey: keys.tds(financialYear),
    queryFn: async () => {
      const payload = await api.get(`/payroll/tds-directives?financialYear=${financialYear}`)
      return { directives: payload.data, tdsEnabled: Boolean(payload.meta?.tds_enabled) }
    },
    enabled: Boolean(financialYear),
  })
}

export function useSetTdsDirective() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input) => (await api.put('/payroll/tds-directives', input)).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['payroll', 'tds'] })
      qc.invalidateQueries({ queryKey: ['payroll', 'readiness'] })
    },
  })
}

// ── Bank accounts and the bank transfer file ────────────────────────────────

export function useBankAccounts(enabled = true) {
  return useQuery({
    queryKey: keys.bankAccounts,
    queryFn: async () => (await api.get('/payroll/bank-accounts')).data,
    enabled,
  })
}

export function useSaveBankAccount() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ employeeId, ...account }) =>
      (await api.put(`/payroll/employees/${employeeId}/bank-account`, account)).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.bankAccounts })
      qc.invalidateQueries({ queryKey: ['payroll', 'bank-preview'] })
    },
  })
}

export function useVerifyBankAccount() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ employeeId, decision, remarks }) =>
      (await api.post(`/payroll/employees/${employeeId}/bank-account/verify`, { decision, remarks })).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.bankAccounts })
      qc.invalidateQueries({ queryKey: ['payroll', 'bank-preview'] })
    },
  })
}

export function useBankFileTemplate() {
  return useQuery({ queryKey: keys.bankTemplate, queryFn: async () => (await api.get('/payroll/bank-file-template')).data })
}

export function useSaveBankFileTemplate() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (template) => (await api.put('/payroll/bank-file-template', template)).data,
    onSuccess: (saved) => {
      qc.setQueryData(keys.bankTemplate, saved)
      qc.invalidateQueries({ queryKey: ['payroll', 'bank-preview'] })
    },
  })
}

export function useBankFilePreview(runId, payDate, enabled = true) {
  return useQuery({
    queryKey: keys.bankPreview(runId, payDate),
    queryFn: async () =>
      (await api.get(`/payroll-runs/${runId}/bank-file/preview${payDate ? `?payDate=${payDate}` : ''}`)).data,
    enabled: Boolean(runId) && enabled,
  })
}

export function downloadBankFile(runId, payDate) {
  return saveFromApi(`/payroll-runs/${runId}/bank-file${payDate ? `?payDate=${payDate}` : ''}`)
}

// ── A person's own payslips ─────────────────────────────────────────────────

export function useMyPayslips() {
  return useQuery({ queryKey: keys.mine, queryFn: async () => (await api.get('/payslips/me')).data })
}

export function downloadMyPayslip(id) {
  return saveFromApi(`/payslips/${id}/pdf`)
}

/** Where my salary is paid: the account Accounts recorded, its last four digits, or null. */
export function useMyBankAccount() {
  return useQuery({ queryKey: keys.myBank, queryFn: async () => (await api.get('/payslips/me/bank-account')).data })
}
