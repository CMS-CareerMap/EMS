/**
 * The order roles come in — "HR comes under the Super Admin" — as the Super
 * Admin set it on the Roles screen (Day 21).
 *
 * The order decides who may hand out which role: only one below your own. It
 * is a tree, not a ladder, because roles are not a straight line: Accounts and
 * HR both come under the Super Admin, and neither is above the other.
 */

export interface RoleNode {
  key: string
  /** The key of the role this one comes under; null at the top. */
  parentKey: string | null
}

/**
 * Is `key` somewhere below `above` in the order?
 *
 * Walks up from `key` and stops at the top, or after as many steps as there
 * are roles — so a loop in stored data (which the Roles screen refuses to save)
 * reads as "not below" rather than hanging the request.
 */
export function isBelow(key: string, above: string, nodes: ReadonlyMap<string, RoleNode>): boolean {
  let current = nodes.get(key)?.parentKey ?? null
  for (let steps = 0; current && steps <= nodes.size; steps++) {
    if (current === above) return true
    current = nodes.get(current)?.parentKey ?? null
  }
  return false
}

/** Would making `parentKey` the role above `key` close a loop? Includes a role coming under itself. */
export function wouldLoop(key: string, parentKey: string, nodes: ReadonlyMap<string, RoleNode>): boolean {
  return parentKey === key || isBelow(parentKey, key, nodes)
}
