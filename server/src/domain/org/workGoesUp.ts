import type { CompanyTree } from './companyTree'

/**
 * "Your own work goes up the tree" (Devesh, 1 Oct 2026). Pure.
 *
 * Somebody who does a kind of work — checks bank accounts, corrects leave
 * balances, checks documents, marks attendance, enters incentives or salaries
 * — never does it on their own record. Nor do their peers or juniors: only the
 * people above them in the company tree, and in the end the Super Admin.
 * An ordinary employee's items are done, as before, by anybody holding the
 * right whose scope reaches them.
 *
 * Whether a person "does that kind of work" is whether their login's role
 * holds one of its permissions — so a custom role given the work is bound by
 * the rule like a built-in one.
 */

export interface WorkWorld {
  tree: CompanyTree
  /** The owner: their own items need nobody's approval. */
  ownerId: string | null
  /** For each person with a live login, whether its role holds this kind of work, and whether it is a Super Admin's. */
  doesWork(employeeId: string): boolean
  isSuperAdmin(employeeId: string): boolean
}

export interface Worker {
  employeeId: string | null
  isSuperAdmin: boolean
}

export type WorkVerdict =
  | { allowed: true }
  /** `askId` is the person to ask: the nearest one above who does this work or holds the Super Admin panel; null is "the Super Admin". */
  | { allowed: false; own: boolean; askId: string | null }

/** The nearest person above `employeeId` who could do it for them. */
function nearestAbove(world: WorkWorld, employeeId: string): string | null {
  for (const above of world.tree.chain(employeeId)) {
    if (world.doesWork(above) || world.isSuperAdmin(above)) return above
  }
  return null
}

export function mayDoWorkOn(world: WorkWorld, worker: Worker, targetId: string): WorkVerdict {
  const me = worker.employeeId

  if (me === targetId) {
    // The owner's own items are recorded directly; everybody else's go up.
    return world.ownerId === targetId ? { allowed: true } : { allowed: false, own: true, askId: nearestAbove(world, targetId) }
  }

  // An ordinary employee's item, as before: anybody holding the right.
  if (!world.doesWork(targetId) && !world.isSuperAdmin(targetId)) return { allowed: true }

  // Somebody who does this work themselves: the people above them —
  if (me && world.tree.chain(targetId).includes(me)) return { allowed: true }
  // — and in the end the Super Admin, unless that would be a junior doing a
  // senior's work. The owner, with nobody above, does their own.
  if (worker.isSuperAdmin && targetId !== world.ownerId && !(me && world.tree.chain(me).includes(targetId))) {
    return { allowed: true }
  }
  return { allowed: false, own: false, askId: targetId === world.ownerId ? targetId : nearestAbove(world, targetId) }
}
