import { btn } from '../../components/ui/styles'
import { useState } from 'react'
import { Loader2, Upload } from 'lucide-react'
import { toast } from 'sonner'
import Dialog, { inputCls } from '../../components/Dialog'
import { prepareUpload, formatSize } from '../../lib/prepareUpload'
import { useUploadDocument } from '../../hooks/useDocuments'

/**
 * Uploading one document. A photo over the company's limit is made smaller
 * here first; a PDF over it gets a message rather than a failed upload.
 *
 * `employee` is set when HR files somebody else's document — then, and only
 * then, "I have checked this against the original" is offered.
 */
export default function UploadDialog({ types, type, employee, limits, onClose, canVerify = true }) {
  const upload = useUploadDocument()
  const [typeId, setTypeId] = useState(type?.id ?? types[0]?.id ?? '')
  const [file, setFile] = useState(null)
  const [checked, setChecked] = useState(false)
  const [problem, setProblem] = useState('')
  const [preparing, setPreparing] = useState(false)
  const chosen = types.find((t) => t.id === typeId)

  async function handleSubmit(e) {
    e.preventDefault()
    if (!file) return
    setProblem('')
    setPreparing(true)
    let ready
    try {
      ready = await prepareUpload(file, limits.maxUploadMb)
    } catch (err) {
      setProblem(err.message)
      setPreparing(false)
      return
    }
    setPreparing(false)
    const ok = await upload.mutateAsync({
      file: ready,
      documentTypeId: typeId,
      employeeId: employee?.id,
      markVerified: Boolean(employee) && canVerify && checked,
    }).then(() => true, (err) => {
      setProblem(err.message)
      return false
    })
    if (ok) {
      toast.success(`${chosen?.label ?? 'Document'} uploaded`)
      onClose()
    }
  }

  const busy = preparing || upload.isPending

  return (
    <Dialog title={employee ? `Upload for ${employee.full_name}` : 'Upload a document'} onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-gray-600">Document</span>
          <select className={inputCls} value={typeId} onChange={(e) => setTypeId(e.target.value)} disabled={Boolean(type)} required>
            {types.map((t) => <option key={t.id} value={t.id}>{t.label}{t.required ? ' (required)' : ''}</option>)}
          </select>
        </label>

        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-gray-600">File</span>
          <input type="file" required accept={limits.accept} onChange={(e) => { setFile(e.target.files?.[0] ?? null); setProblem('') }}
            className="w-full text-sm file:mr-3 file:py-2 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-semibold file:bg-brand-50 file:text-brand-700 hover:file:bg-brand-100" />
          <span className="block text-xs text-gray-500">
            {limits.accepted.join(', ')} · up to {limits.maxUploadMb} MB. A larger photo is made smaller automatically.
            {file ? ` Chosen: ${file.name} (${formatSize(file.size)}).` : ''}
          </span>
        </label>

        {/* Filing it as verified is checking it — which, for somebody who checks documents too, goes up the company tree (Day 22). */}
        {employee && canVerify && (
          <label className="flex items-start gap-2 text-sm text-gray-700">
            <input type="checkbox" className="mt-0.5" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
            <span>I have checked this against the original — file it as verified.</span>
          </label>
        )}

        {problem && <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3">{problem}</p>}

        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" onClick={onClose} className={btn.secondary}>Cancel</button>
          <button type="submit" disabled={busy || !file}
            className={btn.primary}>
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
            {preparing ? 'Making it smaller…' : 'Upload'}
          </button>
        </div>
      </form>
    </Dialog>
  )
}
