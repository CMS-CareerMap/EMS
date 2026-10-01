import { useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, Lock, Pencil, Plus, RotateCcw, ShieldCheck, Trash2, Eye } from 'lucide-react'
import { useCreateRole, useDeleteRole, useResetRole, useRoles, useUpdateRole } from '../../hooks/useRoles'
import { Section } from './ui'
import Dialog, { inputCls } from '../../components/Dialog'
import ConfirmDialog from '../../components/ConfirmDialog'
import DataState from '../../components/DataState'

/**
 * Settings → Roles & Permissions (Day 21), the Super Admin's.
 *
 * Every role in the order the Super Admin arranged them, and an editor that
 * says in plain words what each tick means, whose information it reaches, and
 * — before anything is saved — what the role will be able to do. The server
 * decides whether a role may be saved; this screen explains, and never claims
 * a change it has not seen succeed.
 */

const people = (n) => `${n} ${n === 1 ? 'person' : 'people'}`

/** The roles in their order: each under the one it comes under, with its depth. */
function inOrder(roles) {
  const children = new Map()
  for (const role of roles) {
    const list = children.get(role.parent_key ?? null) ?? []
    list.push(role)
    children.set(role.parent_key ?? null, list)
  }
  const seen = new Set()
  const out = []
  const visit = (role, depth) => {
    if (seen.has(role.key)) return
    seen.add(role.key)
    out.push({ role, depth })
    for (const child of children.get(role.key) ?? []) visit(child, depth + 1)
  }
  for (const top of children.get(null) ?? []) visit(top, 0)
  // Anything not reached (a parent that is gone) is still listed, at the end.
  for (const role of roles) visit(role, 0)
  return out
}

/** A role and everything below it — what it may not be put under. */
function selfAndBelow(roles, key) {
  const below = new Set([key])
  let grew = true
  while (grew) {
    grew = false
    for (const role of roles) {
      if (role.parent_key && below.has(role.parent_key) && !below.has(role.key)) {
        below.add(role.key)
        grew = true
      }
    }
  }
  return below
}

/** What a role may do, in the screen's own words, one line per area. */
function describe(catalogue, permissions, scopes) {
  const has = new Set(permissions)
  const scopeLabel = new Map(catalogue.scopes.map((s) => [s.key, s.label]))
  return catalogue.modules
    .map((m) => {
      const ticked = m.permissions.filter((p) => has.has(p.key)).map((p) => p.label)
      if (ticked.length === 0) return null
      const reach = m.resource ? scopeLabel.get(scopes[m.resource] ?? 'SELF') : null
      return { key: m.key, label: m.label, reach, ticked }
    })
    .filter(Boolean)
}

/**
 * What a role is warned about before it is saved — the same two the server
 * returns from warningsFor (roles.policy.ts), in the same words.
 */
const ROLE_WARNINGS = [
  {
    key: 'payroll',
    applies: (permissions) => permissions.includes('payroll:run:create') && permissions.includes('payroll:run:approve'),
    text: 'This role can both prepare and approve the payroll, so one person could pay out a payroll nobody else has checked. Usually Accounts prepares it and the Super Admin approves it.',
    title: 'Save a role that both prepares and approves the payroll?',
    confirm: "Whoever holds it could prepare a month's payroll and approve it themselves, with nobody else looking.",
  },
  {
    key: 'audit',
    applies: (permissions) => permissions.includes('audit:read'),
    text: 'The audit log shows everything that happened in EMS, for the whole company: every salary change with its amount, and who opened whose documents. Give it only to somebody trusted with all of that.',
    title: 'Save a role that can read the audit log?',
    confirm: 'Whoever holds it can read every salary change, with its amount, and who opened whose documents, across the whole company.',
  },
]

const warningsFor = (permissions) => ROLE_WARNINGS.filter((w) => w.applies(permissions))

export default function RolesSettings() {
  const roles = useRoles()
  const [editing, setEditing] = useState(null)
  const [resetting, setResetting] = useState(null)
  const [deleting, setDeleting] = useState(null)
  const [notice, setNotice] = useState(null)
  const resetRole = useResetRole()
  const deleteRole = useDeleteRole()

  return (
    <div className="space-y-6">
      <Section
        title="Roles & Permissions"
        desc="Make roles, decide what each one can do and whose information it reaches. A change applies at once to everybody holding the role."
      >
        <div className="py-3 space-y-4">
          {notice && (
            <div role="status" className="flex items-start gap-2 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800">
              <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
              <p className="flex-1">{notice}</p>
              <button type="button" onClick={() => setNotice(null)} className="text-green-700 hover:text-green-900 text-xs font-medium">Close</button>
            </div>
          )}

          <DataState query={roles} loading="Loading roles…">
            {(data) => (
              <>
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                  <p className="text-sm text-gray-500">
                    {data.roles.length} roles. Each comes under another — whoever holds a role can give only the roles below it.
                  </p>
                  <button type="button" onClick={() => setEditing({ mode: 'new' })}
                    className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold shrink-0">
                    <Plus className="w-4 h-4" aria-hidden="true" /> New role
                  </button>
                </div>

                <ul className="border border-gray-200 rounded-xl divide-y divide-gray-100 overflow-hidden">
                  {inOrder(data.roles).map(({ role, depth }) => {
                    const parent = data.roles.find((r) => r.key === role.parent_key)
                    const readOnly = role.locked || role.own
                    return (
                      <li key={role.key} className="px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-3 hover:bg-gray-50">
                        <div className="flex-1 min-w-0" style={{ paddingLeft: `${Math.min(depth, 6) * 16}px` }}>
                          <div className="flex flex-wrap items-center gap-2">
                            {depth > 0 && <span className="text-gray-300" aria-hidden="true">└</span>}
                            <p className="text-sm font-semibold text-gray-900">{role.name}</p>
                            {role.locked && (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-purple-100 text-purple-700"><Lock className="w-3 h-3" aria-hidden="true" />Locked</span>
                            )}
                            {role.built_in && !role.locked && <span className="px-2 py-0.5 rounded-full text-xs bg-gray-100 text-gray-600">Built-in</span>}
                            {role.changed_from_default && <span className="px-2 py-0.5 rounded-full text-xs bg-amber-100 text-amber-800">Changed</span>}
                            {role.own && <span className="px-2 py-0.5 rounded-full text-xs bg-blue-100 text-blue-700">Your role</span>}
                          </div>
                          <p className="text-xs text-gray-500 mt-0.5">
                            {parent ? `Comes under ${parent.name}` : 'At the top'} · {people(role.holders)} · {role.locked ? 'everything' : `${role.permissions.length} permissions`}
                          </p>
                          {role.description && <p className="text-xs text-gray-400 mt-0.5 line-clamp-2">{role.description}</p>}
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <button type="button" onClick={() => setEditing({ mode: 'edit', role })}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-gray-700 border border-gray-200 hover:bg-white">
                            {readOnly ? <Eye className="w-3.5 h-3.5" aria-hidden="true" /> : <Pencil className="w-3.5 h-3.5" aria-hidden="true" />}
                            {readOnly ? 'View' : 'Edit'}
                          </button>
                          {role.built_in && !readOnly && role.changed_from_default && (
                            <button type="button" onClick={() => setResetting(role)} title="Reset to default"
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-amber-800 border border-amber-200 hover:bg-amber-50">
                              <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" /> Reset
                            </button>
                          )}
                          {!role.built_in && !readOnly && (
                            <button type="button" onClick={() => setDeleting(role)} aria-label={`Delete ${role.name}`}
                              className="p-2 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50">
                              <Trash2 className="w-4 h-4" aria-hidden="true" />
                            </button>
                          )}
                        </div>
                      </li>
                    )
                  })}
                </ul>

                {editing && (
                  <RoleEditor
                    data={data}
                    role={editing.mode === 'edit' ? editing.role : null}
                    onClose={() => setEditing(null)}
                    onSaved={(text) => { setEditing(null); setNotice(text) }}
                  />
                )}
              </>
            )}
          </DataState>
        </div>
      </Section>

      {resetting && (
        <ConfirmDialog title={`Reset “${resetting.name}” to how EMS started it?`} confirmLabel="Reset"
          onConfirm={async () => {
            const r = await resetRole.mutateAsync({ key: resetting.key, version: resetting.version })
            setNotice(`“${resetting.name}” is back to how EMS started it${r.holders ? ` — for the ${people(r.holders)} holding it, from now on` : ''}.`)
          }}
          onClose={() => setResetting(null)}>
          <p>Its name, description, place in the order, permissions and reach all go back to the defaults.</p>
          {resetting.holders > 0 && <p>It changes at once for the {people(resetting.holders)} holding it.</p>}
        </ConfirmDialog>
      )}

      {deleting && (() => {
        // The two reasons the server refuses, said before anybody presses Delete.
        const below = (roles.data?.roles ?? []).filter((r) => r.parent_key === deleting.key)
        const blocked = deleting.holders > 0 || below.length > 0
        return (
          <ConfirmDialog title={`Delete the role “${deleting.name}”?`} confirmLabel="Delete" danger disabled={blocked}
            onConfirm={async () => {
              await deleteRole.mutateAsync({ key: deleting.key })
              setNotice(`The role “${deleting.name}” was deleted.`)
            }}
            onClose={() => setDeleting(null)}>
            {deleting.holders > 0 && <p>{people(deleting.holders)} still hold this role, so it cannot be deleted. Give them another role first, in Users &amp; Roles.</p>}
            {below.length > 0 && <p>{below.map((r) => `“${r.name}”`).join(', ')} {below.length === 1 ? 'comes' : 'come'} under this role, so it cannot be deleted. Move {below.length === 1 ? 'it' : 'them'} under another role first.</p>}
            {!blocked && <p>Nobody holds it. The audit log keeps the record of it.</p>}
          </ConfirmDialog>
        )
      })()}
    </div>
  )
}

function RoleEditor({ data, role, onClose, onSaved }) {
  const { catalogue } = data
  const isNew = !role
  const readOnly = Boolean(role && (role.locked || role.own))
  const create = useCreateRole()
  const update = useUpdateRole()

  const [form, setForm] = useState(() => ({
    name: role?.name ?? '',
    description: role?.description ?? '',
    parent_key: role?.parent_key ?? 'super_admin',
    permissions: role?.permissions ?? [],
    scopes: { ...(role?.scopes ?? {}) },
  }))
  const [error, setError] = useState(null)
  const [confirmWarning, setConfirmWarning] = useState(false)
  const set = (field, value) => setForm((f) => ({ ...f, [field]: value }))

  const requires = useMemo(
    () => new Map(catalogue.modules.flatMap((m) => m.permissions.map((p) => [p.key, p.requires ?? []]))),
    [catalogue],
  )
  const labelOf = useMemo(
    () => new Map(catalogue.modules.flatMap((m) => m.permissions.map((p) => [p.key, p.label]))),
    [catalogue],
  )

  /** Ticking one ticks what it needs; unticking one unticks whatever needs it. */
  function toggle(permission, on) {
    setForm((f) => {
      const next = new Set(f.permissions)
      if (on) {
        const add = [permission]
        while (add.length) {
          const p = add.pop()
          if (next.has(p)) continue
          next.add(p)
          add.push(...(requires.get(p) ?? []))
        }
      } else {
        const drop = [permission]
        while (drop.length) {
          const p = drop.pop()
          if (!next.has(p)) continue
          next.delete(p)
          for (const [other, needs] of requires) if (needs.includes(p)) drop.push(other)
        }
      }
      return { ...f, permissions: catalogue.modules.flatMap((m) => m.permissions.map((p) => p.key)).filter((k) => next.has(k)) }
    })
  }

  const exclude = role ? selfAndBelow(data.roles, role.key) : new Set()
  const parents = data.roles.filter((r) => !exclude.has(r.key))
  const preview = describe(catalogue, form.permissions, form.scopes)
  const warnings = warningsFor(form.permissions)
  const saving = create.isPending || update.isPending

  async function save() {
    setError(null)
    try {
      const result = isNew
        ? await create.mutateAsync(form)
        : await update.mutateAsync({ ...form, key: role.key, version: role.version })
      const holders = result.holders ?? 0
      onSaved(isNew
        ? `The role “${form.name.trim()}” was created. Give it to somebody from Users & Roles.`
        : `“${form.name.trim()}” was saved${holders ? ` — it applies now for the ${people(holders)} holding it` : ''}.`)
    } catch (err) {
      // The server's words, here, where the person is looking — the toast says it too.
      setError(err?.message ?? 'The role could not be saved.')
    }
  }

  function trySave() {
    if (warnings.length > 0) setConfirmWarning(true)
    else save()
  }

  const title = isNew ? 'New role' : readOnly ? role.name : `Edit “${role.name}”`

  return (
    // While it saves, Escape and the close button wait: closing mid-save
    // would lose what was ticked if the save then failed.
    <Dialog title={title} onClose={saving ? () => {} : onClose} wide>
      {readOnly && (
        <div className="flex items-start gap-2 rounded-lg border border-purple-200 bg-purple-50 px-3 py-2 text-sm text-purple-900">
          <Lock className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
          <p>{role.locked
            ? 'The Super Admin role holds everything and can never be changed, so the company always has somebody who can.'
            : 'You hold this role, so you cannot change it. Another Super Admin can.'}</p>
        </div>
      )}

      {!role?.locked && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="space-y-1 block">
              <span className="text-xs font-medium text-gray-600">Name</span>
              <input value={form.name} onChange={(e) => set('name', e.target.value)} disabled={readOnly} maxLength={40}
                placeholder="e.g. Team Lead" className={inputCls} />
            </label>
            <label className="space-y-1 block">
              <span className="text-xs font-medium text-gray-600">Comes under</span>
              <select value={form.parent_key} onChange={(e) => set('parent_key', e.target.value)} disabled={readOnly} className={`${inputCls} bg-white`}>
                {parents.map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}
              </select>
              <span className="block text-xs text-gray-400">Who can give this role: only people whose role is above it.</span>
            </label>
            <label className="space-y-1 block sm:col-span-2">
              <span className="text-xs font-medium text-gray-600">Description</span>
              <input value={form.description} onChange={(e) => set('description', e.target.value)} disabled={readOnly} maxLength={200}
                placeholder="Optional — what this role is for" className={inputCls} />
            </label>
          </div>

          <div className="space-y-3">
            {catalogue.modules.map((m) => {
              const scopeValue = m.resource ? (form.scopes[m.resource] ?? 'SELF') : null
              return (
                <fieldset key={m.key} aria-labelledby={`module-${m.key}`} className="border border-gray-200 rounded-xl p-3 sm:p-4">
                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                    <p id={`module-${m.key}`} className="text-sm font-semibold text-gray-900">{m.label}</p>
                    {m.resource && (
                      <label className="flex items-center gap-2 text-xs text-gray-600">
                        <span>{m.scope_question}:</span>
                        <select value={scopeValue} disabled={readOnly} aria-label={m.scope_question}
                          onChange={(e) => set('scopes', { ...form.scopes, [m.resource]: e.target.value })}
                          className="border border-gray-300 rounded-lg px-2 py-1 text-xs bg-white disabled:bg-gray-50">
                          {/* Only the choices this module can honour (payslips: own or company). */}
                          {catalogue.scopes.filter((s) => (m.scopes ?? []).includes(s.key)).map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                        </select>
                      </label>
                    )}
                  </div>
                  {m.note && <p className="text-xs text-gray-500 mt-1">{m.note}</p>}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5 mt-2">
                    {m.permissions.map((p) => {
                      const checked = form.permissions.includes(p.key)
                      const hintId = `needs-${p.key.replace(/:/g, '-')}`
                      return (
                        <div key={p.key} className="flex items-start gap-2 text-sm text-gray-700">
                          <input type="checkbox" id={`perm-${hintId}`} checked={checked} disabled={readOnly} onChange={(e) => toggle(p.key, e.target.checked)}
                            aria-describedby={p.requires?.length > 0 ? hintId : undefined}
                            className="mt-0.5 rounded border-gray-300 text-blue-600 focus:ring-blue-500" />
                          <div>
                            {/* The label is the permission alone, so its name is not
                                mixed with the names of what it needs. */}
                            <label htmlFor={`perm-${hintId}`}>{p.label}</label>
                            {p.requires?.length > 0 && (
                              <span id={hintId} className="block text-xs text-gray-400">Comes with “{p.requires.map((r) => labelOf.get(r) ?? r).join('”, “')}”</span>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </fieldset>
              )
            })}
          </div>
        </>
      )}

      <div className="rounded-xl border border-blue-200 bg-blue-50 p-3 sm:p-4">
        <p className="text-sm font-semibold text-blue-900 flex items-center gap-2">
          <ShieldCheck className="w-4 h-4" aria-hidden="true" />
          {role?.locked ? 'This role can do everything in EMS.' : 'What this role will be able to do'}
        </p>
        {!role?.locked && (preview.length === 0
          ? <p className="text-sm text-blue-800 mt-1">Nothing yet — tick what it may do above.</p>
          : (
            <ul className="mt-1.5 space-y-1 text-sm text-blue-900">
              {preview.map((line) => (
                <li key={line.key}>
                  <span className="font-medium">{line.label}{line.reach ? ` (${line.reach.toLowerCase()})` : ''}:</span> {line.ticked.join(', ')}
                </li>
              ))}
            </ul>
          ))}
      </div>

      {!readOnly && warnings.map((w) => (
        <div key={w.key} role="alert" className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
          <p>{w.text}</p>
        </div>
      ))}

      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}

      <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 pt-1">
        <button type="button" onClick={onClose} disabled={saving}
          className="px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-60">
          {readOnly ? 'Close' : 'Cancel'}
        </button>
        {!readOnly && (
          <button type="button" onClick={trySave} disabled={saving || form.name.trim().length < 2}
            className="px-4 py-2 text-sm font-medium text-white rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-60">
            {saving ? 'Saving…' : isNew ? 'Create role' : 'Save changes'}
          </button>
        )}
      </div>

      {confirmWarning && (
        <ConfirmDialog title={warnings.length === 1 ? warnings[0].title : 'Save this role anyway?'} confirmLabel="Save anyway"
          onConfirm={save} onClose={() => setConfirmWarning(false)}>
          {warnings.map((w) => <p key={w.key}>{w.confirm}</p>)}
        </ConfirmDialog>
      )}
    </Dialog>
  )
}
