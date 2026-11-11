/* Workspace grouping for the session list, shared with its regression tests.
 *
 * The Host reports workspaces as {id, title, path} and sessions carry a cwd.
 * A session belongs to the workspace whose path is a prefix of its cwd
 * (deepest match wins, so D:\new\new2 beats D:\new). Everything else groups
 * under 其他.
 */

export function normalizePath(value) {
  return String(value || '').toLowerCase().replace(/[\\/]+$/, '')
}

/** Deepest workspace whose path prefixes the session's cwd. */
export function workspaceOf(session, workspaces) {
  const cwd = normalizePath(session?.cwd)
  if (!cwd) return null
  let best = null
  let bestLength = -1
  for (const workspace of workspaces || []) {
    const base = normalizePath(workspace.path)
    if (!base) continue
    if (cwd === base || cwd.startsWith(base + '\\') || cwd.startsWith(base + '/')) {
      if (base.length > bestLength) {
        best = workspace
        bestLength = base.length
      }
    }
  }
  return best
}

/**
 * Group visible sessions by workspace, keeping each group's recency order.
 * OtherPath (no workspace) only appears when it has sessions. Group order
 * follows each group's newest session, newest first.
 */
export function groupSessionsByWorkspace(sessions, workspaces) {
  const groups = (workspaces || []).map((workspace) => ({ workspace, sessions: [] }))
  const other = { workspace: null, sessions: [] }
  const byId = new Map(groups.map((group) => [group.workspace.id, group]))
  for (const session of sessions || []) {
    const owner = workspaceOf(session, workspaces)
    const target = owner ? byId.get(owner.id) : other
    ;(target || other).sessions.push(session)
  }
  const visible = [...groups, other].filter((group) => group.sessions.length > 0)
  visible.sort((left, right) =>
    Math.max(...right.sessions.map((session) => session.updatedAt || 0)) -
    Math.max(...left.sessions.map((session) => session.updatedAt || 0)))
  return visible
}

/** Toggle a workspace in the collapsed set; returns a new array. */
export function toggleWorkspace(collapsed, title) {
  const set = new Set(collapsed || [])
  if (set.has(title)) set.delete(title)
  else set.add(title)
  return [...set]
}
