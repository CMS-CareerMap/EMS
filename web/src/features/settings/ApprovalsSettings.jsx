import { useState } from 'react'
import { toast } from 'sonner'
import { Section, Field, SaveBar, inp } from './ui'
import DataState from '../../components/DataState'
import { optionsNote } from '../../lib/optionsNote'
import { useApprovalSettings, useCompanyTree, useSaveApprovalSettings } from '../../hooks/useCompanyTree'

/**
 * Settings → Approvals (Day 22): the three things the company tree does not
 * answer by itself. The client's choices are the defaults (30 Sep 2026); the
 * Super Admin can change any of them.
 */
const BACKUP = [
  { value: 'super_admin', label: 'The Super Admin can decide instead' },
  { value: 'next_up', label: 'The manager’s own manager can decide instead' },
  { value: 'none', label: 'Nobody — the request waits for the manager' },
]

const REVERSAL = [
  { value: 'manager_or_super_admin', label: 'The reporting manager, or the Super Admin' },
  { value: 'super_admin_only', label: 'Only the Super Admin' },
]

export default function ApprovalsSettings() {
  const settings = useApprovalSettings()
  return (
    // Not keyed by the version: a save brings a new one, and remounting the
    // form then threw away its "Saved" and any error it was showing.
    <DataState query={settings}>
      {(data) => <ApprovalsForm data={data} />}
    </DataState>
  )
}

const formOf = (data) => ({
  noManagerApproverId: data.no_manager_approver_id ?? '',
  backup: data.backup,
  reversal: data.reversal,
})

function ApprovalsForm({ data }) {
  const tree = useCompanyTree()
  const save = useSaveApprovalSettings()
  const [form, setForm] = useState(() => formOf(data))
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState(null)
  // After a refusal because somebody else saved meanwhile, the form shows
  // their settings as soon as they arrive — not the old ones, to be saved over
  // them. (Set while drawing, React's way of following new data.)
  const [reloadAfter, setReloadAfter] = useState(null)
  if (reloadAfter && data.version !== reloadAfter) {
    setReloadAfter(null)
    setForm(formOf(data))
  }
  const set = (key) => (e) => { setSaved(false); setForm((f) => ({ ...f, [key]: e.target.value })) }
  const changed =
    (form.noManagerApproverId || null) !== (data.no_manager_approver_id ?? null) || form.backup !== data.backup || form.reversal !== data.reversal
  // Only somebody who can sign in can decide anything; the server refuses anybody else.
  const people = [...(tree.data?.people ?? [])].filter((p) => p.can_sign_in).sort((a, b) => a.name.localeCompare(b.name))

  async function handleSave() {
    setError(null)
    try {
      await save.mutateAsync({
        noManagerApproverId: form.noManagerApproverId || null,
        backup: form.backup,
        reversal: form.reversal,
        version: data.version,
      })
      setSaved(true)
      toast.success('Approval settings saved')
    } catch (err) {
      if (err?.status === 409) {
        setReloadAfter(data.version)
        setError('Somebody changed these settings a moment ago. They are shown now; make your change again if it is still needed.')
      } else {
        setError(err?.message ?? 'The settings could not be saved.')
      }
    }
  }
  const named = data.no_manager_approver_id ? data.no_manager_approver_name : null

  return (
    <Section title="Approvals" desc="Leave goes to the person each employee reports to in the company tree. These settings decide what happens when the tree has no answer.">
      <Field label="Somebody with nobody above them" hint="Their leave goes to…">
        <select value={form.noManagerApproverId} onChange={set('noManagerApproverId')} className={inp} aria-label="Who decides for somebody with nobody above them">
          <option value="">The Super Admin</option>
          {/* A person who has left decides nothing, and is not offered. */}
          {tree.isSuccess
            ? people.map((p) => <option key={p.id} value={p.id}>{p.name}{p.designation ? ` — ${p.designation}` : ''}</option>)
            : <option value="" disabled>{optionsNote(tree, '')}</option>}
          {data.no_manager_approver_id && !people.some((p) => p.id === data.no_manager_approver_id) && (
            <option value={data.no_manager_approver_id}>
              {data.no_manager_approver_name}{data.no_manager_approver_can_sign_in ? '' : ' (cannot sign in now)'}
            </option>
          )}
        </select>
      </Field>
      {named && !data.no_manager_approver_can_sign_in && (
        <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          {named} cannot sign in at the moment, so the Super Admin decides these requests until they can. Choose somebody else if that is not what you want.
        </p>
      )}
      <Field label="The reporting manager is away" hint="Who may decide the request instead. Deciding instead is written in the log as standing in.">
        <select value={form.backup} onChange={set('backup')} className={inp} aria-label="Who may decide when the reporting manager is away">
          {BACKUP.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </Field>
      <Field label="Cancelling approved leave" hint="Who may give the days back once leave is approved. Nobody cancels their own.">
        <select value={form.reversal} onChange={set('reversal')} className={inp} aria-label="Who may cancel approved leave">
          {REVERSAL.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </Field>
      {error && <p role="alert" className="text-sm text-red-600 pt-2">{error}</p>}
      <SaveBar onSave={handleSave} saving={save.isPending} saved={saved && !changed} disabled={!changed} />
      <div className="pb-2" />
    </Section>
  )
}
