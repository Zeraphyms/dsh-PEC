/* dsh-PEC mobile client: talks to the dsh-PEC Host plugin on the PC. */
import { emptyProgress, progressFromSnapshot, applyProgressEvent, applyGoalActivation, composerAction, todoCounts, goalPhaseLabel } from './progress.js'
import { matchModel, isSelectedModel } from './models.js'
import { groupSessionsByWorkspace, toggleWorkspace } from './groups.js'

const app = document.getElementById('app')
const toastEl = document.getElementById('toast')

/* ------------------------------------------------------------------ theme */

/**
 * Mirror the desktop's appearance: the phone reads DSH's own `ui-theme`
 * settings (light / dark / system plus the text font size), so both screens
 * agree. `system` falls back to the phone's prefers-color-scheme.
 */
function applyTheme(preference, fontSize) {
  const pref = ['light', 'dark', 'system'].includes(preference) ? preference : 'system'
  const dark =
    pref === 'dark' ||
    (pref === 'system' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches)
  document.body.toggleAttribute('data-ds-dark-theme', dark)
  if (fontSize) document.documentElement.style.setProperty('--dsh-content-font-size', `${fontSize}px`)
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', dark ? '#151517' : '#ffffff')
  try {
    localStorage.setItem('ccdsh_theme', pref)
    if (fontSize) localStorage.setItem('ccdsh_font_size', String(fontSize))
  } catch {
    /* private mode */
  }
}

async function syncDesktopTheme() {
  try {
    const settings = await api('/api/settings')
    const namespace = (settings?.namespaces || []).find((row) => row.ns === 'ui-theme')
    if (!namespace) return
    const field = (key) => (namespace.fields || []).find((row) => row.key === key)?.value
    state.theme = field('preference') || 'system'
    state.fontSize = Number(field('fontSize')) || 14
    applyTheme(state.theme, state.fontSize)
  } catch {
    /* cosmetic: never block boot */
  }
}

if (window.matchMedia) {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
    if ((state.theme || 'system') === 'system') applyTheme('system', state.fontSize || 14)
  })
}

const state = {
  token: '',
  server: null,
  sessions: [],
  models: { groups: [], default: null, failures: [] },
  presets: [],
  workspaces: [],
  permissions: { options: [] },
  plugins: [],
  view: 'sessions',
  current: null,
  progress: emptyProgress(),
  tasksExpanded: false,
  collapsedWorkspaces: [],
  stats: null, // 桌面同款会话统计（轮/步、tok/s、总 tok、缓存命中、上下文）
  events: [],
  snapshotAt: null,
  turnStartedAt: null,  // start time of the running turn, for the live clock
  cursor: null,        // inclusive log cut from the opening snapshot
  hasMore: false,      // older history available on the host
  preserveScroll: null, // distance from the bottom to keep while prepending
  live: null,
  toolResults: new Map(),
  running: false,
  stream: null,
  approvals: { pending: [], armedUntil: 0 },
  questions: { pending: [] },
  /** Answers typed into the open question card, keyed by question id. */
  questionDrafts: {},
  archivedIds: [],
  filter: '',
  loading: true,
  error: '',
}

/* ------------------------------------------------------------------ utils */

// Surface runtime errors on the phone instead of failing silently.
window.addEventListener('error', (event) => {
  const message = event?.message || 'unknown error'
  try {
    toast('页面出错：' + message, 4000)
  } catch {
    /* ignore */
  }
})
window.addEventListener('unhandledrejection', (event) => {
  const reason = event?.reason
  if (reason && reason.code === 401) return // the pairing screen handles this
  try {
    toast('请求出错：' + (reason?.message || reason), 3000)
  } catch {
    /* ignore */
  }
})

const el = (tag, props = {}, children = []) => {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue
    if (key === 'class') node.className = value
    else if (key === 'text') node.textContent = value
    else if (key === 'html') node.innerHTML = value
    else if (key === 'onmount') queueMicrotask(() => { try { value(node) } catch { /* ignore */ } })
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value)
    else if (key === 'dataset') Object.assign(node.dataset, value)
    else node.setAttribute(key, value)
  }
  for (const child of [].concat(children)) {
    if (child == null || child === false) continue
    node.append(child.nodeType ? child : document.createTextNode(String(child)))
  }
  return node
}

const svg = (path, size = 20) => {
  const ns = 'http://www.w3.org/2000/svg'
  const node = document.createElementNS(ns, 'svg')
  node.setAttribute('viewBox', '0 0 24 24')
  node.setAttribute('width', size)
  node.setAttribute('height', size)
  node.setAttribute('fill', 'none')
  node.setAttribute('stroke', 'currentColor')
  node.setAttribute('stroke-width', '1.7')
  node.setAttribute('stroke-linecap', 'round')
  node.setAttribute('stroke-linejoin', 'round')
  node.innerHTML = path
  return node
}

const ICON = {
  back: '<path d="M15 18l-6-6 6-6"/>',
  send: '<path d="M4 12l16-8-6 16-3-7-7-1z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  menu: '<circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v4h-4"/>',
  spark: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/>',
  phone: '<rect x="7" y="3" width="10" height="18" rx="2.5"/><path d="M11 18h2"/>',
  clip: '<path d="M20 11.5l-7.6 7.6a4.5 4.5 0 0 1-6.4-6.4l8-8a3 3 0 0 1 4.3 4.3l-8 8a1.5 1.5 0 0 1-2.1-2.1l7.3-7.3"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3"/><path d="M13 15h4"/>',
  sliders: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M15 5.5A2.5 2.5 0 0 0 12.5 3H6a3 3 0 0 0-3 3v6.5A2.5 2.5 0 0 0 5.5 15"/>',
  speaker: '<path d="M4 9.5h3l4.5-3.6v12.2L7 14.5H4z"/><path d="M15.5 9a4 4 0 0 1 0 6"/><path d="M18 6.6a7.4 7.4 0 0 1 0 10.8"/>',
}

function toast(message, ms = 2200) {
  toastEl.textContent = message
  toastEl.hidden = false
  clearTimeout(toast.timer)
  toast.timer = setTimeout(() => {
    toastEl.hidden = true
  }, ms)
}

function ago(time) {
  if (!time) return ''
  const seconds = Math.max(1, Math.round((Date.now() - time) / 1000))
  if (seconds < 60) return '刚刚'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days} 天前`
  return new Date(time).toLocaleDateString()
}

/* ------------------------------------------------------------------ auth */

function readToken() {
  try {
    if (window.CCDSH && typeof window.CCDSH.token === 'function') {
      const fromApp = window.CCDSH.token()
      if (fromApp) return fromApp
    }
  } catch {}
  const stored = localStorage.getItem('ccdsh_token') || ''
  if (stored) return stored
  const match = document.cookie.match(/(?:^|;\s*)ccdsh_token=([^;]+)/)
  return match ? decodeURIComponent(match[1]) : ''
}

function rememberToken(token) {
  state.token = token
  try {
    localStorage.setItem('ccdsh_token', token)
    document.cookie = `ccdsh_token=${encodeURIComponent(token)}; path=/; max-age=31536000`
  } catch {}
}

async function api(path, options = {}) {
  const headers = Object.assign({ 'content-type': 'application/json' }, options.headers || {})
  if (state.token) headers.authorization = `Bearer ${state.token}`
  const response = await fetch(path, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
    credentials: 'same-origin',
  })
  if (response.status === 401) {
    const error = new Error('unauthorized')
    error.code = 401
    throw error
  }
  const text = await response.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = null
  }
  if (!response.ok) {
    const error = new Error((data && (data.message || data.error)) || `HTTP ${response.status}`)
    error.code = response.status
    throw error
  }
  return data
}

/* ------------------------------------------------------------------ boot */

async function boot() {
  state.token = readToken()
  if (!state.token) return renderPairing()

  await syncDesktopTheme()

  try {
    const bootstrap = await api('/api/bootstrap')
    state.server = bootstrap.server
    state.sessions = bootstrap.sessions?.items || []
    state.models = bootstrap.models?.groups ? bootstrap.models : { groups: [], default: null, failures: [] }
    state.presets = Array.isArray(bootstrap.presets) ? bootstrap.presets : []
    state.workspaces = Array.isArray(bootstrap.workspaces) ? bootstrap.workspaces : []
    state.permissions = bootstrap.permissions || { options: [] }
    state.plugins = Array.isArray(bootstrap.plugins) ? bootstrap.plugins : []
    state.approvals = bootstrap.approvals || { pending: [], armedUntil: 0 }
    state.questions = bootstrap.questions || { pending: [] }
    state.archivedIds = bootstrap.sessions?.archivedSessionIds || state.archivedIds || []
    // Compatibility self-check: the plugin reports which Host capabilities the
    // running DSH still offers, so a Harness update is visible in the UI.
    try {
      state.health = await api('/api/health')
    } catch {
      state.health = null
    }
    state.loading = false
    startPresence()
    const remembered = localStorage.getItem('ccdsh_last_session')
    if (remembered && state.sessions.some((s) => s.id === remembered)) openSession(remembered)
    else render()
  } catch (error) {
    state.loading = false
    if (error.code === 401) {
      localStorage.removeItem('ccdsh_token')
      renderPairing('配对已失效，请重新输入电脑上显示的 6 位配对码')
      return
    }
    renderError(error)
  }
}

/**
 * Tell the gateway the app is on screen. It matters for questions: a request is
 * answered here only while this page is visible, so a phone left idle in a
 * pocket never swallows the dialog that belongs on the desktop.
 */
let presenceTimer = null
function startPresence() {
  if (presenceTimer) return
  const beat = () => {
    if (document.visibilityState !== 'visible') return
    api('/api/presence', { method: 'POST', body: { session: state.current?.id || null } }).catch(() => {
      /* offline; the next beat retries */
    })
  }
  beat()
  presenceTimer = setInterval(beat, 15_000)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') beat()
  })
}

function renderError(error) {  app.replaceChildren(
    el('div', { class: 'pair' }, [
      el('h1', { text: '连不上电脑' }),
      el('p', { text: String(error?.message || error) }),
      el('div', { class: 'err', text: '确认电脑上的 DSH 正在运行，且 dsh-PEC 插件已启用。' }),
      el('button', { class: 'btn', onclick: () => location.reload() }, '重试'),
      el(
        'button',
        { class: 'btn ghost', onclick: () => { localStorage.removeItem('ccdsh_token'); location.reload() } },
        '重新配对',
      ),
    ]),
  )
}

/* ------------------------------------------------------------------ pairing */

function deviceLabel() {
  try {
    if (window.CCDSH && typeof window.CCDSH.deviceName === 'function') {
      const fromApp = window.CCDSH.deviceName()
      if (fromApp) return fromApp
    }
  } catch {}
  const ua = navigator.userAgent || ''
  const platform = /Android/i.test(ua) ? 'Android' : /iPhone|iPad|iPod/i.test(ua) ? 'iOS' : /Windows/i.test(ua) ? 'Windows' : '浏览器'
  const browser = /EdgA|Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /Firefox\//.test(ua) ? 'Firefox' : ''
  const tag = Math.random().toString(36).slice(2, 6).toUpperCase()
  return [platform, browser].filter(Boolean).join(' · ') + ' ' + tag
}

function renderPairing(message = '') {
  const input = el('input', { placeholder: '123456', inputmode: 'numeric', maxlength: '6', autocomplete: 'off' })
  const error = el('div', { class: 'err', text: message })
  const submit = async () => {
    const code = input.value.trim()
    if (code && code.length !== 6) {
      error.textContent = '配对码是 6 位数字；第一次配对也可以留空直接连接。'
      return
    }
    submit.disabled = true
    try {
      const result = await api('/api/pair', {
        method: 'POST',
        body: {
          code,
          name: deviceLabel(),
          platform: (() => {
            try {
              return window.CCDSH?.devicePlatform?.() || navigator.platform || ''
            } catch {
              return navigator.platform || ''
            }
          })(),
          userAgent: navigator.userAgent || '',
        },
      })
      rememberToken(result.token)
      try {
        // Keep the native shell's saved token in sync when pairing happens inside
        // the page (first run, or after the PC revoked this phone).
        window.CCDSH?.saveConnection?.(result.token, result.server?.name || '')
      } catch {}
      location.reload()
    } catch (e) {
      error.textContent = e.message === 'code-invalid' ? '配对码不对，请在电脑上确认新码' : '配对失败：' + e.message
      submit.disabled = false
    }
  }
  app.replaceChildren(
    el('div', { class: 'pair' }, [
      el('div', { class: 'boot-logo', text: 'dsh-PEC' }),
      el('h1', { text: '配对你的电脑' }),
      el('p', { text: '第一次配对不用输码：手机和电脑在同一个 Wi-Fi（或都连着 Tailscale）时，直接点“连接”。之后再加手机才需要电脑上显示的 6 位配对码。' }),
      el('div', { class: 'field' }, [el('label', { text: '配对码（第一次可留空）' }), input]),
      error,
      el('button', { class: 'btn', onclick: submit }, '连接'),
      el('p', { class: 'small', text: '配对码在电脑 DSH 的“设置 → 手机连接”里，每 10 分钟自动更换。' }),
    ]),
  )
  input.focus()
}

/* ------------------------------------------------------------------ shell */

function render() {
  if (state.view === 'chat' && state.current) return renderChat()
  return renderSessions()
}

function topbar(title, subtitle, { back = false, right = [] } = {}) {
  return el('div', { class: 'topbar' }, [
    back
      ? el('button', { class: 'icon-btn', onclick: () => { closeStream(); state.view = 'sessions'; state.current = null; render() } }, [svg(ICON.back)])
      : el('button', { class: 'icon-btn', onclick: () => openSheet(serverSheet) }, [svg(ICON.phone)]),
    el('h1', {}, [title, subtitle ? el('span', { class: 'sub', text: subtitle }) : null]),
    ...right,
  ])
}

/* ------------------------------------------------------------------ sessions */

/**
 * Mirror the desktop's visibility rule (dsh-client-ui-workspace `sessionVisible`):
 * subagent rows and archived rows are hidden, and blank sessions are hidden
 * unless one is the session currently open - the desktop shows at most that one
 * as the "New Session" placeholder. Without this, every never-used session the
 * phone (or the desktop) minted stays visible here as a ghost row the desktop
 * never shows.
 */
function visibleSessions(sessions) {
  const archived = new Set(state.archivedIds || [])
  return sessions.filter((session) => {
    if (session.origin === 'subagent') return false
    if (session.blank && session.id !== state.current?.id) return false
    return !archived.has(String(session.id))
  })
}

function renderSessions() {
  const query = state.filter.trim().toLowerCase()
  const sessions = visibleSessions(state.sessions).filter((session) => {
    if (!query) return true
    return (session.title || '') .toLowerCase().includes(query) || (session.cwd || '').toLowerCase().includes(query)
  })
  const hiddenBlanks = state.sessions.filter((session) => session.blank && session.id !== state.current?.id).length

  const list = el('div', { class: 'list' }, [
    ...(state.health && !state.health.ok ? [healthBanner(state.health)] : []),
    el('div', { class: 'search' }, [
      svg(ICON.search, 18),
      el('input', {
        placeholder: '搜索会话 / 工作区',
        value: state.filter,
        oninput: (event) => {
          state.filter = event.target.value
          renderSessions()
        },
      }),
    ]),
    ...(sessions.length === 0
      ? [el('div', { class: 'empty', text: query ? '没有匹配的会话' : '还没有会话，点右下角新建一个' })]
      : query
        // While searching, a flat list crosses group boundaries.
        ? sessions.map(sessionRow)
        : groupSessionsByWorkspace(sessions, state.workspaces).flatMap((group) => {
            const title = group.workspace?.title || '其他'
            const collapsed = (state.collapsedWorkspaces || []).includes(title)
            return [
              el('button', {
                class: 'ws-group' + (collapsed ? ' collapsed' : ''),
                type: 'button',
                'aria-expanded': String(!collapsed),
                onclick: () => {
                  state.collapsedWorkspaces = toggleWorkspace(state.collapsedWorkspaces, title)
                  renderSessions()
                },
              }, [
                svg(ICON.folder, 16),
                el('span', { class: 'ws-title', text: title }),
                el('span', { class: 'ws-count', text: String(group.sessions.length) }),
                el('span', { class: 'ws-chevron', 'aria-hidden': 'true', text: collapsed ? '⌄' : '⌃' }),
              ]),
              ...(collapsed ? [] : group.sessions.map(sessionRow)),
            ]
          })),
    ...(hiddenBlanks >= 5
      ? [el('button', {
          class: 'cleanup-link',
          onclick: cleanupBlanks,
        }, `清理 ${hiddenBlanks} 个空会话（从未发过消息，桌面端不显示）`)]
      : []),
  ])

  // Replace, never append: this view re-renders on every keystroke and on the
  // 15s refresh, and appending stacked whole screens on top of each other.
  app.replaceChildren(
    topbar('dsh-PEC', state.server?.name || '已连接', {
      right: [
        el('button', { class: 'icon-btn', title: '刷新', onclick: () => boot() }, [svg(ICON.refresh)]),
      ],
    }),
    list,
    el('button', { class: 'fab', onclick: newSession }, [svg(ICON.plus, 18), '新会话']),
  )
}

/** Shown only when the running DSH is missing something the plugin expects. */
function healthBanner(health) {
  const missing = (health.missing || []).slice(0, 4).join('、')
  return el('div', {
    class: 'tool',
    style: 'margin:0 2px 10px;border-color:#6b4a12;background:#241a06',
  }, [
    el('div', { class: 'tool-head' }, [
      el('span', { class: 'tool-name', style: 'color:#fbbf24' }, '插件与当前 DSH 版本不完全匹配'),
    ]),
    el('div', { class: 'tool-body', style: 'color:#ffd9a0;max-height:none' }, [
      `缺少：${missing || '未知能力'}。相关功能会不可用，其余功能不受影响。更新插件通常即可恢复。`,
    ]),
  ])
}

function sessionRow(session) {
  const title = session.title || '未命名会话'
  return el('div', {
    class: `session${session.running ? ' running' : ''}`,
    onclick: () => openSession(session.id),
  }, [
    el('div', { class: 'dot' }),
    el('div', { class: 'body' }, [
      el('div', { class: `title${session.title ? '' : ' blank'}`, text: title }),
      el('div', { class: 'meta' }, [
        el('span', { text: ago(session.updatedAt) }),
        session.running ? el('span', { class: 'tag', text: '运行中' }) : null,
      ]),
    ]),
  ])
}

function shortPath(path) {
  const parts = String(path).split(/[\\/]/).filter(Boolean)
  return parts.slice(-1)[0] || path
}

/* ------------------------------------------------------------------ chat */

function renderChat() {
  const session = state.current
  const title = session.title || '未命名会话'
  const meta = [session.running ? '运行中' : '空闲', modelLabel()].filter(Boolean).join(' · ')

  // Until the opening snapshot lands there is nothing truthful to show: paint a
  // quiet loading line instead of an empty transcript, so the session opens
  // directly at the bottom instead of flashing the top of the conversation.
  const body = state.snapshotAt ? chatRows() : [chatLoading()]
  // The old element is about to be replaced; capture the reader's distance from
  // the bottom NOW, because the fresh .chat starts at scrollTop 0 and would
  // otherwise look "at bottom" and let scrollToBottom() yank them down.
  const previousChat = document.getElementById('chat')
  const previousFromBottom = previousChat ? previousChat.scrollHeight - previousChat.scrollTop - previousChat.clientHeight : 0
  const wasReaderScrolledUp = Boolean(previousChat) && previousFromBottom >= 48
  const previousTop = previousChat?.scrollTop ?? null
  const chat = el('div', { class: 'chat', id: 'chat' }, body)
  const composer = composerNode()
  const approval = approvalStrip()
  const questions = questionStrip()

  app.replaceChildren(
    topbar(title, meta, {
      back: true,
      right: [el('button', { class: 'icon-btn', onclick: () => openSheet(sessionSheet) }, [svg(ICON.menu)])],
    }),
    approval || '',
    chat,
    questions || '',
    composer,
  )
  if (state.preserveScroll != null) {
    // Loading earlier history: hold the reader's place instead of jumping.
    chat.scrollTop = chat.scrollHeight - state.preserveScroll
    state.preserveScroll = null
  } else if (wasReaderScrolledUp) {
    // The reader is somewhere up the transcript (thinking over a long
    // reasoning block). Re-pin their old offset; content appended below never
    // drags the view down, and the jump pill covers returning to the newest.
    chat.scrollTop = Math.min(previousTop ?? 0, Math.max(0, chat.scrollHeight - chat.clientHeight - 1))
  } else {
    scrollToBottom()
  }
  refreshJumpButton()
  // A re-render replaces the textarea; put the caret back where the user had it.
  if (state.composerFocus) {
    const field = app.querySelector('.composer-card textarea')
    if (field) {
      field.focus({ preventScroll: true })
      const end = field.value.length
      try { field.setSelectionRange(end, end) } catch { /* not selectable */ }
    }
  }
  ensureTurnClock()
}

/* A running turn shows a ticking clock; the element is re-created on every
 * render, so the interval only rewrites its text and clears itself once the
 * element is gone. */
let turnClockTimer = null

function ensureTurnClock() {
  const node = document.getElementById('turn-clock')
  if (!node || !state.turnStartedAt) {
    if (turnClockTimer) {
      clearInterval(turnClockTimer)
      turnClockTimer = null
    }
    return
  }
  if (turnClockTimer) return
  turnClockTimer = setInterval(() => {
    const clock = document.getElementById('turn-clock')
    if (!clock || !state.turnStartedAt) {
      clearInterval(turnClockTimer)
      turnClockTimer = null
      return
    }
    clock.textContent = `已用时 ${elapsedLabel(Date.now() - state.turnStartedAt)}`
  }, 1000)
}

function chatRows() {
  const rows = []
  let lastAssistant = null
  let turnStartedAt = null
  let lastAssistantColumn = null
  let turnUsage = null

  // Pair every tool call with its result up front: a re-render has to show the
  // call's real outcome, not the "running" state it was created with.
  const resultsByCall = new Map()
  let lastTurnEndSeq = null
  for (const event of state.events) {
    if (event?.type === 'tool/result') {
      const callId = event.data?.message?.toolCallId
      if (callId) resultsByCall.set(callId, event)
    }
    if (event?.type === 'turn/end' && event.seq != null) {
      if (lastTurnEndSeq == null || event.seq > lastTurnEndSeq) lastTurnEndSeq = event.seq
    }
  }
  // A call inside a finished turn whose result never arrived (pruned or lost)
  // is not still running; say so instead of a stuck spinner label.
  const silentlyFinished = (callSeq) =>
    callSeq != null && lastTurnEndSeq != null && callSeq < lastTurnEndSeq

  if (state.hasMore && state.events.length) rows.push(loadEarlierRow())

  // A reconnect can hand the same seq twice (live frame plus the following
  // snapshot). Counting a duplicate would inflate that turn's tokens, so the
  // transcript renders every seq at most once.
  const seenSeqs = new Set()

  for (const event of state.events) {
    if (!event || !event.type) continue
    if (event.seq != null) {
      if (seenSeqs.has(event.seq)) continue
      seenSeqs.add(event.seq)
    }
    // Only append-origin surface events belong in the transcript; runtime
    // context and tool-addition rows are model-facing bookkeeping.
    if (event.surfaceOp && event.surfaceOp !== 'append') continue
    if (event.type === 'turn/start') {
      turnStartedAt = event.time || null
      lastAssistantColumn = null
      turnUsage = { tokens: 0, input: 0, cache: 0, cacheWrite: 0 }
      continue
    }
    if (event.type === 'user/message') {
      if (event.data?.source?.kind !== 'user') continue
      const content = Array.isArray(event.data?.content) ? event.data.content : []
      const text = textOf(event.data?.content)
      const images = content.filter((block) => block?.type === 'image' && block.attachment?.attachmentId)
      if (!text && images.length === 0) continue
      rows.push(el('div', { class: 'row user' }, [
        el('div', { class: 'bubble' }, [
          ...images.map((block) => el('img', {
            class: 'msg-image',
            src: `/api/attachments/${encodeURIComponent(block.attachment.attachmentId)}`,
            alt: '图片',
          })),
          text ? el('div', { text }) : null,
        ]),
      ]))
      continue
    }
    if (event.type === 'assistant/message') {
      const message = event.data?.message
      const text = textOf(message?.content)
      const reasoning = reasoningOf(message?.content)
      // Token usage rides on each assistant message; the turn's figure is their sum.
      // `tok` follows the desktop's meter exactly: uncached input + cache read +
      // cache write + output (dsh-token-meter's usageTokens). Counting only
      // input+output made a cached conversation look ~100× cheaper than it is.
      if (event.data?.usage) {
        const usage = event.data.usage
        const input = Number(usage.inputTokens) || 0
        const cacheRead = Number(usage.cacheReadTokens) || 0
        const cacheWrite = Number(usage.cacheWriteTokens) || 0
        const output = Number(usage.outputTokens) || 0
        turnUsage = turnUsage || { tokens: 0, input: 0, cache: 0, cacheWrite: 0 }
        turnUsage.tokens += input + cacheRead + cacheWrite + output
        turnUsage.input += input
        turnUsage.cache += cacheRead
        turnUsage.cacheWrite += cacheWrite
      }
      if (!text && !reasoning) continue
      const bubble = el('div', { class: 'bubble' }, [
        reasoning ? reasoningNode(reasoning) : null,
        text ? el('div', { class: 'md' }, [renderMarkdown(text)]) : null,
      ])
      const column = el('div', { class: 'col' }, [bubble, text ? messageActions(text) : null])
      rows.push(el('div', { class: 'row assistant' }, [column]))
      lastAssistant = bubble
      lastAssistantColumn = column
      continue
    }
    if (event.type === 'tool/call') {
      rows.push(toolRow(event.data, resultsByCall.get(event.data?.callId), silentlyFinished(event.seq)))
      continue
    }
    if (event.type === 'tool/result') continue
    if (event.type === 'turn/end' && event.data?.reason?.kind === 'error') {
      rows.push(el('div', { class: 'row note' }, [
        el('div', { class: 'note-pill', text: '本回合出错：' + (event.data.reason.error?.message || '未知错误') }),
      ]))
      continue
    }
    if (event.type === 'turn/end' && event.data?.reason?.kind === 'aborted') {
      rows.push(el('div', { class: 'row note' }, [el('div', { class: 'note-pill', text: '已停止' })]))
    }
    if (event.type === 'turn/end') {
      // Duration, completion time, tokens and cache hit rate sit under the
      // answer they measure. The completion clock is 24-hour so an overnight
      // task's finish time is unambiguous.
      const parts = []
      if (turnStartedAt && event.time && event.time >= turnStartedAt) {
        parts.push(`本轮用时 ${elapsedLabel(event.time - turnStartedAt)}`)
      }
      // The finish clock is 24-hour so an overnight task's end is unambiguous.
      if (event.time) parts.push(`完成于 ${clockLabel(event.time)}`)
      if (turnUsage && turnUsage.tokens > 0) {
        parts.push(`${tokenCount(turnUsage.tokens)} tok`)
        const prompt = turnUsage.input + turnUsage.cache + (turnUsage.cacheWrite || 0)
        const hit = cacheHitLabel(turnUsage.cache, prompt)
        if (hit) parts.push(`缓存命中 ${hit}%`)
      }
      if (parts.length) {
        const text = parts.join(' · ')
        if (lastAssistantColumn) {
          lastAssistantColumn.append(el('div', { class: 'turn-meta', text }))
        } else {
          rows.push(el('div', { class: 'row note' }, [el('div', { class: 'note-pill', text })]))
        }
      }
      turnStartedAt = null
      lastAssistantColumn = null
      turnUsage = null
    }
  }

  // Tool calls already rendered inline; append their result cards in order.
  for (const card of state.toolResults.values()) {
    if (card.parent && !card.parent.isConnected) rows.push(card.parent)
  }

  if (state.live && (state.live.text || state.live.reasoning)) {
    rows.push(
      el('div', { class: 'row assistant' }, [
        el('div', { class: 'bubble', id: 'live-bubble' }, [
          state.live.reasoning ? reasoningNode(state.live.reasoning) : null,
          state.live.text ? el('div', { id: 'live-text', text: state.live.text }) : null,
        ]),
      ]),
    )
  }

  // A turn that is still running gets a live clock under the answer;
  // ensureTurnClock() ticks it.
  if (state.current?.running && state.turnStartedAt) {
    rows.push(
      el('div', { class: 'row' }, [
        el('div', {
          class: 'turn-meta',
          id: 'turn-clock',
          text: `已用时 ${elapsedLabel(Date.now() - state.turnStartedAt)}`,
        }),
      ]),
    )
  }

  if (rows.length === 0) rows.push(emptyChat())
  return rows
}

/**
 * Cache hit percentage the way the desktop formats it: start at one decimal and
 * add precision until the number stops rounding up to 100, so a nearly cached
 * prompt never reads as "100.0%" when a few tokens were still uncached.
 */
function cacheHitLabel(cacheRead, prompt) {
  if (!prompt || prompt <= 0) return null
  if (prompt - cacheRead <= 0) return '100'
  for (let places = 1; places <= 4; places += 1) {
    const factor = 10 ** places
    const units = Math.round((cacheRead / prompt) * 100 * factor)
    if (units < 100 * factor) return (units / factor).toFixed(places)
  }
  return '99.9999'
}

/** 812 / 12.4k / 3.9M — compact token counts like the desktop footer. */
function tokenCount(value) {  const n = Number(value) || 0
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return String(n)
}

/** 24-hour "HH:MM(:SS)" for a wall-clock timestamp; seconds only on odd ones. */
function clockLabel(time) {
  const date = new Date(time)
  return date.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    ...(date.getSeconds() ? { second: '2-digit' } : {}),
  })
}

/** "12 秒" / "3 分 05 秒" / "1 小时 02 分" for a turn's wall-clock time. */
function elapsedLabel(milliseconds) {
  const total = Math.max(0, Math.round(milliseconds / 1000))
  const minutes = Math.floor(total / 60)
  const hours = Math.floor(minutes / 60)
  if (hours > 0) return `${hours} 小时 ${String(minutes % 60).padStart(2, '0')} 分`
  if (minutes > 0) return `${minutes} 分 ${String(total % 60).padStart(2, '0')} 秒`
  return `${total} 秒`
}

/** Copy / read-aloud under an answer, like the desktop transcript's actions. */
function messageActions(text) {
  const actions = []
  actions.push(
    el('button', {
      class: 'msg-act',
      title: '复制',
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(text)
          toast('已复制')
        } catch {
          toast('这台设备不允许剪贴板')
        }
      },
    }, [svg(ICON.copy, 17)]),
  )
  if (typeof window.speechSynthesis === 'object') {
    actions.push(
      el('button', {
        class: 'msg-act',
        title: '朗读',
        onclick: () => {
          try {
            window.speechSynthesis.cancel()
            const utterance = new SpeechSynthesisUtterance(text)
            utterance.lang = 'zh-CN'
            window.speechSynthesis.speak(utterance)
          } catch {
            toast('这台设备没有朗读能力')
          }
        },
      }, [svg(ICON.speaker, 17)]),
    )
  }
  return el('div', { class: 'msg-actions' }, actions)
}

/** Empty transcript: brand mark, greeting, and the way to start. */
function emptyChat() {
  return el('div', { class: 'chat-empty' }, [
    brandMark(),
    el('div', { class: 'empty-title', text: '开始和电脑上的 DSH 对话吧' }),
    el('div', { class: 'empty-sub', text: '消息会发到电脑上这个会话里，模型、权限都按你选好的来' }),
  ])
}

/** Backwards pagination: the pill above the oldest loaded turn. */
function loadEarlierRow() {
  return el('div', { class: 'row load-earlier' }, [
    el('button', { class: 'load-earlier-btn', id: 'load-earlier', onclick: loadEarlier }, '加载更早'),
  ])
}

/** Oldest durable seq currently rendered. */
function earliestSeq() {
  let min = null
  for (const event of state.events) {
    if (event?.seq == null) continue
    if (min == null || event.seq < min) min = event.seq
  }
  return min
}

async function loadEarlier() {
  const button = document.getElementById('load-earlier')
  const id = state.current?.id
  const before = earliestSeq()
  if (!button || button.disabled || !id || !state.cursor || before == null) return
  button.disabled = true
  button.textContent = '加载中…'
  const chat = document.getElementById('chat')
  const fromBottom = chat ? chat.scrollHeight - chat.scrollTop : 0
  try {
    const page = await api(
      `/api/sessions/${encodeURIComponent(id)}/history?through=${encodeURIComponent(state.cursor)}&before=${encodeURIComponent(before)}&limit=30`,
    )
    const known = new Set(state.events.map((event) => event.seq))
    const older = (page.records || [])
      .map((record) => record.event)
      .filter((event) => event && !known.has(event.seq))
    state.hasMore = Boolean(page.hasMore)
    if (older.length) {
      state.events = [...older, ...state.events]
      state.preserveScroll = fromBottom
      render()
    } else {
      render()
      toast(state.hasMore ? '没有更多更早的消息了' : '已经到对话开头')
    }
  } catch (error) {
    button.disabled = false
    button.textContent = '加载更早'
    toast('加载失败：' + error.message)
  }
}

/** Shown between opening a session and its first snapshot frame. */
function chatLoading() {
  return el('div', { class: 'chat-loading' }, [
    el('div', { class: 'spinner' }),
    el('div', { text: '正在读取会话…' }),
  ])
}

/** Inline brand mark, so the empty state never waits on a network asset. */
function brandMark() {
  const ns = 'http://www.w3.org/2000/svg'
  const node = document.createElementNS(ns, 'svg')
  node.setAttribute('viewBox', '0 0 64 64')
  node.setAttribute('width', '64')
  node.setAttribute('height', '64')
  node.setAttribute('class', 'empty-mark')
  node.innerHTML =
    '<defs><linearGradient id="ccdsh-mark" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0" stop-color="#426efe"/><stop offset="1" stop-color="#1d4ed8"/></linearGradient></defs>' +
    '<rect x="2" y="2" width="60" height="60" rx="17" fill="url(#ccdsh-mark)"/>' +
    '<path d="M21 24.5l7.5 7.5-7.5 7.5" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<path d="M34.5 40.5h9" stroke="#fff" stroke-width="4" stroke-linecap="round"/>'
  return node
}

function reasoningNode(text) {
  return el('details', { class: 'reasoning' }, [
    el('summary', { text: `思考过程 · ${text.length} 字` }),
    el('div', { text }),
  ])
}

function toolRow(data, result, ended) {
  const name = data?.name || 'tool'
  let args = data?.arguments || ''
  try {
    args = JSON.stringify(JSON.parse(args), null, 1)
  } catch {}
  const failed = Boolean(result?.data?.error) || Boolean(result?.data?.message?.isError)
  const finished = Boolean(result) || Boolean(ended)
  const status = el('span', {
    class: `tool-status${result ? (failed ? ' err' : ' ok') : ''}`,
    text: result ? (failed ? '失败' : '完成') : (ended ? '已结束' : '运行中'),
  })
  // Finished calls show their output instead of the arguments.
  const output = finished
    ? (textOf(result?.data?.message?.content) || String(result?.data?.error?.reason || ''))
    : ''
  const body = el('div', { class: 'tool-body', text: (finished && output ? (failed ? '错误：' : '') + output : args).slice(0, 6000) })
  // Collapsed like the desktop transcript; open while the call is running.
  const card = el('details', {
    class: 'tool',
    ...(finished ? {} : { open: 'open' }),
    dataset: { callId: data?.callId || '' },
  }, [
    el('summary', { class: 'tool-head' }, [el('span', { class: 'tool-name', text: name }), status]),
    body,
  ])
  if (data?.callId) state.toolResults.get(data.callId)?.node?.remove()
  return card
}

function attachToolResult(data) {
  const callId = data?.message?.toolCallId
  const card = document.querySelector(`.tool[data-call-id="${CSS.escape(callId || '')}"]`)
  if (!card) return
  const status = card.querySelector('.tool-status')
  const body = card.querySelector('.tool-body')
  const failed = Boolean(data?.error) || Boolean(data?.message?.isError)
  if (status) {
    status.textContent = failed ? '失败' : '完成'
    status.className = 'tool-status ' + (failed ? 'err' : 'ok')
  }
  if (body) {
    const text = textOf(data?.message?.content) || String(data?.error?.reason || '')
    if (text) {
      body.textContent = (failed ? '错误：' : '') + text.slice(0, 6000)
      body.style.maxHeight = failed ? '260px' : '160px'
    }
  }
  // Finished calls fold away; the user can still open one to read the output.
  if (card.tagName === 'DETAILS') card.removeAttribute('open')
}

function textOf(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && (block.type === 'text' || typeof block.text === 'string') && block.type !== 'reasoning')
    .map((block) => block.text || '')
    .join('\n')
}

/* ------------------------------------------------------------ markdown-lite */

/**
 * Answers arrive as Markdown. Rendering it keeps the transcript readable the
 * way the desktop shows it; everything is built from text nodes, so model
 * output can never inject markup.
 */
function renderMarkdown(text) {
  const frag = document.createDocumentFragment()
  const lines = String(text || '').split('\n')
  let block = null          // open paragraph / list / code element
  let code = null           // open <pre> while inside a fence
  let list = null

  const closeBlock = () => { block = null }
  const closeList = () => { list = null }

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')

    if (code) {
      if (/^```/.test(line.trim())) {
        frag.append(code)
        code = null
      } else {
        code.textContent += (code.textContent ? '\n' : '') + raw
      }
      continue
    }

    const fence = /^```(\w*)/.exec(line.trim())
    if (fence) {
      closeBlock(); closeList()
      code = el('pre', { class: 'md-code' })
      if (fence[1]) code.dataset.lang = fence[1]
      continue
    }

    if (!line.trim()) { closeBlock(); closeList(); continue }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line)
    if (heading) {
      closeBlock(); closeList()
      frag.append(el(`h${Math.min(4, heading[1].length + 2)}`, { class: 'md-h' }, [inlineMarkdown(heading[2])]))
      continue
    }

    const bullet = /^[-*]\s+(.*)$/.exec(line)
    if (bullet) {
      closeBlock()
      if (!list) { list = el('ul', { class: 'md-list' }); frag.append(list) }
      list.append(el('li', {}, [inlineMarkdown(bullet[1])]))
      continue
    }

    const ordered = /^\d+[.)]\s+(.*)$/.exec(line)
    if (ordered) {
      closeBlock()
      if (!list) { list = el('ol', { class: 'md-list' }); frag.append(list) }
      list.append(el('li', {}, [inlineMarkdown(ordered[1])]))
      continue
    }

    closeList()
    if (!block) { block = el('p', { class: 'md-p' }); frag.append(block) }
    if (block.childNodes.length) block.append(el('br'))
    block.append(inlineMarkdown(line))
  }

  if (code) frag.append(code)
  return frag
}

/** `code`, **bold** and bare links, built from text nodes only. */
function inlineMarkdown(text) {
  const frag = document.createDocumentFragment()
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(https?:\/\/[^\s)]+)/g
  let last = 0
  let match
  while ((match = pattern.exec(text))) {
    if (match.index > last) frag.append(document.createTextNode(text.slice(last, match.index)))
    const token = match[0]
    if (token.startsWith('`')) frag.append(el('code', { text: token.slice(1, -1) }))
    else if (token.startsWith('**')) frag.append(el('strong', { text: token.slice(2, -2) }))
    else frag.append(el('a', { href: token, target: '_blank', rel: 'noreferrer', text: token }))
    last = match.index + token.length
  }
  if (last < text.length) frag.append(document.createTextNode(text.slice(last)))
  return frag
}

function reasoningOf(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && block.type === 'reasoning')
    .map((block) => block.text || '')
    .join('\n')
}

/* ------------------------------------------------------------- composer draft */

/**
 * Unsent text and picked images belong to the session, not to the DOM node:
 * the transcript re-renders on every event, and leaving the chat must not throw
 * away what was typed. Text also survives a reload through localStorage.
 */
const DRAFTS = new Map()

function draftKey(sessionId) {
  return sessionId || 'new'
}

function draftFor(sessionId) {
  const key = draftKey(sessionId)
  let draft = DRAFTS.get(key)
  if (!draft) {
    draft = { text: '', images: [] }
    try {
      draft.text = localStorage.getItem(`ccdsh_draft_${key}`) || ''
    } catch { /* private mode */ }
    DRAFTS.set(key, draft)
  }
  return draft
}

function saveDraftText(sessionId, text) {
  const draft = draftFor(sessionId)
  draft.text = text
  try {
    if (text) localStorage.setItem(`ccdsh_draft_${draftKey(sessionId)}`, text)
    else localStorage.removeItem(`ccdsh_draft_${draftKey(sessionId)}`)
  } catch { /* private mode */ }
}

function clearDraft(sessionId) {
  const draft = draftFor(sessionId)
  draft.text = ''
  draft.images = []
  try {
    localStorage.removeItem(`ccdsh_draft_${draftKey(sessionId)}`)
  } catch { /* private mode */ }
}

/* Status updates replace only this dock, preserving the input, focus and chat scroll. */
function refreshProgressDock() {
  const dock = document.getElementById('progress-dock')
  if (!dock || state.view !== 'chat') return
  const focused = dock.contains(document.activeElement)
    ? document.activeElement.closest('button')?.classList.contains('progress-toggle') ? '.progress-toggle' : '.goal-status'
    : null
  const scrollTop = dock.querySelector('.progress-tasks')?.scrollTop || 0
  const next = progressDock()
  dock.replaceWith(next)
  const list = next.querySelector('.progress-tasks')
  if (list) list.scrollTop = scrollTop
  if (focused) next.querySelector(focused)?.focus({ preventScroll: true })
}

function progressDock() {
  const todos = state.progress.todos || []
  const goal = state.progress.goal
  const showGoal = goal && !['complete', 'completed', 'cleared'].includes(goal.phase)
  const children = []
  if (todos.length) {
    const counts = todoCounts(todos)
    const summary = `${counts.completed} 已完成 · ${counts.in_progress} 进行中 · ${counts.pending} 待处理`
    const expanded = state.tasksExpanded
    children.push(el('section', { class: 'task-status', 'aria-label': '任务清单' }, [
      el('button', {
        class: 'progress-toggle', type: 'button',
        'aria-label': '任务，' + summary + (expanded ? '，收起清单' : '，展开清单'),
        'aria-expanded': String(expanded), 'aria-controls': 'progress-tasks',
        onclick: () => { state.tasksExpanded = !state.tasksExpanded; refreshProgressDock() },
      }, [
        el('span', { class: 'progress-glyph', 'aria-hidden': 'true', text: '☷' }),
        el('span', { class: 'progress-title', text: '任务' }),
        el('span', { class: 'progress-counts', text: summary }),
        el('span', { class: 'progress-chevron', 'aria-hidden': 'true', text: expanded ? '⌃' : '⌄' }),
      ]),
      expanded ? el('ul', { id: 'progress-tasks', class: 'progress-tasks' }, todos.map((todo) =>
        el('li', { class: 'progress-task ' + todo.status }, [
          el('span', { class: 'task-mark', 'aria-hidden': 'true', text: todo.status === 'completed' ? '✓' : todo.status === 'in_progress' ? '◉' : '○' }),
          el('span', { class: 'task-content', text: todo.content }),
          el('span', { class: 'task-state', text: { completed: '已完成', in_progress: '进行中', pending: '待处理' }[todo.status] }),
        ]))) : null,
    ]))
  }
  if (showGoal) {
    const label = goalPhaseLabel(goal)
    children.push(el('button', {
      class: 'goal-status ' + goal.phase, type: 'button',
      'aria-label': label + '：' + goal.objective + '，查看详情',
      onclick: openGoalPanel,
    }, [
      el('span', { class: 'progress-glyph', 'aria-hidden': 'true', text: '◎' }),
      el('span', { class: 'goal-summary' }, [
        el('span', { class: 'goal-label', text: label }),
        el('span', { class: 'goal-objective', text: goal.objective }),
        goal.phase === 'blocked' && goal.blockedReason?.message
          ? el('span', { class: 'goal-blocker', text: goal.blockedReason.message }) : null,
      ]),
      el('span', { class: 'goal-rounds', text: goal.roundsStarted + ' / ' + (goal.maxGoalRounds || '∞') + ' 轮' }),
      el('span', { class: 'progress-chevron', 'aria-hidden': 'true', text: '›' }),
    ]))
  }
  return el('div', { id: 'progress-dock', class: 'progress-dock', hidden: !children.length }, children)
}

// Activation is runtime state rather than a durable log event. Match both the
// session and goal revision so a late read cannot undo an edit, clear or switch.
let goalActivationRead = 0
async function refreshGoalActivation() {
  const sessionId = state.current?.id
  const goal = state.progress.goal
  if (state.view !== 'chat' || !sessionId || !goal || goal.phase !== 'active') return
  const read = ++goalActivationRead
  try {
    const data = await api('/api/goal?session=' + encodeURIComponent(sessionId))
    if (read !== goalActivationRead || state.current?.id !== sessionId) return
    if (applyGoalActivation(state.progress, { goal: data.goal })) refreshProgressDock()
  } catch { /* the durable projection still shows the goal while offline */ }
}

/**
 * Desktop-style session stats line under the composer: steps, tok/s, total
 * tokens, cache hit rate and context pressure. Reads the Host projections that
 * ride on every snapshot; hidden entirely when a projection is absent.
 */
function sessionStatsBar() {
  const stats = state.stats || {}
  const usage = stats.tokenUsage
  const session = stats.sessionStats
  const pressure = stats.contextPressure
  const parts = []
  if (session) {
    parts.push({ icon: '<circle cx="12" cy="12" r="9"/><path d="M9 12h6"/>' , text: `${session.turns ?? 0} 轮 ${session.steps ?? 0} 步` })
    // Desktop's tok/s is decodeTokens over decodeMs (decoding time only).
    const decodeSeconds = session.decodeMs > 0 ? session.decodeMs / 1000 : 0
    if (decodeSeconds > 0 && (session.decodeTokens || 0) > 0) {
      parts.push({ icon: '<path d="M13 2L4 14h6l-1 8 9-12h-6l1-8z"/>', text: `${tokenCount(Math.round(session.decodeTokens / decodeSeconds))}/s` })
    }
  }
  if (usage) {
    const total = (usage.uncachedInputTokens || 0) + (usage.cacheReadTokens || 0) + (usage.cacheWriteTokens || 0) + (usage.outputTokens || 0)
    if (total > 0) {
      parts.push({ icon: '<ellipse cx="12" cy="5" rx="8" ry="2.5"/><path d="M4 5v6c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5V5"/><path d="M4 11v6c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5v-6"/>', text: `${tokenCount(total)} tok` })
      const prompt = (usage.uncachedInputTokens || 0) + (usage.cacheReadTokens || 0) + (usage.cacheWriteTokens || 0)
      const hit = cacheHitLabel(usage.cacheReadTokens || 0, prompt)
      if (hit) parts.push({ icon: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>', text: `缓存命中 ${hit}%` })
    }
  }
  if (pressure?.pressureTokens && pressure?.contextWindow) {
    parts.push({ icon: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/>', text: `${Math.round((pressure.pressureTokens / pressure.contextWindow) * 100)}%` })
  }
  if (!parts.length) return null
  return el('div', { class: 'stats-bar' }, parts.map((part) =>
    el('span', { class: 'stats-item' }, [svg(part.icon, 12), el('span', { text: part.text })])))
}

function composerNode() {
  const sessionId = state.current?.id
  const draft = draftFor(sessionId)
  const input = el('textarea', {
    rows: '1',
    placeholder: state.current?.running ? '继续追加指令…' : '发给电脑上的 DSH…',
    oninput: (event) => {
      event.target.style.height = 'auto'
      event.target.style.height = Math.min(event.target.scrollHeight, 140) + 'px'
      saveDraftText(sessionId, event.target.value)
      syncSendButton()
    },
    onfocus: () => { state.composerFocus = true },
    onblur: () => { state.composerFocus = false },
    onkeydown: (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault()
        send()
      }
    },
  })
  input.value = draft.text
  queueMicrotask(() => {
    input.style.height = 'auto'
    input.style.height = Math.min(input.scrollHeight, 140) + 'px'
  })

  const picker = el('input', {
    type: 'file',
    accept: 'image/png,image/jpeg,image/webp,image/gif',
    multiple: 'multiple',
    style: 'display:none',
    onchange: (event) => addFiles([...event.target.files])
  })

  const attachButton = el('button', {
    class: 'icon-btn',
    style: 'width:38px;height:38px;border-radius:50%',
    title: '添加图片',
    onclick: () => picker.click(),
  }, [svg(ICON.clip, 18)])

  const attachRow = el('div', { class: 'attach-row', id: 'attach-row' })

  function renderAttachments() {
    const images = draft.images
    attachRow.replaceChildren(
      ...images.map((item, index) =>
        el('div', { class: 'attach' }, [
          el('img', { src: item.preview }),
          el('button', { class: 'x', onclick: () => { images.splice(index, 1); renderAttachments() } }, '×'),
        ]),
      ),
    )
    attachRow.style.display = images.length ? 'flex' : 'none'
    syncSendButton()
  }

  async function addFiles(files) {
    for (const file of files.slice(0, 4)) {
      if (!file.type.startsWith('image/')) {
        toast('目前只支持图片；文件请用电脑端')
        continue
      }
      if (file.size > 4 * 1024 * 1024) {
        toast(`${file.name} 超过 4MB，先压缩再发`)
        continue
      }
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.onerror = () => reject(reader.error)
        reader.readAsDataURL(file)
      })
      const [meta, base64] = dataUrl.split(',')
      const mediaType = (meta.match(/data:([^;]+)/) || [])[1] || file.type
      draft.images.push({ mediaType, data: base64, name: file.name, preview: dataUrl })
    }
    renderAttachments()
  }

  const draftHasContent = () => Boolean(input.value.trim() || draft.images.length)
  // A running turn only turns the button into "stop" while there is nothing to
  // send: typing a line and tapping must append to the running turn, not cancel
  // it. Clearing the box returns the button to stop.
  const wantsStop = () => composerAction({ running: Boolean(state.current?.running), hasDraft: draftHasContent() }) === 'stop'
  const idle = () => !state.current?.running && !draftHasContent()
  // Long-press keeps "stop" reachable without clearing a draft the user is
  // still writing; a plain tap with a draft queues instead.
  let stopHold = null
  let holdFired = false
  const cancelHold = () => {
    if (stopHold) clearTimeout(stopHold)
    stopHold = null
  }
  const button = el('button', {
    class: 'send',
    onclick: () => {
      if (holdFired) { holdFired = false; return }
      if (wantsStop()) stop()
      else send()
    },
    onpointerdown: () => {
      if (!state.current?.running) return
      cancelHold()
      stopHold = setTimeout(() => {
        stopHold = null
        holdFired = true
        if (state.current?.running) stop()
      }, 600)
    },
    onpointerup: cancelHold,
    onpointercancel: cancelHold,
    onpointerleave: cancelHold,
  })

  function syncSendButton() {
    const stopping = wantsStop()
    button.classList.toggle('stop', stopping)
    button.classList.toggle('idle', idle())
    button.title = stopping
      ? '停止这一轮'
      : state.current?.running
        ? '插入当前一轮（排在当前步骤之后，不打断；长按停止）'
        : '发送'
    button.replaceChildren(svg(stopping ? ICON.stop : ICON.send, 19))
  }
  syncSendButton()

  async function send() {
    const text = input.value.trim()
    const images = draft.images.map(({ mediaType, data }) => ({ type: 'image', mediaType, data }))
    if (!text && images.length === 0) return
    input.value = ''
    input.style.height = 'auto'
    clearDraft(sessionId)
    renderAttachments()
    button.classList.toggle('idle', idle())
    const queued = Boolean(state.current?.running)
    try {
      await api(`/api/sessions/${encodeURIComponent(state.current.id)}/prompt`, {
        method: 'POST',
        // While a turn runs this queues after the current step; only an explicit
        // 'steer' would interrupt it, which the composer never sends by default.
        body: { text: text || '（图片）', images, mode: 'queue' },
      })
      state.current.running = true
      refreshSessionMeta()
      if (queued) toast('已插入：会排在当前这步之后')
    } catch (error) {
      toast('发送失败：' + error.message)
      input.value = text
      saveDraftText(sessionId, text)
    }
  }

  async function stop() {
    try {
      await api(`/api/sessions/${encodeURIComponent(state.current.id)}/cancel`, { method: 'POST', body: {} })
      toast('已请求停止')
      // Don't trust the toast: poll the Host briefly until it reports the turn
      // over (or give up and let the next snapshot correct us). A cancelled
      // long answer used to leave the phone showing "running" forever when the
      // turn/end frame got lost across an SSE reconnect.
      for (let attempt = 0; attempt < 10; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 1200))
        try {
          const page = await api(`/api/sessions/${encodeURIComponent(state.current.id)}?limit=1`)
          const events = (page.records || []).map((record) => record.event).filter(Boolean)
          const last = [...events].reverse().find((event) => event.type === 'turn/end' || event.type === 'turn/start')
          if (last && last.type === 'turn/end') {
            state.current.running = false
            syncRunningUi()
            return
          }
        } catch {
          return // offline: the reconnect snapshot will correct the state
        }
      }
    } catch (error) {
      toast('停止失败：' + error.message)
    }
  }

  renderAttachments()

  const stats = sessionStatsBar()
  return el('div', { class: 'composer-wrap' }, [
    progressDock(),
    attachRow,
    picker,
    el('div', { class: 'composer-card' }, [
      input,
      el('div', { class: 'composer-tools' }, [
        el('div', { class: 'hint-row', id: 'hints' }, hintChips()),
        el('div', { class: 'composer-actions' }, [attachButton, button]),
      ]),
    ]),
    stats || '',
  ])
}

function hintChips() {
  const chips = []
  const model = currentModel()
  chips.push(
    el('button', { class: 'chip on', onclick: () => openSheet(modelSheet) }, [
      svg(ICON.spark, 12),
      model ? model.name : '选择模型',
    ]),
  )
  const preset = state.current?.agentPreset || state.current?.projections?.agentPreset
  chips.push(el('button', { class: 'chip', onclick: () => openSheet(presetSheet) }, [preset || '默认模式']))
  const permission = state.current?.permission
  if (permission) {
    const short = { 'danger-full-access': '完全访问', 'workspace-write': '仅工作区', 'read-only': '只读' }[permission] || permission
    chips.push(el('button', { class: 'chip', onclick: () => openSheet(permissionSheet) }, [short]))
  }
  const armed = state.approvals.armedUntil > Date.now()
  chips.push(
    el('button', {
      class: `chip${armed ? ' warn' : ''}`,
      onclick: () => openSheet(approvalSheet),
    }, [armed ? '审批已接管' : '审批']),
  )
  return chips
}

function currentModel() {
  return matchModel(state.models.groups, state.current?.model || state.models.default)
}

function modelLabel() {
  const model = currentModel()
  if (!model) return ''
  const selection = state.current?.model || state.models.default
  const effort = model.reasoning?.efforts?.length
    ? selection?.reasoningEffort || model.reasoning?.defaultEffort
    : ''
  return effort ? `${model.name} · ${effort}` : model.name
}

function refreshSessionMeta() {
  syncRunningUi()
  const hints = document.getElementById('hints')
  if (hints) hints.replaceChildren(...hintChips())
}

/** Push the current running flag into the composer chrome (stop/send button, header). */
function syncRunningUi() {
  const sub = document.querySelector('.topbar .sub')
  if (sub) sub.textContent = [state.current?.running ? '运行中' : '空闲', modelLabel()].filter(Boolean).join(' · ')
  const button = document.querySelector('.send')
  if (button) {
    // The composer decides stop vs send from the draft; keep its choice and only
    // refresh what a running-state change actually affects.
    const field = document.querySelector('.composer-card textarea')
    const draft = draftFor(state.current?.id)
    const stopping = composerAction({ running: Boolean(state.current?.running), hasDraft: Boolean(field?.value.trim() || draft.images.length) }) === 'stop'
    button.classList.toggle('stop', stopping)
    button.replaceChildren(svg(stopping ? ICON.stop : ICON.send, 19))
    button.title = stopping
      ? '停止这一轮'
      : state.current?.running
        ? '插入当前一轮（排在当前步骤之后，不打断；长按停止）'
        : '发送'
  }
}

function approvalStrip() {
  const pending = state.approvals.pending || []
  if (!pending.length) return null
  return el('div', { class: 'approval-strip', style: 'padding:8px 12px 0' }, [
    el('div', {
      class: 'tool',
      style: 'border-color:#6b4a12;background:#241a06',
    }, [
      el('div', { class: 'tool-head' }, [
        el('span', { class: 'tool-name', style: 'color:#fbbf24' }, '等待你批准'),
        el('span', { class: 'tool-status', text: `${pending.length} 项` }),
      ]),
      ...pending.map((item) =>
        el('div', { style: 'margin-top:10px' }, [
          el('div', { text: item.title || item.tool || '工具调用', style: 'font-size:13px;color:#ffd9a0' }),
          item.detail ? el('div', { class: 'tool-body', text: String(item.detail).slice(0, 800) }) : null,
          el('div', { style: 'display:flex;gap:10px;margin-top:10px' }, [
            el('button', {
              class: 'chip on',
              onclick: () => answerApproval(item.id, 'allow'),
            }, '允许'),
            el('button', {
              class: 'chip',
              style: 'border-color:#5b1b22;color:#ffb4b4',
              onclick: () => answerApproval(item.id, 'deny'),
            }, '拒绝'),
          ]),
        ]),
      ),
    ]),
  ])
}

/* ---------------------------------------------------------------- questions */

/**
 * `ask_user_question` blocks the turn until someone answers. The desktop shows a
 * card for it; this is the same card on the phone, pinned above the composer so
 * it cannot be scrolled past. Options support single and multi select, plus the
 * free-text "other" answer the protocol allows on every question.
 */
function questionStrip() {
  const pending = state.questions?.pending || []
  if (!pending.length) return null
  const entry = pending[0]
  const drafts = state.questionDrafts[entry.id] || {}

  const answerFor = (question) => {
    const draft = drafts[question.id] || {}
    return {
      selected: Array.isArray(draft.selected) ? draft.selected : [],
      custom: draft.custom || '',
    }
  }
  const setAnswer = (questionId, patch) => {
    const entryDrafts = state.questionDrafts[entry.id] || (state.questionDrafts[entry.id] = {})
    entryDrafts[questionId] = { ...(entryDrafts[questionId] || {}), ...patch }
  }
  const chosen = (question, label) => answerFor(question).selected.includes(label)
  const toggle = (question, label) => {
    const current = answerFor(question).selected
    if (question.multiSelect) {
      setAnswer(question.id, {
        selected: current.includes(label) ? current.filter((item) => item !== label) : [...current, label],
      })
    } else {
      // A single-select answer is one label, and picking one clears the others.
      setAnswer(question.id, { selected: current.includes(label) ? [] : [label] })
    }
    render()
  }

  const remaining = pending.length > 1 ? ` · 还有 ${pending.length - 1} 组` : ''
  return el('div', { class: 'question-strip' }, [
    el('div', { class: 'question-card' }, [
      el('div', { class: 'question-head' }, [
        el('span', { class: 'question-kicker', text: `提问 · 等待回答${remaining}` }),
      ]),
      el('div', { class: 'question-body' }, entry.questions.map((question) =>
        el('div', { class: 'question-item' }, [
          question.header ? el('div', { class: 'question-header', text: question.header }) : null,
          el('div', { class: 'question-text', text: question.question }),
          question.detail ? el('div', { class: 'question-detail', text: question.detail }) : null,
          question.options.length
            ? el('div', { class: 'question-options' }, question.options.map((option, index) =>
                el('button', {
                  class: `question-option${chosen(question, option.label) ? ' on' : ''}`,
                  onclick: () => toggle(question, option.label),
                }, [
                  el('span', { class: 'question-index', text: String(index + 1) }),
                  el('span', { class: 'question-label', text: option.label }),
                  option.description ? el('span', { class: 'question-desc', text: option.description }) : null,
                ]),
              ))
            : null,
          el('input', {
            class: 'question-custom',
            placeholder: question.options.length ? '或者自己写一个答案…' : '输入你的答案…',
            value: answerFor(question).custom,
            oninput: (event) => setAnswer(question.id, { custom: event.target.value }),
          }),
        ]),
      )),
      el('div', { class: 'question-actions' }, [
        el('button', {
          class: 'question-submit',
          onclick: () => submitQuestion(entry),
        }, '提交'),
        el('button', {
          class: 'question-skip',
          onclick: () => submitQuestion(entry, true),
        }, '跳过'),
      ]),
    ]),
  ])
}

async function submitQuestion(entry, skip = false) {
  const drafts = state.questionDrafts[entry.id] || {}
  const answers = entry.questions.map((question) => {
    const draft = drafts[question.id] || {}
    if (skip) return { id: question.id, selected: [] }
    const custom = (draft.custom || '').trim()
    return {
      id: question.id,
      selected: Array.isArray(draft.selected) ? draft.selected : [],
      ...(custom ? { custom } : {}),
    }
  })
  try {
    await api(`/api/questions/${encodeURIComponent(entry.id)}`, { method: 'POST', body: { answers } })
    delete state.questionDrafts[entry.id]
    state.questions.pending = (state.questions.pending || []).filter((item) => item.id !== entry.id)
    toast(skip ? '已跳过' : '已提交')
    render()
  } catch (error) {
    toast('提交失败：' + error.message)
  }
}

async function answerApproval(id, decision) {  try {
    await api(`/api/approvals/${encodeURIComponent(id)}`, { method: 'POST', body: { decision } })
    state.approvals.pending = (state.approvals.pending || []).filter((item) => item.id !== id)
    render()
  } catch (error) {
    toast('提交失败：' + error.message)
  }
}

function scrollToBottom() {
  // Land at the bottom before the first paint, then once more after layout
  // settles (fonts, images). `.chat` is scroll-behavior:auto, so neither call
  // animates - opening a session no longer slides down the transcript. When the
  // reader has scrolled up (thinking over a long reasoning block), this stays
  // hands-off: only an explicit tap on the jump button returns to the bottom.
  const chat = document.getElementById('chat')
  if (!chat || chatAtBottom(chat)) return
  chat.scrollTop = chat.scrollHeight
  requestAnimationFrame(() => {
    const again = document.getElementById('chat')
    if (again && chatAtBottom(again)) return
    if (again) again.scrollTop = again.scrollHeight
  })
}

/** Whether the transcript is visually pinned to its newest line. */
function chatAtBottom(chat) {
  if (!chat) return true
  return chat.scrollHeight - chat.scrollTop - chat.clientHeight < 48
}

/**
 * Hard jump, ignoring the reader's position. Only the jump-to-bottom button and
 * explicit session changes use this.
 */
function forceScrollToBottom() {
  const chat = document.getElementById('chat')
  if (!chat) return
  chat.scrollTop = chat.scrollHeight
  requestAnimationFrame(() => {
    const again = document.getElementById('chat')
    if (again) again.scrollTop = again.scrollHeight
  })
}

/**
 * Whether the reader is scrolled up: while they are, transcript re-renders and
 * live streaming chunks stop dragging the view back to the bottom.
 */
function readerScrolledUp() {
  const chat = document.getElementById('chat')
  return Boolean(chat) && !chatAtBottom(chat)
}

/** Floating "back to newest" pill, shown only while the reader is scrolled up. */
function refreshJumpButton() {
  const chat = document.getElementById('chat')
  if (!chat || state.view !== 'chat') return
  let button = document.getElementById('jump-bottom')
  if (!readerScrolledUp()) {
    button?.remove()
    return
  }
  if (button) return
  button = el('button', {
    class: 'jump-bottom', id: 'jump-bottom', type: 'button',
    'aria-label': '跳到最新消息',
    title: '跳到最新消息',
    onclick: () => { forceScrollToBottom(); refreshJumpButton() },
  }, [svg('<path d="M6 9l6 6 6-6"/>', 18)])
  document.querySelector('.composer-wrap')?.prepend(button)
}

// The pill lives above the composer, which re-renders; keep visibility in sync
// on scroll and after every repaint.
document.addEventListener('scroll', (event) => {
  if (event.target?.id === 'chat') refreshJumpButton()
}, true)
window.addEventListener('resize', () => refreshJumpButton())

/* ------------------------------------------------------------------ stream */

function closeStream() {
  if (state.stream) {
    state.stream.close()
    state.stream = null
  }
}

function openStream(sessionId) {
  closeStream()
  const stream = new EventSource(`/api/sessions/${encodeURIComponent(sessionId)}/stream`)
  state.stream = stream

  stream.addEventListener('frame', (event) => {
    if (state.stream !== stream || state.current?.id !== sessionId) return
    let frame
    try {
      frame = JSON.parse(event.data)
    } catch {
      return
    }
    handleFrame(frame)
  })
  stream.addEventListener('goal-activation', (event) => {
    if (state.stream !== stream || state.current?.id !== sessionId) return
    try {
      const update = JSON.parse(event.data)
      if (update.sessionId === sessionId) {
        goalActivationRead += 1
        if (applyGoalActivation(state.progress, update)) refreshProgressDock()
      }
    } catch { /* a reconnect re-reads activation */ }
  })
  stream.addEventListener('questions', (event) => {
    try {
      const next = JSON.parse(event.data)
      const before = (state.questions?.pending || []).map((item) => item.id).join(',')
      state.questions = next
      const after = (next.pending || []).map((item) => item.id).join(',')
      if (before !== after) {
        // Only a change of *which* question is open needs a repaint; an answer
        // that is mid-typing must not be interrupted by a re-render.
        if ((next.pending || []).length) toast('电脑上在等你回答一个问题')
        render()
      }
    } catch {}
  })
  stream.addEventListener('approvals', (event) => {
    try {
      state.approvals = JSON.parse(event.data)
      if (state.view === 'chat') {
        const strip = document.querySelector('.approval-strip')
        if (strip) strip.replaceWith(approvalStrip() || el('div'))
        else render()
      }
    } catch {}
  })
  stream.addEventListener('error', () => {
    // EventSource retries on its own; the snapshot resets state on reconnect.
  })
  stream.addEventListener('end', () => {
    // The Host closed the follow (idle timeout, upstream hiccup). EventSource
    // does not always reconnect after a clean server close: force one.
    if (state.view === 'chat' && state.current?.id === sessionId) openStream(sessionId)
  })
}

function handleFrame(frame) {
  if (!frame || !frame.type) return
  if (frame.type === 'snapshot') {
    const incoming = (frame.records || []).map((record) => record.event).filter(Boolean)
    // A reconnect re-sends the newest window. Keep any older pages the user has
    // already loaded instead of collapsing the transcript back to the tail.
    const oldestIncoming = incoming[0]?.seq
    const keptOlder = state.events.length > 0 && oldestIncoming != null && state.events[0]?.seq < oldestIncoming
    state.events = keptOlder
      ? [...state.events.filter((event) => event.seq != null && event.seq < oldestIncoming), ...incoming]
      : incoming
    if (Number.isFinite(frame.cursor)) state.cursor = frame.cursor
    if (!keptOlder) state.hasMore = Boolean(frame.hasMore)
    state.snapshotAt = state.current?.id || true
    const values = frame.projections?.values || {}
    state.progress = progressFromSnapshot(frame)
    state.stats = {
      sessionStats: values.sessionStats || null,
      tokenUsage: values.tokenUsage || null,
      contextPressure: values.contextPressure || null,
    }
    refreshGoalActivation()
    if (values.title) state.current.title = values.title
    if (frame.header?.agentPreset) state.current.agentPreset = frame.header.agentPreset
    if (values.agentPreset) state.current.agentPreset = values.agentPreset
    if (values.modelSelection?.model) state.current.model = values.modelSelection
    if (values.permissions?.currentValue) state.current.permission = values.permissions.currentValue
    if (values.workingDirectory) state.current.cwd = values.workingDirectory
    const headerEvent = [...state.events].reverse().find((event) => event.type === 'request/header')
    const config = headerEvent?.data?.header?.config
    if (config?.provider && config?.model) state.current.model = { provider: config.provider, model: config.model }
    // Host-authoritative model selection: the modelSelection projection outranks
    // history scraping. The projection is absent from the list summary (cold
    // sessions ship an empty values map), so without this the header falls back
    // to the global default and shows the wrong model until a turn happens.
    const selection = values.modelSelection?.next || values.modelSelection?.lastUsed
    if (selection?.provider && selection?.model) {
      state.current.model = { provider: selection.provider, model: selection.model, ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}) }
    } else if (config?.provider && config?.model) {
      state.current.model = { provider: config.provider, model: config.model, ...(config.reasoningEffort ? { reasoningEffort: String(config.reasoningEffort) } : {}) }
    }
    state.live = null
    // Host-authoritative truth: a snapshot arrives on open and on every SSE
    // reconnect, so it is the one place a stale local "running" heals itself.
    // The last turn/end in the window outranks a stale summary row.
    const lastTurnEnd = [...state.events].reverse().find((event) => event.type === 'turn/end' || event.type === 'turn/start')
    state.current.running = lastTurnEnd ? lastTurnEnd.type === 'turn/start' : Boolean(state.current.running)
    state.turnStartedAt = lastTurnEnd && lastTurnEnd.type === 'turn/start' ? lastTurnEnd.time || null : null
    syncRunningUi()
    if (state.view === 'chat') render()
    return
  }
  if (frame.type === 'event') {
    const event = frame.event
    if (!event) return
    state.events.push(event)
    if (applyProgressEvent(state.progress, event)) refreshProgressDock()
    if (event.type === 'goal/change' || event.type === 'turn/end') refreshGoalActivation()
    if (event.type === 'assistant/message') {
      state.live = null
    }
    if (event.type === 'request/header') {
      const config = event.data?.header?.config
      if (config?.provider && config?.model) {
        state.current.model = { provider: config.provider, model: config.model }
      }
    }
    if (event.type === 'session/title' && event.data?.title) {
      state.current.title = event.data.title
      const summary = state.sessions.find((session) => session.id === state.current.id)
      if (summary) summary.title = event.data.title
      if (state.view === 'chat') {
        const heading = document.querySelector('.topbar h1')
        if (heading && heading.firstChild) heading.firstChild.textContent = event.data.title
      }
    }
    if (event.type === 'agent-preset/selected' && event.data?.agentPreset) {
      state.current.agentPreset = event.data.agentPreset
    }
    if (event.type === 'permission/preset' && event.data?.preset) {
      state.current.permission = event.data.preset
    }
    if (event.type === 'turn/start') {
      state.current.running = true
      state.turnStartedAt = event.time || Date.now()
    }
    if (event.type === 'turn/end') {
      state.current.running = false
      state.turnStartedAt = null
    }
    if (state.view === 'chat') {
      if (event.type === 'assistant/message' || event.type === 'user/message' || event.type === 'turn/end') {
        render()
      } else if (event.type === 'tool/call') {
        const chat = document.getElementById('chat')
        if (chat) {
          chat.append(toolRow(event.data))
          scrollToBottom()
        }
      } else if (event.type === 'tool/result') {
        attachToolResult(event.data)
      }
    }
    return
  }
  if (frame.type === 'assistant-stream') {
    const inner = frame.frame
    if (!inner) return
    if (inner.type === 'start') {
      state.live = { text: '', reasoning: '' }
      return
    }
    if (inner.type === 'chunk') {
      const chunk = inner.chunk || {}
      if (!state.live) state.live = { text: '', reasoning: '' }
      if (chunk.type === 'text-delta') state.live.text += chunk.text || ''
      else if (chunk.type === 'reasoning-delta') state.live.reasoning += chunk.text || ''
      updateLive()
      return
    }
    if (inner.type === 'end') {
      updateLive()
    }
  }
}

function updateLive() {
  if (state.view !== 'chat' || !state.live) return
  const chat = document.getElementById('chat')
  if (!chat) return
  let bubble = document.getElementById('live-bubble')
  if (!bubble) {
    bubble = el('div', { class: 'row assistant' }, [
      el('div', { class: 'bubble', id: 'live-bubble' }, [
        el('div', { id: 'live-text' }),
        el('div', { id: 'live-reasoning', class: 'reasoning', hidden: 'hidden' }),
      ]),
    ]).firstChild
    chat.append(bubble.parentElement)
  }
  const textNode = document.getElementById('live-text')
  if (textNode) textNode.textContent = state.live.text
  const reasoningNodeEl = document.getElementById('live-reasoning')
  if (reasoningNodeEl) {
    reasoningNodeEl.hidden = !state.live.reasoning
    reasoningNodeEl.textContent = state.live.reasoning
  }
  if (chatAtBottom(chat)) scrollToBottom()
  refreshJumpButton()
}

async function openSession(id) {
  const summary = state.sessions.find((session) => session.id === id)
  state.current = summary ? { ...summary } : { id, title: '' }
  state.progress = emptyProgress()
  goalActivationRead += 1
  state.tasksExpanded = false
  state.events = []
  state.snapshotAt = null
  state.cursor = null
  state.hasMore = false
  state.preserveScroll = null
  state.turnStartedAt = null
  state.live = null
  state.view = 'chat'
  localStorage.setItem('ccdsh_last_session', id)
  render()
  forceScrollToBottom()
  openStream(id)
  // If the stream never delivers its snapshot (offline, host hiccup), fall back
  // to the ordinary empty transcript instead of loading forever.
  setTimeout(() => {
    if (!state.snapshotAt && state.view === 'chat' && state.current?.id === id) {
      state.snapshotAt = 'timeout'
      render()
    }
  }, 4000)
  // Cold summaries carry no modelSelection projection: fetch the Host's
  // authoritative selection so the header shows the real model immediately,
  // even before (or without) the first snapshot frame.
  try {
    const result = await api(`/api/sessions/${encodeURIComponent(id)}/model`)
    const selection = result?.selection
    if (selection?.provider && selection?.model && state.current?.id === id) {
      state.current.model = {
        provider: selection.provider,
        model: selection.model,
        ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
      }
      refreshSessionMeta()
      if (state.view === 'chat') render()
    }
  } catch {
    /* lib layer may predate this endpoint; the snapshot frame still corrects */
  }
}

/**
 * Archive every blank session the list hides. Archiving (not deleting) matches
 * the desktop: the rows disappear from both surfaces, stay recoverable through
 * the desktop's archived filter, and never touch sessions with real content.
 * Two taps instead of confirm(): the APK's WebChromeClient does not implement
 * onJsConfirm, so window.confirm would silently cancel there.
 */
let cleanupArmed = 0
async function cleanupBlanks(event) {
  const button = event?.currentTarget
  const targets = state.sessions.filter(
    (session) => session.blank && session.id !== state.current?.id && session.origin !== 'subagent',
  )
  if (!targets.length) return
  if (!button || Date.now() > cleanupArmed) {
    cleanupArmed = Date.now() + 4000
    if (button) {
      button.textContent = `再点一次确认清理 ${targets.length} 个空会话`
      setTimeout(() => {
        if (button.isConnected) button.textContent = `清理 ${targets.length} 个空会话（从未发过消息，桌面端不显示）`
      }, 4000)
    }
    return
  }
  cleanupArmed = 0
  let ok = 0
  for (const session of targets) {
    try {
      await api(`/api/sessions/${encodeURIComponent(session.id)}/archive`, { method: 'POST', body: {} })
      ok += 1
    } catch {
      /* keep going; the failed row simply stays */
    }
  }
  toast(`已清理 ${ok}/${targets.length} 个空会话`)
  await refreshAll()
}

async function archiveCurrent() {
  const session = state.current
  if (!session) return
  try {
    await api(`/api/sessions/${encodeURIComponent(session.id)}/archive`, { method: 'POST', body: {} })
    toast('已归档')
    closeStream()
    state.sessions = state.sessions.filter((item) => item.id !== session.id)
    state.view = 'sessions'
    state.current = null
    render()
  } catch (error) {
    toast('归档失败：' + error.message)
  }
}

function newSession() {
  const workspaces = state.workspaces || []
  const choose = (body) => async () => {
    try {
      const created = await api('/api/sessions', { method: 'POST', body })
      const session = { id: created.sessionId, title: '', running: false, updatedAt: Date.now() }
      state.sessions.unshift(session)
      openSession(session.id)
    } catch (error) {
      toast('新建失败：' + error.message)
    }
  }
  openSheet((close) => [
    el('h2', { text: '在哪个工作区新建会话' }),
    ...workspaces.map((workspace) =>
      el('button', {
        class: 'option',
        onclick: () => {
          close()
          choose({ workspaceId: workspace.id })()
        },
      }, [
        el('div', { class: 'name' }, [
          el('div', { text: workspace.title || workspace.path }),
          el('div', { class: 'desc', text: workspace.path || '' }),
        ]),
      ]),
    ),
    el('button', {
      class: 'option',
      onclick: () => {
        close()
        choose(state.current?.cwd ? { cwd: state.current.cwd } : {})()
      },
    }, [
      el('div', { class: 'name' }, [
        el('div', { text: '最近使用的工作区' }),
        el('div', { class: 'desc', text: state.current?.cwd || '自动选一个最近活跃的工作区' }),
      ]),
    ]),
  ])
}

/* ------------------------------------------------------------------ sheets */

/** The sheet currently on screen, so the Android back gesture can close it. */
let activeSheet = null

function openSheet(builder) {
  const mask = el('div', { class: 'sheet-mask', onclick: (event) => { if (event.target === mask) close() } })
  const sheet = el('div', { class: 'sheet' }, [el('div', { class: 'sheet-grab' }), ...builder(close)])
  mask.append(sheet)
  document.body.append(mask)
  activeSheet = mask
  function close() {
    mask.remove()
    if (activeSheet === mask) activeSheet = null
  }
  return close
}

function serverSheet(close) {
  const info = state.server || {}
  const urls = info.urls || []
  return [
    el('h2', { text: '这台电脑' }),
    el('div', { class: 'option' }, [el('div', { class: 'name' }, [
      el('div', { text: info.name || 'dsh-PEC 网关' }),
      el('div', { class: 'desc', text: urls.map((u) => u.url).join('  ·  ') }),
    ])]),
    el('div', { class: 'divider' }),
    el('button', {
      class: 'option',
      onclick: () => {
        close()
        openSheet(pluginsSheet)
      },
    }, [
      el('div', { class: 'name' }, [
        el('div', { text: '插件管理' }),
        el('div', { class: 'desc', text: `${(state.plugins || []).filter((p) => p.enabled).length} / ${(state.plugins || []).length} 已启用` }),
      ]),
    ]),
    el('button', {
      class: 'option',
      onclick: () => {
        close()
        openSchedulesPanel()
      },
    }, [
      el('div', { class: 'name' }, [
        el('div', { text: '计划任务' }),
        el('div', { class: 'desc', text: '这台电脑上的定时提醒' }),
      ]),
    ]),
    el('button', {
      class: 'option',
      onclick: () => {
        close()
        openSettingsPanel()
      },
    }, [
      el('div', { class: 'name' }, [
        el('div', { text: 'DSH 设置' }),
        el('div', { class: 'desc', text: '主题、语言、权限默认值、模型默认值等' }),
      ]),
    ]),
    el('button', {
      class: 'option',
      onclick: () => {
        close()
        refreshAll().then(() => toast('已刷新'))
      },
    }, [el('div', { class: 'name', text: '刷新会话与插件' })]),
    el('button', {
      class: 'option',
      onclick: () => {
        try {
          window.CCDSH?.forget?.()
        } catch {}
        localStorage.removeItem('ccdsh_token')
        close()
        renderPairing('已从手机端断开，请重新输入电脑上的配对码')
      },
    }, [el('div', { class: 'name', text: '断开并重新配对' })]),
  ]
}

async function refreshAll() {
  try {
    const bootstrap = await api('/api/bootstrap')
    state.sessions = bootstrap.sessions?.items || state.sessions
    state.archivedIds = bootstrap.sessions?.archivedSessionIds || state.archivedIds
    state.models = bootstrap.models?.groups ? bootstrap.models : state.models
    state.presets = Array.isArray(bootstrap.presets) ? bootstrap.presets : state.presets
    state.workspaces = Array.isArray(bootstrap.workspaces) ? bootstrap.workspaces : state.workspaces
    state.permissions = bootstrap.permissions || state.permissions
    state.plugins = Array.isArray(bootstrap.plugins) ? bootstrap.plugins : state.plugins
    state.approvals = bootstrap.approvals || state.approvals
    render()
  } catch (error) {
    toast('刷新失败：' + error.message)
  }
}

function permissionSheet(close) {
  const options = state.permissions?.options || []
  const current = state.current?.permission || state.permissions?.defaultPreset
  return [
    el('h2', { text: '权限模式（沙箱 + 审批）' }),
    ...options.map((option) =>
      el('button', {
        class: `option${option.id === current ? ' sel' : ''}`,
        onclick: async () => {
          try {
            await api(`/api/sessions/${encodeURIComponent(state.current.id)}/permission`, {
              method: 'POST',
              body: { preset: option.id },
            })
            state.current.permission = option.id
            close()
            refreshSessionMeta()
            toast('已切换到 ' + (option.name || option.id))
          } catch (error) {
            toast('切换失败：' + error.message)
          }
        },
      }, [
        el('div', { class: 'name' }, [
          el('div', { text: option.name || option.id }),
          el('div', { class: 'desc', text: option.description || [option.sandbox, option.approval].filter(Boolean).join(' · ') }),
        ]),
        option.id === current ? el('div', { class: 'check', text: '✓' }) : null,
      ]),
    ),
    options.length === 0 ? el('div', { class: 'small', text: '电脑上没有可用的权限预设' }) : null,
  ]
}

function pluginsSheet(close) {
  const items = (state.plugins || [])
    .filter((plugin) => !plugin.readOnly)
    .sort((a, b) => Number(b.enabled) - Number(a.enabled) || String(a.moduleName).localeCompare(String(b.moduleName)))
  return [
    el('h2', { text: '插件' }),
    el('div', { class: 'small', text: '开关立即作用到电脑上的 DSH；个别插件需要重启 DSH 才生效。系统插件不在列表里。' }),
    ...items.map((plugin) =>
      el('button', {
        class: 'option',
        onclick: async () => {
          try {
            const result = await api(`/api/plugins/${encodeURIComponent(plugin.entryId)}/toggle`, {
              method: 'POST',
              body: { enabled: !plugin.enabled },
            })
            plugin.enabled = !plugin.enabled
            close()
            openSheet(pluginsSheet)
            toast(result.application === 'restart-required' ? '已保存，重启 DSH 后生效' : plugin.enabled ? '已启用' : '已停用')
          } catch (error) {
            toast('操作失败：' + error.message)
          }
        },
      }, [
        el('div', { class: 'name' }, [
          el('div', { text: plugin.moduleName || plugin.entryId }),
          el('div', { class: 'desc', text: plugin.readOnly ? '由系统管理，不能在这里开关' : plugin.phase || '' }),
        ]),
        el('div', { class: `chip${plugin.enabled ? ' on' : ''}`, text: plugin.enabled ? '启用' : '停用' }),
      ]),
    ),
    items.length === 0 ? el('div', { class: 'small', text: '没有读取到插件列表' }) : null,
  ]
}

function sessionSheet(close) {
  const rename = () => {
    const input = el('input', { value: state.current.title || '', placeholder: '会话标题' })
    const sheet = openSheet((done) => [
      el('h2', { text: '重命名会话' }),
      el('div', { class: 'field' }, [input]),
      el('button', {
        class: 'btn',
        onclick: async () => {
          try {
            await api(`/api/sessions/${encodeURIComponent(state.current.id)}/rename`, {
              method: 'POST',
              body: { title: input.value.trim() },
            })
            state.current.title = input.value.trim()
            const summary = state.sessions.find((session) => session.id === state.current.id)
            if (summary) summary.title = state.current.title
            done()
            close()
            render()
          } catch (error) {
            toast('重命名失败：' + error.message)
          }
        },
      }, '保存'),
    ])
  }
  const decisions = [
    ['工作区文件', () => { close(); openFilesPanel() }],
    ['终端', () => { close(); openTerminalPanel() }],
    ['目标（Goal）', () => { close(); openGoalPanel() }],
    ['切换模型', () => { close(); openSheet(modelSheet) }],
    ['切换模式（预设）', () => { close(); openSheet(presetSheet) }],
    ['权限模式', () => { close(); openSheet(permissionSheet) }],
    ['远程审批', () => { close(); openSheet(approvalSheet) }],
    ['重命名', () => { close(); rename() }],
    ['归档（从列表移除）', () => { close(); archiveCurrent() }],
  ]
  return [
    el('h2', { text: '会话操作' }),
    ...decisions.map(([label, action]) => el('button', { class: 'option', onclick: action }, [el('div', { class: 'name', text: label })])),
  ]
}

function modelSheet(close) {
  const selection = state.current?.model || state.models.default
  const rows = []
  if (state.models.failures?.length) {
    rows.push(el('div', { class: 'small', text: '部分模型不可用：' + state.models.failures.map((f) => f.name || f.id).join('、') }))
  }

  const apply = async (provider, model, reasoningEffort) => {
    try {
      const body = { provider, model }
      if (reasoningEffort) body.reasoningEffort = reasoningEffort
      await api(`/api/sessions/${encodeURIComponent(state.current.id)}/model`, { method: 'POST', body })
      state.current.model = body
      close()
      refreshSessionMeta()
      toast(`已切换到 ${model}${reasoningEffort ? ' · ' + reasoningEffort : ''}`)
    } catch (error) {
      toast('切换失败：' + error.message)
    }
  }

  for (const group of state.models.groups) {
    rows.push(el('h2', { text: group.name }))
    for (const model of group.models) {
      const selected = isSelectedModel(group.id, model.id, selection)
      const efforts = model.reasoning?.efforts || []
      // Tapping the model itself picks the highest effort tier when the model
      // has one: an unselected effort would otherwise fall through to the
      // protocol default (often no reasoning), which surprises people.
      const highestEffort = efforts.length
        ? (efforts[efforts.length - 1].id || efforts[efforts.length - 1].value || efforts[efforts.length - 1])
        : undefined
      rows.push(
        el('button', {
          class: `option${selected ? ' sel' : ''}`,
          onclick: () => apply(group.id, model.id, selected ? selection.reasoningEffort : highestEffort),
        }, [
          el('div', { class: 'name' }, [
            el('div', { text: model.name }),
            model.description ? el('div', { class: 'desc', text: model.description }) : null,
          ]),
          selected ? el('div', { class: 'check', text: '✓' }) : null,
        ]),
      )
      if (efforts.length) {
        const currentEffort = selected
          ? selection.reasoningEffort || model.reasoning?.defaultEffort || ''
          : ''
        rows.push(
          el('div', { class: 'effort-row' }, [
            el('span', { class: 'effort-label', text: '推理' }),
            ...efforts.map((effort) => {
              const id = effort.id || effort.value || effort
              const name = effort.name || effort.label || id
              return el('button', {
                class: `chip${currentEffort === id ? ' on' : ''}`,
                onclick: () => apply(group.id, model.id, id),
              }, [name])
            }),
          ]),
        )
      }
    }
  }
  if (!rows.length) rows.push(el('div', { class: 'small', text: '没有可用模型' }))
  return [el('h2', { text: '选择模型' }), ...rows]
}

function presetSheet(close) {
  const current = state.current?.agentPreset || state.current?.projections?.agentPreset
  const rows = state.presets.map((preset) =>
    el('button', {
      class: `option${preset.id === current ? ' sel' : ''}`,
      onclick: async () => {
        try {
          await api(`/api/sessions/${encodeURIComponent(state.current.id)}/preset`, {
            method: 'POST',
            body: { preset: preset.id },
          })
          state.current.agentPreset = preset.id
          close()
          refreshSessionMeta()
          toast('已切换到 ' + preset.name)
        } catch (error) {
          toast('切换失败：' + error.message)
        }
      },
    }, [
      el('div', { class: 'name' }, [
        el('div', { text: preset.name || preset.id }),
        preset.description ? el('div', { class: 'desc', text: preset.description }) : null,
      ]),
      preset.id === current ? el('div', { class: 'check', text: '✓' }) : null,
    ]),
  )
  if (!rows.length) rows.push(el('div', { class: 'small', text: '没有可切换的预设' }))
  return [el('h2', { text: '模式 / 预设' }), ...rows]
}

function approvalSheet(close) {
  const armed = state.approvals.armedUntil > Date.now()
  const forced = Boolean(state.approvals.forced)
  const desktop = Boolean(state.approvals.desktopAttached)

  const arm = async (minutes, force) => {
    try {
      const result = await api('/api/approvals/arm', { method: 'POST', body: { minutes, force } })
      state.approvals.armedUntil = result.armedUntil || 0
      state.approvals.forced = Boolean(result.forced)
      state.approvals.desktopAttached = Boolean(result.desktopAttached)
      close()
      refreshSessionMeta()
      toast(force ? '已强制接管，电脑端可能留弹窗' : '已接管审批 30 分钟')
    } catch (error) {
      toast('设置失败：' + error.message)
    }
  }

  return [
    el('h2', { text: '远程审批' }),
    el('div', { class: 'small', text: '接管后，需要你批准的工具调用会推到手机，直接允许或拒绝；到期自动交还电脑。' }),
    el('div', { class: 'small', style: 'margin-top:6px', text: desktop ? '电脑端页面在线：普通接管会把审批留给电脑，避免电脑上留下点不掉的弹窗。' : '电脑端页面不在线：接管后审批会直接出现在手机上。' }),
    el('button', {
      class: 'option',
      onclick: () => arm(30, false),
    }, [
      el('div', { class: 'name' }, [
        el('div', { text: armed && !forced ? '延长接管 30 分钟' : '接管审批 30 分钟' }),
        el('div', { class: 'desc', text: '电脑端在线时由电脑处理；不在线时推到手机' }),
      ]),
    ]),
    el('button', {
      class: 'option',
      onclick: () => arm(30, true),
    }, [
      el('div', { class: 'name' }, [
        el('div', { text: armed && forced ? '延长强制接管 30 分钟' : '强制接管（人在外面时用）' }),
        el('div', { class: 'desc', text: '即使电脑端在线也由手机决定；电脑上可能留下一个待处理的弹窗' }),
      ]),
    ]),
    armed
      ? el('button', {
        class: 'option',
        onclick: async () => {
          try {
            await api('/api/approvals/arm', { method: 'POST', body: { minutes: 0 } })
            state.approvals.armedUntil = 0
            state.approvals.forced = false
            close()
            refreshSessionMeta()
            toast('已交还电脑审批')
          } catch (error) {
            toast('失败：' + error.message)
          }
        },
      }, [el('div', { class: 'name', text: '交还电脑审批' })])
      : null,
  ]
}

/* ------------------------------------------------------------------ panels */

let lastOpen = { key: '', at: 0 }

/** Ignore a second opening of the same panel within half a second (double tap). */
function guardOpen(key) {
  const now = Date.now()
  if (lastOpen.key === key && now - lastOpen.at < 500) return false
  lastOpen = { key, at: now }
  return true
}

/** Open panels, newest last, so the Android back gesture closes the top one. */
const panelStack = []

function panelShell({ title, subtitle, right = [] }) {
  const titleEl = el('b', { text: title })
  const subtitleEl = el('span', { text: subtitle || '' })
  const body = el('div', { class: 'panel-body' })
  const panel = el('div', { class: 'panel' }, [
    el('div', { class: 'panel-head' }, [
      el('button', { class: 'icon-btn', onclick: () => view.close() }, [svg(ICON.back)]),
      el('div', { class: 'panel-title' }, [titleEl, subtitleEl]),
      ...right,
    ]),
    body,
  ])
  document.body.append(panel)
  const view = {
    panel,
    body,
    close() {
      panel.remove()
      const index = panelStack.indexOf(view)
      if (index >= 0) panelStack.splice(index, 1)
    },
    setTitle(value, sub) {
      titleEl.textContent = value
      if (sub !== undefined) subtitleEl.textContent = sub
    },
    setRight(nodes) {
      const head = panel.querySelector('.panel-head')
      while (head.children.length > 2) head.lastChild.remove()
      for (const node of nodes) head.append(node)
    },
  }
  panelStack.push(view)
  return view
}

/**
 * Android back: close the top panel, then a sheet, then leave the chat. Only a
 * back gesture at the session list returns false, which lets the shell ask
 * whether to quit.
 */
window.__ccdshBack = () => {
  // A sheet is painted above the panel that opened it, so it is consumed first.
  if (activeSheet) {
    activeSheet.remove()
    activeSheet = null
    return true
  }
  const top = panelStack[panelStack.length - 1]
  if (top) {
    top.close()
    return true
  }
  if (state.view === 'chat') {
    closeStream()
    state.view = 'sessions'
    state.current = null
    render()
    return true
  }
  return false
}

/* ------------------------------------------------------------------ files */

function openFilesPanel(startPath = '') {
  if (!guardOpen('files')) return null
  const view = panelShell({ title: '工作区文件', subtitle: '读取中…' })
  const sessionId = state.current?.id || ''

  async function load(pathValue) {
    view.setTitle('工作区文件', pathValue || '（会话工作目录）')
    view.body.replaceChildren(el('div', { class: 'empty', text: '读取中…' }))
    try {
      const data = await api(`/api/files?session=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(pathValue || '')}`)
      const rows = []
      if (data.parent !== null && data.parent !== undefined) {
        rows.push(
          el('button', { class: 'file-row', onclick: () => load(data.parent) }, [
            el('div', { class: 'ftype', text: '↑' }),
            el('div', { class: 'fname', text: '..' }),
          ]),
        )
      }
      for (const entry of data.entries || []) {
        const isDir = entry.kind === 'dir' || entry.kind === 'directory'
        rows.push(
          el('button', {
            class: 'file-row',
            onclick: () => (isDir ? load(entry.path) : previewFile(entry.path, entry.name)),
          }, [
            el('div', { class: 'ftype' }, [svg(isDir ? ICON.folder : ICON.file, 15)]),
            el('div', { class: 'fname', text: entry.name }),
            el('div', { class: 'fmeta', text: isDir ? '' : sizeLabel(entry.size) }),
          ]),
        )
      }
      if (!rows.length) rows.push(el('div', { class: 'empty', text: '这个目录是空的' }))
      view.body.replaceChildren(...rows)
      view.setTitle('工作区文件', data.path || pathValue || '')
    } catch (error) {
      view.body.replaceChildren(el('div', { class: 'empty', text: '读取失败：' + error.message }))
    }
  }

  function previewFile(pathValue, name) {
    const viewer = panelShell({ title: name || pathValue, subtitle: '读取中…' })
    api(`/api/files/read?session=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(pathValue)}`)
      .then((data) => {
        viewer.setTitle(name || pathValue, data.truncated ? '已截断显示' : `${(data.text || '').length} 字符`)
        viewer.body.replaceChildren(el('div', { class: 'code-view', text: data.text || '' }))
      })
      .catch((error) => {
        viewer.body.replaceChildren(el('div', { class: 'empty', text: '读取失败：' + error.message }))
      })
  }

  load(startPath)
  return view
}

function sizeLabel(size) {
  if (!size && size !== 0) return ''
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

/* ------------------------------------------------------------------ terminal */

function openTerminalPanel() {
  if (!guardOpen('terminal')) return null
  if (!window.Terminal) {
    toast('终端组件没加载出来，刷新页面试试')
    return null
  }
  const sessionId = state.current?.id || ''
  const cwd = state.current?.cwd || ''
  const view = panelShell({ title: '终端', subtitle: '正在打开…' })
  const host = el('div', { class: 'xterm-host' })
  view.body.style.padding = '6px'
  view.body.style.overflow = 'hidden'
  view.body.style.display = 'flex'
  view.body.style.flexDirection = 'column'
  view.body.replaceChildren(host)

  const term = new window.Terminal({
    fontSize: 12,
    fontFamily: 'ui-monospace, "Cascadia Code", Consolas, monospace',
    cursorBlink: true,
    scrollback: 3000,
    convertEol: false,
    theme: {
      background: '#080b10',
      foreground: '#c8d6f0',
      cursor: '#4f8cff',
      selectionBackground: '#26406b',
      black: '#1b2230',
      brightBlack: '#5b6b85',
    },
  })
  const FitAddonCtor = window.FitAddon?.FitAddon || window.FitAddon
  const fit = typeof FitAddonCtor === 'function' ? new FitAddonCtor() : null
  if (fit) term.loadAddon(fit)
  term.open(host)

  let source = null
  let closed = false
  let shellName = ''
  let lastOffset = 0

  const encoder = new TextEncoder()
  const toBase64 = (bytes) => {
    let binary = ''
    for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index])
    return btoa(binary)
  }
  const fromBase64 = (text) => {
    const binary = atob(text)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    return bytes
  }

  const fitNow = () => {
    if (!fit) return
    try {
      fit.fit()
    } catch {
      /* ignore */
    }
    api(`/api/term/${encodeURIComponent(sessionId)}/resize`, {
      method: 'POST',
      body: { cols: term.cols, rows: term.rows },
    }).catch(() => {})
  }

  const cleanup = (closeRemote) => {
    if (closed) return
    closed = true
    if (source) {
      source.close()
      source = null
    }
    if (closeRemote) {
      api(`/api/term/${encodeURIComponent(sessionId)}/close`, { method: 'POST', body: {} }).catch(() => {})
    }
  }

  view.setRight([
    el('button', { class: 'icon-btn', title: '关闭终端', onclick: () => { cleanup(true); view.close() } }, [svg(ICON.stop, 16)]),
  ])

  term.onData((data) => {
    if (closed) return
    api(`/api/term/${encodeURIComponent(sessionId)}/input`, {
      method: 'POST',
      body: { data: toBase64(encoder.encode(data)) },
    }).catch(() => {})
  })

  const watcher = setInterval(() => {
    if (!view.panel.isConnected) {
      clearInterval(watcher)
      cleanup(true)
    }
  }, 800)

  async function start() {
    try {
      view.setTitle('终端', '打开中…')
      const opened = await api('/api/term/open', {
        method: 'POST',
        body: { session: sessionId, cols: term.cols || 100, rows: term.rows || 30 },
      })
      shellName = opened.shell ? opened.shell.split(/[\\/]/).pop() : 'shell'
      const modeLabel = opened.mode === 'pty' ? '交互终端' : '持久 shell（兼容模式）'
      view.setTitle(modeLabel, `${shellName} · 连接中…`)
      fitNow()

      const token = state.token ? `&token=${encodeURIComponent(state.token)}` : ''
      source = new EventSource(`/api/term/${encodeURIComponent(sessionId)}/stream?from=0${token}`)
      source.addEventListener('ready', (event) => {
        try {
          const info = JSON.parse(event.data)
          view.setTitle(modeLabel, `${String(info.shell || shellName).split(/[\\/]/).pop()} · 运行中`)
        } catch {
          view.setTitle(modeLabel, '运行中')
        }
      })
      source.addEventListener('data', (event) => {
        try {
          const chunk = JSON.parse(event.data)
          const bytes = fromBase64(chunk.data)
          lastOffset = Math.max(lastOffset, chunk.offset + bytes.length)
          term.write(bytes)
        } catch {
          /* ignore a malformed frame */
        }
      })
      source.addEventListener('exit', () => {
        term.write('\r\n\x1b[2m[进程已退出]\x1b[0m\r\n')
        cleanup(false)
        view.setTitle('终端', '已退出')
      })
      source.addEventListener('error', () => {
        if (closed) return
        view.setTitle('终端', '连接中断，重试中…')
      })
      inputFocus()
    } catch (error) {
      term.write(`\r\n\x1b[31m[打开失败] ${error.message}\x1b[0m\r\n`)
      view.setTitle('终端', '打开失败')
      cleanup(false)
    }
  }

  function inputFocus() {
    try {
      term.focus()
    } catch {
      /* ignore */
    }
  }

  window.addEventListener('resize', fitNow)
  start()
  return view
}
/** Fallback: one command per request (used when no PTY backend exists). */
function openCommandPanel() {
  if (!guardOpen('command')) return null
  const sessionId = state.current?.id || ''
  const cwd = state.current?.cwd || ''
  const view = panelShell({ title: '终端（命令模式）', subtitle: cwd || '逐条执行命令' })
  let running = null // { id, cursor, timer }
  let busy = false

  const output = el('div', { class: 'term' })
  const input = el('input', {
    placeholder: '输入命令，回车执行',
    autocomplete: 'off',
    spellcheck: 'false',
    onkeydown: (event) => {
      if (event.key === 'Enter' && !event.isComposing) {
        event.preventDefault()
        const command = input.value
        input.value = ''
        execute(command)
      }
    },
  })

  const quick = [
    ['ls', 'ls'],
    ['git status', 'git status'],
    ['pwd', 'pwd'],
    ['清屏', null],
  ]

  const wrap = el('div', { class: 'term-wrap' }, [
    output,
    el('div', { class: 'term-kbd' }, quick.map(([label, command]) =>
      el('button', {
        class: 'chip',
        onclick: () => {
          if (command === null) output.textContent = ''
          else execute(command)
        },
      }, [label]),
    )),
    el('div', { class: 'term-input' }, [
      input,
      el('button', { class: 'send', onclick: () => { const command = input.value; input.value = ''; execute(command) } }, [svg(ICON.send, 17)]),
    ]),
  ])
  view.body.style.display = 'flex'
  view.body.style.flexDirection = 'column'
  view.body.replaceChildren(wrap)
  view.setRight([
    el('button', { class: 'icon-btn', title: '结束当前命令', onclick: stopRun }, [svg(ICON.stop, 16)]),
  ])

  function write(text) {
    if (!text) return
    output.textContent += text
    output.scrollTop = output.scrollHeight
  }

  function stopRun() {
    if (!running) return toast('当前没有在运行的命令')
    api(`/api/runs/${encodeURIComponent(running.id)}/kill`, { method: 'POST', body: {} })
      .then(() => toast('已请求结束'))
      .catch((error) => toast('结束失败：' + error.message))
  }

  async function execute(command) {
    const text = String(command || '').trim()
    if (!text) return
    if (busy) return toast('上一条命令还在运行')
    busy = true
    try {
      const created = await api('/api/runs', { method: 'POST', body: { session: sessionId, command: text } })
      running = { id: created.id, cursor: 0, timer: null }
      view.setTitle('终端', '运行中…')
      running.timer = setInterval(poll, 600)
      await poll()
    } catch (error) {
      busy = false
      toast('执行失败：' + error.message)
    }
  }

  async function poll() {
    if (!running) return
    if (!view.panel.isConnected) {
      clearInterval(running.timer)
      running = null
      busy = false
      return
    }
    try {
      const data = await api(`/api/runs/${encodeURIComponent(running.id)}?cursor=${running.cursor}`)
      write(data.text || '')
      running.cursor = data.cursor ?? running.cursor
      if (!data.running) {
        clearInterval(running.timer)
        running = null
        busy = false
        view.setTitle('终端', `已完成${data.exitCode != null ? ' · 退出码 ' + data.exitCode : ''}${data.signal ? ' · ' + data.signal : ''}`)
      }
    } catch (error) {
      clearInterval(running.timer)
      running = null
      busy = false
      view.setTitle('终端', '读取失败')
      toast(error.message)
    }
  }

  write(
    `命令模式（真终端不可用时的退路）：逐条执行，工作目录 ${cwd || '会话目录'}\n` +
      `输出是纯文本，没有交互；需要交互请让电脑上启用 subprocess 的终端能力。\n\n`,
  )
  return view
}

/* ------------------------------------------------------------------ goal */

function openGoalPanel() {
  if (!guardOpen('goal')) return null
  const sessionId = state.current?.id || ''
  const view = panelShell({ title: '目标', subtitle: '读取中…' })

  const phaseLabel = {
    active: '进行中',
    paused: '已暂停',
    complete: '已完成',
    completed: '已完成',
    blocked: '受阻',
    cleared: '已清除',
  }

  async function load() {
    view.body.replaceChildren(el('div', { class: 'empty', text: '读取中…' }))
    try {
      const data = await api(`/api/goal?session=${encodeURIComponent(sessionId)}`)
      const goal = data.goal || (!data.live && state.current?.id === sessionId ? state.progress.goal : null)
      if (!goal) {
        view.setTitle('目标', '无')
        view.body.replaceChildren(
          el('div', { class: 'empty', text: data.live ? '这个会话还没有目标。\n目标由电脑端的 create_goal 建立。' : '会话没在电脑上运行，读不到目标。' }),
        )
        return
      }
      view.setTitle('目标', goal.phase === 'active' && goal.activation === 'disarmed' ? '待继续' : phaseLabel[goal.phase] || goal.phase)
      const action = (label, name, ghost = false) =>
        el('button', {
          class: 'chip' + (ghost ? '' : ' on'),
          onclick: async () => {
            try {
              await api(`/api/goal/${name}`, { method: 'POST', body: { session: sessionId } })
              toast('已' + label)
              load()
            } catch (error) {
              toast('操作失败：' + error.message)
            }
          },
        }, [label])

      const actions = []
      if (data.live && goal.phase === 'active') {
        actions.push(goal.activation === 'disarmed' ? action('继续', 'resume') : action('暂停', 'pause'))
        actions.push(action('标记完成', 'complete'))
      }
      if (data.live && (goal.phase === 'paused' || goal.phase === 'blocked')) actions.push(action('继续', 'resume'))
      if (data.live) actions.push(action('清除', 'clear', true))

      view.body.replaceChildren(
        el('div', { class: 'tool', style: 'margin:0 0 12px' }, [
          el('div', { class: 'tool-head' }, [
            el('span', { class: 'tool-name', text: phaseLabel[goal.phase] || goal.phase }),
            el('span', { class: 'tool-status', text: `${goal.roundsStarted ?? 0} / ${goal.maxGoalRounds || '∞'} 轮` }),
          ]),
          el('div', { class: 'tool-body', style: 'max-height:none' }, [goal.objective]),
          goal.blockedReason?.message
            ? el('div', { class: 'tool-body', style: 'color:#ffb4b4' }, ['受阻：' + goal.blockedReason.message])
            : null,
        ]),
        el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' }, actions),
        el('div', { class: 'small', style: 'margin-top:12px', text: data.live ? '目标会在电脑上自动续跑；暂停或清除后不再自动继续。' : '会话尚未在电脑上运行，当前显示已保存的目标。' }),
      )
    } catch (error) {
      view.body.replaceChildren(el('div', { class: 'empty', text: '读取失败：' + error.message }))
    }
  }

  load()
  return view
}

/* ------------------------------------------------------------------ schedules */

function openSchedulesPanel() {
  if (!guardOpen('schedules')) return null
  const view = panelShell({ title: '计划任务', subtitle: '读取中…' })
  view.setRight([
    el('button', { class: 'icon-btn', title: '新建提醒', onclick: () => openScheduleForm(load) }, [svg(ICON.plus, 16)]),
  ])

  async function load() {
    view.body.replaceChildren(el('div', { class: 'empty', text: '读取中…' }))
    try {
      const data = await api('/api/schedules')
      const items = data.items || []
      view.setTitle('计划任务', `${items.length} 条`)
      if (!items.length) {
        view.body.replaceChildren(el('div', { class: 'empty', text: '电脑上还没有计划任务。\n可以在电脑端用 schedule_create 建一个。' }))
        return
      }
      view.body.replaceChildren(
        ...items.map((item) =>
          el('div', { class: 'tool', style: 'margin:0 0 8px' }, [
            el('div', { class: 'tool-head' }, [
              el('span', { class: 'tool-name', text: item.title }),
              el('span', { class: 'tool-status' + (item.status === 'active' ? ' ok' : ''), text: item.status === 'active' ? '生效中' : '已停用' }),
            ]),
            el('div', { class: 'small', style: 'margin-top:6px' }, [
              item.cadence || '一次性',
              item.scheduledAt ? ` · 下次 ${formatWhen(item.scheduledAt)}` : '',
            ]),
            item.prompt ? el('div', { class: 'tool-body', text: item.prompt }) : null,
            el('div', { style: 'display:flex;gap:8px;margin-top:8px' }, [
              el('button', {
                class: 'chip',
                style: 'border-color:#5b1b22;color:#ffb4b4',
                onclick: async () => {
                  try {
                    await api('/api/schedules/delete', { method: 'POST', body: { session: item.sessionId, id: item.id } })
                    toast('已删除')
                    load()
                  } catch (error) {
                    toast('删除失败：' + error.message)
                  }
                },
              }, '删除'),
            ]),
          ]),
        ),
      )
    } catch (error) {
      view.body.replaceChildren(el('div', { class: 'empty', text: '读取失败：' + error.message }))
    }
  }

  load()
  return view
}

function formatWhen(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return date.toLocaleString()
}

/** Minimal reminder form: title, content, minutes from now. */
function openScheduleForm(reload) {
  const target = state.current || state.sessions[0]
  const title = el('input', { placeholder: '标题，例如：起来喝水' })
  const prompt = el('input', { placeholder: '提醒内容（留空就用标题）' })
  const minutes = el('input', { type: 'number', min: '1', value: '30' })
  const error = el('div', { class: 'err' })

  openSheet((close) => [
    el('h2', { text: '新建提醒' }),
    el('div', { class: 'small', text: target ? `会在「${target.title || '未命名会话'}」里提醒你` : '还没有会话，先建一个' }),
    el('div', { class: 'field' }, [el('label', { text: '标题' }), title]),
    el('div', { class: 'field' }, [el('label', { text: '内容' }), prompt]),
    el('div', { class: 'field' }, [el('label', { text: '多少分钟后' }), minutes]),
    error,
    el('button', {
      class: 'btn',
      onclick: async () => {
        if (!target) return (error.textContent = '没有可用的会话')
        try {
          await api('/api/schedules', {
            method: 'POST',
            body: {
              session: target.id,
              title: title.value.trim(),
              prompt: prompt.value.trim() || title.value.trim(),
              afterMinutes: Number(minutes.value) || 30,
            },
          })
          close()
          toast('提醒已创建')
          reload()
        } catch (cause) {
          error.textContent = '创建失败：' + cause.message
        }
      },
    }, '创建'),
  ])
}

/* ------------------------------------------------------------------ settings */

/** One provider: editable profile (name / URL / protocol / models), key, delete. */
function openProviderDetail(provider, reload) {
  const key = el('input', { placeholder: '输入新的 API Key（留空则不动）', type: 'password' })
  const display = el('input', { value: provider.displayName || '' })
  const baseURL = el('input', { value: provider.baseURL || '' })
  const models = el('textarea', { rows: '4' })
  models.value = provider.models.map((model) => (model.name && model.name !== model.id ? `${model.id} ${model.name}` : model.id)).join('\n')
  models.style.cssText = 'width:100%;background:var(--bg-soft);border:1px solid var(--line);border-radius:10px;padding:10px;color:inherit;font-size:12.5px;font-family:ui-monospace,Consolas,monospace'
  const protocols = ['openai-completions', 'openai-responses', 'anthropic-messages']
  const protocol = el('select', {}, protocols.map((value) =>
    el('option', { value, selected: value === (provider.api || protocols[0]) ? 'selected' : null }, [value]),
  ))
  const error = el('div', { class: 'err' })

  openSheet((close) => [
    el('h2', { text: provider.route }),
    el('div', { class: 'kv' }, [
      el('span', { text: 'API Key' }),
      el('span', { text: provider.keyConfigured ? `已配置（${provider.keyRef}）` : '未配置' }),
    ]),
    el('div', { class: 'field' }, [el('label', { text: '显示名称' }), display]),
    el('div', { class: 'field' }, [el('label', { text: '接口地址 baseURL' }), baseURL]),
    el('div', { class: 'field' }, [el('label', { text: '协议' }), protocol]),
    el('div', { class: 'field' }, [el('label', { text: '模型（每行一个：id 或 id 显示名）' }), models]),
    error,
    el('button', {
      class: 'btn',
      onclick: async () => {
        error.textContent = ''
        try {
          await api('/api/providers/update', {
            method: 'POST',
            body: {
              route: provider.route,
              displayName: display.value,
              baseURL: baseURL.value,
              api: protocol.value,
              models: models.value,
            },
          })
          close()
          toast('已保存 ' + provider.route)
          reload()
        } catch (cause) {
          error.textContent = '保存失败：' + cause.message
        }
      },
    }, '保存配置'),
    el('button', {
      class: 'btn',
      style: 'background:#1c2331;color:#cdd8f2',
      onclick: async () => {
        error.textContent = ''
        try {
          await api('/api/providers/key', {
            method: 'POST',
            body: { route: provider.route, apiKey: key.value },
          })
          close()
          toast(key.value.trim() ? '密钥已更新' : '密钥已清除')
          reload()
        } catch (cause) {
          error.textContent = '保存失败：' + cause.message
        }
      },
    }, '保存密钥'),
    el('button', {
      class: 'btn',
      style: 'background:#3a1418;color:#ffb4b4',
      onclick: async () => {
        try {
          await api('/api/providers/delete', { method: 'POST', body: { route: provider.route } })
          close()
          toast('已删除 ' + provider.route)
          reload()
        } catch (cause) {
          error.textContent = '删除失败：' + cause.message
        }
      },
    }, '删除供应商'),
  ])
}

/** Create one llm-pi-ai route: fetch the endpoint's models, pick, then save. */
function openProviderForm(meta, reload) {
  const route = el('input', { placeholder: 'my-provider', autocapitalize: 'off', autocorrect: 'off' })
  const display = el('input', { placeholder: '显示名称（可留空）' })
  const baseURL = el('input', { placeholder: 'https://api.example.com/v1' })
  const key = el('input', { placeholder: 'sk-...', type: 'password' })
  const protocols = meta.protocols?.length ? meta.protocols : ['openai-completions']
  const protocol = el('select', {}, protocols.map((value) =>
    el('option', { value, selected: value === protocols[0] ? 'selected' : null }, [value]),
  ))
  const error = el('div', { class: 'err' })
  const picked = new Set()
  const sheetBody = { save: null }

  const fetchButton = el('button', {
    class: 'btn',
    style: 'background:#1c2331;color:#cdd8f2',
    onclick: () => fetchModels(),
  }, '获取模型')

  async function fetchModels() {
    error.textContent = ''
    const base = baseURL.value.trim()
    if (!/^https?:\/\//i.test(base)) {
      error.textContent = '请先填接口地址（http(s):// 开头）'
      return
    }
    fetchButton.disabled = true
    fetchButton.textContent = '获取中…'
    try {
      const answer = await api('/api/providers/discover', {
        method: 'POST',
        body: { baseURL: base, api: protocol.value, apiKey: key.value },
      })
      const found = answer.models || []
      if (!found.length) {
        error.textContent = '该端点没有返回任何模型'
        return
      }
      renderPickList(found)
    } catch (cause) {
      error.textContent = '获取失败：' + cause.message
    } finally {
      fetchButton.disabled = false
      fetchButton.textContent = '获取模型'
    }
  }

  /** Checkbox list of advertised models; picked ids feed the create call. */
  function renderPickList(found) {
    document.getElementById('provider-pick')?.remove()
    picked.clear()
    const rows = found.map((model) => {
      picked.add(model.id)
      return el('button', {
        class: 'option sel',
        onclick: (event) => {
          const on = picked.has(model.id)
          if (on) picked.delete(model.id)
          else picked.add(model.id)
          event.currentTarget.classList.toggle('sel', !on)
        },
      }, [
        el('div', { class: 'name' }, [
          el('div', { text: model.id }),
          model.name && model.name !== model.id ? el('div', { class: 'desc', text: model.name }) : null,
        ]),
        el('div', { class: 'check', text: '✓' }),
      ])
    })
    const block = el('div', { id: 'provider-pick' }, [
      el('div', { class: 'small', style: 'margin:10px 6px 2px', text: `获取到 ${found.length} 个模型，点一下取消不要的：` }),
      ...rows,
    ])
    if (sheetBody.save) sheetBody.save.parentNode.insertBefore(block, sheetBody.save)
  }

  openSheet((close) => [
    el('h2', { text: '添加供应商' }),
    el('div', { class: 'small', text: '填好地址和密钥后点「获取模型」，勾选要用的模型再创建；不用发现也可以手动输模型（每行一个 id）。' }),
    el('div', { class: 'field' }, [el('label', { text: '路由名（小写，仅字母数字与连字符）' }), route]),
    el('div', { class: 'field' }, [el('label', { text: '显示名称' }), display]),
    el('div', { class: 'field' }, [el('label', { text: '接口地址 baseURL' }), baseURL]),
    el('div', { class: 'field' }, [el('label', { text: '协议' }), protocol]),
    el('div', { class: 'field' }, [el('label', { text: 'API Key（获取模型和创建时都用它）' }), key]),
    error,
    fetchButton,
    el('button', {
      class: 'btn',
      onmount: (node) => { sheetBody.save = node },
      onclick: async () => {
        error.textContent = ''
        try {
          const result = await api('/api/providers', {
            method: 'POST',
            body: {
              route: route.value.trim(),
              displayName: display.value.trim(),
              baseURL: baseURL.value.trim(),
              api: protocol.value,
              apiKey: key.value,
              // Picked models win; the create endpoint rejects an empty list.
              models: picked.size ? [...picked] : '',
            },
          })
          close()
          toast(`已添加 ${result.route}（${result.models} 个模型）`)
          reload()
        } catch (cause) {
          error.textContent = '创建失败：' + cause.message
        }
      },
    }, '创建'),
  ])
}

function openSettingsPanel() {
  if (!guardOpen('settings')) return null
  const view = panelShell({ title: 'DSH 设置', subtitle: '读取中…' })
  let namespaces = []
  let providers = { providers: [], protocols: [], revision: 0 }

  async function load() {
    view.body.replaceChildren(el('div', { class: 'empty', text: '读取中…' }))
    try {
      const [data, providerData] = await Promise.all([
        api('/api/settings'),
        api('/api/providers').catch(() => ({ providers: [], protocols: [], revision: 0 })),
      ])
      namespaces = data.namespaces || []
      providers = providerData || providers
      view.setTitle('DSH 设置', `${namespaces.length} 组 · ${providers.providers.length} 个供应商`)
      view.body.replaceChildren(...providerSection(), ...namespaceSection())
    } catch (error) {
      view.body.replaceChildren(el('div', { class: 'empty', text: '读取失败：' + error.message }))
    }
  }

  /** Model providers: the same llm-pi-ai routes the desktop settings page writes. */
  function providerSection() {
    const rows = [
      el('div', { class: 'small', style: 'margin:2px 4px 8px', text: '模型供应商（与电脑端「设置 → 模型」共用一份配置）' }),
    ]
    for (const provider of providers.providers) {
      rows.push(
        el('button', {
          class: 'file-row',
          onclick: () => openProviderDetail(provider, load),
        }, [
          el('div', { class: 'ftype' }, [svg(ICON.spark, 15)]),
          el('div', { class: 'fname' }, [
            el('div', { text: provider.displayName || provider.route }),
            el('div', { class: 'small', text: `${provider.route} · ${provider.baseURL}` }),
            el('div', {
              class: 'small',
              text: `${provider.models.length} 个模型 · 密钥${provider.keyConfigured ? '已配置' : '未配置'}`,
            }),
          ]),
          el('div', { class: 'fmeta', text: '›' }),
        ]),
      )
    }
    rows.push(
      el('button', {
        class: 'file-row',
        onclick: () => openProviderForm(providers, load),
      }, [
        el('div', { class: 'ftype' }, [svg(ICON.plus, 15)]),
        el('div', { class: 'fname', text: '添加供应商' }),
      ]),
    )
    rows.push(el('div', { class: 'divider' }))
    return rows
  }

  function namespaceSection() {
    if (!namespaces.length) return [el('div', { class: 'empty', text: '这个 DSH 没有可写的设置项' })]
    return namespaces.map((ns) =>
      el('button', { class: 'file-row', onclick: () => openNamespace(ns) }, [
        el('div', { class: 'ftype' }, [svg(ICON.sliders, 15)]),
        el('div', { class: 'fname', text: ns.title || ns.ns }),
        el('div', { class: 'fmeta', text: `${(ns.fields || []).length} 项` }),
      ]),
    )
  }

  function openNamespace(ns) {
    const detail = panelShell({ title: ns.title || ns.ns, subtitle: ns.ns })
    const draft = {}
    const rows = (ns.fields || []).map((field) => {
      const current = Object.prototype.hasOwnProperty.call(draft, field.key) ? draft[field.key] : field.value
      if (field.type === 'boolean') {
        const control = el('div', { class: `switch${current ? ' on' : ''}` })
        control.addEventListener('click', () => {
          const next = !control.classList.contains('on')
          control.classList.toggle('on', next)
          draft[field.key] = next
        })
        return el('div', { class: 'setting-row' }, [
          el('div', { class: 'sname' }, [el('b', { text: field.label || field.key }), field.description ? el('span', { text: field.description }) : null]),
          control,
        ])
      }
      if (field.type === 'select') {
        const select = el('select', {
          onchange: (event) => {
            draft[field.key] = event.target.value
          },
        }, (field.options || []).map((option) =>
          el('option', { value: option.value, selected: option.value === current ? 'selected' : null }, option.label || option.value),
        ))
        return el('div', { class: 'setting-row' }, [
          el('div', { class: 'sname' }, [el('b', { text: field.label || field.key }), field.description ? el('span', { text: field.description }) : null]),
          select,
        ])
      }
      if (field.type === 'number') {
        const fieldInput = el('input', { type: 'number', value: current ?? '', oninput: (event) => { draft[field.key] = Number(event.target.value) } })
        return el('div', { class: 'setting-row' }, [
          el('div', { class: 'sname' }, [el('b', { text: field.label || field.key }), field.description ? el('span', { text: field.description }) : null]),
          fieldInput,
        ])
      }
      if (field.type === 'string') {
        const fieldInput = el('input', { type: 'text', value: current ?? '', oninput: (event) => { draft[field.key] = event.target.value } })
        return el('div', { class: 'setting-row' }, [
          el('div', { class: 'sname' }, [el('b', { text: field.label || field.key }), field.description ? el('span', { text: field.description }) : null]),
          fieldInput,
        ])
      }
      return el('div', { class: 'setting-row' }, [
        el('div', { class: 'sname' }, [el('b', { text: field.label || field.key }), el('span', { text: '只读：' + JSON.stringify(current).slice(0, 60) })]),
      ])
    })

    const save = el('button', {
      class: 'btn',
      onclick: async () => {
        if (!Object.keys(draft).length) return toast('没有改动')
        try {
          await api(`/api/settings/${encodeURIComponent(ns.ns)}`, {
            method: 'POST',
            body: { patch: draft, revision: ns.revision },
          })
          toast('已保存')
          detail.close()
          load()
        } catch (error) {
          toast('保存失败：' + error.message)
        }
      },
    }, '保存')

    detail.body.replaceChildren(...rows, rows.length ? el('div', { style: 'height:12px' }) : el('div', { class: 'empty', text: '这个设置组没有可编辑字段' }), save)
  }

  load()
  return view
}

/* ------------------------------------------------------------------ go */

boot()
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refreshGoalActivation()
})
setInterval(() => {
  if (!document.hidden) refreshGoalActivation()
  if (state.view === 'sessions' && !document.hidden) {
    // keep the list fresh without a full reload
    api('/api/bootstrap')
      .then((bootstrap) => {
        state.sessions = bootstrap.sessions?.items || state.sessions
        state.approvals = bootstrap.approvals || state.approvals
        if (state.view === 'sessions') renderSessions()
      })
      .catch(() => {})
  }
  if (state.view === 'chat' && state.current && !document.hidden && !state.live) {
    // Self-heal a "running" flag wedged by a lost turn/end frame (SSE reconnect
    // during a long answer): the Host's last turn boundary is the truth.
    api(`/api/sessions/${encodeURIComponent(state.current.id)}?limit=3`)
      .then((page) => {
        const events = (page.records || []).map((record) => record.event).filter(Boolean)
        const last = [...events].reverse().find((event) => event.type === 'turn/end' || event.type === 'turn/start')
        if (!last && state.current.running && events.some((event) => event.type === 'assistant/message')) {
          state.current.running = false // window ends after the settlement: turn is over
        } else if (last) {
          state.current.running = last.type === 'turn/start'
        }
        syncRunningUi()
      })
      .catch(() => {})
  }
}, 15000)
