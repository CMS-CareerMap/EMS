import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api, fetchBlob, saveFromApi } from '../api/http'

/**
 * Payroll, from the server — runs, payslips, the month's inputs, bank accounts
 * and the bank transfer file.
 *
 * This file used to write payroll runs to a hosted table with figures the BROWSER
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
      qc.invalidateQueries({ queryKey: ['dashboard', 'payroll'] })
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

/**
 * The month's entries — `rows` — and `blocked`: the people whose amounts the
 * caller may not enter, by employee id, with whom to ask (Day 22: your own work
 * goes up the company tree).
 */
export function useMonthlyEntries(year, month) {
  return useQuery({
    queryKey: keys.entries(year, month),
    queryFn: async () => {
      const payload = await api.get(`/payroll/monthly-entries?year=${year}&month=${month}`)
      return { rows: payload.data, blocked: new Map((payload.meta?.blocked ?? []).map((b) => [b.employee_id, b])) }
    },
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
      qc.invalidateQueries({ queryKey: ['dashboard', 'payroll'] })
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
      qc.invalidateQueries({ queryKey: ['dashboard', 'payroll'] })
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
    onSuccess: () => Promise.all([
      qc.invalidateQueries({ queryKey: ['payroll', 'tds'] }),
      qc.invalidateQueries({ queryKey: ['payroll', 'readiness'] }),
    ]),
  })
}

// ── Bank accounts and the bank transfer file ────────────────────────────────

/** Everybody's account, and the upload limit for a proof attached here. */
export function useBankAccounts(enabled = true) {
  return useQuery({
    queryKey: keys.bankAccounts,
    queryFn: async () => {
      const payload = await api.get('/payroll/bank-accounts')
      return { rows: payload.data, maxUploadMb: payload.meta.max_upload_mb }
    },
    enabled,
  })
}

/** Multipart when a proof is attached — the cheque or passbook page — JSON otherwise. */
function accountForm(account, proof) {
  const form = new FormData()
  for (const [key, value] of Object.entries(account)) {
    if (value !== undefined && value !== null && value !== '') form.append(key, String(value))
  }
  form.append('proof', proof, proof.name)
  return form
}

export function useSaveBankAccount() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ employeeId, proof, ...account }) =>
      (proof
        ? await api.upload(`/payroll/employees/${employeeId}/bank-account`, accountForm(account, proof), 'PUT')
        : await api.put(`/payroll/employees/${employeeId}/bank-account`, account)
      ).data,
    // Settled, not just succeeded: when the account changed meanwhile (409),
    // the list must show what is there now.
    onSettled: () => Promise.all([
      qc.invalidateQueries({ queryKey: keys.bankAccounts }),
      qc.invalidateQueries({ queryKey: ['payroll', 'bank-preview'] }),
      qc.invalidateQueries({ queryKey: ['dashboard', 'payroll'] }),
    ]),
  })
}

export function useVerifyBankAccount() {
  const qc = useQueryClient()
  return useMutation({
    // accountUpdatedAt: the version that was checked — the server refuses a
    // decision once the account has changed.
    mutationFn: async ({ employeeId, decision, remarks, accountUpdatedAt }) =>
      (await api.post(`/payroll/employees/${employeeId}/bank-account/verify`, { decision, remarks, accountUpdatedAt })).data,
    onSettled: () => Promise.all([
      qc.invalidateQueries({ queryKey: keys.bankAccounts }),
      qc.invalidateQueries({ queryKey: ['payroll', 'bank-preview'] }),
      qc.invalidateQueries({ queryKey: ['dashboard', 'payroll'] }),
    ]),
  })
}

/** The cheque or passbook page on file for somebody's account. */
export function bankProofBlob(employeeId) {
  return fetchBlob(`/payroll/employees/${employeeId}/bank-account/proof`)
}

export function downloadBankProof(employeeId) {
  return saveFromApi(`/payroll/employees/${employeeId}/bank-account/proof`)
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
  return useQuery({
    queryKey: keys.myBank,
    queryFn: async () => {
      const payload = await api.get('/payslips/me/bank-account')
      return { account: payload.data, maxUploadMb: payload.meta.max_upload_mb }
    },
  })
}

/**
 * Sending in my own account, with a cancelled cheque or passbook page. It
 * waits for Accounts to check it against that proof.
 */
export function useSubmitMyBankAccount() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ proof, ...account }) => {
      const form = new FormData()
      for (const [key, value] of Object.entries(account)) {
        if (value !== undefined && value !== null && value !== '') form.append(key, String(value))
      }
      if (proof) form.append('proof', proof, proof.name)
      return (await api.upload('/payslips/me/bank-account', form, 'PUT')).data
    },
    // The form shows these beside the field they are about.
    meta: { quietCodes: ['BAD_REQUEST', 'PAYLOAD_TOO_LARGE', 'VALIDATION_FAILED'] },
    onSuccess: () => Promise.all([qc.invalidateQueries({ queryKey: keys.myBank }), qc.invalidateQueries({ queryKey: ['dashboard', 'payroll'] })]),
  })
}
