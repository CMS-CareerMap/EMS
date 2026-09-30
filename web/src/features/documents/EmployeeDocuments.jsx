import { useEffect, useRef, useState } from 'react'
import { Search, CheckCircle2, Clock, FolderOpen } from 'lucide-react'
import { useCompliance, useChecklist } from '../../hooks/useDocuments'
import Checklist from './Checklist'
import DataState from '../../components/DataState'
import { when } from './meta'

/**
 * HR's view: where everybody stands against the required documents, what is
 * waiting to be checked, and any one person's documents to act on.
 */

const FILTERS = [
  { id: 'all', label: 'Everybody' },
  { id: 'waiting', label: 'Waiting for a check' },
  { id: 'incomplete', label: 'Something missing' },
  { id: 'complete', label: 'Complete' },
]

function matches(filter, e) {
  // Everything waiting for a check — optional documents too, as the list above shows them.
  if (filter === 'waiting') return e.waiting_count > 0
  if (filter === 'incomplete') return e.missing > 0 || e.rejected > 0
  if (filter === 'complete') return e.verified === e.required
  return true
}

export default function EmployeeDocuments({ types, limits, selected, onSelect }) {
  const compliance = useCompliance()
  // Nothing from an answer that has since failed: the list below shows the error instead.
  const data = compliance.isError ? undefined : compliance.data
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('all')
  const checklist = useChecklist(selected, { enabled: Boolean(selected) })
  const detail = useRef(null)

  // On a phone the checklist sits below the whole list: bring it into view —
  // once it has loaded, so the page does not grow under the scroll — or
  // tapping a person seems to do nothing. Once per person chosen.
  const scrolledFor = useRef(null)
  const loaded = Boolean(checklist.data)
  useEffect(() => {
    if (!selected || !loaded || !detail.current || scrolledFor.current === selected) return
    scrolledFor.current = selected
    if (window.matchMedia?.('(max-width: 1023px)').matches) detail.current.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [selected, loaded])

  const employees = (data?.employees ?? []).filter((e) => {
    if (!matches(filter, e)) return false
    const q = search.trim().toLowerCase()
    return !q || e.full_name.toLowerCase().includes(q) || e.employee_code.toLowerCase().includes(q)
  })

  return (
    <div className="space-y-4">
      {data?.waiting?.length > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
          <p className="flex items-center gap-2 text-sm font-semibold text-amber-900">
            <Clock className="w-4 h-4" /> {data.waiting.length === 1 ? 'One document is' : `${data.waiting.length} documents are`} waiting for a check
          </p>
          <ul className="mt-2 flex flex-wrap gap-2">
            {data.waiting.slice(0, 12).map((d) => (
              <li key={d.id}>
                <button onClick={() => onSelect(d.employee_id)} className="px-2.5 py-1 rounded-full bg-white border border-amber-200 text-xs text-amber-900 hover:bg-amber-100">
                  {d.full_name} · {d.type.label} · {when(d.uploaded_at)}
                </button>
              </li>
            ))}
            {data.waiting.length > 12 && (
              <li className="self-center text-xs text-amber-800">
                and {data.waiting.length - 12} more — choose “Waiting for a check” below to see everybody
              </li>
            )}
          </ul>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <div className="space-y-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name or code"
              className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg text-sm bg-white" />
          </div>
          <div className="flex flex-wrap gap-1.5">
            {FILTERS.map((f) => (
              <button key={f.id} onClick={() => setFilter(f.id)}
                className={`px-2.5 py-1 rounded-full text-xs font-medium border ${filter === f.id ? 'bg-blue-600 border-blue-600 text-white' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}>
                {f.label}
              </button>
            ))}
          </div>
          <div className="space-y-2 max-h-140 overflow-y-auto pr-1">
            <DataState query={compliance} compact empty="Nobody here." isEmpty={() => employees.length === 0}>
              {() => employees.map((e) => {
                const active = selected === e.employee_id
                const complete = e.verified === e.required
                return (
                  <button key={e.employee_id} onClick={() => onSelect(e.employee_id)}
                    className={`w-full text-left p-3 rounded-xl border transition-colors ${active ? 'border-blue-500 bg-blue-50/60 ring-1 ring-blue-500' : 'border-gray-200 bg-white hover:bg-gray-50'}`}>
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-gray-900 truncate">{e.full_name}</p>
                        <p className="text-[11px] text-gray-500 truncate"><span className="font-mono">{e.employee_code}</span>{e.department ? ` · ${e.department}` : ''}</p>
                      </div>
                      {complete ? (
                        <CheckCircle2 className="w-4 h-4 text-green-500 shrink-0" aria-label="All required documents verified" />
                      ) : (
                        <span className="text-xs font-bold text-amber-700 bg-amber-50 border border-amber-100 px-1.5 py-0.5 rounded shrink-0">{e.verified}/{e.required}</span>
                      )}
                    </div>
                    {(e.waiting_count > 0 || e.rejected > 0) && (
                      <p className="mt-1 text-[11px] text-gray-500">
                        {e.waiting_count > 0 ? `${e.waiting_count} waiting` : ''}{e.waiting_count > 0 && e.rejected > 0 ? ' · ' : ''}{e.rejected > 0 ? `${e.rejected} rejected` : ''}
                      </p>
                    )}
                  </button>
                )
              })}
            </DataState>
          </div>
        </div>

        <div className="lg:col-span-2 scroll-mt-4" ref={detail}>
          {!selected ? (
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm py-20 text-center">
              <FolderOpen className="w-10 h-10 mx-auto text-gray-300" />
              <p className="mt-2 text-sm font-medium text-gray-600">Choose somebody from the list</p>
              <p className="text-xs text-gray-400">Their documents open here, to check, upload or remove.</p>
            </div>
          ) : (
            <DataState query={checklist}>
              {(data) => <Checklist data={data} types={types} limits={limits} reviewer canUpload />}
            </DataState>
          )}
        </div>
      </div>
    </div>
  )
}
