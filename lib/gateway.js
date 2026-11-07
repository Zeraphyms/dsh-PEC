import dgram from 'node:dgram'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { GatewayState } from './state.js'
import { Dsh } from './dsh.js'
import { ApprovalHub } from './approvals.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const WEB_DIR = path.join(here, '..', 'web')
const DISCOVERY_PORT = 55901
const DISCOVERY_MAGIC = 'CCDSH-DISCOVER-1'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

export class Gateway {
  constructor(ctx, options) {
    this.ctx = ctx
    this.options = options
    this.log = options.log
    this.state = new GatewayState(options.log)
    this.dsh = new Dsh(ctx, options.log)
    this.approvals = new ApprovalHub(ctx, options.log)
    this.server = null
    this.port = 0
    this.discovery = null
    this.streams = new Set()
  }

  async start() {
    this.server = http.createServer((req, res) => {
      this.#handle(req, res).catch((error) => {
        this.log.error('request failed:', error?.stack || error)
        if (!res.headersSent) {
          // Surface which Host capability is missing instead of a bare 500, so a
          // Harness update that renamed something is immediately obvious.
          sendJson(res, 503, {
            error: 'internal',
            message: String(error?.message || error),
            missing: this.dsh.health(this.port).missing,
          })
        } else {
          res.end()
        }
      })
    })
    this.server.on('clientError', (_error, socket) => {
      try {
        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
      } catch {
        /* ignore */
      }
    })

    this.port = await this.#listen(this.options.port)
    this.#injectOrigin()
    this.approvals.onChange((pending) => this.#broadcast('approvals', pending))
    if (this.options.discovery) this.#startDiscovery()

    const urls = this.urls()
    this.log.info(`phone gateway ready on ${urls.map((u) => u.url).join('  ')}`)
    if (this.options.autoPair) {
      const code = this.state.pairCode()
      this.log.info(`pairing code: ${code.value} (valid ${Math.round((code.expiresAt - Date.now()) / 60000)} min)`)
    }
  }

  async stop() {
    for (const close of this.streams) {
      try {
        close()
      } catch {
        /* ignore */
      }
    }
    this.streams.clear()
    try {
      this.disposeIndex?.()
    } catch {
      /* ignore */
    }
    this.disposeIndex = null
    // A PTY is a child process: never leave one behind when the plugin unloads.
    try {
      for (const id of [...this.dsh.ptys.keys()]) await this.dsh.ptyKill(id)
    } catch {
      /* ignore */
    }
    this.approvals.dispose()
    if (this.discovery) {
      try {
        this.discovery.close()
      } catch {
        /* ignore */
      }
      this.discovery = null
    }
    if (this.server) {
      await new Promise((resolve) => this.server.close(() => resolve()))
      this.server = null
    }
  }

  #listen(port) {
    return new Promise((resolve, reject) => {
      const server = this.server
      const onError = (error) => {
        server.removeListener('listening', onListening)
        if (error.code === 'EADDRINUSE' && port !== 0) {
          this.log.warn(`port ${port} is busy, using an ephemeral port`)
          this.#listen(0).then(resolve, reject)
          return
        }
        reject(error)
      }
      const onListening = () => {
        server.removeListener('error', onError)
        server.on('error', (error) => this.log.error('server error:', error?.message || error))
        const bound = server.address().port
        this.port = bound
        // One compatibility line per start: after a Harness update this is the
        // fastest way to see whether something the plugin needs disappeared.
        try {
          const health = this.dsh.health(bound)
          if (health.ok) {
            const off = Object.entries(health.optional).filter(([, on]) => !on).map(([name]) => name)
            this.log.info(`capabilities ok; optional unavailable: ${off.length ? off.join(', ') : 'none'}`)
          } else {
            this.log.warn(`missing Host capabilities: ${health.missing.join(', ')} — affected features are disabled`)
          }
        } catch (error) {
          this.log.warn('capability probe failed:', error?.message || error)
        }
        resolve(bound)
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, this.options.host)
    })
  }

  urls() {
    const result = [{ kind: 'lan', label: '局域网', url: `http://127.0.0.1:${this.port}` }]
    const interfaces = os.networkInterfaces()
    const tailscale = []
    const lan = []
    for (const [name, addresses] of Object.entries(interfaces)) {
      for (const address of addresses || []) {
        if (address.family !== 'IPv4' || address.internal) continue
        const entry = { kind: 'lan', label: name, url: `http://${address.address}:${this.port}` }
        if (address.address.startsWith('100.')) tailscale.push({ ...entry, kind: 'tailscale', label: 'Tailscale' })
        else lan.push(entry)
      }
    }
    result.push(...lan, ...tailscale)
    return result
  }

  // The Settings panel runs on the Harness page origin, which differs from the
  // gateway port, so publish the gateway origin to the page.
  #injectOrigin() {
    try {
      const webServer = this.ctx.get('webServer')
      if (!webServer || typeof webServer.tapIndex !== 'function') return
      const origin = `http://127.0.0.1:${this.port}`
      const script = `<script>window.__CCDSH__=${JSON.stringify({ origin })}</script>`
      this.disposeIndex = webServer.tapIndex((html) =>
        html.includes('</head>') ? html.replace('</head>', `${script}</head>`) : `${html}${script}`,
      )
      this.log.info(`page origin injected: ${origin}`)
    } catch (error) {
      this.log.warn('cannot inject page origin:', error?.message || error)
    }
  }

  #startDiscovery() {
    try {
      const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
      socket.on('error', (error) => this.log.warn('discovery socket error:', error?.message || error))
      socket.on('message', (message, rinfo) => {
        if (!message.subarray(0, DISCOVERY_MAGIC.length).equals(Buffer.from(DISCOVERY_MAGIC))) return
        const reply = Buffer.from(
          JSON.stringify({
            magic: DISCOVERY_MAGIC,
            serverId: this.state.serverId,
            name: this.state.name,
            port: this.port,
            scheme: 'http',
          }),
        )
        socket.send(reply, rinfo.port, rinfo.address, () => {})
      })
      socket.bind(DISCOVERY_PORT, () => {
        try {
          socket.setBroadcast(true)
        } catch {
          /* ignore */
        }
      })
      this.discovery = socket
    } catch (error) {
      this.log.warn('discovery unavailable:', error?.message || error)
    }
  }

  #broadcast(event, data) {
    for (const stream of this.streams) stream.send(event, data)
  }

  #owner(req) {
    const address = req.socket.remoteAddress || ''
    return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
  }

  #authenticate(req, url) {
    const header = req.headers.authorization || ''
    const bearer = header.startsWith('Bearer ') ? header.slice(7) : ''
    const token = bearer || url.searchParams.get('token') || cookie(req, 'ccdsh_token') || ''
    const device = this.state.authenticate(token)
    return device || null
  }

  /** One line per minute at most, so a future disconnect is diagnosable. */
  #noteAuthFailure(req, url) {
    const now = Date.now()
    if (now - (this.lastAuthWarning || 0) < 60_000) return
    this.lastAuthWarning = now
    const header = req.headers.authorization || ''
    const bearer = header.startsWith('Bearer ') ? header.slice(7) : ''
    const token = bearer || url.searchParams.get('token') || cookie(req, 'ccdsh_token') || ''
    this.log.warn(
      `unauthorized ${req.method} ${url.pathname} from ${req.socket.remoteAddress} ` +
        `(token ${token ? `${token.slice(0, 6)}…` : 'none'}, devices ${this.state.devices().length})`,
    )
  }

  /** Raw terminal bytes as SSE; each event carries its absolute byte offset. */
  #termStream(req, res, sessionId, url) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      connection: 'keep-alive',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
    })
    res.write(': terminal\n\n')

    const send = (event, data) => {
      if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }

    let subscription
    try {
      subscription = this.dsh.termSubscribe(sessionId, Number(url.searchParams.get('from')) || 0, (offset, data) => {
        send('data', { offset, data: Buffer.from(data).toString('base64') })
      })
    } catch (error) {
      send('error', { message: String(error?.message || error) })
      res.end()
      return
    }
    send('ready', { mode: subscription.mode, shell: subscription.shell, cursor: subscription.cursor })

    const keepalive = setInterval(() => {
      if (!res.writableEnded) res.write(': keepalive\n\n')
    }, 20_000)
    const watcher = setInterval(() => {
      const status = this.dsh.ptyStatus(sessionId)
      if (!status.running) {
        send('exit', { exitCode: null })
        cleanup()
      }
    }, 1000)

    const cleanup = () => {
      clearInterval(keepalive)
      clearInterval(watcher)
      try {
        subscription.dispose()
      } catch {
        /* ignore */
      }
      if (!res.writableEnded) res.end()
    }

    req.on('close', cleanup)
  }

  async #handle(req, res) {
    const url = new URL(req.url || '/', 'http://localhost')
    const pathname = decodeURIComponent(url.pathname)
    res.setHeader('cache-control', 'no-store')
    if (pathname.startsWith('/api/')) res.setHeader('access-control-allow-origin', '*')

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'authorization, content-type',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-max-age': '600',
      })
      res.end()
      return
    }

    // ---- public surface -------------------------------------------------
    if (pathname === '/' || pathname === '/index.html') return this.#static(res, 'index.html')
    if (pathname === '/app.js') return this.#static(res, 'app.js')
    if (pathname === '/style.css') return this.#static(res, 'style.css')
    if (pathname === '/icon.svg') return this.#static(res, 'icon.svg')
    if (pathname === '/manifest.webmanifest') return this.#static(res, 'manifest.webmanifest')
    if (pathname.startsWith('/vendor/')) return this.#static(res, pathname.slice(1))
    if (pathname === '/api/ping') return sendJson(res, 200, { ok: true, server: { id: this.state.serverId, name: this.state.name } })
    if (pathname === '/api/health') return sendJson(res, 200, this.dsh.health(this.port))

    if (pathname === '/api/pair' && req.method === 'POST') {
      const body = await readJson(req)
      const result = this.state.pair(body.code, body.name, {
        // First pairing from a private network (home Wi-Fi / Tailscale) needs no
        // code: there is nothing to protect yet and the phone just found this PC.
        allowFirstPair: this.options.allowFirstPair !== false && isPrivateAddress(req.socket.remoteAddress),
        platform: body.platform || '',
        userAgent: body.userAgent || req.headers['user-agent'] || '',
      })
      if (!result.ok) return sendJson(res, 401, { error: result.reason })
      this.log.info(`paired new device: ${result.deviceName}`)
      return sendJson(res, 200, {
        token: result.token,
        deviceId: result.deviceId,
        deviceName: result.deviceName,
        server: { id: this.state.serverId, name: this.state.name },
      })
    }

    // ---- everything below needs a device token or loopback --------------
    const owner = this.#owner(req)
    const device = owner ? null : this.#authenticate(req, url)
    if (!owner && !device) {
      this.#noteAuthFailure(req, url)
      return sendJson(res, 401, { error: 'unauthorized' })
    }

    if (pathname === '/api/desktop-url') {
      if (!owner) return sendJson(res, 403, { error: 'owner-only' })
      const webApp = this.ctx.get('webApp')
      const connection = this.ctx.get('connection')
      let base = null
      try {
        base = webApp?.getAdvertisedUrl?.() || null
      } catch {
        base = null
      }
      let authenticated = base
      try {
        if (base && connection?.authenticatedUrl) authenticated = connection.authenticatedUrl(base)
      } catch {
        authenticated = base
      }
      return sendJson(res, 200, { base, url: authenticated })
    }

    if (pathname === '/api/server') {
      return sendJson(res, 200, {
        id: this.state.serverId,
        name: this.state.name,
        urls: this.urls(),
        loopback: owner,
        devices: this.state.devices(),
        pairing: owner ? this.state.pairCode() : null,
        approvals: this.approvals.snapshot(),
      })
    }

    if (pathname === '/api/pairing/rotate' && req.method === 'POST') {
      if (!owner) return sendJson(res, 403, { error: 'owner-only' })
      return sendJson(res, 200, this.state.rotateCode())
    }

    if (pathname === '/api/devices/revoke' && req.method === 'POST') {
      if (!owner) return sendJson(res, 403, { error: 'owner-only' })
      const body = await readJson(req)
      return sendJson(res, 200, { revoked: this.state.revoke(body.id), devices: this.state.devices() })
    }

    if (pathname === '/api/devices/rename' && req.method === 'POST') {
      if (!owner) return sendJson(res, 403, { error: 'owner-only' })
      const body = await readJson(req)
      return sendJson(res, 200, { renamed: this.state.rename(body.id, body.name), devices: this.state.devices() })
    }

    if (pathname === '/api/debug/state') {
      if (!owner) return sendJson(res, 403, { error: 'owner-only' })
      return sendJson(res, 200, this.state.snapshot())
    }

    if (pathname === '/api/debug/services') {
      if (!owner) return sendJson(res, 403, { error: 'owner-only' })
      const names = ['llm', 'terminals', 'terminalController', 'settings', 'settingsController', 'configEditor', 'fs', 'workingDirectory', 'agents', 'sessions', 'shell', 'subprocess', 'jobs', 'tools', 'commands', 'ptcRuntime', 'sandbox', 'bash', 'pwsh']
      const present = names.filter((name) => Boolean(this.ctx.get(name)))
      let settingsSample = null
      try {
        const rows = this.ctx.get('settings')?.describe?.({ redactSecrets: true }) || []
        settingsSample = {
          count: rows.length,
          first: rows[0] ? { ns: rows[0].ns, revision: rows[0].revision, schema: rows[0].schema, value: rows[0].value } : null,
        }
      } catch (error) {
        settingsSample = { error: String(error?.message || error) }
      }
      let terminalInfo = null
      try {
        const terminals = this.ctx.get('terminals')
        terminalInfo = terminals ? { backends: terminals.listBackends?.() ?? null, keys: Object.getOwnPropertyNames(Object.getPrototypeOf(terminals)) } : null
      } catch (error) {
        terminalInfo = { error: String(error?.message || error) }
      }
      return sendJson(res, 200, { present, settingsSample, terminalInfo })
    }

    if (pathname === '/api/bootstrap') return this.#bootstrap(res)

    // ---- workspace files ------------------------------------------------
    if (pathname === '/api/files' && req.method === 'GET') {
      return sendJson(res, 200, await this.dsh.listFiles(url.searchParams.get('session') || '', url.searchParams.get('path') || ''))
    }
    if (pathname === '/api/files/read' && req.method === 'GET') {
      return sendJson(res, 200, await this.dsh.readFile(url.searchParams.get('session') || '', url.searchParams.get('path') || ''))
    }

    // ---- command runs (portable "terminal") -----------------------------
    if (pathname === '/api/runs' && req.method === 'GET') {
      return sendJson(res, 200, this.dsh.listRuns(url.searchParams.get('session') || ''))
    }
    if (pathname === '/api/runs' && req.method === 'POST') {
      const body = await readJson(req)
      return sendJson(res, 200, await this.dsh.runCommand(body.session, body.command))
    }
    const runMatch = pathname.match(/^\/api\/runs\/([^/]+)(?:\/(kill))?$/)
    if (runMatch) {
      const id = decodeURIComponent(runMatch[1])
      if (runMatch[2] === 'kill' && req.method === 'POST') {
        return sendJson(res, 200, await this.dsh.killRun(id))
      }
      return sendJson(res, 200, this.dsh.readRun(id, url.searchParams.get('cursor') || 0))
    }

    // ---- raw terminal transport (xterm.js on the phone) ------------------
    if (pathname === '/api/term/open' && req.method === 'POST') {
      const body = await readJson(req)
      return sendJson(res, 200, await this.dsh.ptyOpen(body.session, body))
    }
    const termMatch = pathname.match(/^\/api\/term\/([^/]+)\/(stream|input|resize|close)$/)
    if (termMatch) {
      const sessionId = decodeURIComponent(termMatch[1])
      const action = termMatch[2]
      if (action === 'stream') return this.#termStream(req, res, sessionId, url)
      const body = await readJson(req)
      if (action === 'input') return sendJson(res, 200, await this.dsh.termWrite(sessionId, body.data))
      if (action === 'resize') return sendJson(res, 200, await this.dsh.ptyResize(sessionId, body.cols, body.rows))
      if (action === 'close') return sendJson(res, 200, await this.dsh.ptyKill(sessionId))
    }

    // ---- real PTY -------------------------------------------------------
    if (pathname === '/api/pty' && req.method === 'POST') {
      const body = await readJson(req)
      return sendJson(res, 200, await this.dsh.ptyOpen(body.session, body))
    }
    if (pathname === '/api/pty' && req.method === 'GET') {
      return sendJson(res, 200, this.dsh.ptyStatus(url.searchParams.get('session') || ''))
    }
    const ptyMatch = pathname.match(/^\/api\/pty\/([^/]+)(?:\/(input|resize|kill))?$/)
    if (ptyMatch) {
      const sessionId = decodeURIComponent(ptyMatch[1])
      const action = ptyMatch[2] || ''
      if (!action) return sendJson(res, 200, this.dsh.ptyRead(sessionId, url.searchParams.get('cursor') || 0))
      const body = await readJson(req)
      if (action === 'input') return sendJson(res, 200, await this.dsh.ptyInput(sessionId, body.text))
      if (action === 'resize') return sendJson(res, 200, await this.dsh.ptyResize(sessionId, body.cols, body.rows))
      if (action === 'kill') return sendJson(res, 200, await this.dsh.ptyKill(sessionId))
    }

    // ---- goal + schedules ----------------------------------------------
    if (pathname === '/api/goal' && req.method === 'GET') {
      return sendJson(res, 200, await this.dsh.goal(url.searchParams.get('session') || ''))
    }
    const goalMatch = pathname.match(/^\/api\/goal\/(pause|resume|complete|clear)$/)
    if (goalMatch && req.method === 'POST') {
      const body = await readJson(req)
      return sendJson(res, 200, await this.dsh.goalAction(body.session, goalMatch[1]))
    }
    if (pathname === '/api/schedules' && req.method === 'GET') {
      return sendJson(res, 200, await this.dsh.schedules())
    }
    if (pathname === '/api/schedules' && req.method === 'POST') {
      const body = await readJson(req)
      return sendJson(res, 200, await this.dsh.createSchedule(body.session, body))
    }
    if (pathname === '/api/schedules/delete' && req.method === 'POST') {
      const body = await readJson(req)
      return sendJson(res, 200, await this.dsh.deleteSchedule(body.session, body.id))
    }

    // ---- providers (Settings → Models → add provider) -------------------
    if (pathname === '/api/providers' && req.method === 'GET') {
      return sendJson(res, 200, await this.dsh.providers())
    }
    if (pathname === '/api/providers' && req.method === 'POST') {
      const body = await readJson(req)
      return sendJson(res, 200, await this.dsh.addProvider(body))
    }
    if (pathname === '/api/providers/delete' && req.method === 'POST') {
      const body = await readJson(req)
      return sendJson(res, 200, await this.dsh.removeProvider(body.route))
    }
    if (pathname === '/api/providers/key' && req.method === 'POST') {
      const body = await readJson(req)
      return sendJson(res, 200, await this.dsh.setProviderKey(body.route, body.apiKey))
    }
    if (pathname === '/api/providers/update' && req.method === 'POST') {
      const body = await readJson(req)
      return sendJson(res, 200, await this.dsh.updateProvider(body))
    }
    if (pathname === '/api/providers/discover' && req.method === 'POST') {
      const body = await readJson(req)
      return sendJson(res, 200, await this.dsh.discoverModels(body))
    }

    // ---- settings -------------------------------------------------------
    if (pathname === '/api/settings' && req.method === 'GET') {
      return sendJson(res, 200, await this.dsh.settings())
    }
    const settingsMatch = pathname.match(/^\/api\/settings\/(.+)$/)
    if (settingsMatch && req.method === 'POST') {
      const body = await readJson(req)
      return sendJson(res, 200, await this.dsh.updateSettings(decodeURIComponent(settingsMatch[1]), body.patch || {}, body.revision))
    }

    if (pathname === '/api/sessions' && req.method === 'GET') {
      // Metadata only (no rows): the archived set lets the phone mirror the
      // desktop's hidden-archive behaviour between full bootstraps.
      return sendJson(res, 200, { archivedSessionIds: await this.dsh.archivedIds() })
    }

    if (pathname === '/api/sessions' && req.method === 'POST') {
      const body = await readJson(req)
      return sendJson(res, 200, await this.dsh.createSession(body))
    }

    const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)(?:\/([a-z]+))?$/)
    if (sessionMatch) {
      const sessionId = sessionMatch[1]
      const action = sessionMatch[2] || ''
      if (!action && req.method === 'GET') return sendJson(res, 200, await this.dsh.sessionPage(sessionId, url))
      if (action === 'prompt') {
        const body = await readJson(req)
        return sendJson(res, 200, await this.dsh.prompt(sessionId, body))
      }
      if (action === 'cancel') return sendJson(res, 200, await this.dsh.cancel(sessionId))
      if (action === 'rename') {
        const body = await readJson(req)
        return sendJson(res, 200, await this.dsh.rename(sessionId, body.title))
      }
      if (action === 'model') {
        if (req.method === 'GET') {
          // Authoritative current selection for the phone header; cold summaries
          // carry no projection, so the UI would otherwise fall back to the
          // global default and show a stale model.
          return sendJson(res, 200, { selection: await this.dsh.modelSelection(sessionId) })
        }
        const body = await readJson(req)
        return sendJson(res, 200, await this.dsh.selectModel(sessionId, body))
      }
      if (action === 'history' && req.method === 'GET') {
        // Backwards pagination for "load earlier": the phone passes the opening
        // cursor plus the seq its window starts at.
        return sendJson(res, 200, await this.dsh.older(sessionId, {
          through: url.searchParams.get('through'),
          before: url.searchParams.get('before'),
          limit: url.searchParams.get('limit'),
        }))
      }
      if (action === 'preset') {
        const body = await readJson(req)
        return sendJson(res, 200, await this.dsh.selectPreset(sessionId, body.preset))
      }
      if (action === 'permission') {
        const body = await readJson(req)
        return sendJson(res, 200, await this.dsh.setPermission(sessionId, body.preset))
      }
      if (action === 'archive') {
        return sendJson(res, 200, await this.dsh.archiveSession(sessionId))
      }
      if (action === 'stream') return this.#stream(req, res, sessionId, url)
    }

    if (pathname === '/api/plugins' && req.method === 'GET') {
      return sendJson(res, 200, { items: await this.dsh.plugins() })
    }
    const pluginToggle = pathname.match(/^\/api\/plugins\/(.+)\/toggle$/)
    if (pluginToggle && req.method === 'POST') {
      const body = await readJson(req)
      return sendJson(res, 200, await this.dsh.setPlugin(decodeURIComponent(pluginToggle[1]), body.enabled))
    }
    if (pathname === '/api/permissions' && req.method === 'GET') {
      return sendJson(res, 200, await this.dsh.permissionCatalog())
    }

    if (pathname === '/api/approvals/arm' && req.method === 'POST') {      const body = await readJson(req)
      return sendJson(res, 200, this.approvals.arm(Number(body.minutes) || 10, Boolean(body.force)))
    }
    if (pathname === '/api/approvals') return sendJson(res, 200, this.approvals.snapshot())
    const approvalMatch = pathname.match(/^\/api\/approvals\/([^/]+)$/)
    if (approvalMatch && req.method === 'POST') {
      const body = await readJson(req)
      return sendJson(res, 200, { answered: this.approvals.answer(approvalMatch[1], body.decision) })
    }
    const questionMatch = pathname.match(/^\/api\/questions\/([^/]+)$/)
    if (questionMatch && req.method === 'POST') {
      const body = await readJson(req)
      return sendJson(res, 200, { answered: this.approvals.answerQuestion(questionMatch[1], body) })
    }

    return sendJson(res, 404, { error: 'not-found', path: pathname })
  }

  async #bootstrap(res) {
    const [sessions, models, presets, workspaces, permissions, plugins] = await Promise.all([
      this.dsh.listSessions().catch((e) => ({ error: String(e?.message || e) })),
      this.dsh.models().catch((e) => ({ error: String(e?.message || e) })),
      this.dsh.presets().catch((e) => ({ error: String(e?.message || e) })),
      this.dsh.workspaces().catch(() => []),
      this.dsh.permissionCatalog().catch(() => ({ options: [] })),
      this.dsh.plugins().catch(() => []),
    ])
    sendJson(res, 200, {
      server: { id: this.state.serverId, name: this.state.name, urls: this.urls() },
      sessions,
      models,
      presets,
      workspaces,
      permissions,
      plugins,
      approvals: this.approvals.snapshot(),
    })  }

  #static(res, file) {
    const target = path.join(WEB_DIR, file)
    if (!target.startsWith(WEB_DIR)) return sendJson(res, 403, { error: 'forbidden' })
    fs.readFile(target, (error, data) => {
      if (error) return sendJson(res, 404, { error: 'not-found' })
      res.writeHead(200, { 'content-type': MIME[path.extname(target)] || 'application/octet-stream' })
      res.end(data)
    })
  }

  #stream(req, res, sessionId, url) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      connection: 'keep-alive',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
    })
    res.write(': connected\n\n')

    const send = (event, data) => {
      if (res.writableEnded) return
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }
    send('hello', { sessionId, from: url.searchParams.get('from') || null })

    const stream = { send }
    this.streams.add(stream)

    const from = Number(url.searchParams.get('from'))
    const abort = new AbortController()
    const keepalive = setInterval(() => {
      if (!res.writableEnded) res.write(': keepalive\n\n')
    }, 20_000)

    ;(async () => {
      try {
        for await (const frame of this.dsh.follow(sessionId, Number.isFinite(from) ? from : undefined, abort.signal)) {
          send('frame', frame)
        }
        send('end', {})
      } catch (error) {
        if (!abort.signal.aborted) send('error', { message: String(error?.message || error) })
      } finally {
        clearInterval(keepalive)
        this.streams.delete(stream)
        if (!res.writableEnded) res.end()
      }
    })()

    req.on('close', () => {
      abort.abort()
      clearInterval(keepalive)
      this.streams.delete(stream)
    })
  }
}

function sendJson(res, status, payload) {
  if (res.writableEnded) return
  const body = JSON.stringify(payload === undefined ? { ok: true } : payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

function isPrivateAddress(address) {
  if (!address) return false
  const value = String(address).replace('::ffff:', '')
  if (value === '::1' || value.startsWith('127.')) return true
  const parts = value.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) return false
  const [a, b] = parts
  if (a === 10) return true
  if (a === 192 && b === 168) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 100 && b >= 64 && b <= 127) return true // Tailscale CGNAT range
  return false
}

function cookie(req, name) {  const header = req.headers.cookie || ''
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return decodeURIComponent(rest.join('='))
  }
  return ''
}

function readJson(req) {
  return new Promise((resolve) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 2_000_000) req.destroy()
    })
    req.on('end', () => {
      if (!body) return resolve({})
      try {
        resolve(JSON.parse(body))
      } catch {
        resolve({})
      }
    })
    req.on('error', () => resolve({}))
  })
}
