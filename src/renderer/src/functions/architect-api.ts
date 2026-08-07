const getGeminiKey = async (): Promise<string> => {
  try {
    const keys = await window.electron.ipcRenderer.invoke('secure-get-keys')
    return (keys?.geminiKey || localStorage.getItem('brutus_custom_api_key') || '').trim()
  } catch {
    return (localStorage.getItem('brutus_custom_api_key') || '').trim()
  }
}

export const draftProjectPlan = async (goal: string) => {
  try {
    const geminiKey = await getGeminiKey()
    if (!geminiKey) return '⚠️ Missing Gemini API Key. Add it in the Command Center Vault first.'

    window.dispatchEvent(new CustomEvent('architect-drafting', { detail: { goal } }))
    const r = await window.electron.ipcRenderer.invoke('architect-draft', { goal, geminiKey })

    if (r.success) {
      window.dispatchEvent(new CustomEvent('architect-drafted', { detail: r.plan }))
      return `✅ Drafted project "${r.projectName}".\n${r.summary || ''}\nFiles planned: ${(r.fileList || []).join(', ')}\n\nReview it, then say "execute the plan" to build it (add "and run setup" to also run install commands).`
    }
    return `❌ Draft failed: ${r.error}`
  } catch (err) {
    return `❌ System error during draft: ${err}`
  }
}

export const executeProjectPlan = async (runCommands = false, baseDir?: string) => {
  try {
    const r = await window.electron.ipcRenderer.invoke('architect-execute', { runCommands, baseDir })
    if (r.success) {
      window.dispatchEvent(new CustomEvent('architect-executed', { detail: { root: r.root } }))
      let msg = `✅ Project built at ${r.root}. Created ${r.created} file(s).`
      if (r.skipped && r.skipped.length) msg += ` (Skipped ${r.skipped.length} unsafe path(s).)`
      if (r.ranCommands && r.cmdOut) msg += `\nSetup output:\n${String(r.cmdOut).slice(0, 1200)}`
      return msg
    }
    return `❌ Execution failed: ${r.error}`
  } catch (err) {
    return `❌ System error during execution: ${err}`
  }
}
