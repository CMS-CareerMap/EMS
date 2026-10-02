import { useCallback, useState } from 'react'
import { Eye, Download, Upload, Trash2, Check, X, ChevronDown, ChevronRight, FileText, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import Dialog, { inputCls } from '../../components/Dialog'
import { useDownload } from '../../hooks/useDownload'
import { useDecideDocument, useRemoveDocument, documentBlob, downloadDocument } from '../../hooks/useDocuments'
import { formatSize } from '../../lib/prepareUpload'
import PreviewDialog from './PreviewDialog'
import UploadDialog from './UploadDialog'
import { STATUS, when } from './meta'

/**
 * One person's documents against the company's checklist.
 *
 * `reviewer` — HR or Admin looking at somebody else's: they may verify,
 * reject, remove, and file documents for them. Looking at their OWN, a
 * reviewer is an employee like anyone else: the server refuses a decision on
 * one's own document, and the buttons are not drawn for it.
 */
export default function Checklist({ data, types, limits, reviewer, canUpload }) {
  const [uploading, setUploading] = useState(null)
  const [viewing, setViewing] = useState(null)
  const [deciding, setDeciding] = useState(null)
  const [removing, setRemoving] = useState(null)
  const [open, setOpen] = useState({})
  const { busy, start } = useDownload()

  // Reviewing somebody else's — and allowed to check theirs: somebody who
  // checks documents too has theirs checked by the people above them (Day 22).
  const reviews = reviewer && !data.own
  const decides = reviews && data.may_check !== false
  const required = data.items.filter((i) => i.type.required)
  const verified = required.filter((i) => i.current?.status === 'verified').length
  const employee = data.employee

  const canRemove = (doc) => (reviews ? true : data.own && doc.status === 'pending' && !doc.replaced_at)

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 border-b border-gray-100 bg-slate-50">
        <div>
          <p className="text-sm font-bold text-gray-900">{employee.full_name}</p>
          <p className="text-xs text-gray-500">
            <span className="font-mono">{employee.employee_code}</span>
            {employee.department ? ` · ${employee.department}` : ''}
            {employee.designation ? ` · ${employee.designation}` : ''}
          </p>
        </div>
        <div className="text-right">
          <p className="text-sm font-bold text-gray-900">{verified} / {required.length}</p>
          <p className="text-[11px] uppercase tracking-wider font-semibold text-gray-400">Required verified</p>
        </div>
      </div>

      {reviews && data.may_check === false && (
        <p className="px-5 py-2.5 text-xs text-gray-600 bg-amber-50 border-b border-amber-100">
          {employee.full_name} checks documents too, so the people above them check theirs: {data.check_goes_to}.
        </p>
      )}
      {data.own && reviewer && data.check_goes_to && (
        <p className="px-5 py-2.5 text-xs text-gray-600 bg-gray-50 border-b border-gray-100">
          Your own documents are checked by the person above you: {data.check_goes_to}.
        </p>
      )}

      <div className="divide-y divide-gray-100">
        {data.items.map((item) => {
          const doc = item.current
          const status = STATUS[doc?.status ?? 'missing']
          return (
            <div key={item.type.id} className="px-5 py-4">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="flex items-start gap-3 min-w-0">
                  <FileText className="w-5 h-5 text-gray-300 shrink-0 mt-0.5" />
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-semibold text-gray-900">{item.type.label}</p>
                      {item.type.required && <span className="text-[10px] px-1.5 py-0.5 rounded font-bold uppercase bg-red-50 text-red-700 border border-red-200">Required</span>}
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold border ${status.cls}`}>
                        <status.icon className="w-3.5 h-3.5" /> {status.label}
                      </span>
                    </div>
                    {doc ? (
                      <div className="mt-1 text-xs text-gray-500 space-y-0.5">
                        <p className="truncate">{doc.file_name} · {formatSize(doc.bytes)} · uploaded {when(doc.uploaded_at)}{doc.uploaded_by && !data.own ? ` by ${doc.uploaded_by}` : ''}</p>
                        {doc.status === 'rejected' && doc.remarks && <p className="text-red-600">Why: {doc.remarks}</p>}
                        {doc.status === 'verified' && doc.decided_at && <p>Verified {when(doc.decided_at)}{doc.decided_by ? ` by ${doc.decided_by}` : ''}</p>}
                      </div>
                    ) : (
                      <p className="mt-1 text-xs text-gray-400">{data.own ? 'Not uploaded yet.' : 'Nothing uploaded.'}</p>
                    )}
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-1.5 sm:justify-end">
                  {doc && (
                    <>
                      <button onClick={() => setViewing(doc)} className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold">
                        <Eye className="w-3.5 h-3.5" /> View
                      </button>
                      <button onClick={() => start(doc.id, () => downloadDocument(doc.id))} disabled={busy === doc.id} aria-label={`Download ${item.type.label}`}
                        className="p-1.5 rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50 disabled:opacity-50">
                        {busy === doc.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                      </button>
                    </>
                  )}
                  {decides && doc?.status === 'pending' && (
                    <>
                      <button onClick={() => setDeciding({ doc, decision: 'verified' })} aria-label={`Verify ${item.type.label}`}
                        className="p-1.5 rounded-lg bg-green-50 hover:bg-green-100 text-green-700 border border-green-200"><Check className="w-4 h-4" /></button>
                      <button onClick={() => setDeciding({ doc, decision: 'rejected' })} aria-label={`Reject ${item.type.label}`}
                        className="p-1.5 rounded-lg bg-red-50 hover:bg-red-100 text-red-600 border border-red-200"><X className="w-4 h-4" /></button>
                    </>
                  )}
                  {doc && canRemove(doc) && (
                    <button onClick={() => setRemoving(doc)} aria-label={`Remove ${item.type.label}`}
                      className="p-1.5 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50"><Trash2 className="w-4 h-4" /></button>
                  )}
                  {canUpload && (
                    <button onClick={() => setUploading(item.type)}
                      className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-dashed border-gray-300 hover:border-blue-400 hover:bg-blue-50 text-gray-600 hover:text-blue-700 text-xs font-semibold">
                      <Upload className="w-3.5 h-3.5" /> {doc ? 'Replace' : 'Upload'}
                    </button>
                  )}
                </div>
              </div>

              {item.earlier.length > 0 && (
                <div className="mt-2 ml-8">
                  <button onClick={() => setOpen((o) => ({ ...o, [item.type.id]: !o[item.type.id] }))} className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700">
                    {open[item.type.id] ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                    Earlier uploads ({item.earlier.length})
                  </button>
                  {open[item.type.id] && (
                    <ul className="mt-1 space-y-1">
                      {item.earlier.map((old) => (
                        <li key={old.id} className="flex flex-wrap items-center gap-2 text-xs text-gray-500">
                          <span className="truncate max-w-56">{old.file_name}</span>
                          <span>· {STATUS[old.status].label.toLowerCase()} · replaced {when(old.replaced_at)}</span>
                          <button onClick={() => setViewing(old)} className="text-blue-600 hover:underline">View</button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          )
        })}
        {data.other.length > 0 && (
          <div className="px-5 py-4">
            <p className="text-xs font-semibold text-gray-500 mb-2">Filed under types no longer asked for</p>
            <ul className="space-y-1">
              {data.other.map((doc) => (
                <li key={doc.id} className="flex items-center gap-2 text-sm text-gray-700">
                  <span>{doc.type.label}: {doc.file_name}</span>
                  <button onClick={() => setViewing(doc)} className="text-xs text-blue-600 hover:underline">View</button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {uploading && (
        <UploadDialog types={types} type={uploading} limits={limits} employee={data.own ? null : employee} canVerify={decides} onClose={() => setUploading(null)} />
      )}
      {viewing && (
        <DocumentPreview doc={viewing} employee={employee} decides={decides} onDecide={(decision) => { setDeciding({ doc: viewing, decision }); setViewing(null) }} onClose={() => setViewing(null)} />
      )}
      {deciding && <DecisionDialog doc={deciding.doc} decision={deciding.decision} employee={employee} onClose={() => setDeciding(null)} />}
      {removing && <RemoveDialog doc={removing} onClose={() => setRemoving(null)} />}
    </div>
  )
}

function DocumentPreview({ doc, employee, decides, onDecide, onClose }) {
  const loadBlob = useCallback(() => documentBlob(doc.id), [doc.id])
  const status = STATUS[doc.status]
  return (
    <PreviewDialog
      title={`${doc.type.label} — ${employee.full_name}`}
      subtitle={`${doc.file_name} · ${formatSize(doc.bytes)} · ${status.label}${doc.replaced_at ? ' · replaced by a newer upload' : ''}`}
      loadBlob={loadBlob}
      download={() => downloadDocument(doc.id)}
      contentType={doc.content_type}
      onClose={onClose}
    >
      {({ failed }) =>
        decides && doc.status === 'pending' && !doc.replaced_at ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className={`text-xs ${failed ? 'text-amber-800' : 'text-gray-500'}`}>
              {failed ? 'This file cannot be checked. Reject it, and ask for it to be uploaded again.' : 'Compare it with the original before verifying.'}
            </p>
            <div className="flex gap-2">
              <button onClick={() => onDecide('rejected')} className="flex items-center gap-1.5 px-4 py-2 rounded-lg border border-red-200 text-red-600 hover:bg-red-50 text-sm font-medium"><X className="w-4 h-4" /> Reject</button>
              {!failed && (
                <button onClick={() => onDecide('verified')} className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-green-600 hover:bg-green-700 text-white text-sm font-medium"><Check className="w-4 h-4" /> Verify</button>
              )}
            </div>
          </div>
        ) : doc.status === 'rejected' && doc.remarks ? (
          <p className="text-sm text-red-700">Rejected: {doc.remarks}</p>
        ) : null
      }
    </PreviewDialog>
  )
}

function DecisionDialog({ doc, decision, employee, onClose }) {
  const decide = useDecideDocument()
  const [remarks, setRemarks] = useState('')
  const [asked, setAsked] = useState(false)
  const verifying = decision === 'verified'

  async function handle(e) {
    e.preventDefault()
    if (!verifying && !remarks.trim()) {
      setAsked(true)
      return
    }
    const ok = await decide.mutateAsync({ id: doc.id, decision, remarks: remarks.trim() }).then(() => true, () => false)
    if (ok) {
      toast.success(verifying ? `${doc.type.label} verified` : `${doc.type.label} rejected — ${employee.full_name} will be told why`)
      onClose()
    }
  }

  return (
    <Dialog title={`${verifying ? 'Verify' : 'Reject'} ${doc.type.label} — ${employee.full_name}`} onClose={onClose}>
      <form onSubmit={handle} className="space-y-4">
        <p className="text-sm text-gray-600">
          {verifying
            ? 'Verify only after comparing the file with the original document.'
            : 'Say what is wrong, so it can be put right. The employee sees this and uploads a corrected copy.'}
        </p>
        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-gray-600">Remarks {verifying ? <span className="text-gray-400 font-normal">(optional)</span> : ''}</span>
          <textarea rows={3} className={inputCls} value={remarks} maxLength={300} onChange={(e) => setRemarks(e.target.value)}
            placeholder={verifying ? 'For example: matches the original' : 'For example: the photo is blurred — the number cannot be read'} />
          {asked && !remarks.trim() && <span className="text-xs text-red-600">Say why, so it can be put right.</span>}
        </label>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-lg border border-gray-300 text-sm font-medium text-gray-700">Cancel</button>
          <button type="submit" disabled={decide.isPending}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-white text-sm font-medium disabled:opacity-60 ${verifying ? 'bg-green-600 hover:bg-green-700' : 'bg-red-600 hover:bg-red-700'}`}>
            {decide.isPending && <Loader2 className="w-4 h-4 animate-spin" />} {verifying ? 'Verify' : 'Reject'}
          </button>
        </div>
      </form>
    </Dialog>
  )
}

function RemoveDialog({ doc, onClose }) {
  const remove = useRemoveDocument()
  async function handle() {
    const ok = await remove.mutateAsync({ id: doc.id }).then(() => true, () => false)
    if (ok) {
      toast.success('Document removed')
      onClose()
    }
  }
  return (
    <Dialog title={`Remove ${doc.type.label}?`} onClose={onClose}>
      <p className="text-sm text-gray-600">
        It comes off the list. If it replaced an earlier upload, that one is current again. The file itself is kept, so the record of what was filed is never lost.
      </p>
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className="px-4 py-2 rounded-lg border border-gray-300 text-sm font-medium text-gray-700">Keep it</button>
        <button onClick={handle} disabled={remove.isPending} className="px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white text-sm font-medium disabled:opacity-60">Remove</button>
      </div>
    </Dialog>
  )
}
