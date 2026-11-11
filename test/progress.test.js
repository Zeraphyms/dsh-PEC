import test from 'node:test'
import assert from 'node:assert/strict'
import { emptyProgress, progressFromSnapshot, applyProgressEvent, applyGoalActivation, composerAction, todoCounts, goalPhaseLabel } from '../web/progress.js'
import { Dsh } from '../lib/dsh.js'

const tasks = [
  { content: '确认需求', status: 'completed' },
  { content: '实现界面', status: 'in_progress' },
  { content: '验证手机布局', status: 'pending' },
]
const goal = { id: 'goal-a', revision: 1, objective: '完成交付', phase: 'active', maxGoalRounds: 10 }
const projection = { goal, roundsStarted: 2, createdAt: 1000, updatedAt: 2000 }
const event = (seq, type, data = {}) => ({ seq, type, data, time: 3000 + seq })
const change = (operation, current = goal, roundsStarted = 0) => ({
  kind: 'goal/change', version: 1, operation, goal: current, roundsStarted, createdAt: 1000, updatedAt: 2000,
})

test('opening mid-run reads full-log projections even when history omits their writes', () => {
  const progress = progressFromSnapshot({ cursor: 50, projections: { asOfSeq: 50, values: { todos: tasks, goal: projection } }, records: [] })
  assert.deepEqual(progress.todos, tasks)
  assert.equal(progress.goal.objective, '完成交付')
  assert.equal(progress.goal.roundsStarted, 2)
  assert.equal(progress.goal.revision, 1)
  assert.equal(progress.seq, 50)
  assert.equal(applyProgressEvent(progress, event(49, 'todo/write', { todos: [] })), false)
  assert.deepEqual(progress.todos, tasks)
})

test('explicit null clears stale history on reconnect; empty sessions stay empty', () => {
  const records = [event(1, 'todo/write', { todos: tasks }), event(2, 'goal/change', change('create'))].map((event) => ({ event }))
  const progress = progressFromSnapshot({ cursor: 5, projections: { values: { todos: null, goal: null } }, records })
  assert.equal(progress.todos, null)
  assert.equal(progress.goal, null)
  assert.deepEqual(progressFromSnapshot({ records: [] }), emptyProgress())
})

test('live task lists replace as a whole, deduplicate, and reset only on the next turn', () => {
  const progress = emptyProgress()
  applyProgressEvent(progress, event(1, 'todo/write', { todos: tasks }))
  assert.deepEqual(todoCounts(progress.todos), { completed: 1, in_progress: 1, pending: 1 })
  applyProgressEvent(progress, event(2, 'turn/end'))
  assert.equal(progress.todos.length, 3)
  const completed = tasks.map((item) => ({ ...item, status: 'completed' }))
  applyProgressEvent(progress, event(3, 'todo/write', { todos: completed }))
  applyProgressEvent(progress, event(3, 'todo/write', { todos: [] }))
  assert.equal(todoCounts(progress.todos).completed, 3)
  applyProgressEvent(progress, event(4, 'turn/start'))
  assert.equal(progress.todos, null)
})

test('goal changes replace lifecycle state; only matching admitted rounds advance', () => {
  const progress = emptyProgress()
  applyProgressEvent(progress, event(1, 'goal/change', change('create')))
  applyProgressEvent(progress, event(2, 'user/message', { source: { kind: 'goal', goalId: goal.id, revision: 1, round: 1 } }))
  assert.equal(progress.goal.roundsStarted, 1)
  applyProgressEvent(progress, event(3, 'user/message', { source: { kind: 'user' } }))
  applyProgressEvent(progress, event(4, 'user/message', { source: { kind: 'goal', goalId: 'other', revision: 1, round: 2 } }))
  applyProgressEvent(progress, event(5, 'user/message', { source: { kind: 'goal', goalId: goal.id, revision: 1, round: 5 } }))
  assert.equal(progress.goal.roundsStarted, 1)
  applyProgressEvent(progress, event(6, 'goal/change', change('pause', { ...goal, revision: 2, phase: 'paused' }, 1)))
  assert.equal(goalPhaseLabel(progress.goal), '已暂停的目标')
  applyProgressEvent(progress, event(7, 'goal/change', change('complete', { ...goal, revision: 3, phase: 'complete' }, 1)))
  assert.equal(progress.goal.phase, 'complete')
  applyProgressEvent(progress, event(8, 'goal/change', { kind: 'goal/change', version: 1, operation: 'clear', cleared: { id: goal.id, revision: 4 }, clearedAt: 3000 }))
  assert.equal(progress.goal, null)
})

test('runtime activation cannot overwrite another goal or revision', () => {
  const progress = progressFromSnapshot({ projections: { values: { goal: projection } } })
  assert.equal(applyGoalActivation(progress, { goal: { id: 'other', revision: 1, activation: 'disarmed' } }), false)
  assert.equal(applyGoalActivation(progress, { goal: { id: goal.id, revision: 2, activation: 'disarmed' } }), false)
  assert.equal(applyGoalActivation(progress, { goal: { id: goal.id, revision: 1, activation: 'disarmed' } }), true)
  assert.equal(goalPhaseLabel(progress.goal), '待继续的目标')
  assert.equal(applyGoalActivation(progress, { goal: { id: goal.id, revision: 1, activation: 'disarmed' } }), false)
  assert.equal(applyGoalActivation(progress, { goal: { id: goal.id, revision: 1, activation: 'armed' } }), true)
  assert.equal(goalPhaseLabel(progress.goal), '进行中的目标')
})

test('legacy snapshot fallback folds recorded writes without changing a different session', () => {
  const first = progressFromSnapshot({ records: [event(1, 'goal/change', change('create')), event(2, 'todo/write', { todos: tasks })].map((event) => ({ event })) })
  const second = progressFromSnapshot({ cursor: 1, projections: { values: { todos: null, goal: null } } })
  applyProgressEvent(first, event(3, 'todo/write', { todos: [] }))
  assert.equal(second.goal, null)
  assert.equal(second.todos, null)
})

test('a typed message keeps the send button while a turn runs', () => {
  assert.equal(composerAction({ running: true, hasDraft: false }), 'stop')
  assert.equal(composerAction({ running: true, hasDraft: true }), 'send')
  assert.equal(composerAction({ running: false, hasDraft: false }), 'send')
  assert.equal(composerAction({ running: false, hasDraft: true }), 'send')
})

test('goal adapter returns runtime authority and uses the latest ref for controls', async () => {
  let view = { ...goal, roundsStarted: 2, activation: 'armed' }
  const agent = { id: 'session-a' }
  const goals = {
    get: () => view,
    pause: (actualAgent, ref) => {
      assert.equal(actualAgent, agent)
      assert.deepEqual(ref, { id: goal.id, revision: 1 })
      view = { ...view, revision: 2, phase: 'paused', activation: 'disarmed' }
    },
  }
  const adapter = new Dsh({ get: (name) => ({ goals, agents: { get: () => agent }, sessionController: {} })[name] }, { warn() {} })
  assert.equal((await adapter.goal(agent.id)).goal.activation, 'armed')
  assert.equal((await adapter.goalAction(agent.id, 'pause')).goal.phase, 'paused')
})
