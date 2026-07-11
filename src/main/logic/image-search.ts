import { IpcMain } from 'electron'
import axios from 'axios'
import fs from 'fs/promises'
import path from 'path'

/**
 * BRUTUS web image search & fetch.
 * --------------------------------
 * Scrapes Bing Images for high-resolution, contextually-relevant photos,
 * downloads one, and normalizes it (webp→png, capped size) via sharp so it
 * embeds reliably in PPTX. Used by Deck Studio; also exposed as `search-images`.
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'

export async function searchImageUrls(query: string, count = 8): Promise<string[]> {
  const urls: string[] = []
  try {
    const url = `https://www.bing.com/images/search?q=${encodeURIComponent(
      query
    )}&form=HDRSC2&first=1&qft=+filterui:imagesize-large+filterui:photo-photo`
    const res = await axios.get(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
      timeout: 15000
    })
    const html: string = res.data || ''
    // Bing embeds the media URL as murl inside HTML-encoded JSON.
    const re = /murl&quot;:&quot;(.*?)&quot;/g
    let m: RegExpExecArray | null
    while ((m = re.exec(html)) && urls.length < count) {
      const u = m[1].replace(/\\\//g, '/')
      if (/^https?:\/\//.test(u) && !urls.includes(u)) urls.push(u)
    }
    // Secondary pattern (some responses use plain "murl":"...")
    if (urls.length === 0) {
      const re2 = /"murl":"(.*?)"/g
      while ((m = re2.exec(html)) && urls.length < count) {
        const u = m[1].replace(/\\\//g, '/')
        if (/^https?:\/\//.test(u) && !urls.includes(u)) urls.push(u)
      }
    }
  } catch {
    // network/scrape failure — return whatever we have (possibly empty)
  }
  return urls
}

async function downloadRaw(url: string): Promise<{ buf: Buffer; ct: string } | null> {
  try {
    const res = await axios.get(url, {
      responseType: 'arraybuffer',
      headers: { 'User-Agent': UA },
      timeout: 20000,
      maxContentLength: 30 * 1024 * 1024,
      maxRedirects: 4
    })
    const ct = String(res.headers['content-type'] || '')
    if (!ct.startsWith('image/')) return null
    return { buf: Buffer.from(res.data), ct }
  } catch {
    return null
  }
}

/**
 * Fetch one usable image for a query: tries multiple results, downloads,
 * normalizes to PNG (max 1600px wide). Returns the local file path or null.
 */
export async function fetchImage(
  query: string,
  destDir: string,
  name: string
): Promise<string | null> {
  await fs.mkdir(destDir, { recursive: true })
  const urls = await searchImageUrls(query, 8)
  for (const u of urls) {
    const raw = await downloadRaw(u)
    if (!raw) continue
    try {
      const sharpMod: any = await import('sharp')
      const sharp = sharpMod.default ?? sharpMod
      const dest = path.join(destDir, `${name}.png`)
      await sharp(raw.buf)
        .resize({ width: 1600, withoutEnlargement: true })
        .png({ quality: 90 })
        .toFile(dest)
      return dest
    } catch {
      // sharp couldn't decode this one — try the next url
      continue
    }
  }
  return null
}

export default function registerImageSearch(ipcMain: IpcMain) {
  ipcMain.removeHandler('search-images')
  ipcMain.handle('search-images', async (_e, { query, count }) => {
    const urls = await searchImageUrls(String(query || ''), Number(count) || 5)
    return { success: urls.length > 0, urls }
  })
}
