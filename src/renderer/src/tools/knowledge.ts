import axios from 'axios'

// ─── Translation (keyless Google endpoint) ────────────────────────────
export const translateText = async (text: string, target = 'en', source = 'auto') => {
  try {
    if (!text || !text.trim()) return '❌ Nothing to translate.'
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${encodeURIComponent(
      source
    )}&tl=${encodeURIComponent(target)}&dt=t&q=${encodeURIComponent(text)}`
    const res = await axios.get(url, { timeout: 12000 })
    // response: [[[translated, original, ...], ...], ...]
    const segments = res.data?.[0]
    if (!Array.isArray(segments)) return '❌ Translation failed.'
    const translated = segments.map((s: any) => s[0]).join('')
    const detected = res.data?.[2] || source
    return `Translation (${detected} → ${target}):\n${translated}`
  } catch (err) {
    return `❌ Translation failed: ${String(err)}`
  }
}

// ─── Dictionary (dictionaryapi.dev) ───────────────────────────────────
export const defineWord = async (word: string) => {
  try {
    if (!word || !word.trim()) return '❌ No word provided.'
    const res = await axios.get(
      `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word.trim())}`,
      { timeout: 12000 }
    )
    const entry = res.data?.[0]
    if (!entry) return `❌ No definition found for "${word}".`

    const phonetic = entry.phonetic || entry.phonetics?.find((p: any) => p.text)?.text || ''
    const lines: string[] = [`📖 ${entry.word}${phonetic ? ` ${phonetic}` : ''}`]
    for (const meaning of (entry.meanings || []).slice(0, 3)) {
      lines.push(`\n(${meaning.partOfSpeech})`)
      for (const def of (meaning.definitions || []).slice(0, 2)) {
        lines.push(`• ${def.definition}`)
        if (def.example) lines.push(`   e.g. "${def.example}"`)
      }
    }
    return lines.join('\n')
  } catch (err: any) {
    if (err?.response?.status === 404) return `❌ No definition found for "${word}".`
    return `❌ Dictionary lookup failed: ${String(err)}`
  }
}

// ─── Wikipedia (REST summary, with search fallback) ───────────────────
export const wikipediaSearch = async (query: string) => {
  try {
    if (!query || !query.trim()) return '❌ No search query provided.'
    const headers = {
      'User-Agent': 'BrutusAI/1.0 (https://github.com/Aditya060806; aditya060806@gmail.com)',
      'Api-User-Agent': 'BrutusAI/1.0 (https://github.com/Aditya060806)',
      Accept: 'application/json'
    }
    // 1. resolve the best matching page title
    const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(
      query
    )}&format=json&origin=*&srlimit=1`
    const sres = await axios.get(searchUrl, { timeout: 12000, headers })
    const hit = sres.data?.query?.search?.[0]
    if (!hit) return `❌ No Wikipedia article found for "${query}".`

    // 2. fetch the summary for that title
    const sumUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(
      hit.title
    )}`
    const sumRes = await axios.get(sumUrl, { timeout: 12000, headers })
    const d = sumRes.data
    const extract = d?.extract || 'No summary available.'
    const link = d?.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encodeURIComponent(hit.title)}`
    return `📚 ${d?.title || hit.title}\n\n${extract}\n\n🔗 ${link}`
  } catch (err) {
    return `❌ Wikipedia lookup failed: ${String(err)}`
  }
}
