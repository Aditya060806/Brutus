export const runDeepResearch = async (query: string): Promise<string> => {
  try {
    window.dispatchEvent(new CustomEvent('deep-research-start', { detail: { query } }))

    const tavilyKey = localStorage.getItem('brutus_tailvy_api_key') || ''
    const groqKey = localStorage.getItem('brutus_groq_api_key') || ''
    const notionKey = localStorage.getItem('brutus_notion_api_key') || ''
    const notionDbId = localStorage.getItem('brutus_notion_database_id') || ''

    const result = await window.electron.ipcRenderer.invoke('execute-deep-research', {
      query,
      tavilyKey,
      groqKey,
      notionKey,
      notionDbId
    })

    if (result.success) {
      window.dispatchEvent(
        new CustomEvent('deep-research-done', {
          detail: { success: true, summary: result.summary }
        })
      )
      return `✅ Research complete. Here is a summary of the data so you can inform the user: ${result.summary}`
    }

    window.dispatchEvent(new CustomEvent('deep-research-done', { detail: { success: false } }))
    return `❌ Research failed: ${result.error}`
  } catch (error) {
    alert(`System failure during deep research: ${String(error)}`)
    return `❌ System failure: ${String(error)}`
  }
}

