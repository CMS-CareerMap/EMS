import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api, fetchBlob, saveFromApi } from '../api/http'

/**
 * Documents, from the server — each employee's checklist and files, HR's
 * compliance view, and the company's own documents.
 *
 * The page this replaces read and wrote the old backend directly from the
 * component, kept files as base64 text in a table column, drew a pretend
 * "Government of India — OFFICIAL COPY" card when there was no file, and let
 * an employee mark their own Aadhaar verified. Every rule now lives on the
 * server; this file only asks.
 */

const keys = {
  types: (archived) => ['documents', 'types', archived],
  checklist: (employeeId) => ['documents', 'checklist', employeeId ?? 'me'],
  compliance: ['documents', 'compliance'],
  company: ['documents', 'company'],
}

/** The checklist of types, and what an upload may be (`meta.max_upload_mb`, `meta.accepted`). */
export function useDocumentTypes({ includeArchived = false, enabled = true } = {}) {
  return useQuery({
    queryKey: keys.types(includeArchived),
    queryFn: async () => {
      const payload = await api.get(`/document-types${includeArchived ? '?includeArchived=true' : ''}`)
      // The server always sends the limit; nothing here guesses one.
      return { types: payload.data, maxUploadMb: payload.meta.max_upload_mb, accepted: payload.meta.accepted, accept: payload.meta.accept }
    },
    enabled,
  })
}

export function useSaveDocumentType() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, ...change }) =>
      (id ? await api.patch(`/document-types/${id}`, change) : await api.post('/document-types', change)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['documents'] }),
  })
}

/**
 * The largest upload the company accepts (Super Admin's). Every screen that
 * checks a file before sending it reads this limit — the document types, the
 * bank-account lists and one's own bank account carry it — so all of them are
 * refreshed, or they would keep checking against the old one.
 */
export function useSaveUploadLimit() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (maxUploadMb) => (await api.put('/settings/company', { maxUploadMb })).data,
    onSuccess: () => Promise.all([
      qc.invalidateQueries({ queryKey: ['documents'] }),
      qc.invalidateQueries({ queryKey: ['settings', 'company'] }),
      qc.invalidateQueries({ queryKey: ['payroll', 'bank-accounts'] }),
      qc.invalidateQueries({ queryKey: ['payslips', 'my-bank-account'] }),
    ]),
  })
}

/** One person's checklist — the caller's own when no employee is given. */
export function useChecklist(employeeId, { enabled = true } = {}) {
  return useQuery({
    queryKey: keys.checklist(employeeId),
    queryFn: async () => (await api.get(`/employee-documents${employeeId ? `?employeeId=${employeeId}` : ''}`)).data,
    enabled,
    retry: false,
  })
}

export function useCompliance({ enabled = true } = {}) {
  return useQuery({ queryKey: keys.compliance, queryFn: async () => (await api.get('/employee-documents/compliance')).data, enabled })
}

/**
 * Returned, not just started: a mutation then settles only once the lists
 * show the change, so its dialog closes onto the new state rather than onto
 * the old one for a moment.
 */
function invalidateDocuments(qc) {
  return Promise.all([
    qc.invalidateQueries({ queryKey: ['documents', 'checklist'] }),
    qc.invalidateQueries({ queryKey: keys.compliance }),
  ])
}

/** Uploads a file for a document type. `employeeId` only when filing for somebody else. */
export function useUploadDocument() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ file, documentTypeId, employeeId, markVerified }) => {
      const form = new FormData()
      form.append('documentTypeId', documentTypeId)
      if (employeeId) form.append('employeeId', employeeId)
      if (markVerified) form.append('markVerified', 'true')
      form.append('file', file, file.name)
      return (await api.upload('/employee-documents', form)).data
    },
    onSuccess: () => invalidateDocuments(qc),
    // The upload dialog shows these itself, next to the file they are about.
    meta: { quietCodes: ['BAD_REQUEST', 'PAYLOAD_TOO_LARGE', 'VALIDATION_FAILED', 'FORBIDDEN'] },
  })
}

export function useDecideDocument() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, decision, remarks }) => (await api.post(`/employee-documents/${id}/decision`, { decision, remarks: remarks || null })).data,
    onSuccess: () => invalidateDocuments(qc),
  })
}

export function useRemoveDocument() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ id }) => api.del(`/employee-documents/${id}`),
    onSuccess: () => invalidateDocuments(qc),
  })
}

export function downloadDocument(id) {
  return saveFromApi(`/employee-documents/${id}/file`)
}

/** The file itself, to show on the page. */
export function documentBlob(id) {
  return fetchBlob(`/employee-documents/${id}/file`)
}

// ── The company's documents ─────────────────────────────────────────────────

export function useCompanyDocuments({ enabled = true } = {}) {
  return useQuery({ queryKey: keys.company, queryFn: async () => (await api.get('/company-documents')).data, enabled })
}

export function usePublishCompanyDocument() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ file, title, category, description }) => {
      const form = new FormData()
      form.append('title', title)
      form.append('category', category)
      if (description) form.append('description', description)
      form.append('file', file, file.name)
      return (await api.upload('/company-documents', form)).data
    },
    meta: { quietCodes: ['BAD_REQUEST', 'PAYLOAD_TOO_LARGE', 'VALIDATION_FAILED'] },
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.company }),
  })
}

export function useRemoveCompanyDocument() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ id }) => api.del(`/company-documents/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.company }),
  })
}

export function downloadCompanyDocument(id) {
  return saveFromApi(`/company-documents/${id}/file`)
}

export function companyDocumentBlob(id) {
  return fetchBlob(`/company-documents/${id}/file`)
}
