import { createElement, useState } from 'react'
import { ArrowUp, ArrowDown, Trash2, Plus, Loader2, Info } from 'lucide-react'
import { toast } from 'sonner'
import { useBankFileTemplate, useSaveBankFileTemplate } from '../../hooks/usePayroll'
import { useAuthStore } from '../../stores/authStore'
import { inputCls, fieldCls } from '../../components/Dialog'

/**
 * The bank file's layout: which columns, in what order, with what headings.
 *
 * Every bank's bulk-payment portal wants its own columns, so the company sets
 * them once here from the bank's sample file. The server checks the layout —
 * it must have an account number and an amount — and fills it in per run.
 */

// A made-up person, only to show what one line of the file will look like.
const EXAMPLE = {
  beneficiary_name: 'Asha Verma',
  employee_name: 'Asha Verma',
  employee_code: 'EMP001',
  account_number: '001234567890',
  ifsc: 'HDFC0001234',
  bank_name: 'HDFC Bank',
  amount: '45000.00',
}

function exampleDate(format) {
  const [y, m, d] = ['2026', '09', '30']
  return { 'YYYY-MM-DD': `${y}-${m}-${d}`, 'DD-MM-YYYY': `${d}-${m}-${y}`, 'MM/DD/YYYY': `${m}/${d}/${y}` }[format] ?? `${d}/${m}/${y}`
}

function exampleCell(column, form) {
  if (column.field === 'fixed') return column.text ?? ''
  if (column.field === 'pay_date') return exampleDate(form.date_format)
  if (column.field === 'narration') {
    return form.narration.replace(/\{month\}/g, 'September').replace(/\{year\}/g, '2026').replace(/\{code\}/g, EXAMPLE.employee_code)
  }
  return EXAMPLE[column.field] ?? ''
}

export default function BankFileFormat() {
  const { data, isLoading } = useBankFileTemplate()
  if (isLoading || !data) return <p className="text-sm text-gray-400 py-10 text-center">Loading…</p>
  // Keyed on the saved layout so a save, or another person's, starts the form afresh.
  return <Editor key={JSON.stringify([data.columns, data.include_header, data.date_format, data.narration, data.only_verified])} template={data} />
}

function Editor({ template }) {
  const can = useAuthStore((s) => s.can)
  const canEdit = can('payroll:structure:manage')
  const save = useSaveBankFileTemplate()
  const initial = {
    columns: template.columns.map((c) => ({ header: c.header, field: c.field, text: c.text ?? '' })),
    include_header: template.include_header,
    date_format: template.date_format,
    narration: template.narration,
    only_verified: template.only_verified,
  }
  const [form, setForm] = useState(initial)
  const labels = Object.fromEntries(template.fields.map((f) => [f.field, f.label]))

  const setColumn = (i, patch) => setForm((f) => ({ ...f, columns: f.columns.map((c, j) => (j === i ? { ...c, ...patch } : c)) }))
  const move = (i, by) => setForm((f) => {
    const columns = [...f.columns]
    const [col] = columns.splice(i, 1)
    columns.splice(i + by, 0, col)
    return { ...f, columns }
  })
  const remove = (i) => setForm((f) => ({ ...f, columns: f.columns.filter((_, j) => j !== i) }))
  const add = () => setForm((f) => ({ ...f, columns: [...f.columns, { header: '', field: 'employee_name', text: '' }] }))

  const missing = ['account_number', 'amount'].filter((field) => !form.columns.some((c) => c.field === field))
  const dirty = JSON.stringify(form) !== JSON.stringify(initial)

  async function handleSave() {
    const ok = await save.mutateAsync({
      columns: form.columns.map((c) => ({ header: c.header, field: c.field, ...(c.field === 'fixed' ? { text: c.text } : {}) })),
      includeHeader: form.include_header,
      dateFormat: form.date_format,
      narration: form.narration,
      onlyVerified: form.only_verified,
    }).then(() => true, () => false)
    if (ok) toast.success('Bank file format saved')
  }

  return (
    <div className="space-y-4">
      {!template.saved && (
        <p className="flex gap-2 text-sm text-gray-600 bg-gray-50 border border-gray-200 rounded-lg p-3">
          <Info className="w-4 h-4 shrink-0 mt-0.5 text-gray-400" />
          This is the standard layout. Ask the bank for its bulk-payment sample file and match the columns below to it.
        </p>
      )}

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 space-y-4">
        <p className="text-sm font-semibold text-gray-900">Columns, in order</p>
        <div className="space-y-2">
          {form.columns.map((column, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <span className="w-6 text-xs text-gray-400 text-right">{i + 1}</span>
              <input className={`${fieldCls} flex-1 min-w-40`} value={column.header} disabled={!canEdit} maxLength={60}
                onChange={(e) => setColumn(i, { header: e.target.value })} placeholder="Heading" aria-label={`Column ${i + 1} heading`} />
              <select className={`${fieldCls} w-48`} value={column.field} disabled={!canEdit}
                onChange={(e) => setColumn(i, { field: e.target.value })} aria-label={`Column ${i + 1} holds`}>
                {template.fields.map((f) => <option key={f.field} value={f.field}>{f.label}</option>)}
              </select>
              {column.field === 'fixed' && (
                <input className={`${fieldCls} w-36`} value={column.text} disabled={!canEdit} maxLength={60}
                  onChange={(e) => setColumn(i, { text: e.target.value })} placeholder="Text, e.g. NEFT" aria-label={`Column ${i + 1} text`} />
              )}
              {canEdit && (
                <div className="flex gap-1">
                  <IconButton onClick={() => move(i, -1)} disabled={i === 0} label="Move up" icon={ArrowUp} />
                  <IconButton onClick={() => move(i, 1)} disabled={i === form.columns.length - 1} label="Move down" icon={ArrowDown} />
                  <IconButton onClick={() => remove(i)} disabled={form.columns.length === 1} label="Remove" icon={Trash2} />
                </div>
              )}
            </div>
          ))}
        </div>
        {canEdit && (
          <button onClick={add} disabled={form.columns.length >= 25} className="flex items-center gap-1.5 text-sm font-medium text-blue-600 hover:text-blue-700 disabled:text-gray-400">
            <Plus className="w-4 h-4" /> Add a column
          </button>
        )}
        {missing.length > 0 && (
          <p className="text-xs text-red-600">The file needs {missing.map((f) => labels[f]?.toLowerCase()).join(' and ')} {missing.length === 1 ? 'column' : 'columns'}.</p>
        )}
      </div>

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 grid grid-cols-1 md:grid-cols-2 gap-4">
        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-gray-600">Narration</span>
          <input className={inputCls} value={form.narration} disabled={!canEdit} maxLength={60}
            onChange={(e) => setForm((f) => ({ ...f, narration: e.target.value }))} />
          <span className="block text-xs text-gray-400">{'{month}'}, {'{year}'} and {'{code}'} are filled in on each line.</span>
        </label>
        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-gray-600">Date format</span>
          <select className={inputCls} value={form.date_format} disabled={!canEdit}
            onChange={(e) => setForm((f) => ({ ...f, date_format: e.target.value }))}>
            {template.date_formats.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        </label>
        <label className="flex items-start gap-2 text-sm text-gray-700">
          <input type="checkbox" className="mt-0.5" checked={form.include_header} disabled={!canEdit}
            onChange={(e) => setForm((f) => ({ ...f, include_header: e.target.checked }))} />
          <span>First line has the column headings</span>
        </label>
        <label className="flex items-start gap-2 text-sm text-gray-700">
          <input type="checkbox" className="mt-0.5" checked={form.only_verified} disabled={!canEdit}
            onChange={(e) => setForm((f) => ({ ...f, only_verified: e.target.checked }))} />
          <span>
            Pay verified accounts only
            <span className="block text-xs text-gray-400">A rejected account is never paid, whichever is chosen.</span>
          </span>
        </label>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 space-y-2">
        <p className="text-sm font-semibold text-gray-900">How a line will look <span className="text-xs font-normal text-gray-400">— an example with a made-up person</span></p>
        <div className="overflow-x-auto">
          <table className="text-xs font-mono border border-gray-200">
            <tbody>
              {form.include_header && (
                <tr className="bg-gray-50">{form.columns.map((c, i) => <td key={i} className="px-2 py-1 border border-gray-200 font-semibold whitespace-nowrap">{c.header}</td>)}</tr>
              )}
              <tr>{form.columns.map((c, i) => <td key={i} className="px-2 py-1 border border-gray-200 whitespace-nowrap">{exampleCell(c, form)}</td>)}</tr>
            </tbody>
          </table>
        </div>
      </div>

      {canEdit && (
        <div className="flex justify-end gap-2">
          <button onClick={() => setForm(initial)} disabled={!dirty} className="px-4 py-2 rounded-lg border border-gray-300 text-sm font-medium text-gray-700 disabled:opacity-50">Discard changes</button>
          <button onClick={handleSave} disabled={save.isPending || missing.length > 0 || (!dirty && template.saved)}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium disabled:opacity-60">
            {save.isPending && <Loader2 className="w-4 h-4 animate-spin" />} Save format
          </button>
        </div>
      )}
    </div>
  )
}

function IconButton({ onClick, disabled, label, icon }) {
  return (
    <button onClick={onClick} disabled={disabled} aria-label={label} title={label}
      className="p-2 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 disabled:opacity-30 disabled:hover:bg-transparent">
      {createElement(icon, { className: 'w-4 h-4' })}
    </button>
  )
}
