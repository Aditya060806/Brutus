export const triggerPersonaEffect = async (effect: string, text?: string) => {
  const e = String(effect || '').toLowerCase()
  window.dispatchEvent(new CustomEvent('brutus-dramatic', { detail: { effect: e, text } }))

  if (e === 'self_destruct') {
    return 'Initiating dramatic self-destruct sequence on screen — purely theatrical, nothing is actually harmed.'
  }
  if (e === 'obsession_note' || e === 'obsession') {
    return 'Displaying an intense obsession note on screen.'
  }
  return 'Persona effect triggered on screen.'
}
