/**
 * The company tree (Day 22): everybody reports to one person, and the person
 * above decides. Pure — the people come in as rows, and nothing here reads a
 * database or a clock.
 *
 * Two readings of "above", on purpose:
 *
 *   - IN EFFECT. A person whose reporting manager has left has nobody above
 *     them until the Super Admin places them. That is the reading for who
 *     approves and who does a person's work (`managerOf`, `chain`, `below`):
 *     nobody who has left decides anything, and nobody is skipped silently.
 *   - AS RECORDED. Every reporting line still stored, through people who have
 *     left. That is the reading for hiding seniors' information (`above`): a
 *     manager leaving must not, for the days before their team is placed again,
 *     show that team's HR the salary of the director above them.
 *
 * Every walk is bounded by the number of people, so rows that loop — which the
 * screens refuse to make (`wouldLoop`) — end a walk instead of hanging it.
 */

export interface TreePerson {
  id: string
  managerId: string | null
  /** Left the company: archived. Still in the tree as recorded, never in effect. */
  left: boolean
  /**
   * Has a login that can sign in. Somebody without one still sits in the tree
   * — people report to them — but cannot decide anything there: their team's
   * leave goes on as if nobody were above (domain/leave/approval). Unknown
   * (undefined) counts as able, for trees read without logins.
   */
  canSignIn?: boolean
}

export interface CompanyTree {
  has(id: string): boolean
  /** Everybody in it, people who have left included. */
  ids(): string[]
  /** Has left the company. */
  left(id: string): boolean
  /** Still here, with a login that can sign in — somebody who can decide. */
  canAct(id: string): boolean
  /** Their reporting manager in effect: null when there is none, or that person has left. */
  managerOf(id: string): string | null
  /** Everybody above them in effect, nearest first, up to the top. */
  chain(id: string): string[]
  /** Everybody under them in effect, at every level. */
  below(id: string): string[]
  /** Everybody above them as recorded, through people who have left. */
  above(id: string): string[]
  /** Would reporting to `managerId` put this person under themselves? */
  wouldLoop(personId: string, managerId: string): boolean
  /** People still here with nobody above them in effect, and the manager who left, if one did. */
  unplaced(): { id: string; managerWhoLeft: string | null }[]
}

/**
 * A person's place for the two scopes that follow the tree: everybody under
 * them, and everybody above them — counting, as above, the people at the top
 * of the company whatever the reporting lines say (the owner and the Super
 * Admins: `alwaysAbove`). Somebody not yet placed under anybody has nobody
 * above them in the tree, and "the whole company except seniors" must not
 * become the whole company — the owner's salary included.
 */
export function placeIn(tree: CompanyTree, employeeId: string, alwaysAbove: readonly string[]): { below: string[]; above: string[] } {
  const below = tree.below(employeeId)
  const above = new Set(tree.above(employeeId))
  for (const id of alwaysAbove) if (id !== employeeId && !below.includes(id)) above.add(id)
  return { below, above: [...above] }
}

export function buildTree(people: readonly TreePerson[]): CompanyTree {
  const byId = new Map(people.map((p) => [p.id, p]))
  const limit = people.length + 1

  const managerOf = (id: string): string | null => {
    const managerId = byId.get(id)?.managerId ?? null
    if (!managerId) return null
    const manager = byId.get(managerId)
    return manager && !manager.left ? manager.id : null
  }

  // Children in effect, and as recorded.
  const reportsInEffect = new Map<string, string[]>()
  const reportsRecorded = new Map<string, string[]>()
  for (const person of people) {
    if (person.managerId) {
      reportsRecorded.set(person.managerId, [...(reportsRecorded.get(person.managerId) ?? []), person.id])
    }
    const manager = managerOf(person.id)
    if (manager) reportsInEffect.set(manager, [...(reportsInEffect.get(manager) ?? []), person.id])
  }

  const walkUp = (id: string, next: (id: string) => string | null): string[] => {
    const found: string[] = []
    const seen = new Set([id])
    let current = next(id)
    while (current && !seen.has(current) && found.length < limit) {
      found.push(current)
      seen.add(current)
      current = next(current)
    }
    return found
  }

  const walkDown = (id: string, reports: Map<string, string[]>): string[] => {
    const found: string[] = []
    const seen = new Set([id])
    const queue = [...(reports.get(id) ?? [])]
    while (queue.length && found.length < limit) {
      const next = queue.shift()!
      if (seen.has(next)) continue
      seen.add(next)
      found.push(next)
      queue.push(...(reports.get(next) ?? []))
    }
    return found
  }

  return {
    has: (id) => byId.has(id),
    ids: () => [...byId.keys()],
    left: (id) => byId.get(id)?.left ?? false,
    canAct: (id) => {
      const person = byId.get(id)
      return Boolean(person && !person.left && person.canSignIn !== false)
    },
    managerOf,
    chain: (id) => walkUp(id, managerOf),
    below: (id) => walkDown(id, reportsInEffect),
    above: (id) => walkUp(id, (current) => byId.get(current)?.managerId ?? null),
    wouldLoop: (personId, managerId) => managerId === personId || walkDown(personId, reportsRecorded).includes(managerId),
    unplaced: () =>
      people
        .filter((p) => !p.left && managerOf(p.id) === null)
        .map((p) => ({ id: p.id, managerWhoLeft: p.managerId && byId.has(p.managerId) ? p.managerId : null })),
  }
}
