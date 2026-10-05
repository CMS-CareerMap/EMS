import { useState } from 'react'
import { Plus, Edit2, Archive } from 'lucide-react'
import { toast } from 'sonner'
import Dialog, { inputCls } from '../../components/Dialog'
import ConfirmDialog from '../../components/ConfirmDialog'
import DataState from '../../components/DataState'
import { useAuthStore } from '../../stores/authStore'
import { useAllComponents, useAddComponent, useChangeComponent, useArchiveComponent } from '../../hooks/usePayrollExtras'
import { btn, th } from '../../components/ui/styles'

/**
 * The company's salary components (client §40): Basic, HRA and the rest, and
 * any it adds — a Site Allowance, a Bonus, a Canteen deduction. Which ones
 * count for PF, for ESI and for professional tax is the accountant's to say.
 */
export default function ComponentsTab() {
  const can = useAuthStore((s) => s.can)
  const canManage = can('payroll:structure:manage')
  const query = useAllComponents()
  const archive = useArchiveComponent()
  const [editing, setEditing] = useState(null)
  const [archiving, setArchiving] = useState(null)

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-gray-600 max-w-3xl">
          Earnings and deductions on a salary record, or entered each month (an incentive, a bonus). Payroll writes PF, ESI, professional tax, TDS, overtime, leave encashment and loan recovery itself.
        </p>
        {canManage && (
          <button onClick={() => setEditing({})} className={btn.primary}>
            <Plus className="w-4 h-4" /> Add a component
          </button>
        )}
      </div>

      <DataState query={query} empty="No salary components yet.">
        {(rows) => (
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-x-auto">
            <table className="w-full min-w-180">
              <thead>
                <tr>
                  {['Component', 'Kind', 'Entered', 'PF', 'ESI', 'PT', 'Taxable', ''].map((h) => (
                    <th key={h} className={th}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id} className={`border-b border-gray-100 last:border-0 ${c.archived ? 'opacity-50' : ''}`}>
                    <td className="px-4 py-3">
                      <p className="text-sm font-medium text-gray-900">{c.label}{c.archived ? ' (archived)' : ''}</p>
                      <p className="font-mono text-xs text-gray-500">{c.code}</p>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-700">{c.type === 'earning' ? 'Earning' : 'Deduction'}</td>
                    <td className="px-4 py-3 text-sm text-gray-700">{c.entry === 'fixed' ? 'On the salary' : 'Each month'}</td>
                    {['counts_for_pf', 'counts_for_esi', 'counts_for_pt', 'taxable'].map((k) => (
                      <td key={k} className="px-4 py-3 text-sm">{c.type === 'deduction' && k !== 'taxable' ? '—' : c[k] ? <span className="text-green-700">Yes</span> : <span className="text-gray-400">No</span>}</td>
                    ))}
                    <td className="px-4 py-3">
                      {canManage && !c.archived && (
                        <div className="flex justify-end gap-1">
                          <button onClick={() => setEditing(c)} aria-label={`Change ${c.label}`} className="p-1.5 rounded-lg hover:bg-brand-50 text-gray-400 hover:text-brand-600"><Edit2 className="w-3.5 h-3.5" /></button>
                          <button onClick={() => setArchiving(c)} aria-label={`Archive ${c.label}`} className="p-1.5 rounded-lg hover:bg-amber-50 text-gray-400 hover:text-amber-600"><Archive className="w-3.5 h-3.5" /></button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </DataState>

      {editing && <ComponentDialog component={editing.id ? editing : null} onClose={() => setEditing(null)} />}
      {archiving && (
        <ConfirmDialog title={`Archive ${archiving.label}?`} confirmLabel="Archive" danger
          onConfirm={() => archive.mutateAsync({ id: archiving.id }).then(() => toast.success(`${archiving.label} archived`))}
          onClose={() => setArchiving(null)}>
          <p>It will no longer be offered for a salary or a month. Payslips that paid it keep it. Adding {archiving.code} again brings it back.</p>
        </ConfirmDialog>
      )}
    </div>
  )
}

function ComponentDialog({ component, onClose }) {
  const add = useAddComponent()
  const change = useChangeComponent()
  const busy = add.isPending || change.isPending
  const [f, setF] = useState(() => ({
    code: component?.code ?? '',
    label: component?.label ?? '',
    type: component?.type ?? 'earning',
    entry: component?.entry ?? 'monthly',
    countsForPf: component?.counts_for_pf ?? false,
    countsForEsi: component?.counts_for_esi ?? true,
    countsForPt: component?.counts_for_pt ?? true,
    taxable: component?.taxable ?? true,
  }))
  const set = (key, value) => setF({ ...f, [key]: value })
  const earning = f.type === 'earning'

  async function submit(e) {
    e.preventDefault()
    const body = { label: f.label.trim(), type: f.type, entry: f.entry, countsForPf: earning && f.countsForPf, countsForEsi: f.countsForEsi, countsForPt: f.countsForPt, taxable: f.taxable }
    const done = component
      ? await change.mutateAsync({ id: component.id, ...body }).then(() => true, () => false)
      : await add.mutateAsync({ code: f.code.trim().toUpperCase(), ...body }).then((r) => {
        toast.success(r.meta?.restored ? `${r.data.label} was archived — it is back` : `${r.data.label} added`)
        return true
      }, () => false)
    if (done) {
      if (component) toast.success(`${body.label} saved`)
      onClose()
    }
  }

  return (
    <Dialog title={component ? `Change ${component.label}` : 'Add a salary component'} onClose={busy ? () => {} : onClose}>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-gray-700">Code</span>
            <input className={`${inputCls} font-mono uppercase`} value={f.code} onChange={(e) => set('code', e.target.value)} required minLength={2} maxLength={16} pattern="[A-Za-z][A-Za-z0-9_]{1,15}" disabled={Boolean(component)} placeholder="SITE_ALLOW" />
            <span className="block text-xs text-gray-500">{component ? 'Payslips carry it, so it does not change.' : 'Letters, digits or _ — on payslips and exports.'}</span>
          </label>
          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-gray-700">Name</span>
            <input className={inputCls} value={f.label} onChange={(e) => set('label', e.target.value)} required maxLength={60} placeholder="Site Allowance" />
          </label>
          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-gray-700">Kind</span>
            <select className={inputCls} value={f.type} onChange={(e) => set('type', e.target.value)}>
              <option value="earning">Earning</option>
              <option value="deduction">Deduction</option>
            </select>
          </label>
          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-gray-700">Entered</span>
            <select className={inputCls} value={f.entry} onChange={(e) => set('entry', e.target.value)}>
              <option value="fixed">On the salary record, every month (prorated)</option>
              <option value="monthly">Each month, as an amount (never prorated)</option>
            </select>
          </label>
        </div>
        {component && <p className="text-xs text-gray-500">Once anybody is paid it, its kind and how it is entered stay as they are.</p>}
        <div className="space-y-2">
          {earning && <Check label="Counts for PF" hint="Basic and DA do; an allowance paid to everybody may too — the accountant’s call." checked={f.countsForPf} onChange={(v) => set('countsForPf', v)} />}
          {earning && <Check label="Counts for ESI" hint="An annual bonus is usually outside ESI wages." checked={f.countsForEsi} onChange={(v) => set('countsForEsi', v)} />}
          {earning && <Check label="Counts for professional tax" hint="Part of the gross the PT slab is chosen by." checked={f.countsForPt} onChange={(v) => set('countsForPt', v)} />}
          <Check label="Taxable" hint="For income tax." checked={f.taxable} onChange={(v) => set('taxable', v)} />
        </div>
        <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} disabled={busy} className={btn.secondary}>Cancel</button>
          <button type="submit" disabled={busy} className={btn.primary}>{busy ? 'Saving…' : component ? 'Save' : 'Add'}</button>
        </div>
      </form>
    </Dialog>
  )
}

function Check({ label, hint, checked, onChange }) {
  return (
    <label className="flex items-start gap-3">
      <input type="checkbox" className="mt-1 h-4 w-4" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <span className="block text-sm font-medium text-gray-700">{label}</span>
        <span className="block text-xs text-gray-500">{hint}</span>
      </span>
    </label>
  )
}
