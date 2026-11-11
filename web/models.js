/* Model catalog matching, shared by the mobile client and its tests.
 *
 * A model id is only unique inside one provider: two routes may both advertise
 * "deepseek-v4.1-flash". The stored selection is {provider, model}, so every
 * lookup has to compare the provider too — matching the id alone highlighted
 * every provider that exposed the same name.
 */

/** The catalog row a selection points at, provider first. */
export function matchModel(groups, selection) {
  if (!selection || typeof selection.model !== 'string' || !selection.model) return null
  const list = Array.isArray(groups) ? groups : []
  const provider = selection.provider || ''
  for (const group of list) {
    for (const model of group.models || []) {
      if (model.id === selection.model && (!provider || group.id === provider)) {
        return { ...model, provider: group.id }
      }
    }
  }
  // A selection can outlive a renamed route: keep the model visible rather than
  // claiming nothing is selected.
  for (const group of list) {
    for (const model of group.models || []) {
      if (model.id === selection.model) return { ...model, provider: group.id }
    }
  }
  return { id: selection.model, name: selection.model, provider }
}

/** Whether one catalog row is the selected one; ids repeat across providers. */
export function isSelectedModel(groupId, modelId, selection) {
  return Boolean(selection && selection.model === modelId && (!selection.provider || selection.provider === groupId))
}
