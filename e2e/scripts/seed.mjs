// Runs one browser-test seed against the local test database, by hand:
//
//   node scripts/seed.mjs day20 seed             → e2e/.work/day20-fixture.json
//   node scripts/seed.mjs day18 seed review      → e2e/.work/day18-review-fixture.json
//   node scripts/seed.mjs day20 cleanup <stamp>
//
// The runner (run.mjs) does this itself before each suite.
import { seed } from '../lib/stack.mjs'

const [name, mode, arg] = process.argv.slice(2)
if (!name || !['seed', 'cleanup'].includes(mode ?? '')) {
  console.error('Usage: node scripts/seed.mjs <day18|day19|day20> <seed|cleanup> [variant|stamp]')
  process.exit(1)
}
seed(name, mode, arg)
