import test from 'node:test'
import assert from 'node:assert/strict'
import { matchModel, isSelectedModel } from '../web/models.js'

// Two routes advertise the same model id; only the provider tells them apart.
const groups = [
  { id: 'ikun', name: 'ikun', models: [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash' }, { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' }] },
  { id: 'ikunn', name: 'ikunn', models: [{ id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash' }] },
  { id: 'zcode', name: 'ZCode', models: [{ id: 'GLM-5.3-Flash', name: 'GLM-5.3-Flash' }] },
]

test('only the selected provider row is marked, not every same-id row', () => {
  const selection = { provider: 'ikunn', model: 'deepseek-v4.1-flash' }
  assert.equal(isSelectedModel('ikun', 'deepseek-v4.1-flash', selection), false)
  assert.equal(isSelectedModel('ikunn', 'deepseek-v4.1-flash', selection), true)
  assert.equal(isSelectedModel('zcode', 'GLM-5.3-Flash', selection), false)
  const selectedRows = groups.flatMap((group) => (group.models || []).filter((model) => isSelectedModel(group.id, model.id, selection)).map((model) => group.id))
  assert.deepEqual(selectedRows, ['ikunn'])
})

test('the header resolves the selected provider, not the first same-id route', () => {
  const match = matchModel(groups, { provider: 'ikunn', model: 'deepseek-v4.1-flash' })
  assert.equal(match.provider, 'ikunn')
  assert.equal(match.name, 'deepseek-v4.1-flash')
  assert.equal(matchModel(groups, { provider: 'ikun', model: 'deepseek-v4.1-flash' }).name, 'DeepSeek-V4.1-Flash')
})

test('a selection without a provider still resolves by id', () => {
  assert.equal(matchModel(groups, { model: 'GLM-5.3-Flash' }).provider, 'zcode')
  assert.equal(isSelectedModel('zcode', 'GLM-5.3-Flash', { model: 'GLM-5.3-Flash' }), true)
})

test('a selection whose provider disappeared keeps the model name visible', () => {
  const match = matchModel(groups, { provider: 'retired-route', model: 'deepseek-v4.1-flash' })
  assert.equal(match.provider, 'ikun')
  const missing = matchModel(groups, { provider: 'retired-route', model: 'not-listed' })
  assert.deepEqual(missing, { id: 'not-listed', name: 'not-listed', provider: 'retired-route' })
  assert.equal(matchModel(groups, null), null)
  assert.equal(matchModel([], { model: 'x' }).name, 'x')
})
