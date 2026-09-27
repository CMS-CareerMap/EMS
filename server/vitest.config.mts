import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Neon's free tier suspends its compute when idle, so the first query after
    // a pause has to wait for it to wake — routinely 5-10 seconds. The defaults
    // (5s test, 10s hook) fail on that alone, which looks like a broken test
    // rather than a sleeping database.
    // The suite runs against local Postgres (see .env.test), where a query is
    // one or two milliseconds. These are therefore generous already — the only
    // thing that takes real time is the very first connection.
    testTimeout: 20_000,
    hookTimeout: 30_000,

    // Refuses to run against a remote database. The tests delete rows.
    setupFiles: ['./vitest.setup.ts'],

    // Integration tests share one database. Running files in parallel would let
    // one file's cleanup delete another's fixtures mid-run.
    fileParallelism: false,

    // Files the suite writes — payslip PDFs — go to a scratch folder, not into
    // the developer's own uploads/.
    env: { STORAGE_PATH: join(tmpdir(), 'ems-test-uploads') },
  },
})
