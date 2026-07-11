import { InferenceClient } from '@huggingface/inference'

export const setWallpaper = async (source: string) => {
  try {
    const r = await window.electron.ipcRenderer.invoke('set-wallpaper', { source })
    return r.success
      ? `✅ Desktop wallpaper updated${r.path ? ` (${r.path})` : ''}.`
      : `❌ ${r.error || 'Failed to set wallpaper.'}`
  } catch (err) {
    return `System Error: Wallpaper engine offline. ${err}`
  }
}

export const generateWallpaper = async (prompt: string) => {
  try {
    if (!prompt || !prompt.trim()) return '❌ Provide a description for the wallpaper.'
    const HF = localStorage.getItem('brutus_hf_api_key') || ''
    if (!HF.trim()) {
      return '⚠️ Missing Hugging Face API Key. Add it in the Command Center Vault to generate AI wallpapers.'
    }

    const client = new InferenceClient(HF)
    const blob: any = await client.textToImage({
      model: 'black-forest-labs/FLUX.1-schnell',
      inputs: `${prompt}, high resolution desktop wallpaper, 16:9, highly detailed`
    })

    const base64 = await new Promise<string>((resolve, reject) => {
      const fr = new FileReader()
      fr.onloadend = () => resolve(fr.result as string)
      fr.onerror = reject
      fr.readAsDataURL(blob as Blob)
    })

    const saved = await window.electron.ipcRenderer.invoke('save-image-to-gallery', {
      title: `wallpaper_${prompt}`,
      base64Data: base64
    })
    if (!saved?.success || !saved.path) return '❌ Could not save the generated image.'

    const r = await window.electron.ipcRenderer.invoke('set-wallpaper', { source: saved.path })
    return r.success
      ? `✅ Generated and set a new wallpaper from: "${prompt}".`
      : `❌ Generated the image but could not set it: ${r.error}`
  } catch (e: any) {
    return `❌ Wallpaper generation failed: ${e?.message || e}`
  }
}
