import { useRef, useState } from 'react'
import { X, Upload, Download, Loader2, CheckCircle2, AlertCircle, Copy, Check } from 'lucide-react'
import { useImportEmployees, useMasterData } from '../../hooks/useEmployees'
import { saveFromApi } from '../../api/http'
import DataState from '../../components/DataState'

/**
 * Importing a roster from a spreadsheet.
 *
 * The server side has existed since Day 10 — a dry run that saves nothing and
 * names every problem by line, then an all-or-nothing import — but nothing on
 * the page called it, so the only way to add people in bulk was one form at a
 * time.
 *
 * Nobody gets a password from a file. Rows with an email get an invitation
 * link, shown once at the end; rows without one become employee records with
 * no login, which is right for somebody HR marks attendance for.
 */

const MAX_BYTES = 1_000_000

/** The template comes from the server — the columns the importer itself reads. */
function downloadTemplate() {
  saveFromApi('/employees/import/template').catch(() => undefined)
}

function linkFor(token) {
  return `${window.location.origin}/set-password#token=${encodeURIComponent(token)}`
}

export default function ImportEmployeesModal({ onClose }) {
  const importer = useImportEmployees()
  const masterData = useMasterData()
  const fileInput = useRef(null)

  const [fileName, setFileName] = useState('')
  const [csv, setCsv] = useState('')
  const [preview, setPreview] = useState(null)
  const [result, setResult] = useState(null)
  const [fileError, setFileError] = useState('')
  const [copied, setCopied] = useState('')

  async function handleFile(event) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return

    setPreview(null)
    setFileError('')
    if (file.size > MAX_BYTES) {
      setFileError('That file is larger than 1 MB. A roster is at most 500 rows — split it and import in parts.')
      return
    }

    const text = await file.text()
    setFileName(file.name)
    setCsv(text)

    // The dry run straight away: nothing is saved, and every problem comes back
    // with the line number the spreadsheet shows.
    const checked = await importer.mutateAsync({ csv: text, dryRun: true }).catch(() => null)
    if (checked) setPreview(checked)
  }

  async function handleImport() {
    const done = await importer.mutateAsync({ csv, dryRun: false }).catch(() => null)
    if (done) setResult(done)
  }

  async function copy(text, key) {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(key)
    } catch {
      setCopied('')
    }
  }

  const problems = preview?.rows.filter((row) => row.issues.length > 0) ?? []

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 overflow-y-auto">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-3xl my-8 overflow-hidden">
        <div className="flex items-center justify-between px-6 py-5 border-b border-gray-100">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">Import Employees</h2>
            <p className="text-sm text-gray-400 mt-0.5">From a CSV file — checked before anything is saved</p>
          </div>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-5 max-h-[78vh] overflow-y-auto">
          {result ? (
            <ImportDone result={result} copied={copied} onCopy={copy} onClose={onClose} />
          ) : (
            <>
              <div className="text-sm text-gray-600 space-y-2">
                <p>
                  One row per person. <span className="font-medium">employee_code</span> and <span className="font-medium">full_name</span> are
                  required; the rest is optional. Dates as DD/MM/YYYY or YYYY-MM-DD.
                </p>
                <p>
                  For somebody already working here and past probation, fill <span className="font-medium">confirmed_on</span>.
                  Left empty, the person starts as a new joiner: onboarding, then probation.
                </p>
                {/* Which departments a file may name. Failed, it says so — silence
                    would read as "any department is fine". */}
                <DataState query={masterData} compact isEmpty={(lists) => !lists.departments?.length} empty={
                  <p className="text-xs text-gray-500">
                    No departments are set up yet, so leave the department column blank — anything in it is flagged,
                    not created. Add departments in Settings first to use it.
                  </p>
                }>
                  {(lists) => (
                    <p className="text-xs text-gray-500">
                      Departments must be one of: {lists.departments.map((d) => d.name).join(', ')}.
                      Anything else is flagged, not created — so a typo cannot become a new department.
                    </p>
                  )}
                </DataState>
                <button onClick={downloadTemplate} className="inline-flex items-center gap-1.5 text-sm font-medium text-blue-600 hover:text-blue-800">
                  <Download className="w-4 h-4" /> Download a template
                </button>
              </div>

              <input ref={fileInput} type="file" accept=".csv,text/csv" onChange={handleFile} className="hidden" />
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

                  {problems.length > 0 ? (
                    <>
                      <div className="flex items-start gap-2 p-3 rounded-lg bg-red-50 border border-red-200">
                        <AlertCircle className="w-4 h-4 text-red-500 mt-0.5 shrink-0" />
                        <p className="text-sm text-red-700">
                          Nothing is imported while any row has a problem — a half-imported roster leaves somebody working out which rows made it.
                          Fix these lines in the file and choose it again.
                        </p>
                      </div>
                      <div className="border border-gray-200 rounded-xl divide-y divide-gray-100">
                        {problems.map((row) => (
                          <div key={row.line} className="px-4 py-2.5 text-sm">
                            <p className="font-medium text-gray-900">
                              Line {row.line}{row.full_name ? ` — ${row.full_name}` : ''}{row.employee_code ? ` (${row.employee_code})` : ''}
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
                      <p className="text-sm text-green-800">
                        Every row is ready. {preview.summary.with_login > 0
                          ? `${preview.summary.with_login} of them have an email and will get an invitation link.`
                          : 'None has an email, so none will get a login.'}
                      </p>
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
                  Import {preview?.summary.valid ? `${preview.summary.valid} employees` : ''}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function ImportDone({ result, copied, onCopy, onClose }) {
  const invites = result.invites
  const everything = invites.map((i) => `${i.email}\t${linkFor(i.token)}`).join('\n')

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2 p-3 rounded-lg bg-green-50 border border-green-200">
        <CheckCircle2 className="w-4 h-4 text-green-600 mt-0.5 shrink-0" />
        <p className="text-sm text-green-800">{result.summary.imported} employees imported.</p>
      </div>

      {invites.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-gray-900">Invitation links</p>
            <button onClick={() => onCopy(everything, 'all')} className="inline-flex items-center gap-1.5 text-xs font-semibold text-blue-600 hover:text-blue-800">
              {copied === 'all' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />} Copy all
            </button>
          </div>
          <p className="text-xs text-gray-500">
            No email is sent. Send each person their own link — each works once and expires in 72 hours. They are not shown again;
            a lost one can be replaced from Settings → Users.
          </p>
          <div className="border border-gray-200 rounded-xl divide-y divide-gray-100">
            {invites.map((invite) => (
              <div key={invite.email} className="px-4 py-2.5 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-900">{invite.email}</p>
                  <p className="text-xs text-gray-400 font-mono truncate">{linkFor(invite.token)}</p>
                </div>
                <button onClick={() => onCopy(linkFor(invite.token), invite.email)}
                  className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-blue-50 text-blue-700 hover:bg-blue-100 text-xs font-semibold">
                  {copied === invite.email ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />} Copy
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex justify-end">
        <button onClick={onClose} className="px-5 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium">Done</button>
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
