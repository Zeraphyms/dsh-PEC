import test from 'node:test'
import assert from 'node:assert/strict'
import { groupSessionsByWorkspace, workspaceOf, toggleWorkspace } from '../web/groups.js'

const workspaces = [
  { id: 'w-new2', title: 'new2', path: 'D:\\new\\new2' },
  { id: 'w-new', title: 'new', path: 'D:\\new' },
  { id: 'w-empty', title: 'novel', path: 'D:\\novel' },
]
const session = (title, cwd, updatedAt = 1) => ({ title, cwd, updatedAt })

test('a session joins the deepest matching workspace, not just any prefix', () => {
  assert.equal(workspaceOf(session('a', 'D:\\new\\new2\\x'), workspaces).title, 'new2')
  assert.equal(workspaceOf(session('b', 'D:\\new\\other'), workspaces).title, 'new')
  assert.equal(workspaceOf(session('c', 'D:\\new\\new2'), workspaces).title, 'new2')
})

test('case and trailing slashes do not break the match', () => {
  assert.equal(workspaceOf(session('d', 'd:\\NEW\\NEW2\\'), workspaces).title, 'new2')
})

test('sessions without a workspace land in one 其他 group', () => {
  const groups = groupSessionsByWorkspace(
    [session('a', 'C:\\Downloads'), session('b', 'D:\\new\\new2'), session('c', 'E:\\temp')],
    workspaces,
  )
  const other = groups.find((group) => group.workspace === null)
  assert.deepEqual(other.sessions.map((item) => item.title), ['a', 'c'])
  assert.equal(groups.find((group) => group.workspace?.title === 'new2').sessions.length, 1)
})

test('empty workspaces are not rendered as empty folders', () => {
  const groups = groupSessionsByWorkspace([session('a', 'D:\\new\\new2')], workspaces)
  assert.equal(groups.find((group) => group.workspace?.title === 'novel'), undefined)
})

test('groups sort by their newest session', () => {
  const groups = groupSessionsByWorkspace(
    [session('old', 'D:\\new\\new2', 100), session('fresh', 'D:\\new', 500)],
    workspaces,
  )
  assert.deepEqual(groups.map((group) => group.workspace?.title), ['new', 'new2'])
})

test('toggle adds and removes a title', () => {
  let collapsed = toggleWorkspace([], 'new2')
  assert.deepEqual(collapsed, ['new2'])
  collapsed = toggleWorkspace(collapsed, 'new')
  assert.equal(collapsed.length, 2)
  collapsed = toggleWorkspace(collapsed, 'new2')
  assert.deepEqual(collapsed, ['new'])
})
