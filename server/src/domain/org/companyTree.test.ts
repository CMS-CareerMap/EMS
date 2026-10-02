import { describe, it, expect } from 'vitest'
import { buildTree, type TreePerson } from './companyTree'

// owner ─ sales head ─ team lead ─ agent
//       └ hr
// gone (left) ─ orphan
const people: TreePerson[] = [
  { id: 'owner', managerId: null, left: false },
  { id: 'head', managerId: 'owner', left: false },
  { id: 'lead', managerId: 'head', left: false },
  { id: 'agent', managerId: 'lead', left: false },
  { id: 'hr', managerId: 'owner', left: false },
  { id: 'gone', managerId: 'head', left: true },
  { id: 'orphan', managerId: 'gone', left: false },
  { id: 'loose', managerId: null, left: false },
]
const tree = buildTree(people)

describe('the company tree', () => {
  it('walks up and down the reporting lines in effect', () => {
    expect(tree.managerOf('agent')).toBe('lead')
    expect(tree.chain('agent')).toEqual(['lead', 'head', 'owner'])
    expect(tree.below('head').sort()).toEqual(['agent', 'gone', 'lead'])
    expect(tree.below('owner').sort()).toEqual(['agent', 'gone', 'head', 'hr', 'lead'])
  })

  it('treats a manager who has left as nobody above, while the recorded line still hides the seniors', () => {
    expect(tree.managerOf('orphan')).toBeNull()
    expect(tree.chain('orphan')).toEqual([])
    // As recorded, through the person who left: the head and the owner are still seniors.
    expect(tree.above('orphan')).toEqual(['gone', 'head', 'owner'])
    // Nobody leads the orphan in effect, so they are under nobody.
    expect(tree.below('head')).not.toContain('orphan')
  })

  it('lists who has nobody above them, with the manager who left', () => {
    expect(tree.unplaced()).toEqual([
      { id: 'owner', managerWhoLeft: null },
      { id: 'orphan', managerWhoLeft: 'gone' },
      { id: 'loose', managerWhoLeft: null },
    ])
  })

  it('refuses a reporting line that would loop, through people who left too', () => {
    expect(tree.wouldLoop('head', 'agent')).toBe(true)
    expect(tree.wouldLoop('head', 'head')).toBe(true)
    expect(tree.wouldLoop('head', 'orphan')).toBe(true)
    expect(tree.wouldLoop('agent', 'hr')).toBe(false)
  })

  it('ends a walk over rows that already loop instead of hanging', () => {
    const looped = buildTree([
      { id: 'a', managerId: 'b', left: false },
      { id: 'b', managerId: 'a', left: false },
    ])
    expect(looped.chain('a')).toEqual(['b'])
    expect(looped.below('a')).toEqual(['b'])
    expect(looped.above('a')).toEqual(['b'])
  })
})
