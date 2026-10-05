// A stand-in for the production web container on :5183: serves web/dist with
// the headers read from deploy/web/security-headers.caddy (so what is tested is
// what is deployed), real 404s for missing assets, the SPA fallback, and /api
// proxied to :4100 with X-Forwarded-For — as deploy/web/Caddyfile does.
//
// Never rebuild web/dist while this is serving: it reads files on every
// request, and a build deletes the old ones from under it.
import http from 'node:http'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join, extname, normalize } from 'node:path'
import { API_PORT, REPO, WEB, WEB_PORT } from '../lib/env.mjs'

const DIST = join(WEB, 'dist').replace(/\\/g, '/')
const API = { host: '127.0.0.1', port: API_PORT }

// One header per line inside the file's `header { … }` block: Name "value".
// Every other line must be blank, a comment, or the block's own braces: a form
// this cannot read (-Name, a trailing comment …) stops it, rather than letting
// the tests run with headers production would send differently.
const headers = []
for (const [i, line] of readFileSync(join(REPO, 'deploy', 'web', 'security-headers.caddy'), 'utf8').split(/\r?\n/).entries()) {
  const m = /^\s*([A-Za-z][A-Za-z-]*)\s+"([^"]*)"\s*$/.exec(line)
  if (m) headers.push([m[1], m[2]])
  else if (!/^\s*(#.*)?$/.test(line) && !/^\s*(header\s*\{|\})\s*$/.test(line)) {
    throw new Error(`web: cannot read line ${i + 1} of deploy/web/security-headers.caddy: ${line.trim()}`)
  }
}
if (headers.length === 0) throw new Error('web: no security headers found in deploy/web/security-headers.caddy')
// On plain http://localhost the upgrade directive would send every asset to
// https://localhost; in production the site is already https, where it is a no-op.
const local = Object.fromEntries(headers.map(([k, v]) => [k, k === 'Content-Security-Policy' ? v.replace(/;\s*upgrade-insecure-requests/, '') : v]))
console.log(`web: ${headers.length} security headers from deploy/web/security-headers.caddy`)

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2' }

// A 404 is cached by nobody, as deploy/web/Caddyfile says.
function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store', ...local })
  res.end('<html><body>404 Not Found</body></html>')
}

function sendFile(res, file, cache) {
  let body
  try {
    body = readFileSync(file)
  } catch {
    notFound(res)
    return
  }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': cache, ...local })
  res.end(body)
}

const isFile = (path) => {
  try {
    return existsSync(path) && statSync(path).isFile()
  } catch {
    return false
  }
}

function handle(req, res) {
  const url = new URL(req.url, 'http://x')
  if (url.pathname.startsWith('/api/')) {
    const forwarded = [req.headers['x-forwarded-for'], req.socket.remoteAddress].filter(Boolean).join(', ')
    const proxied = http.request({ ...API, method: req.method, path: req.url, headers: { ...req.headers, 'x-forwarded-for': forwarded, 'x-forwarded-proto': 'http' } }, (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers)
      up.pipe(res)
    })
    proxied.on('error', () => { res.writeHead(502, { 'Content-Type': 'text/html' }); res.end('<html><body>502 Bad Gateway</body></html>') })
    req.pipe(proxied)
    return
  }
  // A path that is not valid percent-encoding is a bad request, never a crash.
  let decoded
  try {
    decoded = decodeURIComponent(url.pathname)
  } catch {
    res.writeHead(400)
    res.end()
    return
  }
  const path = normalize(join(DIST, decoded)).replace(/\\/g, '/')
  if (path !== DIST && !path.startsWith(`${DIST}/`)) { res.writeHead(400); res.end(); return }
  // Dot-files and dot-folders (.env, .git) are a plain 404, never the app.
  if (decoded.includes('/.')) return notFound(res)
  if (url.pathname.startsWith('/assets/')) {
    if (isFile(path)) return sendFile(res, path, 'public, max-age=31536000, immutable')
    return notFound(res)
  }
  if (url.pathname !== '/' && isFile(path)) return sendFile(res, path, 'no-cache')
  sendFile(res, join(DIST, 'index.html'), 'no-cache')
}

// This machine only — both loopbacks, so "localhost" answers whichever it resolves to.
// Never the network: the demo prints its shared password.
http.createServer(handle).listen(WEB_PORT, '127.0.0.1', () => console.log(`web: http://localhost:${WEB_PORT} → web/dist, /api → :${API.port}`))
http.createServer(handle).listen(WEB_PORT, '::1').on('error', () => undefined)
