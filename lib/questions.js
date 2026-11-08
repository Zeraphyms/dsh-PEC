import crypto from 'node:crypto'

/**
 * Phone answering for `user-questions/request`.
 *
 * That event is a Cordis waterfall: the first listener to return an answer wins,
 * and the shipped web client normally answers through its page dialog. We stay
 * transparent - call `next()` and let the desktop answer - unless the phone is
 * actually in someone's hand, which is what `shouldClaim` decides. Claiming
 * consumes the request, so the desktop never renders a dialog we would strand;
 * falling through leaves the desktop exactly as it was.
 */
export class QuestionHub {
  constructor(ctx, log, options = {}) {
    this.ctx = ctx
    this.log = log
    /** @returns {boolean} whether a phone is looking at the screen right now. */
    this.phoneActive = options.phoneActive || (() => false)
    /** @returns {boolean} whether a desktop page could answer instead. */
    this.desktopAttached = options.desktopAttached || (() => false)
    this.onChange = options.onChange || (() => {})
    /** @returns {boolean} whether a phone stream is open for this session. */
    this.phoneOnSession = options.phoneOnSession || (() => false)
    this.pending = new Map()
    this.disposed = false
    this.windowMs = 10 * 60 * 1000
    this.timers = new Set()
    this.off = null
    this.#register()
  }

  #register() {
    if (this.off) return
    try {
      this.off = this.ctx.on(
        'user-questions/request',
        async (request, next) => {
          if (this.disposed) return next()
          if (!this.shouldClaim(request)) return next()
          return this.#ask(request, next)
        },
        { prepend: true },
      )
    } catch (error) {
      // The event is optional: an older Harness without dsh-user-questions must
      // not fail activation.
      this.log?.warn('user-questions unavailable:', error?.message || error)
      this.off = null
    }
  }

  shouldClaim(request) {
    const sessionId = request?.agent?.id || ''
    // The phone wins whenever it is the surface in front of someone: the app on
    // screen, or a stream already open on the session that asked. Claiming means
    // no desktop dialog is rendered at all, so nothing is left stranded there.
    if (this.phoneOnSession(sessionId)) return true
    return this.phoneActive()
  }

  dispose() {
    this.disposed = true
    try {
      this.off?.()
    } catch {
      /* ignore */
    }
    this.off = null
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    this.clear()
  }

  clear() {
    for (const [id, entry] of this.pending) {
      entry.resolve?.(null)
      this.pending.delete(id)
    }
    this.onChange(this.snapshot())
  }

  snapshot() {
    return {
      pending: [...this.pending.values()].map(({ id, sessionId, questions, startedAt, expiresAt }) => ({
        id,
        sessionId,
        questions,
        startedAt,
        expiresAt,
      })),
    }
  }

  answer(id, answers) {
    const entry = this.pending.get(id)
    if (!entry) return false
    const normalized = normalizeAnswer(entry.questions, answers)
    entry.resolve(normalized)
    return true
  }

  #ask(request, next) {
    const id = crypto.randomUUID()
    const sessionId = request?.agent?.id || ''
    const questions = normalizeQuestions(request?.questions)
    if (!questions.length) return next()

    return new Promise((resolve) => {
      let settled = false
      const finish = (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.timers.delete(timer)
        this.pending.delete(id)
        this.onChange(this.snapshot())
        resolve(value)
      }

      const timer = setTimeout(() => {
        this.log?.info(`question ${id} timed out unanswered`)
        finish(null)
      }, this.windowMs)
      this.timers.add(timer)

      this.pending.set(id, {
        id,
        sessionId,
        questions,
        startedAt: Date.now(),
        expiresAt: Date.now() + this.windowMs,
        resolve: (value) => finish(value),
      })
      this.onChange(this.snapshot())
      this.log?.info(`question from phone: ${questions.length} item(s) (${sessionId})`)

      request?.signal?.addEventListener('abort', () => finish(null), { once: true })
    }).then((answer) => answer || next())
  }
}

function normalizeQuestions(raw) {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((item) => item && typeof item === 'object')
    .map((item, index) => ({
      id: String(item.id ?? index),
      question: String(item.question ?? ''),
      detail: item.detail ? String(item.detail) : '',
      header: item.header ? String(item.header) : '',
      multiSelect: Boolean(item.multiSelect),
      options: Array.isArray(item.options)
        ? item.options
            .filter((option) => option && option.label != null)
            .map((option) => ({ label: String(option.label), description: option.description ? String(option.description) : '' }))
        : [],
      intent: item.intent?.kind === 'plan-review' ? { kind: 'plan-review', approve: String(item.intent.approve ?? '') } : null,
    }))
}

/**
 * One answer item per question, in the order they were asked. A skipped item is
 * `{ id, selected: [] }`, which the service accepts and the model reads as "no
 * preference"; labels that were never offered are dropped so a stale phone
 * cannot invent an option.
 */
function normalizeAnswer(questions, answers) {
  // The route hands over `body.answers`; accept the wrapped shape too so a caller
  // that forwards the whole request body is not silently read as "skipped".
  const list = Array.isArray(answers) ? answers : Array.isArray(answers?.answers) ? answers.answers : []
  const byId = new Map()
  for (const item of list) {
    if (item && item.id != null) byId.set(String(item.id), item)
  }
  return {
    answers: questions.map((question) => {
      const given = byId.get(question.id) || {}
      const allowed = new Set(question.options.map((option) => option.label))
      const selected = (Array.isArray(given.selected) ? given.selected : [])
        .map((label) => String(label))
        .filter((label) => allowed.size === 0 || allowed.has(label))
      const limit = question.multiSelect ? selected.length : Math.min(selected.length, 1)
      const custom = given.custom == null ? '' : String(given.custom).trim()
      return {
        id: question.id,
        selected: selected.slice(0, Math.max(limit, 0)),
        ...(custom ? { custom } : {}),
      }
    }),
  }
}
