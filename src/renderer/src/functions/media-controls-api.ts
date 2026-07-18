export const mediaTransport = async (action: string) => {
  try {
    return await window.electron.ipcRenderer.invoke('media-transport', { action })
  } catch (err) {
    return `System Error: Media engine offline. ${err}`
  }
}

export const nowPlaying = async () => {
  try {
    return await window.electron.ipcRenderer.invoke('media-now-playing')
  } catch (err) {
    return `System Error: Media engine offline. ${err}`
  }
}

export const youtubeControl = async (action: string) => {
  try {
    return await window.electron.ipcRenderer.invoke('youtube-control', { action })
  } catch (err) {
    return `System Error: Media engine offline. ${err}`
  }
}

export const spotifyControl = async (action: string) => {
  try {
    return await window.electron.ipcRenderer.invoke('spotify-control', { action })
  } catch (err) {
    return `System Error: Media engine offline. ${err}`
  }
}

export const openStreaming = async (platform: string, query?: string) => {
  try {
    return await window.electron.ipcRenderer.invoke('open-streaming', { platform, query })
  } catch (err) {
    return `System Error: Media engine offline. ${err}`
  }
}
