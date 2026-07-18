export const checkWebsiteStatus = async (url: string) => {
  try {
    const r = await window.electron.ipcRenderer.invoke('check-website-status', { url })
    if (!r.success) return `❌ ${r.error || 'Status check failed.'}`
    if (r.online) {
      return `✅ ${r.url} is ONLINE (HTTP ${r.status}, responded in ${r.latencyMs}ms).`
    }
    const code = r.status ? ` (HTTP ${r.status})` : ''
    const reason = r.error ? ` — ${r.error}` : ''
    return `🔴 ${r.url} appears DOWN${code}${reason}.`
  } catch (err) {
    return `System Error: Status engine offline. ${err}`
  }
}
