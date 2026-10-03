import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Crown, AlertTriangle, ChevronDown, ChevronRight, Loader2, Search, UserX } from 'lucide-react'
import { Section, inpSm } from './ui'
import DataState from '../../components/DataState'
import ConfirmDialog from '../../components/ConfirmDialog'
import { useCompanyTree, useMarkOwner, useMoveInTree } from '../../hooks/useCompanyTree'

/**
 * Settings → Company tree (Day 22), the Super Admin's.
 *
 * Everybody reports to one person, and the person above decides: their leave,
 * and the work of theirs they cannot do on their own record. The chart is the
 * tree; from it the Super Admin moves people, marks the one owner — whose own
 * leave needs nobody — and places the people with nobody above them.
 *
 * Moving is the employee edit (PATCH /employees/:id), so the server's checks —
 * no loops, nobody under somebody who left, nobody above the owner — answer
 * here in the same words as on the person's page.
 */
export default function CompanyTree() {
  const tree = useCompanyTree()
  return (
    <div className="space-y-6">
      <DataState query={tree}>
        {(data) => <TreeView data={data} />}
      </DataState>
    </div>
  )
}

/** Each person's reports, from the tree as the server sent it. */
function reportsOf(people) {
  const map = new Map()
  for (const p of people) {
    if (!p.manager_id) continue
    map.set(p.manager_id, [...(map.get(p.manager_id) ?? []), p])
  }
  for (const list of map.values()) list.sort((a, b) => a.name.localeCompare(b.name))
  return map
}

/** Everybody under somebody — whom they may not report to. */
function underOf(id, reports) {
  const found = new Set()
  const queue = [...(reports.get(id) ?? [])]
  while (queue.length) {
    const next = queue.shift()
    if (found.has(next.id)) continue
    found.add(next.id)
    queue.push(...(reports.get(next.id) ?? []))
  }
  return found
}

function TreeView({ data }) {
  const people = data.people
  const byId = useMemo(() => new Map(people.map((p) => [p.id, p])), [people])
  const reports = useMemo(() => reportsOf(people), [people])
  const unplaced = data.unplaced.map((id) => byId.get(id)).filter(Boolean)
  const owner = data.owner_id ? byId.get(data.owner_id) : null
  // The chart starts from the owner, then from everybody else with nobody above.
  const roots = [owner, ...people.filter((p) => !p.manager_id && p.id !== data.owner_id).sort((a, b) => a.name.localeCompare(b.name))].filter(Boolean)
  const [search, setSearch] = useState('')
  const [marking, setMarking] = useState(null)
  const markOwner = useMarkOwner()
  const q = search.trim().toLowerCase()
  const matches = (p) => !q || p.name.toLowerCase().includes(q) || p.code.toLowerCase().includes(q)

  return (
    <>
      <Section title="Company tree" desc="Who reports to whom. A person’s leave goes to the one above them, whatever their role — and so does the work they cannot do on their own record.">
        <div className="py-4 space-y-4">
          {!owner && (
            <div role="alert" className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-900">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
              <p>
                No owner is marked. The owner is the one person at the top whose own leave needs nobody’s approval. Until one is marked, the leave of everybody with nobody above goes to the Super Admin — including the Super Admin’s own.{' '}
                {people.some((p) => p.can_be_owner) ? (
                  <>Mark the owner from their row below (<Crown className="inline w-3.5 h-3.5" aria-hidden="true" /> Make owner).</>
                ) : (
                  // On a fresh start the only Super Admin is the first administrator,
                  // who has no employee record: nobody on the chart can be the owner yet.
                  <>Nobody on the chart holds the Super Admin panel yet. Give the owner’s own record a Super Admin login first (Employees → their name → Logins → Add login), then mark them here.</>
                )}
              </p>
            </div>
          )}

          <label className="relative block max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" aria-hidden="true" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Find a person…" aria-label="Find a person"
              className={`${inpSm} w-full pl-9`} />
          </label>

          {q ? (
            <ul className="divide-y divide-gray-100 border border-gray-200 rounded-xl">
              {people.filter(matches).map((p) => (
                <li key={p.id} className="px-3 py-2.5">
                  <PersonRow person={p} byId={byId} reports={reports} people={people} onMakeOwner={setMarking} showManager />
                </li>
              ))}
              {people.filter(matches).length === 0 && <li className="px-3 py-6 text-center text-sm text-gray-400">Nobody matches that.</li>}
            </ul>
          ) : (
            <ul className="space-y-1" aria-label="Company tree">
              {roots.map((p) => (
                <Branch key={p.id} person={p} depth={0} byId={byId} reports={reports} people={people} onMakeOwner={setMarking} />
              ))}
            </ul>
          )}
        </div>
      </Section>

      <Section title="Nobody above" desc="People still here with nobody to report to — their leave goes to the Super Admin until they are placed.">
        <div className="py-4">
          {unplaced.length === 0 ? (
            <p className="text-sm text-gray-500">Everybody has somebody above them{owner ? ', except the owner at the top' : ''}.</p>
          ) : (
            <ul className="divide-y divide-gray-100 border border-gray-200 rounded-xl">
              {unplaced.map((p) => (
                <li key={p.id} className="px-3 py-3 space-y-2">
                  <div className="flex items-start gap-2">
                    <UserX className="w-4 h-4 mt-0.5 text-amber-500 shrink-0" aria-hidden="true" />
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-gray-900">{p.name} <span className="font-normal text-gray-400">({p.code})</span></p>
                      <p className="text-xs text-gray-500">
                        {p.manager_who_left ? `Reported to ${p.manager_who_left}, who has left.` : 'Has never been placed.'}
                        {p.role ? ` · ${p.role}` : ''}
                      </p>
                    </div>
                  </div>
                  <MoveControl person={p} people={people} reports={reports} label="Place under" />
                </li>
              ))}
            </ul>
          )}
        </div>
      </Section>

      {marking && (
        <ConfirmDialog title={`Make ${marking.name} the owner?`} confirmLabel="Make owner"
          onConfirm={() => markOwner.mutateAsync({ employeeId: marking.id, version: data.version }).then(() => toast.success(`${marking.name} is now the owner`))}
          onClose={() => setMarking(null)}>
          <p>The owner sits at the top of the company tree and needs nobody’s approval: their own leave is recorded directly, and the audit log says so.</p>
          {marking.manager_id && <p>They report to {byId.get(marking.manager_id)?.name ?? 'somebody'} now; that line is taken away.</p>}
          {owner && <p>{owner.name} stops being the owner, and goes on the list of people with nobody above.</p>}
        </ConfirmDialog>
      )}
    </>
  )
}

function Branch({ person, depth, byId, reports, people, onMakeOwner }) {
  const children = reports.get(person.id) ?? []
  // Deep trees open two levels at first; the rest one click away.
  const [open, setOpen] = useState(depth < 2)
  return (
    <li>
      <div className={`rounded-lg border ${person.is_owner ? 'border-purple-200 bg-purple-50/50' : 'border-gray-200 bg-white'} px-3 py-2.5`}
        style={{ marginLeft: `${Math.min(depth, 6) * 1.25}rem` }}>
        <div className="flex items-start gap-2">
          {children.length > 0 ? (
            <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}
              aria-label={`${open ? 'Hide' : 'Show'} the ${children.length} reporting to ${person.name}`}
              className="mt-0.5 p-0.5 rounded hover:bg-gray-100 text-gray-500">
              {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
            </button>
          ) : <span className="w-5" aria-hidden="true" />}
          <div className="flex-1 min-w-0">
            <PersonRow person={person} byId={byId} reports={reports} people={people} onMakeOwner={onMakeOwner} count={children.length} />
          </div>
        </div>
      </div>
      {open && children.length > 0 && (
        <ul className="mt-1 space-y-1">
          {children.map((c) => (
            <Branch key={c.id} person={c} depth={depth + 1} byId={byId} reports={reports} people={people} onMakeOwner={onMakeOwner} />
          ))}
        </ul>
      )}
    </li>
  )
}

function PersonRow({ person, byId, reports, people, onMakeOwner, count = 0, showManager = false }) {
  const [moving, setMoving] = useState(false)
  const facts = [person.designation, person.department, person.role].filter(Boolean).join(' · ')
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium text-gray-900 flex items-center gap-1.5 flex-wrap">
            {person.name}
            {person.is_owner && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase bg-purple-100 text-purple-800">
                <Crown className="w-3 h-3" aria-hidden="true" /> Owner
              </span>
            )}
          </p>
          <p className="text-xs text-gray-500">
            {facts || person.code}
            {count > 0 ? ` · ${count} report${count === 1 ? 's' : ''} to them` : ''}
            {showManager ? ` · ${person.manager_id ? `reports to ${byId.get(person.manager_id)?.name ?? 'somebody'}` : 'nobody above'}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          {person.can_be_owner && !person.is_owner && (
            <button type="button" onClick={() => onMakeOwner(person)}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-purple-200 text-purple-700 hover:bg-purple-50 text-xs font-medium">
              <Crown className="w-3.5 h-3.5" aria-hidden="true" /> Make owner
            </button>
          )}
          {!person.is_owner && (
            <button type="button" onClick={() => setMoving(!moving)} aria-expanded={moving}
              className="px-2.5 py-1 rounded-lg border border-gray-200 text-gray-700 hover:bg-gray-50 text-xs font-medium">
              {moving ? 'Cancel' : 'Change who they report to'}
            </button>
          )}
        </div>
      </div>
      {moving && <MoveControl person={person} people={people} reports={reports} label="Reports to" onDone={() => setMoving(false)} />}
    </div>
  )
}

/** Who somebody reports to: anybody but themselves and the people under them, or nobody. */
function MoveControl({ person, people, reports, label, onDone }) {
  const move = useMoveInTree()
  const under = useMemo(() => underOf(person.id, reports), [person.id, reports])
  const options = people
    .filter((p) => p.id !== person.id && !under.has(p.id))
    .sort((a, b) => a.name.localeCompare(b.name))
  const [managerId, setManagerId] = useState(person.manager_id ?? '')
  const [error, setError] = useState(null)

  async function save() {
    setError(null)
    try {
      await move.mutateAsync({ employeeId: person.id, managerId: managerId || null })
      toast.success(managerId ? `${person.name} now reports to ${people.find((p) => p.id === managerId)?.name}` : `${person.name} now has nobody above`)
      onDone?.()
    } catch (err) {
      // The server's words — a loop, somebody who left — where the person is looking.
      setError(err?.message ?? 'That could not be saved.')
    }
  }

  return (
    <div className="space-y-1.5">
      <div className="flex flex-col sm:flex-row sm:items-center gap-2">
        <label className="flex-1 min-w-0">
          <span className="sr-only">{label} — {person.name}</span>
          <select value={managerId} onChange={(e) => setManagerId(e.target.value)} aria-label={`${label} — ${person.name}`}
            className={`${inpSm} w-full`}>
            <option value="">Nobody above</option>
            {options.map((p) => <option key={p.id} value={p.id}>{p.name}{p.designation ? ` — ${p.designation}` : ''}</option>)}
          </select>
        </label>
        <button type="button" onClick={save} disabled={move.isPending || managerId === (person.manager_id ?? '')}
          className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 text-white text-sm font-medium">
          {move.isPending && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />} Save
        </button>
      </div>
      <p className="text-xs text-gray-400">Their waiting leave requests go to the new person at once.</p>
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
    </div>
  )
}
