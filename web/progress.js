/* Durable task/goal state, shared by the mobile dock and its regression tests. */
const TODO_STATUSES = new Set(['pending', 'in_progress', 'completed'])

export function emptyProgress() {
  return { todos: null, goal: null, seq: -1 }
}

function todosValue(value) {
  if (!Array.isArray(value)) return null
  return value.filter((item) => item && typeof item.content === 'string' && TODO_STATUSES.has(item.status))
    .map(({ content, status }) => ({ content, status }))
}

/** Accept both the durable projection and the existing /api/goal response. */
export function goalValue(value) {
  if (!value) return null
  const goal = value.goal || value
  if (typeof goal.id !== 'string' || typeof goal.objective !== 'string') return null
  return {
    ...goal,
    phase: goal.phase === 'completed' ? 'complete' : goal.phase,
    roundsStarted: value.roundsStarted ?? goal.roundsStarted ?? 0,
    createdAt: value.createdAt ?? goal.createdAt,
    updatedAt: value.updatedAt ?? goal.updatedAt,
  }
}

/** Seed from the full-log projection, never replay a partial window over it. */
export function progressFromSnapshot(frame) {
  const progress = emptyProgress()
  const values = frame.projections?.values || {}
  const hasTodos = Object.hasOwn(values, 'todos')
  const hasGoal = Object.hasOwn(values, 'goal')
  // Older Hosts may omit a projection. Only that missing field is reconstructed
  // from the supplied history; explicit null means cleared and must win.
  for (const record of frame.records || []) {
    const event = record.event
    if (!event) continue
    foldEvent(progress, event)
  }
  if (hasTodos) progress.todos = todosValue(values.todos)
  if (hasGoal) progress.goal = goalValue(values.goal)
  progress.seq = Math.max(-1, frame.cursor ?? -1, frame.projections?.asOfSeq ?? -1,
    ...(frame.records || []).map((record) => record.event?.seq ?? -1))
  return progress
}

/** Each durable event applies once; historical paging never enters this fold. */
export function applyProgressEvent(progress, event) {
  if (!Number.isSafeInteger(event?.seq) || event.seq <= progress.seq) return false
  progress.seq = event.seq
  return foldEvent(progress, event)
}

function foldEvent(progress, event) {
  if (event.type === 'turn/start') {
    const changed = progress.todos !== null
    progress.todos = null
    return changed
  }
  if (event.type === 'todo/write') {
    progress.todos = todosValue(event.data?.todos)
    return true
  }
  if (event.type === 'goal/change') {
    const change = event.data
    if (change?.kind !== 'goal/change' || change.version !== 1) return false
    if (change.operation === 'clear') {
      progress.goal = null
      return true
    }
    const next = goalValue(change)
    if (!next) return false
    // Activation is process-local: don't carry the old revision's authority.
    progress.goal = next
    return true
  }
  const source = event.type === 'user/message' ? event.data?.source : null
  const goal = progress.goal
  if (source?.kind === 'goal' && goal?.phase === 'active' && source.goalId === goal.id &&
      source.revision === goal.revision && source.round === goal.roundsStarted + 1 &&
      source.round <= goal.maxGoalRounds) {
    progress.goal = { ...goal, roundsStarted: source.round }
    return true
  }
  return false
}

export function applyGoalActivation(progress, event) {
  const next = event?.goal
  const goal = progress.goal
  if (!goal || next?.id !== goal.id || next.revision !== goal.revision ||
      !['armed', 'disarmed'].includes(next.activation) || goal.activation === next.activation) return false
  progress.goal = { ...goal, activation: next.activation }
  return true
}

export function todoCounts(todos) {
  const counts = { completed: 0, in_progress: 0, pending: 0 }
  for (const todo of todos || []) counts[todo.status] += 1
  return counts
}

export function goalPhaseLabel(goal) {
  if (goal?.phase === 'active') return goal.activation === 'disarmed' ? '待继续的目标' : '进行中的目标'
  return { paused: '已暂停的目标', blocked: '受阻的目标', complete: '已完成的目标' }[goal?.phase] || '目标'
}
