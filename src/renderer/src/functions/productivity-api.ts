const ipc = (channel: string, payload?: any) =>
  window.electron.ipcRenderer.invoke(channel, payload)

// ─── Reminders & timers ───────────────────────────────────────────────
export const setReminder = async (text: string, delayMinutes?: number, atISO?: string) => {
  try {
    const r = await ipc('set-reminder', { text, delayMinutes, atISO })
    return r.success ? `✅ Reminder set for ${r.fireAt}: "${text}".` : `❌ ${r.error}`
  } catch (e) {
    return `System Error: ${e}`
  }
}

export const setTimer = async (label?: string, minutes?: number, seconds?: number) => {
  try {
    const r = await ipc('set-timer', { label, minutes, seconds })
    if (!r.success) return `❌ ${r.error}`
    const m = Math.floor(r.seconds / 60)
    const s = r.seconds % 60
    const dur = m ? `${m}m${s ? ` ${s}s` : ''}` : `${s}s`
    return `✅ Timer started for ${dur}. I'll alert you when it's up.`
  } catch (e) {
    return `System Error: ${e}`
  }
}

export const cancelReminder = async (id: string) => {
  try {
    const r = await ipc('cancel-reminder', { id })
    return r.success ? '✅ Cancelled that reminder.' : '⚠️ No matching reminder found.'
  } catch (e) {
    return `System Error: ${e}`
  }
}

export const listReminders = async () => {
  try {
    const list: any[] = await ipc('list-reminders')
    if (!list || list.length === 0) return 'You have no active reminders or timers.'
    return (
      'Active reminders & timers:\n' +
      list
        .map((r, i) => `${i + 1}. [${r.type}] "${r.text}" — ${r.fireAt} (id: ${r.id})`)
        .join('\n')
    )
  } catch (e) {
    return `System Error: ${e}`
  }
}

export const clearReminders = async () => {
  try {
    await ipc('clear-reminders')
    return '✅ Cleared all reminders and timers.'
  } catch (e) {
    return `System Error: ${e}`
  }
}

// ─── Focus mode ───────────────────────────────────────────────────────
export const startFocus = async (apps?: string[], websites?: string[], durationMinutes?: number) => {
  try {
    const r = await ipc('start-focus', { apps, websites, durationMinutes })
    if (!r.success) return `❌ ${r.error}`
    let msg = `✅ Focus mode ON. Blocking ${r.apps.length} app(s)`
    if (r.sites.length) msg += ` and ${r.sites.length} site(s)`
    if (r.durationMinutes) msg += ` for ${r.durationMinutes} minutes`
    msg += '.'
    if (r.sites.length && !r.websitesBlocked) {
      msg += ` ⚠️ Couldn't block websites (${r.hostsError}). Run Brutus as administrator to block sites; apps are still blocked.`
    }
    return msg
  } catch (e) {
    return `System Error: ${e}`
  }
}

export const stopFocus = async () => {
  try {
    const r = await ipc('stop-focus')
    return r.wasActive
      ? `✅ Focus mode OFF. Apps and websites unblocked.${r.websitesRestored ? '' : ' (Note: could not edit hosts file — run as admin to fully restore site blocking.)'}`
      : 'Focus mode was not active.'
  } catch (e) {
    return `System Error: ${e}`
  }
}

// ─── Presentation ─────────────────────────────────────────────────────
export const createPresentation = async (
  title: string,
  slides: any[],
  subtitle?: string,
  fileName?: string
) => {
  try {
    const r = await ipc('create-presentation', { title, subtitle, slides, fileName })
    return r.success
      ? `✅ Presentation created with ${r.slideCount} slides: ${r.path}`
      : `❌ ${r.error}`
  } catch (e) {
    return `System Error: ${e}`
  }
}
