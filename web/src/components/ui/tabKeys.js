/**
 * The keys a row of tabs answers to, as the WAI-ARIA tabs pattern has them:
 * ← and → move to the previous and next tab (round the ends), Home and End to
 * the first and last. The tab moved to is chosen and takes the focus; only the
 * chosen tab is in the Tab order (each tab button carries `data-tab-key` and
 * tabIndex 0 when chosen, -1 otherwise), so Tab leaves the row for what it shows.
 *
 * `keys` are the tabs in order, `current` the chosen one, `choose` sets it.
 */
export function onTabKeyDown(event, keys, current, choose) {
  // Alt+← is the browser's Back, Ctrl/⌘ with an arrow the page's own: not ours.
  if (keys.length === 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
  // From the tab that has the focus: a choice that changes the address shows
  // a moment later, and a held key must not stick on the tab it started from.
  const focused = event.target?.closest?.('[data-tab-key]')?.dataset.tabKey
  const from = focused !== undefined ? keys.find((k) => String(k) === focused) ?? current : current
  const index = keys.indexOf(from)
  let next
  switch (event.key) {
    case 'ArrowRight':
      next = keys[(index + 1) % keys.length]
      break
    case 'ArrowLeft':
      next = keys[index <= 0 ? keys.length - 1 : index - 1]
      break
    case 'Home':
      next = keys[0]
      break
    case 'End':
      next = keys[keys.length - 1]
      break
    default:
      return
  }
  event.preventDefault()
  if (next !== from) choose(next)
  // The button is already there, out of the Tab order: focusing it moves the reader with the choice.
  const button = [...event.currentTarget.querySelectorAll('[data-tab-key]')].find((b) => b.dataset.tabKey === String(next))
  button?.focus()
}

/** The ids that tie a tab to the panel it shows: `panelId` names the panel, each tab `${panelId}-tab-${key}`. */
export const tabIdOf = (panelId, key) => `${panelId}-tab-${key}`
