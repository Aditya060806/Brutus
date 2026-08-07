import { IpcMain, app, BrowserWindow } from 'electron'
import fs from 'fs/promises'
import path from 'path'
import process from 'process'
import { authenticate } from '@google-cloud/local-auth'
import { google } from 'googleapis'

const SCOPES = ['https://mail.google.com/']
const TOKEN_PATH = path.join(app.getPath('userData'), 'gmail_token.json')
const CREDENTIALS_PATH = path.join(process.cwd(), 'credentials.json')

/**
 * RFC 2047 encoded-word, for header values that are not pure ASCII.
 *
 * A raw UTF-8 byte in a header is invalid per RFC 5322, and clients render it
 * as mojibake. `Subject: Invoice ₹45,000` arrives mangled without this.
 * Pure-ASCII values are returned untouched so ordinary subjects stay readable
 * in transit and in logs.
 */
export const encodeHeader = (value: string): string => {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(value)) return value
  return `=?UTF-8?B?${Buffer.from(value, 'utf-8').toString('base64')}?=`
}

export interface MailOptions {
  to: string
  subject: string
  body: string
  /** Message-ID being replied to. Present only on a reply. */
  inReplyTo?: string
  /** Full References chain, so clients thread it correctly. */
  references?: string
}

/**
 * Build a base64url MIME message.
 *
 * ── WHY THIS IS MORE THAN A JOIN ───────────────────────────────────────────
 * The original was `['To: …','Subject: …','',body].join('\n')`. Three problems,
 * all of which only show up at the recipient's end:
 *
 *   • **No charset.** With no `Content-Type`, clients fall back to US-ASCII, so
 *     ₹, em-dashes and any non-Latin name arrive corrupted. For an app that
 *     now sends invoices and client mail on its own, that is not cosmetic.
 *   • **Unencoded subject.** Non-ASCII in a header is invalid (see above).
 *   • **LF, not CRLF.** RFC 5322 requires CRLF. Gmail tolerates it; other
 *     servers in the chain are not obliged to.
 *
 * `In-Reply-To` and `References` are what make a reply *join* a conversation
 * rather than start a new one — without them every follow-up looks like a
 * cold email, which is exactly the wrong impression to give a client.
 */
export const makeEmail = (opts: MailOptions): string => {
  const headers = [
    `To: ${opts.to}`,
    `Subject: ${encodeHeader(opts.subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit'
  ]
  if (opts.inReplyTo) headers.push(`In-Reply-To: ${opts.inReplyTo}`)
  if (opts.references) headers.push(`References: ${opts.references}`)

  const message = headers.join('\r\n') + '\r\n\r\n' + opts.body

  return Buffer.from(message, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/** Read a header case-insensitively — Gmail does not normalise their casing. */
export const header = (
  headers: { name?: string | null; value?: string | null }[],
  name: string
): string => headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value || ''

async function loadSavedCredentialsIfExist(): Promise<any | null> {
  try {
    const content = await fs.readFile(TOKEN_PATH, 'utf-8')
    const credentials = JSON.parse(content)
    return google.auth.fromJSON(credentials)
  } catch (err) {
    return null
  }
}

async function saveCredentials(client: any) {
  const content = await fs.readFile(CREDENTIALS_PATH, 'utf-8')
  const keys = JSON.parse(content)
  const key = keys.installed || keys.web
  const payload = JSON.stringify({
    type: 'authorized_user',
    client_id: key.client_id,
    client_secret: key.client_secret,
    refresh_token: client.credentials.refresh_token
  })
  await fs.writeFile(TOKEN_PATH, payload)
}

export async function authorize(): Promise<{ client: any; isNewLogin: boolean }> {
  let client = await loadSavedCredentialsIfExist()
  if (client) return { client, isNewLogin: false }

  client = (await authenticate({ scopes: SCOPES, keyfilePath: CREDENTIALS_PATH })) as any
  if (client && client.credentials) {
    await saveCredentials(client)
  }

  const mainWindow = BrowserWindow.getAllWindows()[0]
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    mainWindow.setAlwaysOnTop(true)
    mainWindow.setAlwaysOnTop(false)
  }

  return { client, isNewLogin: true }
}

export function parseMessageParts(
  part: any,
  result = { text: '', html: '', attachments: [] as any[] }
) {
  if (!part) return result

  if (part.filename && part.filename.length > 0) {
    result.attachments.push({
      filename: part.filename,
      mimeType: part.mimeType,
      size: part.body?.size
    })
  } else {
    if (part.mimeType === 'text/plain' && part.body?.data) {
      result.text += Buffer.from(part.body.data, 'base64').toString('utf-8')
    } else if (part.mimeType === 'text/html' && part.body?.data) {
      result.html += Buffer.from(part.body.data, 'base64').toString('utf-8')
    }
  }

  if (part.parts && part.parts.length > 0) {
    for (const childPart of part.parts) {
      parseMessageParts(childPart, result)
    }
  }
  return result
}

export default function registerGmailHandlers(ipcMain: IpcMain) {
  ipcMain.removeHandler('gmail-read')
  /**
   * Read messages.
   *
   * ── BACKWARD COMPATIBILITY IS LOAD-BEARING ─────────────────────────────────
   * The `read_emails` voice tool calls this with a bare number
   * (`invoke('gmail-read', 5)`), and its `{ speechText, uiData }` shape is what
   * the Email widget renders. Both are preserved exactly. The options-object
   * form is additive, for the Desk engine, which needs a Gmail query and the
   * threading fields the original never returned.
   */
  ipcMain.handle(
    'gmail-read',
    async (_event, arg: number | { maxResults?: number; query?: string } = 5) => {
      try {
        const opts = typeof arg === 'number' ? { maxResults: arg } : (arg ?? {})
        const maxResults = Math.min(Math.max(opts.maxResults ?? 5, 1), 100)
        const query = opts.query?.trim() || undefined

        const { client: auth, isNewLogin } = await authorize()
        if (!auth) throw new Error('Failed to authenticate.')

        const gmail = google.gmail({ version: 'v1', auth: auth as any })
        const res = await gmail.users.messages.list({ userId: 'me', maxResults, q: query })
        const messages = res.data.messages || []

        const prefix = isNewLogin
          ? '[SYSTEM NOTICE: Gmail Login was just completed successfully. Tell the user this before reading the emails.]\n\n'
          : ''

        if (!messages.length) return { speechText: prefix + '📭 Inbox is empty.', uiData: [] }

        const emailListForIris: string[] = []
        const uiDataArray: any[] = []

        for (const msg of messages) {
          const fullMsg = await gmail.users.messages.get({ userId: 'me', id: msg.id! })
          const headers = fullMsg.data.payload?.headers || []

          const subject = header(headers, 'Subject') || 'No Subject'
          const from = header(headers, 'From') || 'Unknown'
          const date = header(headers, 'Date')
          const snippet = fullMsg.data.snippet

          const parsed = parseMessageParts(fullMsg.data.payload)

          emailListForIris.push(`📧 From: ${from}\nSubject: ${subject}\nPreview: ${snippet}\n`)

          uiDataArray.push({
            id: fullMsg.data.id,
            from,
            subject,
            date,
            preview: snippet,
            body: parsed.html || parsed.text || snippet,
            attachments: parsed.attachments,
            // ── Additive fields, for the Desk ──
            // threadId is how a reply joins a conversation; messageId is what
            // In-Reply-To must point at; labelIds carries UNREAD, which is how
            // the engine knows what is new without re-reading the whole mailbox.
            threadId: fullMsg.data.threadId,
            labelIds: fullMsg.data.labelIds || [],
            messageId: header(headers, 'Message-ID'),
            references: header(headers, 'References'),
            to: header(headers, 'To'),
            internalDate: Number(fullMsg.data.internalDate) || 0
          })
        }

        return {
          speechText: prefix + emailListForIris.join('\n---\n'),
          uiData: uiDataArray
        }
      } catch (e: any) {
        return { speechText: `❌ Gmail Error: ${e.message}`, uiData: [] }
      }
    }
  )

  ipcMain.removeHandler('gmail-thread')
  /**
   * Every message in one thread, oldest first.
   *
   * This is how the Desk answers "did they ever reply?" — the single question a
   * follow-up depends on. Asking it per thread is far cheaper than re-reading
   * the mailbox, and it is the only way to see messages that arrived after the
   * last sync but were already marked read.
   */
  ipcMain.handle('gmail-thread', async (_event, { threadId }: { threadId: string }) => {
    try {
      if (!threadId) return { success: false, error: 'threadId is required' }
      const { client: auth } = await authorize()
      if (!auth) throw new Error('Failed to authenticate.')

      const gmail = google.gmail({ version: 'v1', auth: auth as any })
      const res = await gmail.users.threads.get({ userId: 'me', id: threadId })

      const messages = (res.data.messages || []).map((m) => {
        const headers = m.payload?.headers || []
        const parsed = parseMessageParts(m.payload)
        return {
          id: m.id,
          from: header(headers, 'From'),
          to: header(headers, 'To'),
          subject: header(headers, 'Subject'),
          date: header(headers, 'Date'),
          messageId: header(headers, 'Message-ID'),
          references: header(headers, 'References'),
          labelIds: m.labelIds || [],
          internalDate: Number(m.internalDate) || 0,
          snippet: m.snippet,
          body: parsed.text || parsed.html || m.snippet || ''
        }
      })

      return { success: true, threadId, messages }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.removeHandler('gmail-reply')
  /**
   * Reply inside an existing thread.
   *
   * Deliberately separate from `gmail-send` rather than an extra branch in it:
   * `gmail-send` is wired to the `send_email` voice tool and its behaviour must
   * not shift underneath that. A reply also has different required inputs — a
   * thread it must join and a message it must point at — and silently starting
   * a new thread when one of them is missing is the failure this signature
   * makes impossible.
   */
  ipcMain.handle(
    'gmail-reply',
    async (
      _event,
      {
        threadId,
        inReplyTo,
        references,
        to,
        subject,
        body
      }: {
        threadId: string
        inReplyTo: string
        references?: string
        to: string
        subject: string
        body: string
      }
    ) => {
      try {
        if (!threadId || !inReplyTo || !to) {
          return { success: false, error: 'threadId, inReplyTo and to are all required' }
        }

        const { client: auth } = await authorize()
        if (!auth) throw new Error('Failed to authenticate.')
        const gmail = google.gmail({ version: 'v1', auth: auth as any })

        // Gmail shows "Re: x" once; prefixing an already-prefixed subject gives
        // the client "Re: Re: Re: x".
        const replySubject = /^re:/i.test(subject) ? subject : `Re: ${subject}`

        const raw = makeEmail({
          to,
          subject: replySubject,
          body,
          inReplyTo,
          // Append to the existing chain rather than replacing it, or clients
          // lose the middle of the conversation.
          references: [references, inReplyTo].filter(Boolean).join(' ')
        })

        const res = await gmail.users.messages.send({
          userId: 'me',
          // Both are needed: threadId puts it in the conversation server-side,
          // the headers make other clients agree.
          requestBody: { raw, threadId }
        })

        return { success: true, id: res.data.id, threadId: res.data.threadId }
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  )

  ipcMain.removeHandler('gmail-send')
  ipcMain.handle('gmail-send', async (_event, { to, subject, body }) => {
    try {
      const { client: auth, isNewLogin } = await authorize()
      if (!auth) throw new Error('Failed to authenticate.')
      const gmail = google.gmail({ version: 'v1', auth: auth as any })
      const raw = makeEmail({ to, subject, body })

      await gmail.users.messages.send({ userId: 'me', requestBody: { raw } })

      const prefix = isNewLogin ? '[SYSTEM NOTICE: Login successful.]\n\n' : ''
      return prefix + `✅ Email successfully sent to ${to}.`
    } catch (e: any) {
      return `❌ Send Error: ${e.message}`
    }
  })

  ipcMain.removeHandler('gmail-draft')
  ipcMain.handle('gmail-draft', async (_event, { to, subject, body }) => {
    try {
      const { client: auth, isNewLogin } = await authorize()
      if (!auth) throw new Error('Failed to authenticate.')
      const gmail = google.gmail({ version: 'v1', auth: auth as any })
      const raw = makeEmail({ to, subject, body })

      await gmail.users.drafts.create({ userId: 'me', requestBody: { message: { raw } } })

      const prefix = isNewLogin ? '[SYSTEM NOTICE: Login successful.]\n\n' : ''
      return prefix + `✅ Draft created for ${to}. You can review it in your Gmail.`
    } catch (e: any) {
      return `❌ Draft Error: ${e.message}`
    }
  })
}
