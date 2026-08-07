export const saveCommitment = async (text: string, due?: string) => {
  try {
    const ok = await window.electron.ipcRenderer.invoke('save-commitment', { text, due })
    if (ok) return `✅ Noted your commitment: "${text}"${due ? ` (due ${due})` : ''}.`
    return '❌ Failed to save the commitment.'
  } catch (err) {
    return `❌ System error saving commitment: ${err}`
  }
}

export const getCommitments = async () => {
  try {
    const list: any[] = await window.electron.ipcRenderer.invoke('get-commitments')
    if (!list || list.length === 0) return 'You have no saved commitments or promises right now.'
    const recent = list.slice(-15)
    return (
      'Here are your recorded commitments / promises:\n' +
      recent
        .map((c, i) => {
          const due = c.due ? ` — due ${c.due}` : ''
          const when = c.createdAt ? new Date(c.createdAt).toLocaleDateString() : ''
          return `${i + 1}. ${c.text}${due} (noted ${when})`
        })
        .join('\n')
    )
  } catch (err) {
    return `❌ System error reading commitments: ${err}`
  }
}

export const forgetMemory = async (query: string) => {
  try {
    const r = await window.electron.ipcRenderer.invoke('delete-core-memory', query)
    if (r.success) return `✅ Removed ${r.removed} memory item(s) matching "${query}".`
    return `❌ Could not delete memory: ${r.error || 'unknown error'}`
  } catch (err) {
    return `❌ System error deleting memory: ${err}`
  }
}
