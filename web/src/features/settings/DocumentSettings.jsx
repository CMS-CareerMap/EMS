import { btn } from '../../components/ui/styles'
import { useState } from 'react'
import { ArrowUp, ArrowDown, Archive, RotateCcw, Plus, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Section, Toggle, inpSm } from './ui'
import { useAuthStore } from '../../stores/authStore'
import { useDocumentTypes, useSaveDocumentType, useSaveUploadLimit } from '../../hooks/useDocuments'
import DataState from '../../components/DataState'

/**
 * The Documents tab: the largest file anybody may upload (the Super Admin's
 * to set — 2 MB unless changed), and the checklist of documents HR collects
 * from every employee (HR's and Admin's to keep).
 */

const LIMITS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]

export default function DocumentSettings() {
  const can = useAuthStore((s) => s.can)
  const canSetLimit = can('settings:update')
  const canEditTypes = can('document:type:manage')
  const documentTypes = useDocumentTypes({ includeArchived: true })
  const saveType = useSaveDocumentType()
  const saveLimit = useSaveUploadLimit()
  const [label, setLabel] = useState('')
  const [required, setRequired] = useState(false)

  const types = documentTypes.data?.types ?? []
  const active = types.filter((t) => !t.archived)
  const archived = types.filter((t) => t.archived)

  async function change(type, patch, message) {
    const ok = await saveType.mutateAsync({ id: type.id, ...patch }).then(() => true, () => false)
    if (ok && message) toast.success(message)
  }

  async function move(index, by) {
    const a = active[index]
    const b = active[index + by]
    if (!a || !b) return
    // Swap their places — two small saves, each audited.
    await change(a, { displayOrder: b.display_order })
    await change(b, { displayOrder: a.display_order })
  }

  async function add(e) {
    e.preventDefault()
    const ok = await saveType.mutateAsync({ label: label.trim(), required }).then(() => true, () => false)
    if (ok) {
      toast.success(`${label.trim()} added to the checklist`)
      setLabel('')
      setRequired(false)
    }
  }

  async function setLimit(value) {
    const ok = await saveLimit.mutateAsync(Number(value)).then(() => true, () => false)
    if (ok) toast.success(`Uploads are now limited to ${value} MB`)
  }

  return (
    <div className="space-y-6">
      <Section title="Largest upload" desc="Applies to every file: documents, company policies and bank proofs. A photo bigger than this is made smaller in the browser before it is sent; a PDF bigger than this is refused with a message.">
        {/* The stored limit, never an assumed one: the server always sends it. */}
        <DataState query={documentTypes} compact>
          {(data) => (
          <div className="flex items-center gap-3">
            <select className={inpSm} value={data.maxUploadMb} disabled={!canSetLimit || saveLimit.isPending} onChange={(e) => setLimit(e.target.value)} aria-label="Largest upload in MB">
              {LIMITS.map((n) => <option key={n} value={n}>{n} MB</option>)}
            </select>
            {!canSetLimit && <span className="text-xs text-gray-500">Set by the Super Admin.</span>}
          </div>
          )}
        </DataState>
      </Section>

      <Section title="Documents to collect" desc="What every employee is asked for. Required ones decide who is complete on the compliance list. A type no longer needed is archived — files already under it keep their name.">
        <DataState query={documentTypes} compact>
          <div className="space-y-4">
            <div className="divide-y divide-gray-100 border border-gray-200 rounded-lg">
              {active.length === 0 && <p className="px-3 py-2.5 text-sm text-gray-400">No documents on the checklist yet.</p>}
              {active.map((type, i) => (
                <div key={type.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                  <input className={`${inpSm} flex-1 min-w-40`} defaultValue={type.label} disabled={!canEditTypes} maxLength={60} aria-label={`Name of ${type.label}`}
                    onBlur={(e) => {
                      const next = e.target.value.trim()
                      if (next && next !== type.label) change(type, { label: next }, `Renamed to ${next}`)
                      else e.target.value = type.label
                    }} />
                  <label className="flex items-center gap-2 text-xs text-gray-600">
                    <Toggle checked={type.required} disabled={!canEditTypes} onChange={(v) => change(type, { required: v }, `${type.label} is ${v ? 'now required' : 'no longer required'}`)} label={`${type.label} required`} />
                    Required
                  </label>
                  {canEditTypes && (
                    <div className="flex gap-1">
                      <button onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move ${type.label} up`} className="p-1.5 rounded-lg text-gray-400 hover:bg-gray-100 disabled:opacity-30"><ArrowUp className="w-4 h-4" /></button>
                      <button onClick={() => move(i, 1)} disabled={i === active.length - 1} aria-label={`Move ${type.label} down`} className="p-1.5 rounded-lg text-gray-400 hover:bg-gray-100 disabled:opacity-30"><ArrowDown className="w-4 h-4" /></button>
                      <button onClick={() => change(type, { archived: true }, `${type.label} archived`)} aria-label={`Archive ${type.label}`} className="p-1.5 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50"><Archive className="w-4 h-4" /></button>
                    </div>
                  )}
                </div>
              ))}
            </div>

            {canEditTypes && (
              <form onSubmit={add} className="flex flex-wrap items-center gap-3">
                <input className={`${inpSm} flex-1 min-w-48`} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Another document, e.g. Address Proof" minLength={2} maxLength={60} required />
                <label className="flex items-center gap-2 text-xs text-gray-600">
                  <Toggle checked={required} onChange={setRequired} label="New document required" /> Required
                </label>
                <button type="submit" disabled={saveType.isPending} className={btn.primary}>
                  {saveType.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Add
                </button>
              </form>
            )}

            {archived.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-gray-500 mb-1">Archived</p>
                <ul className="space-y-1">
                  {archived.map((type) => (
                    <li key={type.id} className="flex items-center gap-2 text-sm text-gray-500">
                      {type.label}
                      {canEditTypes && (
                        <button onClick={() => change(type, { archived: false }, `${type.label} restored`)} className="flex items-center gap-1 text-xs text-brand-600 hover:underline">
                          <RotateCcw className="w-3 h-3" /> Restore
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </DataState>
      </Section>
    </div>
  )
}
