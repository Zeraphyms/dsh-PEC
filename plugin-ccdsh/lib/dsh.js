import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Thin adapter over the Harness Host services.
 *
 * All calls are made in-process as the owner; the gateway's own device
 * authentication is the only access boundary that matters here.
 */
export class Dsh {
  constructor(ctx, log) {
    this.ctx = ctx
    this.log = log
    this.#check()
  }

  #check() {
    const missing = ['sessionController', 'agents'].filter((key) => !this.ctx.get(key))
    if (missing.length) this.log.warn(`host services missing: ${missing.join(', ')}`)
  }

  #svc(name) {
    return this.ctx.get(name)
  }

  #signal(ms = 30_000) {
    return AbortSignal.timeout(ms)
  }

  async listSessions() {
    const controller = this.#svc('sessionController')
    if (!controller) return { items: [] }
    const value = await controller.list({}, this.#signal(15_000))
    return {
      items: (value?.items || [])
        .filter((item) => item?.origin !== 'subagent')
        .map((item) => this.#summarize(item)),
    }
  }

  #summarize(item) {
    const projections = item?.projections?.values || {}
    const title =
      projections.title ||
      projections.sessionTitle ||
      projections['session-title'] ||
      projections.name ||
      ''
    return {
      id: item?.sessionId,
      title: typeof title === 'string' ? title : '',
      updatedAt: item?.updatedAt || 0,
      running: Boolean(item?.running),
      blank: Boolean(item?.blank),
      cwd: item?.cwd || '',
      agentAvailable: Boolean(item?.agentAvailable),
      parentSessionId: item?.parentSessionId || null,
      origin: item?.origin || null,
      projections,
    }
  }

  async models() {
    const controller = this.#svc('sessionController')
    if (!controller) return { groups: [], default: null, failures: [] }
    const catalog = await controller.modelCatalog()
    return {
      default: catalog?.default || null,
      routableProviders: catalog?.routableProviders || [],
      failures: catalog?.failures || [],
      groups: (catalog?.groups || []).map((group) => ({
        id: group.id,
        name: group.name || group.id,
        models: (group.models || []).map((model) => ({
          id: model.id,
          name: model.name || model.id,
          description: model.description || '',
          reasoning: model.reasoning || null,
        })),
      })),
    }
  }

  async presets() {
    const registry = this.#svc('agentPresets')
    if (!registry) return []
    const list = await registry.list()
    return (list || []).map((preset) => ({
      id: preset?.id || preset?.name || '',
      name: preset?.title || preset?.name || preset?.id || '',
      description: preset?.description || '',
    }))
  }

  async workspaces() {
    const registry = this.#svc('workspaceRegistry')
    if (!registry) return []
    return (registry.list() || []).map((workspace) => ({
      id: workspace.id,
      title: workspace.title || workspace.path,
      path: workspace.path,
    }))
  }

  async permissionPresets() {
    const service = this.#svc('permissionPresets')
    if (!service) return {}
    try {
      const catalog = typeof service.list === 'function' ? await service.list() : service.catalog
      return catalog || {}
    } catch (error) {
      return { error: String(error?.message || error) }
    }
  }

  async plugins() {
    const manager = this.#svc('pluginManager')
    if (!manager) return []
    try {
      const list = await manager.listPlugins()
      return (list || [])
        .filter((entry) => entry && entry.entryId)
        .map((entry) => ({
          entryId: entry.entryId,
          moduleName: entry.moduleName,
          enabled: Boolean(entry.enabled),
          phase: entry.fiberPhase || null,
          patchId: entry.patchId || '',
          title: entry.meta?.title || entry.meta?.description ? entry.meta?.title || '' : '',
          description: entry.meta?.description || '',
          readOnly: Boolean(entry.readOnlyReason),
          readOnlyReason: entry.readOnlyReason || '',
        }))
    } catch (error) {
      this.log.warn('plugin list failed:', error?.message || error)
      return []
    }
  }

  async setPlugin(entryId, enabled) {
    const manager = this.#svc('pluginManager')
    if (!manager) throw new Error('pluginManager unavailable')
    // The gateway server is created during plugin activation, so its request
    // callbacks inherit the HMR async context; management operations open their
    // own transaction and refuse to nest. Step out of the inherited context.
    const result = await this.#outsideHmr(() => manager.setPluginEnabled(entryId, Boolean(enabled)))
    return {
      changed: Boolean(result?.changed),
      application: result?.application || 'unknown',
      error: result?.error?.code || null,
      message: result?.error?.message || result?.error?.diagnostic || '',
      warnings: result?.warnings || [],
    }
  }

  #outsideHmr(operation) {
    const hmr = this.#svc('hmr')
    const store = hmr?.executing
    if (store && typeof store.exit === 'function') {
      try {
        return store.exit(operation)
      } catch {
        return operation()
      }
    }
    return operation()
  }

  async permissionCatalog() {
    const presets = this.#svc('permissionPresets')
    if (!presets) return { options: [], defaultPreset: null }
    try {
      const catalog = await presets.catalog()
      return {
        defaultPreset: catalog?.defaultPreset || null,
        defaultOptions: catalog?.defaultOptions || null,
        options: (catalog?.options || []).map((option) => ({
          id: option?.id || option?.name || '',
          name: option?.title || option?.name || option?.id || '',
          description: option?.description || '',
          sandbox: option?.sandbox || option?.options?.sandbox || '',
          approval: option?.approval || option?.options?.approval || '',
        })),
      }
    } catch (error) {
      return { options: [], error: String(error?.message || error) }
    }
  }

  async setPermission(sessionId, preset) {
    const presets = this.#svc('permissionPresets')
    const sessions = this.#svc('sessions')
    if (!presets || !sessions) throw new Error('permission presets unavailable')
    const session = sessions.get(sessionId)
    if (!session) throw new Error('会话尚未在电脑上打开')
    const value = await presets.set(session, preset)
    return value || { preset }
  }

  async createSession(options = {}) {
    const controller = this.#svc('sessionController')
    if (!controller) throw new Error('sessionController unavailable')
    const request = {}
    if (options.cwd) request.cwd = options.cwd
    if (options.workspaceId) request.workspaceId = options.workspaceId
    if (options.preset) request.agentPreset = options.preset
    const value = await controller.create(request)
    return { sessionId: value?.sessionId, agentPreset: value?.agentPreset }
  }

  async prompt(sessionId, body = {}) {
    const controller = this.#svc('sessionController')
    if (!controller) throw new Error('sessionController unavailable')
    const text = String(body.text || '').trim()
    if (!text) throw new Error('empty prompt')
    const content = [{ type: 'text', text }]
    for (const image of body.images || []) content.push(image)
    const value = await controller.prompt(
      {
        requestId: crypto.randomUUID(),
        sessionId,
        mode: body.mode === 'steer' ? 'steer' : 'queue',
        content,
        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
      this.#signal(30_000),
    )
    return value || { accepted: true }
  }

  async cancel(sessionId) {
    const controller = this.#svc('sessionController')
    if (!controller) throw new Error('sessionController unavailable')
    return controller.cancel({ sessionId })
  }

  async rename(sessionId, title) {
    const controller = this.#svc('sessionController')
    if (!controller) throw new Error('sessionController unavailable')
    return controller.rename({ sessionId, title: String(title || '') })
  }

  async selectModel(sessionId, body = {}) {
    const controller = this.#svc('sessionController')
    if (!controller) throw new Error('sessionController unavailable')
    const request = { sessionId, provider: body.provider, model: body.model }
    if (body.reasoningEffort) request.reasoningEffort = body.reasoningEffort
    return controller.selectModel(request)
  }

  async selectPreset(sessionId, preset) {
    const registry = this.#svc('agentPresets')
    const controller = this.#svc('sessionController')
    if (!registry) throw new Error('agentPresets unavailable')
    let agent = this.#svc('agents')?.get?.(sessionId)
    if (!agent && controller) {
      const resolved = await controller.resolveAgent(sessionId)
      agent = resolved?.agent
    }
    if (!agent) throw new Error('session is not resumable')
    const selected = await registry.select(agent, preset)
    return { preset: selected ?? preset }
  }

  async page(sessionId, url) {
    const controller = this.#svc('sessionController')
    if (!controller) throw new Error('sessionController unavailable')
    // `page` needs an exact `throughSeq`; the follow snapshot already gives the
    // newest aligned history, so read that and stop.
    const abort = new AbortController()
    try {
      for await (const frame of controller.follow(
        { address: { kind: 'session', sessionId }, maxMessages: Number(url.searchParams.get('limit')) || undefined },
        abort.signal,
      )) {
        if (frame?.type === 'snapshot') {
          return { records: frame.records || [], hasMore: Boolean(frame.hasMore) }
        }
      }
    } finally {
      abort.abort()
    }
    return { records: [], hasMore: false }
  }

  async sessionPage(sessionId, url) {
    return this.page(sessionId, url)
  }

  /* ---------------------------------------------------------------- files */

  #agent(sessionId) {
    return this.#svc('agents')?.get?.(sessionId)
  }

  #sessionCwd(sessionId) {
    const session = this.#svc('sessions')?.get?.(sessionId)
    if (!session) return process.cwd()
    try {
      const working = this.#svc('workingDirectory')?.get?.(session)
      if (working) return working
    } catch {
      /* fall through */
    }
    return session.header?.cwd || process.cwd()
  }

  async listFiles(sessionId, pathValue) {
    const fs = this.#svc('fs')
    if (!fs) throw new Error('文件服务不可用')
    const cwd = this.#sessionCwd(sessionId)
    const target = await fs.resolve(pathValue || cwd, { cwd })
    const basic = await fs.stat(target)
    if (basic && basic.type !== 'directory') throw new Error('不是目录')
    const entries = await fs.listDir(target)
    const resolved = fs.processPath(target)
    const parent = path.dirname(resolved)
    return {
      path: resolved,
      parent: parent === resolved ? null : parent,
      entries: (entries || [])
        .map((entry) => ({
          name: entry.name,
          kind: entry.type === 'directory' ? 'dir' : entry.type,
          size: entry.size ?? null,
          path: safeProcessPath(fs, entry.target, resolved, entry.name),
        }))
        .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1)),
    }
  }

  async readFile(sessionId, pathValue) {
    const fs = this.#svc('fs')
    if (!fs) throw new Error('文件服务不可用')
    const cwd = this.#sessionCwd(sessionId)
    const target = await fs.resolve(pathValue, { cwd })
    const info = await fs.stat(target)
    if (!info) throw new Error('文件不存在')
    if (info.type !== 'file') throw new Error('不是普通文件')
    if ((info.size || 0) > 2_000_000) throw new Error('文件太大（>2MB），请用电脑打开')
    let text
    try {
      text = await fs.readText(target)
    } catch (error) {
      throw new Error('无法按文本读取（可能是二进制文件）')
    }
    const truncated = text.length > 200_000
    return { path: fs.processPath(target), text: truncated ? `${text.slice(0, 200_000)}\n\n…（已截断）` : text, truncated }
  }

  /* ------------------------------------------------------------- terminal */

  async listTerminals(sessionId) {
    const terminals = this.#svc('terminals')
    const agent = this.#agent(sessionId)
    if (!terminals || !agent) return { items: [], backends: terminals?.listBackends?.() || [] }
    return {
      backends: terminals.listBackends(),
      items: terminals.list(agent).map((snapshot) => ({
        id: snapshot.sessionId,
        title: snapshot.name || snapshot.type,
        type: snapshot.type,
        pid: snapshot.pid,
        running: snapshot.status?.kind === 'running',
        exitCode: snapshot.status?.kind === 'exited' ? snapshot.status.exitCode : null,
      })),
    }
  }

  /**
   * A PTY needs the isolated `terminals` service, which many compositions do
   * not mount for a plugin. `ctx.shell` is the portable surface: one command at
   * a time, incremental output, real exit codes and `kill()`.
   */
  get runs() {
    if (!this._runs) this._runs = new Map()
    return this._runs
  }

  async runCommand(sessionId, command) {
    const text = String(command || '').trim()
    if (!text) throw new Error('命令为空')
    const cwd = this.#sessionCwd(sessionId)

    // `ctx.shell` is whatever executor the composition mounted (on Windows it is
    // often the bash one, which needs Git Bash). Spawning the platform shell
    // through `ctx.subprocess` is deterministic and still gives us incremental
    // output, exit codes and terminate().
    const subprocess = this.#svc('subprocess')
    if (!subprocess) throw new Error('这台电脑没有启用子进程服务')

    const shellPath = resolveWindowsShell()
    const preamble = "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$OutputEncoding=[Console]::OutputEncoding;"
    const argv = shellPath.endsWith('powershell.exe') || shellPath.endsWith('pwsh.exe')
      ? [shellPath, '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `${preamble}${text}`]
      : [shellPath, '-NoLogo', '-c', text]

    const handle = subprocess.spawn({
      argv,
      cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 400_000, spill: { maxBytes: 8_000_000 } },
        stderr: { maxBytes: 200_000, spill: { maxBytes: 2_000_000 } },
      },
      graceMs: 3000,
    })

    const id = crypto.randomUUID()
    const run = {
      id,
      sessionId,
      command: text,
      cwd,
      handle,
      buffer: `$ ${text}\n`,
      cursor: 0,
      running: true,
      exitCode: null,
      signal: null,
      outOffset: 0,
      errOffset: 0,
      startedAt: Date.now(),
      timer: null,
    }
    run.timer = setInterval(() => this.#drainRun(run), 250)
    this.runs.set(id, run)
    this.#drainRun(run)
    handle.done.then(
      (outcome) => {
        run.exitCode = outcome?.exitCode ?? null
        run.signal = outcome?.signal ?? null
        this.#finishRun(run)
      },
      (error) => {
        run.buffer += `\n[启动失败] ${error?.message || error}\n`
        this.#finishRun(run)
      },
    )
    return { id, command: text, cwd, shell: shellPath }
  }

  #drainRun(run) {
    try {
      const stdout = run.handle?.collected?.stdout
      if (stdout) {
        const read = stdout.readFrom(run.outOffset)
        if (read?.text) {
          run.buffer += read.text
          run.outOffset = read.nextOffset ?? run.outOffset + read.text.length
        }
      }
      const stderr = run.handle?.collected?.stderr
      if (stderr) {
        const read = stderr.readFrom(run.errOffset)
        if (read?.text) {
          run.buffer += read.text
          run.errOffset = read.nextOffset ?? run.errOffset + read.text.length
        }
      }
      if (run.buffer.length > 400_000) run.buffer = `…（输出过长，只保留最后 300k）\n${run.buffer.slice(-300_000)}`
    } catch {
      /* the process may already be gone */
    }
  }

  #finishRun(run) {
    if (!run.running) return
    run.running = false
    this.#drainRun(run)
    if (run.timer) clearInterval(run.timer)
    run.timer = null
    const suffix = run.signal ? `[被信号 ${run.signal} 结束]` : `[退出码 ${run.exitCode ?? 0}]`
    if (!run.buffer.endsWith('\n')) run.buffer += '\n'
    run.buffer += `${suffix}\n`
    // Keep the last 20 finished runs reachable; drop the older ones.
    const finished = [...this.runs.values()].filter((entry) => !entry.running)
    for (const stale of finished.slice(0, Math.max(0, finished.length - 20))) this.runs.delete(stale.id)
  }

  readRun(id, cursor = 0) {
    const run = this.runs.get(id)
    if (!run) throw new Error('这条命令已经不在缓存里')
    const from = Math.max(0, Math.min(Number(cursor) || 0, run.buffer.length))
    return {
      text: run.buffer.slice(from),
      cursor: run.buffer.length,
      running: run.running,
      exitCode: run.exitCode,
      signal: run.signal,
      command: run.command,
      cwd: run.cwd,
    }
  }

  async killRun(id) {
    const run = this.runs.get(id)
    if (!run) throw new Error('这条命令已经结束')
    try {
      run.handle?.terminate?.()
    } catch {
      /* ignore */
    }
    return { ok: true }
  }

  listRuns(sessionId) {
    return {
      items: [...this.runs.values()]
        .filter((run) => !sessionId || run.sessionId === sessionId)
        .slice(-20)
        .map((run) => ({
          id: run.id,
          command: run.command,
          running: run.running,
          exitCode: run.exitCode,
          startedAt: run.startedAt,
        })),
    }
  }

  /* --------------------------------------------------------------- goals */

  async goal(sessionId) {
    const goals = this.#svc('goals')
    const agent = this.#agent(sessionId)
    if (!goals || !agent) return { goal: null, live: Boolean(agent) }
    try {
      const view = goals.get(agent)
      if (!view) return { goal: null, live: true }
      return {
        live: true,
        goal: {
          id: view.id,
          revision: view.revision,
          objective: view.objective,
          phase: view.phase,
          blockedReason: view.blockedReason || null,
          roundsStarted: view.roundsStarted ?? 0,
          maxGoalRounds: view.maxGoalRounds ?? 0,
          activation: view.activation || null,
          createdAt: view.createdAt || 0,
          updatedAt: view.updatedAt || 0,
        },
      }
    } catch (error) {
      return { goal: null, live: false, reason: String(error?.message || error) }
    }
  }

  async goalAction(sessionId, action) {
    const goals = this.#svc('goals')
    const agent = this.#agent(sessionId)
    if (!goals || !agent) throw new Error('这个会话在电脑上没在运行')
    const current = goals.get(agent)
    if (!current) throw new Error('这个会话没有目标')
    const ref = { id: current.id, revision: current.revision }
    if (action === 'pause') goals.pause(agent, ref)
    else if (action === 'resume') goals.resume(agent, ref)
    else if (action === 'complete') goals.complete(agent, ref)
    else if (action === 'clear') goals.clear(agent, ref)
    else throw new Error('未知操作：' + action)
    return this.goal(sessionId)
  }

  /* ------------------------------------------------------------ schedules */

  async schedules() {
    const schedule = this.#svc('schedule')
    if (!schedule) return { items: [] }
    const rows = await schedule.catalog()
    const sessions = this.#svc('sessions')
    return {
      items: (rows || []).map((row) => {
        const session = sessions?.get?.(row.sessionId)
        return {
          id: row.id,
          title: row.title || row.name || '提醒',
          sessionId: row.sessionId,
          sessionTitle: session?.header?.id ? '' : '',
          status: row.status || 'active',
          scheduledAt: row.scheduledAt || '',
          prompt: String(row.prompt || '').slice(0, 300),
          cadence: describeCadence(row),
        }
      }),
    }
  }

  async deleteSchedule(sessionId, id) {
    const schedule = this.#svc('schedule')
    if (!schedule) throw new Error('计划任务服务不可用')
    return schedule.delete({ sessionId, id })
  }

  async createSchedule(sessionId, body = {}) {
    const schedule = this.#svc('schedule')
    if (!schedule) throw new Error('计划任务服务不可用')
    const title = String(body.title || '').trim()
    const prompt = String(body.prompt || title).trim()
    if (!title) throw new Error('需要标题')
    const minutes = Math.max(1, Number(body.afterMinutes) || 30)
    const record = await schedule.create(
      sessionId,
      { title, prompt, after_seconds: minutes * 60 },
      this.#signal(20_000),
    )
    return { id: record?.id, title: record?.title, scheduledAt: record?.scheduledAt || '' }
  }



  /* ------------------------------------------------------------- settings */

  async settings() {
    const settings = this.#svc('settings')
    if (!settings) return { namespaces: [] }
    const rows = settings.describe({ redactSecrets: true }) || []
    return {
      namespaces: rows
        .map((row) => ({
          ns: row.ns,
          revision: row.revision,
          title: prettyNamespace(row.ns),
          fields: extractFields(row.schema, row.value || {}, row.user || {}),
        }))
        .filter((row) => row.fields.length > 0)
        .sort((a, b) => a.title.localeCompare(b.title)),
    }
  }

  async updateSettings(ns, patch, revision) {
    const settings = this.#svc('settings')
    if (!settings) throw new Error('设置服务不可用')
    try {
      return await this.#outsideHmr(() => settings.update(ns, patch, revision))
    } catch (error) {
      // Single-field edits sometimes need an explicit path (e.g. an empty
      // string default that the merge path cannot materialize).
      const keys = Object.keys(patch || {})
      if (keys.length === 1 && typeof settings.mutate === 'function') {
        const path = keys[0].split('.')
        const ops = [{ op: 'set', path, value: patch[keys[0]] }]
        return this.#outsideHmr(() => settings.mutate(ns, ops, revision))
      }
      throw error
    }
  }

  /**
   * Follow one session. Yields the opening snapshot first, then durable
   * events, then live assistant-stream frames.
   */
  async *follow(sessionId, _from, signal) {
    const controller = this.#svc('sessionController')
    if (!controller) throw new Error('sessionController unavailable')
    const stream = controller.follow(
      { address: { kind: 'session', sessionId }, assistantStream: true },
      signal || this.#signal(10 * 60_000),
    )
    for await (const frame of stream) yield frame
  }
}

/* ------------------------------------------------------------------ helpers */

function safeProcessPath(fs, target, base, name) {
  try {
    const resolved = fs.processPath(target)
    if (typeof resolved === 'string' && resolved) return resolved
  } catch {
    /* fall back to the joined path */
  }
  return path.join(base, name)
}

/** Human-readable recurrence for a schedule row. */
function describeCadence(row) {
  const parts = []
  if (row.cron?.expression) parts.push(`cron ${row.cron.expression}`)
  if (row.every_seconds) parts.push(`每 ${formatSeconds(row.every_seconds)}`)
  if (row.daily?.time) parts.push(`每天 ${row.daily.time}`)
  if (row.weekly?.time) parts.push(`每周 ${row.weekly.time}`)
  if (row.at) parts.push(`在 ${typeof row.at === 'string' ? row.at : JSON.stringify(row.at)}`)
  return parts.join(' · ')
}

function formatSeconds(seconds) {
  const value = Number(seconds) || 0
  if (value >= 3600 && value % 3600 === 0) return `${value / 3600} 小时`
  if (value >= 60 && value % 60 === 0) return `${value / 60} 分钟`
  return `${value} 秒`
}

/** The shell every phone command runs through on this platform. */
function resolveWindowsShell() {
  if (process.platform !== 'win32') return process.env.SHELL || '/bin/sh'
  const candidates = [
    'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  ]
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate
    } catch {
      /* ignore */
    }
  }
  return 'powershell.exe'
}

const NAMESPACE_TITLES = {
  permission: '权限默认值',
  'agent-preset-registry': '默认模式（预设）',
  'agent-default-model': '默认模型',
  'ui-theme': '外观 / 主题',
  'ui-locale': '语言',
  locale: '语言',
  'ui-conversation': '对话与输入',
  'agent-loop': '代理循环',
  subagent: '子代理',
  'subagent-model-selection': '子代理模型',
  web: '网络访问',
  'web-search-deepseek': '网络搜索',
  'session-log-deepseek': '会话日志',
  'tool-call-timeout-policy': '工具超时',
  'compaction-basic': '上下文压缩',
  'repeat-tool-reminder': '重复工具提醒',
  'desktop-product-telemetry': '使用统计',
}

/**
 * Schemastery's JSON form is reference based (`{uid, refs}` with numeric ids in
 * `dict`/`list`/`inner`), so resolve it into a plain tree before walking it.
 */
function derefSchema(schema, budget = 20000) {
  const refs = schema?.refs || {}
  const seen = new Set()

  const walk = (node) => {
    if (--budget < 0) return { type: 'unknown' }
    if (typeof node === 'number') return refs[node] === undefined ? { type: 'unknown' } : walk(refs[node])
    if (typeof node === 'string' && refs[node] !== undefined) return walk(refs[node])
    if (!node || typeof node !== 'object') return { type: 'unknown' }
    if (seen.has(node)) return { type: 'unknown' }
    seen.add(node)

    const out = { type: node.type, meta: node.meta || {} }
    if (node.dict && typeof node.dict === 'object') {
      out.dict = {}
      for (const [key, child] of Object.entries(node.dict)) out.dict[key] = walk(child)
    }
    if (Array.isArray(node.list)) out.list = node.list.map(walk)
    if (node.inner !== undefined) out.inner = walk(node.inner)
    if (node.value !== undefined) out.value = node.value
    return out
  }

  // `form.toJSON()` wraps the root as `{ uid, refs }` where `refs[uid]` is the
  // root node itself.
  if (schema && schema.uid !== undefined && refs[schema.uid] !== undefined) return walk(refs[schema.uid])
  return walk(schema)
}

function prettyNamespace(ns) {
  if (!ns) return '未知设置'
  const key = String(ns).replace(/^include:/, '')
  return NAMESPACE_TITLES[key] || key
}

/**
 * Project one schemastery JSON form into the flat rows the phone renders.
 * Only top-level primitive-ish fields are exposed; anything nested stays out of
 * the phone UI rather than being written back in a shape the Host would reject.
 */
function extractFields(schema, value, user) {
  const form = derefSchema(schema)
  if (!form || form.type !== 'object' || !form.dict) return []
  const fields = []
  for (const [key, child] of Object.entries(form.dict)) {
    if (!child || typeof child !== 'object') continue
    const label = child.meta?.description || child.meta?.title || key
    const description = child.meta?.description && child.meta?.title ? child.meta.description : undefined
    const current = Object.prototype.hasOwnProperty.call(user, key)
      ? user[key]
      : Object.prototype.hasOwnProperty.call(value, key)
        ? value[key]
        : child.meta?.default

    if (child.type === 'boolean') {
      fields.push({ key, type: 'boolean', label, value: Boolean(current) })
      continue
    }
    if (child.type === 'number' || child.type === 'natural') {
      fields.push({ key, type: 'number', label, value: typeof current === 'number' ? current : null })
      continue
    }
    if (child.type === 'string') {
      fields.push({ key, type: 'string', label, value: current == null ? '' : String(current) })
      continue
    }
    if (child.type === 'const') {
      fields.push({
        key,
        type: 'select',
        label,
        value: current ?? child.value,
        options: [{ value: child.value, label: String(child.value) }],
      })
      continue
    }
    if (child.type === 'union' && Array.isArray(child.list)) {
      const options = child.list
        .filter((item) => item && item.type === 'const')
        .map((item) => ({ value: item.value, label: String(item.meta?.description || item.value) }))
      if (options.length && options.length <= 12) {
        fields.push({ key, type: 'select', label, value: current ?? options[0].value, options })
      }
    }
  }
  return fields
}
