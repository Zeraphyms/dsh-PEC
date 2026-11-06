import crypto from 'node:crypto'

/**
 * Remote approvals.
 *
 * `approval/request` is a Cordis waterfall: the first listener that returns an
 * outcome wins, and the terminal fallback is `'unavailable'`. The shipped web
 * client answers it through the page dialog. We therefore stay completely
 * transparent until the user explicitly arms phone approval: only then do we
 * claim a request, broadcast it to connected phones and wait for an answer,
 * always falling through to `next()` on timeout or disarm.
 */
export class ApprovalHub {
  constructor(ctx, log) {
    this.ctx = ctx
    this.log = log
    this.pending = new Map()
    this.armedUntil = 0
    this.forced = false
    this.disposed = false
    this.watchers = new Set()
    this.timers = new Set()
    this.windowMs = 150_000
    this.offApproval = null

    // Registered first so a request can be claimed before the desktop page's
    // forwarder sees it; re-registered on every arm to stay in front of
    // forwarders that pages add when they (re)connect.
    this.#register()
  }

  #register() {
    if (this.offApproval) return
    this.offApproval = this.ctx.on(
      'approval/request',
      async (request, next) => {
        if (this.disposed || !this.isArmed()) return next()
        // Safe mode: when a desktop page is attached and can answer, let it.
        // Claiming there would leave its dialog stranded, because answering on
        // the phone never settles the page's pending request.
        if (!this.forced && this.desktopAttached()) return next()
        return this.#ask(request, next)
      },
      { prepend: true },
    )
  }

  #unregister() {
    try {
      this.offApproval?.()
    } catch {
      /* ignore */
    }
    this.offApproval = null
  }

  /** Whether a browser page that can answer is attached right now. */
  desktopAttached() {
    try {
      return Boolean(this.ctx.get('typertGateway')?.hasLiveClient?.())
    } catch {
      return false
    }
  }

  dispose() {
    this.disposed = true
    this.#unregister()
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    this.reset()
  }

  isArmed() {
    return this.armedUntil > Date.now()
  }

  arm(minutes, force = false) {
    const ms = Math.max(0, Number(minutes) || 0) * 60_000
    this.armedUntil = ms ? Date.now() + ms : 0
    this.forced = Boolean(force) && ms > 0
    if (!ms) this.reset()
    // Put our listener back at the head of the waterfall for this window.
    this.#unregister()
    if (ms) this.#register()
    this.#changed()
    return this.snapshot()
  }

  reset() {
    this.forced = false
    for (const [id, entry] of this.pending) {
      entry.resolve?.(null)
      this.pending.delete(id)
    }
  }

  snapshot() {
    return {
      armedUntil: this.armedUntil,
      armed: this.isArmed(),
      forced: this.forced,
      desktopAttached: this.desktopAttached(),
      pending: [...this.pending.values()].map(({ id, toolName, sessionId, reason, detail, startedAt }) => ({
        id,
        tool: toolName,
        title: toolName,
        sessionId,
        detail: detail || reason || '',
        startedAt,
      })),
    }
  }

  onChange(listener) {
    this.watchers.add(listener)
    return () => this.watchers.delete(listener)
  }

  #changed() {
    for (const watcher of this.watchers) {
      try {
        watcher(this.snapshot())
      } catch {
        /* ignore */
      }
    }
  }

  answer(id, decision) {
    const entry = this.pending.get(id)
    if (!entry) return false
    entry.resolve(decision === 'allow' ? 'allowed-once' : 'rejected')
    return true
  }

  answerQuestion() {
    return false
  }

  #ask(request, next) {
    const id = crypto.randomUUID()
    const sessionId = request?.agent?.id || ''
    const detail = describe(request)

    return new Promise((resolve) => {
      let settled = false
      let watch = null
      const finish = (outcome) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (watch) clearInterval(watch)
        this.timers.delete(timer)
        this.pending.delete(id)
        this.#changed()
        resolve(outcome)
      }

      const timer = setTimeout(() => finish(null), this.windowMs)
      this.timers.add(timer)

      this.pending.set(id, {
        id,
        toolName: request?.toolName || 'tool',
        sessionId,
        reason: request?.reason || '',
        detail,
        startedAt: Date.now(),
        resolve: (outcome) => finish(outcome),
      })
      this.#changed()
      this.log.info(`approval request from phone: ${request?.toolName || 'tool'} (${sessionId})`)

      if (request?.signal) {
        request.signal.addEventListener('abort', () => finish(null), { once: true })
      }

      // Disarming while a request is pending hands it back immediately.
      watch = setInterval(() => {
        if (!this.isArmed()) finish(null)
      }, 1000)
    }).then((outcome) => outcome || next())
  }
}

function describe(request) {
  const parts = []
  if (request?.displayReason) {
    if (typeof request.displayReason === 'string') parts.push(request.displayReason)
    else if (typeof request.displayReason === 'object') {
      parts.push(request.displayReason.zh || request.displayReason.en || '')
    }
  }
  if (request?.reason) parts.push(String(request.reason))
  if (request?.toolName) parts.unshift(`工具：${request.toolName}`)
  return parts.filter(Boolean).join('\n')
}
