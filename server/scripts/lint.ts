import { resolve } from 'node:path'
import { checkServer, RULES } from './architecture'

/**
 *   npm run lint
 *
 * Prints every §A5 violation as file:line:column, grouped by rule, and exits 1
 * if there is any. The same check runs inside `npm test` (architecture.test.ts),
 * so a violation cannot reach main by skipping this command.
 */

const violations = checkServer(resolve(__dirname, '..'))

if (violations.length === 0) {
  console.log(`§A5: all ${Object.keys(RULES).length} rules hold.`)
  process.exit(0)
}

for (const [rule, text] of Object.entries(RULES)) {
  const hits = violations.filter((v) => v.rule === rule)
  if (hits.length === 0) continue
  console.log(`\n${rule} — ${text} (${hits.length})`)
  for (const v of hits) console.log(`  src/${v.file}:${v.line}:${v.column}  ${v.message}`)
}

console.log(`\n${violations.length} violation${violations.length === 1 ? '' : 's'} of §A5.`)
process.exit(1)
