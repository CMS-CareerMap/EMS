import { useCallback, useState } from 'react'
import { Shield, BookOpen, File, Megaphone, FileText, Eye, Download, Plus, Trash2, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import Dialog, { inputCls } from '../../components/Dialog'
import { useAuthStore } from '../../stores/authStore'
import { useDownload } from '../../hooks/useDownload'
import {
  useCompanyDocuments, usePublishCompanyDocument, useRemoveCompanyDocument,
  downloadCompanyDocument, companyDocumentBlob, useDocumentTypes,
} from '../../hooks/useDocuments'
import { prepareUpload, formatSize } from '../../lib/prepareUpload'
import DataState, { QueryError } from '../../components/DataState'
import PreviewDialog from './PreviewDialog'
import { CATEGORIES, categoryLabel, when } from './meta'

/**
 * The company's own documents — the handbook, the policies, the forms.
 * Everybody reads them; HR and Admin publish and withdraw them. The list the
 * old page showed ("Employee Handbook 2026, uploaded by Anita Rao") did not
 * exist anywhere, and its Download button was an alert().
 */

const ICONS = { policy: Shield, handbook: BookOpen, template: File, announcement: Megaphone, other: FileText }

export default function CompanyDocuments() {
  const can = useAuthStore((s) => s.can)
  const manages = can('document:company:manage')
  const docsQuery = useCompanyDocuments()
  const [publishing, setPublishing] = useState(false)
  const [viewing, setViewing] = useState(null)
  const [removing, setRemoving] = useState(null)
  const { busy, start } = useDownload()

  return (
    <div className="space-y-4">
      {manages && (
        <div className="flex justify-end">
          <button onClick={() => setPublishing(true)} className="flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium">
            <Plus className="w-4 h-4" /> Publish a document
          </button>
        </div>
      )}

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden divide-y divide-gray-100">
        <DataState query={docsQuery} empty={
          <div className="px-5 py-12 text-center">
            <FileText className="w-8 h-8 mx-auto text-gray-300" />
            <p className="mt-2 text-sm font-medium text-gray-700">No company documents yet</p>
            <p className="text-sm text-gray-500">{manages ? 'Publish the handbook or a policy, and everybody can read it here.' : 'Policies and the handbook appear here once HR publishes them.'}</p>
          </div>
        }>
          {(docs) => docs.map((doc) => {
            const Icon = ICONS[doc.category] ?? FileText
            return (
              <div key={doc.id} className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-5 py-4">
                <div className="flex items-start gap-3 min-w-0">
                  <div className="w-10 h-10 rounded-xl bg-blue-50 flex items-center justify-center shrink-0"><Icon className="w-5 h-5 text-blue-600" /></div>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-gray-900">{doc.title}</p>
                    <p className="text-xs text-gray-500">{categoryLabel(doc.category)} · {formatSize(doc.bytes)} · {when(doc.uploaded_at)}{doc.uploaded_by ? ` · ${doc.uploaded_by}` : ''}</p>
                    {doc.description && <p className="text-xs text-gray-600 mt-0.5">{doc.description}</p>}
                  </div>
                </div>
                <div className="flex items-center gap-1.5 self-end sm:self-center">
                  <button onClick={() => setViewing(doc)} className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold">
                    <Eye className="w-3.5 h-3.5" /> View
                  </button>
                  <button onClick={() => start(doc.id, () => downloadCompanyDocument(doc.id))} disabled={busy === doc.id}
                    className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-gray-200 text-gray-700 text-xs font-semibold hover:bg-gray-50 disabled:opacity-50">
                    {busy === doc.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />} Download
                  </button>
                  {manages && (
                    <button onClick={() => setRemoving(doc)} aria-label={`Withdraw ${doc.title}`} className="p-1.5 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </DataState>
      </div>

      {publishing && <PublishDialog onClose={() => setPublishing(false)} />}
      {viewing && <CompanyPreview doc={viewing} onClose={() => setViewing(null)} />}
      {removing && <WithdrawDialog doc={removing} onClose={() => setRemoving(null)} />}
    </div>
  )
}

function CompanyPreview({ doc, onClose }) {
  const loadBlob = useCallback(() => companyDocumentBlob(doc.id), [doc.id])
  return (
    <PreviewDialog title={doc.title} subtitle={`${categoryLabel(doc.category)} · ${formatSize(doc.bytes)}`} loadBlob={loadBlob}
      download={() => downloadCompanyDocument(doc.id)} contentType={doc.content_type} onClose={onClose} />
  )
}

function PublishDialog({ onClose }) {
  const publish = usePublishCompanyDocument()
  const typesQuery = useDocumentTypes()
  // The file is checked against the limit before it is sent: no limit, no publishing.
  const limits = typesQuery.isError ? undefined : typesQuery.data
  const [title, setTitle] = useState('')
  const [category, setCategory] = useState('policy')
  const [description, setDescription] = useState('')
  const [file, setFile] = useState(null)
  const [problem, setProblem] = useState('')
  const [preparing, setPreparing] = useState(false)
  const maxMb = limits?.maxUploadMb

  async function handle(e) {
    e.preventDefault()
    if (!file) return
    setProblem('')
    setPreparing(true)
    let ready
    try {
      ready = await prepareUpload(file, maxMb)
    } catch (err) {
      setProblem(err.message)
      setPreparing(false)
      return
    }
    setPreparing(false)
    const ok = await publish.mutateAsync({ file: ready, title: title.trim(), category, description: description.trim() }).then(() => true, (err) => {
      setProblem(err.message)
      return false
    })
    if (ok) {
      toast.success(`${title.trim()} published — everybody has been told`)
      onClose()
    }
  }

  return (
    <Dialog title="Publish a company document" onClose={onClose}>
      <form onSubmit={handle} className="space-y-4">
        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-gray-600">Title</span>
          <input className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} required minLength={2} maxLength={120} placeholder="Leave Policy 2026" />
        </label>
        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-gray-600">Kind</span>
          <select className={inputCls} value={category} onChange={(e) => setCategory(e.target.value)}>
            {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
        </label>
        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-gray-600">What it is <span className="text-gray-400 font-normal">(optional)</span></span>
          <input className={inputCls} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} />
        </label>
        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-gray-600">File</span>
          <input type="file" required accept={limits?.accept} onChange={(e) => { setFile(e.target.files?.[0] ?? null); setProblem('') }}
            className="w-full text-sm file:mr-3 file:py-2 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-semibold file:bg-blue-50 file:text-blue-700" />
          {limits && <span className="block text-xs text-gray-500">{limits.accepted.join(', ')} · up to {maxMb} MB.</span>}
        </label>
        {typesQuery.isError && <QueryError error={typesQuery.error} onRetry={() => typesQuery.refetch()} retrying={typesQuery.isFetching} compact />}
        {problem && <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3">{problem}</p>}
        <p className="text-xs text-gray-500">Everybody in the company is told it has been published.</p>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-lg border border-gray-300 text-sm font-medium text-gray-700">Cancel</button>
          <button type="submit" disabled={preparing || publish.isPending || !file || !limits}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 text-white text-sm font-medium">
            {(preparing || publish.isPending) && <Loader2 className="w-4 h-4 animate-spin" />} Publish
          </button>
        </div>
      </form>
    </Dialog>
  )
}

function WithdrawDialog({ doc, onClose }) {
  const remove = useRemoveCompanyDocument()
  async function handle() {
    const ok = await remove.mutateAsync({ id: doc.id }).then(() => true, () => false)
    if (ok) {
      toast.success(`${doc.title} withdrawn`)
      onClose()
    }
  }
  return (
    <Dialog title={`Withdraw ${doc.title}?`} onClose={onClose}>
      <p className="text-sm text-gray-600">Nobody will see it in Documents any more.</p>
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className="px-4 py-2 rounded-lg border border-gray-300 text-sm font-medium text-gray-700">Keep it</button>
        <button onClick={handle} disabled={remove.isPending} className="px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white text-sm font-medium disabled:opacity-60">Withdraw</button>
      </div>
    </Dialog>
  )
}
