// The isolated stack, left running until Ctrl+C — to look at a seeded company
// in a browser by hand, or to run one suite on its own:
//
//   node scripts/up.mjs                     API (real time) + web on ems_e2e
//   node scripts/up.mjs --now 2026-09-30T13:00:00+05:30
//
// http://localhost:5183 — the API behind it on :4100. Never :4000/:5173.
import { BASE, DB } from '../lib/env.mjs'
import { migrate, startApi, startWeb, stop } from '../lib/stack.mjs'

const at = process.argv.indexOf('--now')
const fakeNow = at > 0 ? process.argv[at + 1] : null
if (at > 0 && !fakeNow) throw new Error('--now needs a time, e.g. 2026-09-30T13:00:00+05:30')

migrate()
const api = await startApi({ fakeNow })
const web = await startWeb().catch(async (err) => {
  // Not left holding :4100 when the web app cannot start.
  await stop(api)
  throw err
})
console.log(`\n  ${BASE}  (database ${DB}${fakeNow ? `, the API's clock at ${fakeNow}` : ''})\n  Ctrl+C stops both.\n`)

process.on('SIGINT', async () => {
  await stop(web)
  await stop(api)
  process.exit(0)
})
