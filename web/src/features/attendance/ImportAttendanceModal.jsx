import { useRef, useState } from 'react'
import { X, Upload, Loader2, CheckCircle2, AlertCircle, AlertTriangle } from 'lucide-react'
import { useImportAttendance } from '../../hooks/useAttendance'
import { useEscape } from '../../hooks/useEscape'

/**
 * Importing the biometric machine's attendance from a CSV file (Day 12).
 *
 * The server has read these files since Day 12 — a preview that saves nothing
 * and names every problem by line, then an all-or-nothing import — but no page
 * called it, so a company on the machine could not get its days in at all.
 * Same shape as the employee importer.
 */

const MAX_BYTES = 1_000_000

export default function ImportAttendanceModal({ onClose }) {
  useEscape(onClose)
  const importer = useImportAttendance()
  const fileInput = useRef(null)

  const [fileName, setFileName] = useState('')
  const [csv, setCsv] = useState('')
  const [preview, setPreview] = useState(null)
  const [result, setResult] = useState(null)
  const [fileError, setFileError] = useState('')

  async function handleFile(event) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return

    setPreview(null)
    setFileError('')
    if (file.size > MAX_BYTES) {
      setFileError('That file is larger than 1 MB. Export a shorter date range from the machine.')
      return
    }

    const text = await file.text()
    setFileName(file.name)
    setCsv(text)
    // The preview straight away: nothing is saved, and every problem comes back
    // with the line number the spreadsheet shows.
    const checked = await importer.mutateAsync({ csv: text, dryRun: true }).catch(() => null)
    if (checked) setPreview(checked)
  }

  async function handleImport() {
    const done = await importer.mutateAsync({ csv, dryRun: false }).catch(() => null)
    if (done) setResult(done)
  }

  const problems = preview?.rows.filter((row) => row.issues.length > 0) ?? []

  return (
    <div role="dialog" aria-modal="true" aria-label="Import attendance" className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 overflow-y-auto">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-3xl my-8 overflow-hidden">
        <div className="flex items-center justify-between px-6 py-5 border-b border-gray-100">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">Import Attendance</h2>
            <p className="text-sm text-gray-400 mt-0.5">From the biometric machine’s CSV — checked before anything is saved</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="p-2 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-5 max-h-[78vh] overflow-y-auto">
          {result ? (
            <div className="space-y-4">
              <div className="flex items-start gap-2 p-3 rounded-lg bg-green-50 border border-green-200">
                <CheckCircle2 className="w-4 h-4 text-green-600 mt-0.5 shrink-0" />
                <p className="text-sm text-green-800">
                  {result.summary.imported} day{result.summary.imported === 1 ? '' : 's'} imported
                  {result.summary.would_overwrite ? `, ${result.summary.would_overwrite} of them replacing a day already recorded` : ''}.
                </p>
              </div>
              <div className="flex justify-end">
                <button onClick={onClose} className="px-5 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium">Done</button>
              </div>
            </div>
          ) : (
            <>
              <div className="text-sm text-gray-600 space-y-2">
                <p>
                  One row per person per day, with the columns <span className="font-medium">employee_code</span>, <span className="font-medium">date</span>,{' '}
                  <span className="font-medium">check_in</span> and <span className="font-medium">check_out</span>. Most machines’ own names for them are read too
                  (emp_id, in_time, out_time…).
                </p>
                <p className="text-xs text-gray-500">
                  Dates as DD/MM/YYYY or YYYY-MM-DD; times as 09:30 or 9:30 AM, on the company’s clock. A check-out before the check-in is the next
                  morning, for a night shift. Hours, late marks and overtime are worked out from each person’s shift. A month whose payroll is
                  approved cannot change.
                </p>
                <p className="text-xs font-mono text-gray-500 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
                  employee_code,date,check_in,check_out<br />CMS007,01/09/2026,09:28,18:41
                </p>
              </div>

              <input ref={fileInput} type="file" accept=".csv,text/csv" onChange={handleFile} className="hidden" aria-label="Attendance CSV file" />
              <button onClick={() => fileInput.current?.click()} disabled={importer.isPending}
                className="w-full border-2 border-dashed border-gray-300 hover:border-blue-400 rounded-xl py-8 flex flex-col items-center gap-2 text-gray-500 hover:text-blue-600 transition-colors">
                {importer.isPending ? <Loader2 className="w-6 h-6 animate-spin" /> : <Upload className="w-6 h-6" />}
                <span className="text-sm font-medium">{fileName || 'Choose a CSV file'}</span>
                {fileName && <span className="text-xs text-gray-400">Choose again to replace it</span>}
              </button>

              {fileError && (
                <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{fileError}</p>
              )}
              {/* A refused preview or import, in the server's words, where the person is looking. */}
              {importer.isError && (
                <p role="alert" className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{importer.error?.message}</p>
              )}

              {preview && (
                <div className="space-y-3">
                  <div className="grid grid-cols-3 gap-3 text-center">
                    <Stat label="Rows" value={preview.summary.total_rows} />
                    <Stat label="Ready" value={preview.summary.valid} tone="green" />
                    <Stat label="With problems" value={preview.summary.invalid} tone={preview.summary.invalid ? 'red' : undefined} />
                  </div>

                  {preview.summary.would_overwrite > 0 && (
                    <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-50 border border-amber-200">
                      <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
                      <p className="text-sm text-amber-800">
                        {preview.summary.would_overwrite} of these day{preview.summary.would_overwrite === 1 ? ' is' : 's are'} already recorded and will be
                        replaced by the machine’s times — including any correction made by hand.
                      </p>
                    </div>
                  )}

                  {problems.length > 0 ? (
                    <>
                      <div className="flex items-start gap-2 p-3 rounded-lg bg-red-50 border border-red-200">
                        <AlertCircle className="w-4 h-4 text-red-500 mt-0.5 shrink-0" />
                        <p className="text-sm text-red-700">
                          Nothing is imported while any row has a problem. Fix these lines in the file, or leave them out, and choose it again.
                        </p>
                      </div>
                      <div className="border border-gray-200 rounded-xl divide-y divide-gray-100">
                        {problems.map((row) => (
                          <div key={row.line} className="px-4 py-2.5 text-sm">
                            <p className="font-medium text-gray-900">
                              Line {row.line}{row.employee_id ? ` — ${row.employee_id}` : ''}{row.date ? `, ${row.date}` : ''}
                            </p>
                            <ul className="mt-1 space-y-0.5">
                              {row.issues.map((issue, i) => (
                                <li key={i} className="text-xs text-red-600">{issue.field}: {issue.message}</li>
                              ))}
                            </ul>
                          </div>
                        ))}
                      </div>
                    </>
                  ) : (
                    <div className="flex items-start gap-2 p-3 rounded-lg bg-green-50 border border-green-200">
                      <CheckCircle2 className="w-4 h-4 text-green-600 mt-0.5 shrink-0" />
                      <p className="text-sm text-green-800">Every row is ready.</p>
                    </div>
                  )}
                </div>
              )}

              <div className="flex justify-end gap-3">
                <button onClick={onClose} className="px-4 py-2 rounded-lg border border-gray-300 text-sm font-medium text-gray-700 hover:bg-gray-50">
                  Cancel
                </button>
                <button onClick={handleImport}
                  disabled={!preview || problems.length > 0 || preview.summary.valid === 0 || importer.isPending}
                  className="px-5 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 text-white text-sm font-medium flex items-center gap-2">
                  {importer.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
                  Import {preview?.summary.valid ? `${preview.summary.valid} day${preview.summary.valid === 1 ? '' : 's'}` : ''}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function Stat({ label, value, tone }) {
  const color = tone === 'green' ? 'text-green-700' : tone === 'red' ? 'text-red-600' : 'text-slate-900'
  return (
    <div className="bg-slate-50 border border-slate-200 rounded-xl py-2.5">
      <p className="text-[11px] text-slate-500">{label}</p>
      <p className={`text-lg font-bold ${color}`}>{value}</p>
    </div>
  )
}
