import { btn, th } from '../../components/ui/styles'
import { useState } from 'react'
import { Plus, Check, X, Edit2, Archive, Loader2, SlidersHorizontal } from 'lucide-react'
import { useMasterData } from '../../hooks/useEmployees'
import {
  useAddNamed, useRenameNamed, useArchiveNamed,
  useAddShift, useEditShift, useArchiveShift,
} from '../../hooks/useMasterDataAdmin'
import DataState from '../../components/DataState'
import ConfirmDialog from '../../components/ConfirmDialog'
import ShiftRulesDialog from './ShiftRulesDialog'
import { rulesSummary } from '../../lib/rules'

/**
 * The company's departments, designations and shifts.
 *
 * Seeded on the first day as a starting point — never meant as a fixed list —
 * and until now changeable only with a database query. Nothing here deletes:
 * "Archive" stops an entry being offered to new hires, and the people already
 * in it keep it. Adding an archived name again brings the old one back.
 *
 * Every change saves as it is made; there is no Save button to forget.
 */

const inp = 'border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent text-gray-900'

export default function OrganisationSettings() {
  const masterData = useMasterData()

  return (
    <DataState query={masterData}>
      {(data) => (
        <div className="space-y-6">
          <NamedList kind="departments" title="Departments" noun="department" rows={data.departments ?? []} />
          <NamedList kind="designations" title="Designations" noun="designation" rows={data.designations ?? []} />
          <Shifts rows={data.shifts ?? []} />
        </div>
      )}
    </DataState>
  )
}

function Card({ title, desc, children }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm">
      <div className="px-6 py-4 border-b border-gray-100">
        <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
        <p className="text-xs text-gray-500 mt-0.5">{desc}</p>
      </div>
      <div className="p-6 space-y-3">{children}</div>
    </div>
  )
}

function NamedList({ kind, title, noun, rows }) {
  const add = useAddNamed(kind)
  const rename = useRenameNamed(kind)
  const archive = useArchiveNamed(kind)

  const [newName, setNewName] = useState('')
  const [editId, setEditId] = useState(null)
  const [editName, setEditName] = useState('')
  const [notice, setNotice] = useState('')
  const [archiving, setArchiving] = useState(null)

  async function handleAdd(e) {
    e.preventDefault()
    if (!newName.trim()) return
    const result = await add.mutateAsync({ name: newName.trim() }).catch(() => null)
    if (!result) return
    setNewName('')
    setNotice(result.restored ? `"${result.row.name}" was archived and has been brought back.` : '')
  }

  async function handleRename(id) {
    const done = await rename.mutateAsync({ id, name: editName.trim() }).then(() => true, () => false)
    if (done) setEditId(null)
  }

  return (
    <Card title={title} desc={`Archiving a ${noun} stops it being offered to new hires. People already in it keep it.`}>
      {notice && <p className="text-xs text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2">{notice}</p>}

      <div className="border border-gray-200 rounded-xl divide-y divide-gray-100">
        {rows.length === 0 && <p className="px-4 py-3 text-sm text-gray-400">None yet.</p>}
        {rows.map((row) => (
          <div key={row.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
            {editId === row.id ? (
              <div className="flex items-center gap-2 flex-1">
                <input value={editName} onChange={(e) => setEditName(e.target.value)} maxLength={60} className={`${inp} flex-1 py-1.5`} autoFocus />
                <button onClick={() => handleRename(row.id)} disabled={rename.isPending || !editName.trim()}
                  className="p-1.5 rounded bg-green-100 text-green-600 hover:bg-green-200" title="Save">
                  <Check className="w-3.5 h-3.5" />
                </button>
                <button onClick={() => setEditId(null)} className="p-1.5 rounded bg-gray-100 text-gray-500 hover:bg-gray-200" title="Cancel">
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            ) : (
              <>
                <span className="text-sm text-gray-800">{row.name}</span>
                <div className="flex items-center gap-1">
                  <button onClick={() => { setEditId(row.id); setEditName(row.name) }}
                    className="p-1.5 rounded-lg hover:bg-brand-50 text-gray-400 hover:text-brand-600" title="Rename">
                    <Edit2 className="w-3.5 h-3.5" />
                  </button>
                  <button onClick={() => setArchiving(row)} disabled={archive.isPending}
                    className="p-1.5 rounded-lg hover:bg-amber-50 text-gray-400 hover:text-amber-600" title="Archive">
                    <Archive className="w-3.5 h-3.5" />
                  </button>
                </div>
              </>
            )}
          </div>
        ))}
      </div>

      <form onSubmit={handleAdd} className="flex items-center gap-2">
        <input value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={60}
          placeholder={`New ${noun}`} className={`${inp} flex-1`} />
        <button type="submit" disabled={add.isPending || !newName.trim()}
          className={btn.primary}>
          {add.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Add
        </button>
      </form>

      {/* Last in the card, so the card's spacing adds no margin to the overlay. */}
      {archiving && (
        <ConfirmDialog title={`Archive the ${noun} "${archiving.name}"?`} confirmLabel="Archive" danger
          onConfirm={() => archive.mutateAsync({ id: archiving.id })}
          onClose={() => setArchiving(null)}>
          <p><strong>{archiving.name}</strong> will no longer be offered to new hires.</p>
          <p>Nobody already in it is moved.</p>
        </ConfirmDialog>
      )}
    </Card>
  )
}

const EMPTY_SHIFT = { name: '', startTime: '09:30', endTime: '18:30', breakMinutes: '60', expectedHours: '9' }

function toBody(form) {
  return {
    name: form.name.trim(),
    startTime: form.startTime,
    endTime: form.endTime,
    breakMinutes: Number(form.breakMinutes),
    expectedHours: Number(form.expectedHours),
  }
}

function Shifts({ rows }) {
  const add = useAddShift()
  const edit = useEditShift()
  const archive = useArchiveShift()

  const [form, setForm] = useState(EMPTY_SHIFT)
  const [editId, setEditId] = useState(null)
  const [editForm, setEditForm] = useState(EMPTY_SHIFT)
  const [archiving, setArchiving] = useState(null)
  const [ruling, setRuling] = useState(null)

  async function handleAdd(e) {
    e.preventDefault()
    const done = await add.mutateAsync(toBody(form)).then(() => true, () => false)
    if (done) setForm(EMPTY_SHIFT)
  }

  async function handleSave(id) {
    const done = await edit.mutateAsync({ id, ...toBody(editForm) }).then(() => true, () => false)
    if (done) setEditId(null)
  }

  function startEdit(row) {
    setEditId(row.id)
    setEditForm({
      name: row.name,
      startTime: row.start_time,
      endTime: row.end_time,
      breakMinutes: String(row.break_minutes),
      expectedHours: String(row.expected_hours),
    })
  }

  const cells = (f, set) => (
    <>
      <td className="px-3 py-2"><input value={f.name} onChange={(e) => set({ ...f, name: e.target.value })} maxLength={40} placeholder="Name" className={`${inp} w-full py-1.5`} /></td>
      <td className="px-3 py-2"><input type="time" value={f.startTime} onChange={(e) => set({ ...f, startTime: e.target.value })} className={`${inp} py-1.5`} /></td>
      <td className="px-3 py-2"><input type="time" value={f.endTime} onChange={(e) => set({ ...f, endTime: e.target.value })} className={`${inp} py-1.5`} /></td>
      <td className="px-3 py-2"><input type="number" min="0" max="600" value={f.breakMinutes} onChange={(e) => set({ ...f, breakMinutes: e.target.value })} className={`${inp} w-20 py-1.5`} /></td>
      <td className="px-3 py-2"><input type="number" min="0.5" max="24" step="0.25" value={f.expectedHours} onChange={(e) => set({ ...f, expectedHours: e.target.value })} className={`${inp} w-20 py-1.5`} /></td>
    </>
  )

  return (
    <Card title="Shifts" desc="Daily hours are read against a shift's expected hours, and its rules (the sliders button) mark lateness, leaving early and overtime. Changing a shift affects days recorded from now on — past days keep what they were measured against.">
      <div className="border border-gray-200 rounded-xl overflow-x-auto">
        <table className="w-full min-w-160">
          <thead>
            <tr>
              {['Name', 'Start', 'End', 'Break (min)', 'Full day (h)', ''].map((h) => (
                <th key={h} className={th}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-b border-gray-100">
                {editId === row.id ? (
                  <>
                    {cells(editForm, setEditForm)}
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      <button onClick={() => handleSave(row.id)} disabled={edit.isPending} className="p-1.5 rounded bg-green-100 text-green-600 hover:bg-green-200 mr-1" title="Save"><Check className="w-3.5 h-3.5" /></button>
                      <button onClick={() => setEditId(null)} className="p-1.5 rounded bg-gray-100 text-gray-500 hover:bg-gray-200" title="Cancel"><X className="w-3.5 h-3.5" /></button>
                    </td>
                  </>
                ) : (
                  <>
                    <td className="px-3 py-2.5">
                      <p className="text-sm font-medium text-gray-900">{row.name}</p>
                      <p className="text-xs text-gray-400">{rulesSummary(row)}</p>
                    </td>
                    <td className="px-3 py-2.5 text-sm text-gray-700">{row.start_time}</td>
                    <td className="px-3 py-2.5 text-sm text-gray-700">{row.end_time}</td>
                    <td className="px-3 py-2.5 text-sm text-gray-700">{row.break_minutes}</td>
                    <td className="px-3 py-2.5 text-sm text-gray-700">{row.expected_hours}</td>
                    <td className="px-3 py-2.5 text-right whitespace-nowrap">
                      <button onClick={() => setRuling(row)} className="p-1.5 rounded-lg hover:bg-brand-50 text-gray-400 hover:text-brand-600" title="Rules: grace, late, overtime" aria-label={`Rules of ${row.name}`}><SlidersHorizontal className="w-3.5 h-3.5" /></button>
                      <button onClick={() => startEdit(row)} className="p-1.5 rounded-lg hover:bg-brand-50 text-gray-400 hover:text-brand-600" title="Edit"><Edit2 className="w-3.5 h-3.5" /></button>
                      <button onClick={() => setArchiving(row)} disabled={archive.isPending} className="p-1.5 rounded-lg hover:bg-amber-50 text-gray-400 hover:text-amber-600" title="Archive"><Archive className="w-3.5 h-3.5" /></button>
                    </td>
                  </>
                )}
              </tr>
            ))}
            {/* The add row, always at the bottom */}
            <tr className="bg-gray-50/60">
              {cells(form, setForm)}
              <td className="px-3 py-2 text-right">
                <button onClick={handleAdd} disabled={add.isPending || !form.name.trim()}
                  className={`${btn.primarySm} ml-auto`}>
                  <Plus className="w-3.5 h-3.5" /> Add
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {ruling && <ShiftRulesDialog shift={ruling} onClose={() => setRuling(null)} />}

      {archiving && (
        <ConfirmDialog title={`Archive the "${archiving.name}" shift?`} confirmLabel="Archive" danger
          onConfirm={() => archive.mutateAsync({ id: archiving.id })}
          onClose={() => setArchiving(null)}>
          <p>People already on <strong>{archiving.name}</strong> stay on it.</p>
        </ConfirmDialog>
      )}
    </Card>
  )
}
