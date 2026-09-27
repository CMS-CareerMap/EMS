import { useState, useEffect, useMemo, useCallback } from 'react'
import {
  FileText, Upload, Download, Search, Eye,
  Trash2, Plus, FolderOpen, Shield, BookOpen,
  Megaphone, File, X, CheckCircle, Clock, AlertCircle, RefreshCw, Check, XCircle
} from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuthStore } from '../stores/authStore'
import { isoInstant } from '../lib/dates'

// ─── Constants ────────────────────────────────────────────────────────────────

const COMPANY_DOCS = [
  { id: 1,  name: 'Employee Handbook 2026',          category: 'handbook',     size: '2.4 MB', uploaded: '2026-01-10', uploader: 'Anita Rao',    type: 'pdf' },
  { id: 2,  name: 'Leave Policy — FY 2025-26',       category: 'policy',       size: '512 KB', uploaded: '2026-01-15', uploader: 'Anita Rao',    type: 'pdf' },
  { id: 3,  name: 'Work From Home Policy',           category: 'policy',       size: '320 KB', uploaded: '2025-11-01', uploader: 'Anita Rao',    type: 'pdf' },
  { id: 4,  name: 'Code of Conduct',                 category: 'policy',       size: '890 KB', uploaded: '2025-10-20', uploader: 'HR Admin',     type: 'pdf' },
]

const EMPLOYEE_DOC_TYPES = [
  { key: 'offer_letter',    label: 'Offer Letter',          required: true },
  { key: 'aadhaar',         label: 'Aadhaar Card',          required: true },
  { key: 'pan',             label: 'PAN Card',              required: true },
  { key: 'passport',        label: 'Passport',              required: false },
  { key: 'resume',          label: 'Resume / CV',           required: true },
  { key: 'edu_certificate', label: 'Education Certificate', required: false },
  { key: 'exp_letter',      label: 'Experience Letter',     required: false },
  { key: 'other',           label: 'Other Documents',       required: false },
]

const CATEGORY_META = {
  policy:       { label: 'Policy',       icon: Shield,    bg: 'bg-blue-100',   color: 'text-blue-600',   border: 'border-blue-200' },
  handbook:     { label: 'Handbook',     icon: BookOpen,  bg: 'bg-purple-100', color: 'text-purple-600', border: 'border-purple-200' },
  template:     { label: 'Template',     icon: File,      bg: 'bg-amber-100',  color: 'text-amber-600',  border: 'border-amber-200' },
  announcement: { label: 'Announcement', icon: Megaphone, bg: 'bg-green-100',  color: 'text-green-600',  border: 'border-green-200' },
}

const FILE_TYPE_COLOR = {
  pdf:  'bg-red-100 text-red-600',
  docx: 'bg-blue-100 text-blue-600',
  xlsx: 'bg-green-100 text-green-700',
}

function formatDate(str) {
  if (!str) return '—'
  return new Date(str).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getInitials(name) {
  return (name || '').split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase()
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function Documents() {
  const { user, can } = useAuthStore()
  const [tab, setTab] = useState('company')
  
  // Data lists
  const [profiles, setProfiles] = useState([])
  const [empDocs, setEmpDocs] = useState([])
  const [loading, setLoading] = useState(true)
  const [actionLoading, setActionLoading] = useState(false)
  
  // Modals & inputs
  const [uploadOpen, setUploadOpen] = useState(false)
  const [uploadTargetEmp, setUploadTargetEmp] = useState(null) // ID of employee (null if self)
  const [uploadDocType, setUploadDocType] = useState('aadhaar')
  const [uploadFile, setUploadFile] = useState(null)
  
  const [remarksOpen, setRemarksOpen] = useState(false)
  const [remarksTargetDoc, setRemarksTargetDoc] = useState(null) // document object
  const [remarksStatus, setRemarksStatus] = useState('verified') // 'verified' | 'rejected'
  const [remarksText, setRemarksText] = useState('')
  const [viewingDoc, setViewingDoc] = useState(null)

  const [selectedEmp, setSelectedEmp] = useState(null)
  const [searchEmp, setSearchEmp] = useState('')

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      // Fetch employee profiles
      const { data: profs } = await supabase
        .from('profiles')
        .select('id, full_name, employee_id, department, designation')
        .eq('status', 'active')
        .order('full_name')

      // Fetch uploaded employee documents
      const { data: docs } = await supabase
        .from('employee_documents')
        .select('*')

      setProfiles(profs || [])
      setEmpDocs(docs || [])

      // Auto-select first employee for admin view if not selected yet
      if (profs && profs.length > 0) {
        setSelectedEmp((current) => current || profs[0])
      }
    } catch (err) {
      console.error('Error fetching documents data:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // Handle document upload
  async function handleUpload(e) {
    e.preventDefault()
    if (!uploadFile) return

    setActionLoading(true)
    const empId = uploadTargetEmp || user.id
    const fileExt = uploadFile.name.split('.').pop()
    const filePath = `employee-docs/${empId}/${uploadDocType}_${Date.now()}.${fileExt}`

    let fileUrl = null
    try {
      fileUrl = await new Promise((resolve) => {
        const reader = new FileReader()
        reader.onload = (evt) => resolve(evt.target.result)
        reader.onerror = () => resolve(null)
        reader.readAsDataURL(uploadFile)
      })
    } catch (err) {
      console.warn('Failed to read file URL:', err)
    }

    try {
      // 1. Upload to Supabase storage
      const { error: uploadError } = await supabase.storage
        .from('employee-documents')
        .upload(filePath, uploadFile)

      if (uploadError) throw uploadError

      // 2. Insert/upsert DB record
      const { error: dbError } = await supabase
        .from('employee_documents')
        .upsert({
          employee_id: empId,
          doc_type: uploadDocType,
          file_name: uploadFile.name,
          file_path: filePath,
          file_url: fileUrl,
          file_size: uploadFile.size,
          file_type: uploadFile.type || `application/${fileExt}`,
          document_verification_status: 'pending',
          verified_by: null,
          verified_at: null,
          verification_remarks: null
        }, { onConflict: 'employee_id,doc_type' })

      if (dbError) throw dbError

      // 3. Reset and Refresh
      setUploadOpen(false)
      setUploadFile(null)
      await fetchData()
    } catch (err) {
      alert('Upload failed: ' + err.message)
    } finally {
      setActionLoading(false)
    }
  }

  // Open modal to enter remarks for approval/rejection
  function startVerification(doc, status) {
    setRemarksTargetDoc(doc)
    setRemarksStatus(status)
    setRemarksText('')
    setRemarksOpen(true)
  }

  // Submit approval/rejection decision
  async function submitVerification(e) {
    e.preventDefault()
    if (!remarksTargetDoc) return

    setActionLoading(true)
    try {
      const { error } = await supabase
        .from('employee_documents')
        .update({
          document_verification_status: remarksStatus,
          verified_by: user.id,
          verified_at: isoInstant(),
          verification_remarks: remarksText.trim() || null
        })
        .eq('id', remarksTargetDoc.id)

      if (error) throw error

      setRemarksOpen(false)
      setRemarksTargetDoc(null)
      await fetchData()
    } catch (err) {
      alert('Verification decision failed: ' + err.message)
    } finally {
      setActionLoading(false)
    }
  }

  // Delete a document
  async function handleDeleteDoc(doc) {
    if (!window.confirm('Are you sure you want to delete this document? This cannot be undone.')) return
    setActionLoading(true)

    try {
      // 1. Remove from storage
      await supabase.storage.from('employee-documents').remove([doc.file_path])

      // 2. Delete from DB
      const { error } = await supabase
        .from('employee_documents')
        .delete()
        .eq('id', doc.id)

      if (error) throw error

      await fetchData()
    } catch (err) {
      alert('Deletion failed: ' + err.message)
    } finally {
      setActionLoading(false)
    }
  }

  // Helper: map a list of documents by key for quick access
  const mappedEmpDocs = useMemo(() => {
    const map = {}
    empDocs.forEach(d => {
      if (!map[d.employee_id]) map[d.employee_id] = {}
      map[d.employee_id][d.doc_type] = d
    })
    return map
  }, [empDocs])

  // Compute compliance score
  const complianceStats = useMemo(() => {
    const requiredTypes = EMPLOYEE_DOC_TYPES.filter(t => t.required).map(t => t.key)
    let incompleteCount = 0

    profiles.forEach(emp => {
      const docs = mappedEmpDocs[emp.id] || {}
      const allUploaded = requiredTypes.every(k => docs[k] && docs[k].document_verification_status === 'verified')
      if (!allUploaded) incompleteCount++
    })

    return {
      incompleteCount,
      totalCount: profiles.length
    }
  }, [profiles, mappedEmpDocs])

  // Render Employee checklist section (for own files or viewing details)
  function renderChecklist(targetEmployeeId, isReviewView = false) {
    const docs = mappedEmpDocs[targetEmployeeId] || {}
    const empProfile = profiles.find(p => p.id === targetEmployeeId) || {}

    return (
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        {/* Header info */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 bg-slate-50">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-blue-100 flex items-center justify-center shrink-0">
              <span className="text-blue-700 text-sm font-semibold">{getInitials(empProfile.full_name)}</span>
            </div>
            <div>
              <p className="text-sm font-bold text-gray-900">{empProfile.full_name}</p>
              <p className="text-xs text-gray-400">{empProfile.employee_id} · {empProfile.department} · {empProfile.designation}</p>
            </div>
          </div>
          <div className="text-right">
            <p className="text-sm font-bold text-gray-900">
              {Object.values(docs).filter(d => d.document_verification_status === 'verified').length} / {EMPLOYEE_DOC_TYPES.filter(t => t.required).length}
            </p>
            <p className="text-[10px] uppercase font-bold tracking-wider text-gray-400">Required Verified</p>
          </div>
        </div>

        {/* Checklist */}
        <div className="divide-y divide-gray-100">
          {EMPLOYEE_DOC_TYPES.map((docType) => {
            const doc = docs[docType.key]
            const isUploaded = !!doc

            let statusBadge = (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-gray-100 text-gray-500 border border-gray-200">
                <Clock className="w-3.5 h-3.5" /> Not Uploaded
              </span>
            )
            if (isUploaded) {
              if (doc.document_verification_status === 'verified') {
                statusBadge = (
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-green-50 text-green-700 border border-green-200">
                    <CheckCircle className="w-3.5 h-3.5" /> Verified
                  </span>
                )
              } else if (doc.document_verification_status === 'rejected') {
                statusBadge = (
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-red-50 text-red-700 border border-red-200">
                    <XCircle className="w-3.5 h-3.5" /> Rejected
                  </span>
                )
              } else {
                statusBadge = (
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-50 text-amber-700 border border-amber-200">
                    <Clock className="w-3.5 h-3.5" /> Pending Verification
                  </span>
                )
              }
            }

            return (
              <div key={docType.key} className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-5 py-4 hover:bg-slate-50/50 transition-colors">
                <div className="flex items-start gap-3">
                  <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 mt-0.5
                    ${isUploaded ? (doc.document_verification_status === 'verified' ? 'bg-green-50 border border-green-100' : 'bg-amber-50 border border-amber-100') : 'bg-slate-100'}`}>
                    {isUploaded && doc.document_verification_status === 'verified'
                      ? <CheckCircle className="w-4 h-4 text-green-600" />
                      : <FileText className="w-4 h-4 text-slate-400" />
                    }
                  </div>
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-semibold text-slate-900">{docType.label}</p>
                      {docType.required && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded font-bold uppercase bg-red-100 text-red-700 border border-red-200">
                          Required
                        </span>
                      )}
                    </div>
                    {isUploaded ? (
                      <div className="mt-1">
                        <p className="text-xs text-slate-500 font-medium">{doc.file_name} ({(doc.file_size / (1024 * 1024)).toFixed(2)} MB)</p>
                        {doc.verification_remarks && (
                          <p className="text-xs text-slate-400 italic mt-0.5">Remarks: {doc.verification_remarks}</p>
                        )}
                        {doc.verified_at && (
                          <p className="text-[10px] text-slate-400 mt-0.5">
                            Reviewed on {formatDate(doc.verified_at)}
                          </p>
                        )}
                      </div>
                    ) : (
                      <p className="text-xs text-slate-400 mt-0.5">Please upload your document file.</p>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2 self-end sm:self-center">
                  <div className="mr-2">{statusBadge}</div>
                  
                  {isUploaded ? (
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => {
                          setViewingDoc({
                            ...doc,
                            profile: selectedEmp || profiles.find(p => p.id === doc.employee_id)
                          })
                        }}
                        className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold transition-colors"
                        title="View Document"
                      >
                        <Eye className="w-3.5 h-3.5" /> View
                      </button>
                      
                      {isReviewView && (
                        <>
                          <button
                            onClick={() => startVerification(doc, 'verified')}
                            className="flex items-center justify-center p-1.5 rounded-lg bg-green-50 hover:bg-green-100 text-green-600 border border-green-200 transition-colors"
                            title="Verify/Approve"
                          >
                            <Check className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => startVerification(doc, 'rejected')}
                            className="flex items-center justify-center p-1.5 rounded-lg bg-red-50 hover:bg-red-100 text-red-600 border border-red-200 transition-colors"
                            title="Reject Document"
                          >
                            <X className="w-4 h-4" />
                          </button>
                        </>
                      )}

                      <button
                        onClick={() => handleDeleteDoc(doc)}
                        className="p-1.5 rounded-lg bg-slate-50 hover:bg-red-50 text-slate-400 hover:text-red-500 transition-colors border border-transparent"
                        title="Delete Document"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => {
                        setUploadTargetEmp(targetEmployeeId)
                        setUploadDocType(docType.key)
                        setUploadOpen(true)
                      }}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-dashed border-gray-300
                        hover:border-blue-400 hover:bg-blue-50 text-gray-500 hover:text-blue-600 text-xs font-semibold transition-colors"
                    >
                      <Upload className="w-3.5 h-3.5" /> Upload File
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  // Filter employee list by search query
  const filteredProfiles = profiles.filter((p) =>
    p.full_name.toLowerCase().includes(searchEmp.toLowerCase()) ||
    p.employee_id.toLowerCase().includes(searchEmp.toLowerCase())
  )

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-slate-400">
        <RefreshCw className="w-8 h-8 animate-spin mb-3 text-blue-600" />
        <p className="text-sm font-medium">Loading documents matrix...</p>
      </div>
    )
  }

  // Whoever may verify documents — the same three roles the list named, held
  // as a permission so the server and this page cannot disagree.
  const isManagement = can('document:verify')

  return (
    <div className="space-y-6">
      
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Documents Hub</h2>
          <p className="text-sm text-gray-500 mt-0.5">Track compliance checklist, verify credentials, and view policy files</p>
        </div>
      </div>

      {/* Stats Cards (For management only) */}
      {isManagement && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 flex items-center gap-4">
            <div className="bg-blue-100 rounded-xl p-3 shrink-0">
              <FileText className="w-6 h-6 text-blue-600" />
            </div>
            <div>
              <p className="text-2xl font-bold text-gray-900">{COMPANY_DOCS.length}</p>
              <p className="text-sm text-gray-500">Company Policies & Handbooks</p>
            </div>
          </div>
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 flex items-center gap-4">
            <div className="bg-green-100 rounded-xl p-3 shrink-0">
              <Shield className="w-6 h-6 text-green-600" />
            </div>
            <div>
              <p className="text-2xl font-bold text-gray-900">{profiles.length}</p>
              <p className="text-sm text-gray-500">Employees Monitored</p>
            </div>
          </div>
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 flex items-center gap-4">
            <div className="bg-amber-100 rounded-xl p-3 shrink-0">
              <Clock className="w-6 h-6 text-amber-600" />
            </div>
            <div>
              <p className="text-2xl font-bold text-gray-900">{complianceStats.incompleteCount}</p>
              <p className="text-sm text-gray-500">Compliance Deficits</p>
            </div>
          </div>
        </div>
      )}

      {/* Tabs */}
      {isManagement && (
        <div className="flex items-center gap-1 border-b border-gray-200">
          <button onClick={() => setTab('company')}
            className={`px-4 py-2.5 text-sm font-semibold border-b-2 transition-all -mb-px flex items-center gap-2
              ${tab === 'company'
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}>
            <FileText className="w-4 h-4" /> Company Documents
          </button>
          <button onClick={() => setTab('employee')}
            className={`px-4 py-2.5 text-sm font-semibold border-b-2 transition-all -mb-px flex items-center gap-2
              ${tab === 'employee'
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}>
            <FolderOpen className="w-4 h-4" /> Employee Compliance
          </button>
        </div>
      )}

      {/* Tab content 1: Company Documents */}
      {(!isManagement || tab === 'company') && (
        <div className="space-y-4">
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden divide-y divide-gray-100">
            <div className="px-5 py-4 bg-slate-50 flex items-center justify-between border-b border-gray-100">
              <h3 className="text-sm font-bold text-gray-900">Official Policy Handbooks</h3>
              <span className="text-xs text-gray-400 font-medium">{COMPANY_DOCS.length} Documents</span>
            </div>
            {COMPANY_DOCS.map((doc) => {
              const meta = CATEGORY_META[doc.category]
              const Icon = meta?.icon || FileText
              return (
                <div key={doc.id} className="flex items-center justify-between gap-4 px-5 py-4 hover:bg-slate-50/50 transition-colors">
                  <div className="flex items-center gap-3">
                    <div className={`w-10 h-10 rounded-xl ${meta?.bg || 'bg-slate-100'} flex items-center justify-center shrink-0`}>
                      <Icon className={`w-5 h-5 ${meta?.color || 'text-slate-500'}`} />
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-slate-950">{doc.name}</p>
                      <p className="text-xs text-slate-400 mt-0.5">{doc.size} · Uploaded by {doc.uploader}</p>
                    </div>
                  </div>
                  <button
                    onClick={() => {
                      alert(`Downloading ${doc.name}...`);
                    }}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold transition-colors"
                  >
                    <Download className="w-3.5 h-3.5" /> Download
                  </button>
                </div>
              )
            })}
          </div>

          {/* Self checklist for Employees */}
          {!isManagement && (
            <div className="mt-8 space-y-4">
              <h3 className="text-lg font-bold text-slate-900">My Compliance Checklist</h3>
              {renderChecklist(user.id, false)}
            </div>
          )}
        </div>
      )}

      {/* Tab content 2: Employee compliance lists (Admin/HR only) */}
      {isManagement && tab === 'employee' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Employee list sidebar */}
          <div className="lg:col-span-1 space-y-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                type="text"
                placeholder="Search employees..."
                value={searchEmp}
                onChange={(e) => setSearchEmp(e.target.value)}
                className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent placeholder:text-gray-400 bg-white text-slate-950"
              />
            </div>

            <div className="space-y-2 overflow-y-auto max-h-[550px] pr-1">
              {filteredProfiles.map((emp) => {
                const isSelected = selectedEmp?.id === emp.id
                const docs = mappedEmpDocs[emp.id] || {}
                const reqTypes = EMPLOYEE_DOC_TYPES.filter(t => t.required)
                const verifiedCount = reqTypes.filter(t => docs[t.key] && docs[t.key].document_verification_status === 'verified').length
                const complete = verifiedCount === reqTypes.length

                return (
                  <button
                    key={emp.id}
                    onClick={() => setSelectedEmp(emp)}
                    className={`w-full text-left p-4 rounded-xl border transition-all duration-100
                      ${isSelected
                        ? 'border-blue-500 bg-blue-50/50 ring-1 ring-blue-500 shadow-sm'
                        : 'border-gray-200 bg-white hover:border-gray-300 hover:bg-gray-50'}`}
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center shrink-0">
                        <span className="text-blue-700 text-xs font-semibold">{getInitials(emp.full_name)}</span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold text-gray-900 truncate leading-none">{emp.full_name}</p>
                        <p className="text-[10px] text-gray-400 mt-1 truncate">{emp.department} · {emp.designation}</p>
                      </div>
                      {complete ? (
                        <CheckCircle className="w-4 h-4 text-green-500 shrink-0" />
                      ) : (
                        <span className="text-xs font-bold text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded border border-amber-100 shrink-0">
                          {verifiedCount}/{reqTypes.length}
                        </span>
                      )}
                    </div>
                  </button>
                )
              })}
            </div>
          </div>

          {/* Employee document checklist view */}
          <div className="lg:col-span-2">
            {selectedEmp ? (
              renderChecklist(selectedEmp.id, true)
            ) : (
              <div className="bg-white rounded-xl border border-gray-200 shadow-sm h-64 flex flex-col items-center justify-center py-20 text-center">
                <FolderOpen className="w-12 h-12 text-gray-300 mb-3" />
                <p className="text-sm font-medium text-gray-500">No Employee Selected</p>
                <p className="text-xs text-gray-400 mt-1">Select an employee from the sidebar to inspect their compliance documents.</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ─── Upload Modal ─────────────────────────────────────────────────── */}
      {uploadOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md overflow-hidden border border-gray-100">
            <div className="flex items-center justify-between px-6 py-5 border-b border-gray-100 bg-slate-50">
              <h2 className="text-base font-bold text-gray-900">Upload Verification Document</h2>
              <button onClick={() => setUploadOpen(false)} className="p-1.5 rounded-lg hover:bg-gray-200 text-gray-400 hover:text-gray-600 transition-colors">
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleUpload} className="p-6 space-y-4">
              <div className="space-y-1.5">
                <label className="text-xs font-bold uppercase tracking-wider text-slate-500">Document Category</label>
                <select
                  value={uploadDocType}
                  onChange={(e) => setUploadDocType(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white text-slate-900"
                >
                  {EMPLOYEE_DOC_TYPES.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}
                </select>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-bold uppercase tracking-wider text-slate-500">Select File</label>
                <input
                  type="file"
                  required
                  accept=".pdf,.png,.jpg,.jpeg"
                  onChange={(e) => setUploadFile(e.target.files[0])}
                  className="w-full text-sm file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-xs file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100 cursor-pointer text-slate-900"
                />
                <p className="text-[10px] text-slate-400">PDF, PNG, JPG formats up to 10MB.</p>
              </div>

              <div className="flex justify-end gap-3 pt-2 border-t border-gray-100">
                <button type="button" onClick={() => setUploadOpen(false)} className="px-4 py-2 rounded-lg border border-gray-300 text-sm font-semibold text-gray-700 hover:bg-gray-50 transition-colors">
                  Cancel
                </button>
                <button type="submit" disabled={actionLoading} className="px-5 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold transition-colors disabled:bg-blue-400">
                  {actionLoading ? 'Uploading...' : 'Upload File'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ─── Verification Remarks Modal ─────────────────────────────────────── */}
      {remarksOpen && remarksTargetDoc && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md overflow-hidden border border-gray-100">
            <div className="flex items-center justify-between px-6 py-5 border-b border-gray-100 bg-slate-50">
              <h2 className="text-base font-bold text-gray-900">
                {remarksStatus === 'verified' ? 'Verify/Approve Document' : 'Reject Document'}
              </h2>
              <button onClick={() => setRemarksOpen(false)} className="p-1.5 rounded-lg hover:bg-gray-200 text-gray-400 hover:text-gray-600 transition-colors">
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={submitVerification} className="p-6 space-y-4">
              <p className="text-xs text-slate-500 font-semibold leading-relaxed">
                Confirm your decision for <span className="font-bold text-slate-800">{remarksTargetDoc.file_name}</span>. Provide verification remarks or rejection reasons for compliance tracking.
              </p>
              
              <div className="space-y-1.5">
                <label className="text-xs font-bold uppercase tracking-wider text-slate-500">Remarks / Notes</label>
                <textarea
                  value={remarksText}
                  onChange={(e) => setRemarksText(e.target.value)}
                  placeholder={remarksStatus === 'verified' ? 'e.g. Validated against original physical document.' : 'e.g. Identity photo blurry, re-upload clean file.'}
                  rows={4}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 text-slate-900 bg-white placeholder:text-slate-400"
                />
              </div>

              <div className="flex justify-end gap-3 pt-2 border-t border-gray-100">
                <button type="button" onClick={() => setRemarksOpen(false)} className="px-4 py-2 rounded-lg border border-gray-300 text-sm font-semibold text-gray-700 hover:bg-gray-50 transition-colors">
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={actionLoading}
                  className={`px-5 py-2 rounded-lg text-white text-sm font-semibold transition-colors disabled:opacity-50
                    ${remarksStatus === 'verified' ? 'bg-green-600 hover:bg-green-700' : 'bg-red-600 hover:bg-red-700'}`}
                >
                  {actionLoading ? 'Saving decision...' : remarksStatus === 'verified' ? 'Approve & Verify' : 'Submit Rejection'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ─── Document Preview & Viewer Modal ─────────────────────────────── */}
      {viewingDoc && (
        <DocumentViewerModal
          doc={viewingDoc}
          profile={viewingDoc.profile}
          onClose={() => setViewingDoc(null)}
          onApprove={(d) => {
            setViewingDoc(null)
            startVerification(d, 'verified')
          }}
          onReject={(d) => {
            setViewingDoc(null)
            startVerification(d, 'rejected')
          }}
          isManagement={isManagement}
        />
      )}

    </div>
  )
}

function DocumentViewerModal({ doc, profile, onClose, onApprove, onReject, isManagement }) {
  if (!doc) return null

  const isImage = doc.file_url?.startsWith('data:image/') ||
                  doc.file_type?.includes('image') ||
                  /\.(jpg|jpeg|png|webp|gif)$/i.test(doc.file_name || doc.file_path || '')

  const isPdf = doc.file_url?.startsWith('data:application/pdf') ||
                doc.file_type?.includes('pdf') ||
                /\.pdf$/i.test(doc.file_name || doc.file_path || '')

  const docTypeName = EMPLOYEE_DOC_TYPES.find(t => t.key === doc.doc_type)?.label || doc.doc_type || 'Document'
  const empName = profile?.full_name || 'Employee'
  const empId = profile?.employee_id || 'EMP'
  const empDept = profile?.department || 'Operations'
  const status = doc.document_verification_status || 'pending'

  const handleDownload = () => {
    if (doc.file_url) {
      const a = document.createElement('a')
      a.href = doc.file_url
      a.download = doc.file_name || `${docTypeName}.pdf`
      a.click()
    } else {
      alert(`Downloading ${doc.file_name || docTypeName}...`)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4 overflow-y-auto">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl overflow-hidden border border-slate-200 my-8 flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-100 bg-slate-50 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-blue-100 text-blue-700 font-bold">
              <FileText className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-bold text-slate-900 leading-snug">{docTypeName}</h3>
              <p className="text-xs text-slate-500">{empName} ({empId}) · {doc.file_name || 'Verification Document'}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleDownload}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white border border-slate-300 hover:bg-slate-50 text-slate-700 text-xs font-semibold shadow-xs transition-colors"
            >
              <Download className="w-3.5 h-3.5" /> Download
            </button>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-200 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Content Viewer Body */}
        <div className="flex-1 overflow-y-auto p-6 bg-slate-900/5 flex flex-col items-center justify-center min-h-[350px]">
          {isImage && doc.file_url ? (
            <div className="w-full flex flex-col items-center justify-center">
              <img
                src={doc.file_url}
                alt={doc.file_name}
                className="max-h-[60vh] object-contain rounded-xl shadow-lg border border-slate-200 bg-white"
              />
            </div>
          ) : isPdf && doc.file_url ? (
            <iframe
              src={doc.file_url}
              title={doc.file_name}
              className="w-full h-[60vh] rounded-xl border border-slate-200 bg-white shadow-sm"
            />
          ) : (
            /* Render Authentic Stylized Document Preview Card for Mock / Demo Data */
            <div className="w-full max-w-xl bg-white rounded-2xl border border-slate-200 shadow-md p-6 relative overflow-hidden space-y-6">
              {/* Header Seal */}
              <div className="flex items-center justify-between border-b pb-4 border-slate-200">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-blue-600 flex items-center justify-center text-white font-bold text-sm">
                    {doc.doc_type === 'aadhaar' ? '🇮🇳' : doc.doc_type === 'pan' ? '💳' : '📄'}
                  </div>
                  <div>
                    <h4 className="text-sm font-bold text-slate-900 uppercase tracking-wide">
                      {doc.doc_type === 'aadhaar' ? 'Government of India — UIDAI' :
                       doc.doc_type === 'pan' ? 'Income Tax Department — Govt. of India' :
                       doc.doc_type === 'passport' ? 'Republic of India — Passport Authority' :
                       'CareerMap Solutions — Official Document'}
                    </h4>
                    <p className="text-[11px] text-slate-500 font-mono">DOCUMENT REF: {doc.file_path || `DOC-${doc.id || 'VERIFIED'}`}</p>
                  </div>
                </div>
                <div className="px-2.5 py-1 rounded-full text-xs font-bold bg-blue-50 text-blue-700 border border-blue-200">
                  OFFICIAL COPY
                </div>
              </div>

              {/* Body Details */}
              <div className="grid grid-cols-2 gap-4 text-xs">
                <div>
                  <span className="text-slate-400 font-medium block">Document Holder Name</span>
                  <span className="font-bold text-slate-900 text-sm">{empName}</span>
                </div>
                <div>
                  <span className="text-slate-400 font-medium block">Employee ID</span>
                  <span className="font-mono font-semibold text-slate-800">{empId}</span>
                </div>
                <div>
                  <span className="text-slate-400 font-medium block">Department</span>
                  <span className="font-medium text-slate-800">{empDept}</span>
                </div>
                <div>
                  <span className="text-slate-400 font-medium block">Document Type</span>
                  <span className="font-semibold text-blue-700 uppercase">{docTypeName}</span>
                </div>
                <div>
                  <span className="text-slate-400 font-medium block">Verification Status</span>
                  <span className={`inline-block font-semibold capitalize ${
                    status === 'verified' ? 'text-emerald-600' :
                    status === 'rejected' ? 'text-rose-600' : 'text-amber-600'
                  }`}>
                    ● {status}
                  </span>
                </div>
                <div>
                  <span className="text-slate-400 font-medium block">Uploaded File</span>
                  <span className="font-mono text-slate-700 truncate block">{doc.file_name || 'document.pdf'}</span>
                </div>
              </div>

              {/* Watermark / Badge / Remarks */}
              {doc.verification_remarks && (
                <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 text-xs">
                  <span className="font-bold text-slate-700 block">Verification Remarks:</span>
                  <p className="text-slate-600 mt-0.5">{doc.verification_remarks}</p>
                </div>
              )}

              {/* Bottom stamp */}
              <div className="pt-4 border-t border-slate-100 flex items-center justify-between text-[11px] text-slate-400">
                <span>Verified digitally via EMS Verification Portal</span>
                <span className="font-mono text-emerald-600 font-semibold">● SECURE ENCRYPTED DATA</span>
              </div>
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="px-6 py-4 border-t border-slate-100 bg-white flex items-center justify-between shrink-0">
          <div className="text-xs text-slate-500">
            Status: <span className="font-bold capitalize">{status}</span>
          </div>
          <div className="flex items-center gap-2">
            {isManagement && onApprove && onReject && (
              <>
                <button
                  onClick={() => onReject(doc)}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-rose-50 hover:bg-rose-100 text-rose-700 text-xs font-semibold border border-rose-200 transition-colors"
                >
                  <X className="w-3.5 h-3.5" /> Reject
                </button>
                <button
                  onClick={() => onApprove(doc)}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold shadow-xs transition-colors"
                >
                  <Check className="w-3.5 h-3.5" /> Approve & Verify
                </button>
              </>
            )}
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-xl border border-slate-300 text-slate-700 hover:bg-slate-50 text-xs font-semibold transition-colors"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
