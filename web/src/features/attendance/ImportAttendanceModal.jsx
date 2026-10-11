import { btn } from '../../components/ui/styles'
import { useRef, useState } from 'react'
import { X, Upload, Loader2, CheckCircle2, AlertCircle, AlertTriangle } from 'lucide-react'
import { useImportAttendance } from '../../hooks/useAttendance'
import { useEscape } from '../../hooks/useEscape'
import { formatDay } from '../../lib/dates'

/**
 * What the machine's file said of the app's days (client, 11 Oct 2026), when
 * the company confirms app check-ins by the fingerprint machine: the app's
 * days stand; the machine's scans confirm them, differ from them, or are not
 * there. `done`: said of an import made, not one to be made.
 */
function MachinePanel({ machine, done = false }) {
  const count = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
  const facts = [
    ['Confirmed', machine.confirmed, 'text-emerald-700'],
    ['Times differ', machine.time_differs, machine.time_differs ? 'text-amber-700' : 'text-gray-900'],
    ['Not on the machine', machine.not_on_machine, machine.not_on_machine ? 'text-red-700' : 'text-gray-900'],
    ['Filled from the machine', machine.from_machine, 'text-gray-900'],
  ]
  return (
    <section aria-label="The fingerprint machine and the app" className="space-y-2 p-3 rounded-lg bg-slate-50 border border-slate-200">
      <p className="text-sm font-semibold text-gray-900">
        The machine and the app, {formatDay(machine.from, { year: machine.from.slice(0, 4) !== machine.to.slice(0, 4) })} – {formatDay(machine.to)}
      </p>
      <dl className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {facts.map(([label, value, tone]) => (
          <div key={label} className="bg-white rounded-lg border border-slate-200 px-2.5 py-1.5">
            <dt className="text-[11px] text-gray-500">{label}</dt>
            <dd className={`text-base font-bold tabular-nums ${tone}`}>{value}</dd>
          </div>
        ))}
      </dl>
      {machine.not_filled > 0 && (
        <p className="text-xs text-gray-600">{count(machine.not_filled, 'day')} with scans and no app punch {done ? 'were' : 'will be'} left alone — the company does not fill days from the machine.</p>
      )}
      {machine.not_on_machine > 0 && (
        <div className="text-xs text-gray-700 space-y-1">
          <p>
            Checked in on the app, with no scan that day:{' '}
            {machine.missing.map((m) => `${m.full_name} (${formatDay(m.date, { year: false })})`).join(', ')}
            {machine.not_on_machine > machine.missing.length ? ` and ${machine.not_on_machine - machine.missing.length} more` : ''}.
          </p>
          <p className={machine.made_absent > 0 ? 'font-semibold text-red-700' : ''}>
            {machine.made_absent > 0
              ? `${count(machine.made_absent, 'day')} ${done ? 'were' : 'will be'} made absent — cut from pay, and the person told.`
              : 'Flagged for HR; the days stand as the app recorded them.'}
          </p>
        </div>
      )}
      {machine.not_in_file.length > 0 && (
        <p className="flex items-start gap-1.5 text-xs text-amber-800">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" aria-hidden="true" />
          <span>
            Not in this file at all: {machine.not_in_file.map((p) => `${p.full_name} (${count(p.days, 'app day')})`).join(', ')}. If the machine’s export left them out, their days read as not on the machine.
          </span>
        </p>
      )}
    </section>
  )
}

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
              {result.summary.machine && <MachinePanel machine={result.summary.machine} done />}
              <div className="flex justify-end">
                <button onClick={onClose} className={btn.primary}>Done</button>
              </div>
            </div>
          ) : (
            <>
              <div className="text-sm text-gray-600 space-y-2">
                <p>
                  One row per person per day, with the columns <span className="font-medium">employee_code</span>, <span className="font-medium">date</span>,{' '}
                  <span className="font-medium">check_in</span> and <span className="font-medium">check_out</span> — or one row per finger scan, with the code and the
                  time (the date in its own column or with the time). A person’s day is their scans: the first is the check-in, the last the check-out. Most
                  machines’ own names for the columns are read too (AC-No., Enroll No, in_time, Time…), and a person’s Machine ID before their code.
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
                className="w-full border-2 border-dashed border-gray-300 hover:border-brand-400 rounded-xl py-8 flex flex-col items-center gap-2 text-gray-500 hover:text-brand-600 transition-colors">
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

                  {preview.summary.machine && <MachinePanel machine={preview.summary.machine} />}

                  {preview.summary.on_leave > 0 && (
                    <p className="text-sm text-gray-600">
                      {preview.summary.on_leave} line{preview.summary.on_leave === 1 ? ' has' : 's have'} no times on a day of approved leave — left as the
                      leave, not imported.
                    </p>
                  )}

                  {preview.summary.edge_nights_left_out > 0 && (
                    <p className="text-sm text-gray-600">
                      {preview.summary.edge_nights_left_out} night shift
                      {preview.summary.edge_nights_left_out === 1 ? '’s morning scan belongs' : 's’ morning scans belong'} to the night before the
                      file’s first day, which has nothing recorded yet — left out. Include that day in the file to bring{' '}
                      {preview.summary.edge_nights_left_out === 1 ? 'it' : 'them'} in.
                    </p>
                  )}

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

              <div className="flex flex-wrap justify-end gap-3">
                <button onClick={onClose} className={btn.secondary}>
                  Cancel
                </button>
                <button onClick={handleImport}
                  disabled={!preview || problems.length > 0 || (preview.summary.valid === 0 && !preview.summary.machine?.not_on_machine) || importer.isPending}
                  className={btn.primary}>
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
