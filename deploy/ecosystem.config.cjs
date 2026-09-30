/**
 * PM2 — keeps the API running, restarts it if it dies, and starts it on boot.
 *
 *   cd /srv/ems && pm2 start deploy/ecosystem.config.cjs
 *   pm2 save && pm2 startup        (once: survive a reboot)
 *   pm2 stop ems-api / pm2 start ems-api   (around an update — DEPLOY.md, "Updating")
 *
 * ONE process, on purpose. The sign-in rate limits are counted in the
 * process's memory; four processes would each count separately and allow
 * four times the attempts. A company of this size does not need more.
 */
module.exports = {
  apps: [
    {
      name: 'ems-api',
      cwd: '/srv/ems/server',
      script: 'dist/src/main.js',
      exec_mode: 'fork',
      instances: 1,
      env: {
        NODE_ENV: 'production',
      },
      // The API finishes the requests in flight before it exits (shutdown.ts);
      // give it the time to.
      kill_timeout: 15000,
      max_memory_restart: '512M',
      // Each log line already carries its time (the logger writes JSON).
      time: false,
      merge_logs: true,
    },
  ],
}
