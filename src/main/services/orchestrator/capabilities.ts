/**
 * BRUTUS Orchestrator — the v1 capability set
 * --------------------------------------------
 * Two kinds of capability live here:
 *
 *  1. MANIFEST — existing `ipcMain.handle` channels, adopted without touching
 *     the modules that own them. `createCapabilityCapture` (capability-bus.ts)
 *     records the handler as it is registered. Each entry declares:
 *       • risk tags, which drive the approval gate;
 *       • a one-line description the agent sees;
 *       • an `adapt` that maps the agent's flat args onto the handler's real
 *         positional signature, injecting API keys the handler expects.
 *     Signatures were read from the handlers directly, so these match.
 *
 *  2. AGENT-ONLY — things with no IPC channel, defined here outright: Tavily
 *     search (the researcher's evidence stage) and a keyless weather lookup.
 */
import { tavily } from '@tavily/core'
import { capability, defineCapability, type IpcMainLike } from './capability-bus'
import { createCapabilityCapture } from './capability-bus'
import { DEFAULT_CONFIG, type CapabilitySpec, type OrchestratorConfig } from './types'

/** Live config, so adapters can inject the keys handlers expect. */
let getConfig: () => OrchestratorConfig = () => DEFAULT_CONFIG

export function bindCapabilityConfig(fn: () => OrchestratorConfig): void {
  getConfig = fn
}

const A = (s: string): string => s // readability helper for arg docs

type ManifestEntry = {
  spec: CapabilitySpec
  adapt?: (args: Record<string, unknown>) => unknown[]
}

/**
 * channel → capability. The capability name is kept identical to the channel so
 * logs, approvals and the UI all speak one vocabulary.
 */
export const CAPABILITY_MANIFEST: Record<string, ManifestEntry> = {
  // ── Files: read ──────────────────────────────────────────────────────────
  'read-file': {
    spec: {
      name: 'read-file',
      tags: ['read'],
      description: 'Read the full text content of a file at an absolute path.',
      args: { file_path: A('absolute path to the file') }
    },
    adapt: (a) => [a.file_path ?? a.path]
  },
  'read-directory': {
    spec: {
      name: 'read-directory',
      tags: ['read'],
      description: 'List the entries of a directory.',
      args: { dir_path: A('absolute directory path') }
    },
    adapt: (a) => [a.dir_path ?? a.path]
  },
  'search-files': {
    spec: {
      name: 'search-files',
      tags: ['read'],
      description: 'Semantic search across indexed files on this machine.',
      args: { query: A('what to look for') }
    },
    adapt: (a) => [{ query: a.query, groqKey: getConfig().groqKeys[0] || '' }]
  },
  'analyze-folder': {
    spec: {
      name: 'analyze-folder',
      tags: ['read'],
      description: 'Summarise the size, types and structure of a folder.',
      args: { directory: A('absolute folder path') }
    },
    adapt: (a) => [{ directory: a.directory ?? a.path }]
  },
  'index-folder': {
    spec: {
      name: 'index-folder',
      tags: ['read'],
      description: 'Index a folder so it becomes searchable. Slow on big trees.',
      args: { folder_path: A('absolute folder path') }
    },
    adapt: (a) => [a.folder_path ?? a.path]
  },

  // ── Files: write / destructive ───────────────────────────────────────────
  'write-file': {
    spec: {
      name: 'write-file',
      tags: ['write'],
      description: 'Create or overwrite a file with the given content.',
      args: { file_name: A('file name or path'), content: A('full file content') }
    },
    adapt: (a) => [{ fileName: a.file_name ?? a.fileName, content: a.content }]
  },
  'append-file': {
    spec: {
      name: 'append-file',
      tags: ['write'],
      description: 'Append content to the end of an existing file.',
      args: { file_name: A('file name or path'), content: A('text to append') }
    },
    adapt: (a) => [{ fileName: a.file_name ?? a.fileName, content: a.content }]
  },
  'file-ops': {
    spec: {
      name: 'file-ops',
      tags: ['destructive'],
      description: 'Move, copy, rename or delete a file. Irreversible.',
      args: {
        operation: A('move | copy | rename | delete'),
        source_path: A('absolute source path'),
        dest_path: A('absolute destination path, omit for delete')
      }
    },
    adapt: (a) => [{ operation: a.operation, sourcePath: a.source_path, destPath: a.dest_path }]
  },
  'convert-file': {
    spec: {
      name: 'convert-file',
      tags: ['write'],
      description: 'Convert a file to another format (pdf, docx, csv, md, png…).',
      args: {
        source_path: A('absolute source path'),
        target_format: A('target extension, e.g. pdf'),
        output_dir: A('optional output directory')
      }
    },
    adapt: (a) => [
      { sourcePath: a.source_path, targetFormat: a.target_format, outputDir: a.output_dir }
    ]
  },
  'zip-items': {
    spec: {
      name: 'zip-items',
      tags: ['write'],
      description: 'Compress files or folders into a zip archive.',
      args: { paths: A('array of absolute paths'), output_zip_path: A('destination .zip') }
    },
    adapt: (a) => [{ paths: a.paths, outputZipPath: a.output_zip_path }]
  },
  'create-pdf': {
    spec: {
      name: 'create-pdf',
      tags: ['write'],
      description: 'Render a titled text document to a PDF file.',
      args: {
        file_name: A('output file name'),
        title: A('document title'),
        content: A('body text'),
        output_dir: A('optional output directory')
      }
    },
    adapt: (a) => [
      { fileName: a.file_name, title: a.title, content: a.content, outputDir: a.output_dir }
    ]
  },

  // ── Notes ────────────────────────────────────────────────────────────────
  'get-notes': {
    spec: { name: 'get-notes', tags: ['read'], description: 'List all saved notes.' },
    adapt: () => []
  },
  'save-note': {
    spec: {
      name: 'save-note',
      tags: ['write'],
      description: 'Save a titled note to the local notes store.',
      args: { title: A('note title'), content: A('note body') }
    },
    adapt: (a) => [{ title: a.title, content: a.content }]
  },

  // ── Knowledge ────────────────────────────────────────────────────────────
  'consult-oracle': {
    spec: {
      name: 'consult-oracle',
      tags: ['read'],
      description: "Answer a question from the user's own indexed documents (RAG).",
      args: { query: A('the question') }
    },
    adapt: (a) => [{ query: a.query, geminiKey: '', groqKey: getConfig().groqKeys[0] || '' }]
  },
  'kg-query': {
    spec: {
      name: 'kg-query',
      tags: ['read'],
      description: 'Query the knowledge graph for entities and relationships.',
      args: { query: A('natural-language question') }
    },
    adapt: (a) => [a]
  },
  'kg-stats': {
    spec: { name: 'kg-stats', tags: ['read'], description: 'Knowledge graph size and health.' },
    adapt: (a) => [a]
  },

  // ── Web ──────────────────────────────────────────────────────────────────
  'google-search': {
    spec: {
      name: 'google-search',
      tags: ['read'],
      description: 'Quick web lookup. Prefer web_search for real research.',
      args: { query: A('search query') }
    },
    adapt: (a) => [a.query]
  },
  'check-website-status': {
    spec: {
      name: 'check-website-status',
      tags: ['read'],
      description: 'Check whether a URL is reachable and how fast it responds.',
      args: { url: A('full URL') }
    },
    adapt: (a) => [a.url ?? a]
  },
  'search-images': {
    spec: {
      name: 'search-images',
      tags: ['read'],
      description: 'Find image URLs for a query.',
      args: { query: A('image subject'), count: A('how many, default 8') }
    },
    adapt: (a) => [{ query: a.query, count: a.count ?? 8 }]
  },

  // ── Email (external → always approved by the user first) ─────────────────
  'gmail-read': {
    spec: {
      name: 'gmail-read',
      tags: ['read'],
      description: 'Read the most recent emails from the connected Gmail account.',
      args: { max_results: A('how many, default 5') }
    },
    adapt: (a) => [a.max_results ?? 5]
  },
  'gmail-draft': {
    spec: {
      name: 'gmail-draft',
      tags: ['write'],
      description: 'Create a Gmail draft. Does NOT send it.',
      args: { to: A('recipient'), subject: A('subject'), body: A('email body') }
    },
    adapt: (a) => [{ to: a.to, subject: a.subject, body: a.body }]
  },
  'gmail-send': {
    spec: {
      name: 'gmail-send',
      tags: ['external'],
      description: 'SEND an email immediately. Leaves this machine.',
      args: { to: A('recipient'), subject: A('subject'), body: A('email body') }
    },
    adapt: (a) => [{ to: a.to, subject: a.subject, body: a.body }]
  },

  // ── Code / system ────────────────────────────────────────────────────────
  'git-op': {
    spec: {
      name: 'git-op',
      tags: ['write'],
      description: 'Run a git operation (status, diff, log, commit, branch).',
      args: { operation: A('git subcommand'), path: A('repository path') }
    },
    adapt: (a) => [a]
  },
  'run-shell-command': {
    spec: {
      name: 'run-shell-command',
      tags: ['destructive'],
      description: 'Execute a shell command. Can change or destroy anything.',
      args: { command: A('the command'), cwd: A('working directory') }
    },
    adapt: (a) => [{ command: a.command, cwd: a.cwd }]
  },
  'excel-op': {
    spec: {
      name: 'excel-op',
      tags: ['write'],
      description: 'Read or write spreadsheet data.',
      args: { operation: A('the operation'), path: A('workbook path') }
    },
    adapt: (a) => [a]
  },

  // ── Productivity ─────────────────────────────────────────────────────────
  'set-reminder': {
    spec: {
      name: 'set-reminder',
      tags: ['write'],
      description: 'Schedule a reminder.',
      args: {
        text: A('what to be reminded of'),
        delay_minutes: A('minutes from now'),
        at_iso: A('or an absolute ISO timestamp')
      }
    },
    adapt: (a) => [{ text: a.text, delayMinutes: a.delay_minutes, atISO: a.at_iso }]
  },
  'list-reminders': {
    spec: { name: 'list-reminders', tags: ['read'], description: 'List pending reminders.' },
    adapt: () => []
  },
  'open-app': {
    spec: {
      name: 'open-app',
      tags: ['write'],
      description: 'Launch a desktop application by name.',
      args: { app_name: A('application name') }
    },
    adapt: (a) => [a.app_name ?? a.name]
  }
}

/**
 * Install the capture proxy. Pass the returned object to the registrars in
 * main/index.ts instead of the raw ipcMain; every channel above becomes
 * agent-callable with no change to the module that owns it.
 */
export function captureCapabilities(realIpcMain: IpcMainLike): IpcMainLike {
  return createCapabilityCapture(realIpcMain, CAPABILITY_MANIFEST)
}

// ── Agent-only capabilities (no IPC channel behind them) ────────────────────

export interface SearchSource {
  index: number
  title: string
  url: string
  content: string
}

/**
 * Tavily evidence gathering — stage one of the research pipeline.
 *
 * `includeRawContent` with 8 results is deliberately heavy: the researcher runs
 * on openai/gpt-oss-120b (131k context), which is large enough to reason over
 * all eight pages in a single call. Sources are numbered so the model can cite
 * them inline as [1][2] and we can map those back to URLs afterwards.
 */
export async function tavilySearch(
  query: string,
  opts: { maxResults?: number; apiKey?: string } = {}
): Promise<{ answer: string; sources: SearchSource[] }> {
  const apiKey = (opts.apiKey ?? getConfig().tavilyKey ?? '').trim()
  if (!apiKey) throw new Error('No Tavily API key configured (Settings → API Keys).')

  // Tavily hard-rejects queries over 400 characters. Callers are supposed to
  // pass a real search query, but this is the last line of defence: a rejected
  // search fails the whole research task, so clamp rather than throw.
  const MAX_QUERY = 380
  let q = String(query || '')
    .replace(/\s+/g, ' ')
    .trim()
  if (q.length > MAX_QUERY) {
    const cut = q.slice(0, MAX_QUERY)
    const lastSpace = cut.lastIndexOf(' ')
    q = (lastSpace > MAX_QUERY * 0.6 ? cut.slice(0, lastSpace) : cut).trim()
  }
  if (!q) throw new Error('Empty search query.')

  const client = tavily({ apiKey })
  const res = await client.search(q, {
    searchDepth: 'advanced',
    includeAnswer: true,
    // 'text' rather than `true`: this SDK version types raw content as a
    // format, and plain text is what the model reasons over best.
    includeRawContent: 'text',
    maxResults: opts.maxResults ?? 8
  })

  // The SDK's result type varies by version (rawContent vs raw_content), so we
  // read it structurally rather than depending on a shape that may change.
  type RawResult = {
    title?: string
    url?: string
    content?: string
    rawContent?: string
    raw_content?: string
  }
  const payload = res as { results?: RawResult[]; answer?: string }

  const sources: SearchSource[] = (payload.results ?? []).map((r, i) => ({
    index: i + 1,
    title: String(r.title || 'Untitled'),
    url: String(r.url || ''),
    // Raw content is the whole page; cap per-source so eight of them still fit
    // comfortably inside the context window alongside the prompt.
    content: String(r.rawContent || r.raw_content || r.content || '').slice(0, 12_000)
  }))

  return { answer: String(payload.answer || ''), sources }
}

export function registerAgentCapabilities(): void {
  defineCapability(
    {
      name: 'web_search',
      tags: ['read'],
      description:
        'Search the live web and return numbered sources with full page text. Use this for any research question.',
      args: { query: 'what to research', max_results: 'how many sources, default 8' }
    },
    async (args) => {
      const { answer, sources } = await tavilySearch(String(args.query || ''), {
        maxResults: Number(args.max_results) || 8
      })
      return {
        quick_answer: answer,
        sources: sources.map((s) => ({
          n: s.index,
          title: s.title,
          url: s.url,
          excerpt: s.content.slice(0, 2000)
        }))
      }
    }
  )

  defineCapability(
    {
      name: 'get_weather',
      tags: ['read'],
      description: 'Current weather for a city.',
      args: { city: 'city name' }
    },
    async (args) => {
      const city = String(args.city || '').trim()
      if (!city) throw new Error('city is required')
      const geo = await fetch(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en&format=json`
      ).then((r) => r.json())
      const loc = geo?.results?.[0]
      if (!loc) throw new Error(`Unknown location: ${city}`)
      const wx = await fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}&current=temperature_2m,relative_humidity_2m,precipitation,weather_code,wind_speed_10m&timezone=auto`
      ).then((r) => r.json())
      return {
        location: `${loc.name}, ${loc.country ?? ''}`.trim(),
        ...wx.current
      }
    }
  )
}

/** Re-export so orchestrator/index.ts can register non-manifest capabilities. */
export { capability }
