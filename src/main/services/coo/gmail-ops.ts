import { google } from 'googleapis'
import { authorize, header, makeEmail, parseMessageParts } from '../../logic/gmail-manager'
import type { MailMessage } from './types'

/**
 * Gmail, as the Desk engine needs it.
 *
 * The IPC handlers in `gmail-manager.ts` are shaped for the renderer — they
 * return `{ speechText, uiData }` for the voice tools and swallow errors into
 * friendly strings. The engine wants neither: it needs typed messages and it
 * needs a failure to be a rejected promise it can log and retry, not a string
 * that looks like success.
 *
 * So this is a thin typed layer over the same authorised client, rather than
 * the engine reaching sideways into renderer-shaped handlers.
 */

/** Turn a Gmail API message into our own shape. */
function toMailMessage(raw: {
  id?: string | null
  threadId?: string | null
  payload?: unknown
  labelIds?: string[] | null
  internalDate?: string | null
  snippet?: string | null
}): MailMessage {
  const headers = ((raw.payload as { headers?: [] })?.headers || []) as {
    name?: string | null
    value?: string | null
  }[]
  const parsed = parseMessageParts(raw.payload)
  return {
    id: raw.id || '',
    threadId: raw.threadId || '',
    messageId: header(headers, 'Message-ID'),
    references: header(headers, 'References'),
    from: header(headers, 'From'),
    to: header(headers, 'To'),
    subject: header(headers, 'Subject') || '(no subject)',
    // Plain text first: the HTML alternative is full of markup that would eat
    // the model's context and teach it to reply in HTML.
    body: (parsed.text || parsed.html || raw.snippet || '').trim(),
    date: Number(raw.internalDate) || 0,
    labelIds: raw.labelIds || []
  }
}

async function client(): Promise<ReturnType<typeof google.gmail>> {
  const { client: auth } = await authorize()
  if (!auth) throw new Error('Gmail is not authorised')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return google.gmail({ version: 'v1', auth: auth as any })
}

/** Thread ids matching a Gmail query, newest first. */
export async function listThreadIds(query: string, max = 25): Promise<string[]> {
  const gmail = await client()
  const res = await gmail.users.threads.list({ userId: 'me', q: query, maxResults: max })
  return (res.data.threads || []).map((t) => t.id!).filter(Boolean)
}

/** Every message in a thread, oldest first. */
export async function getThread(threadId: string): Promise<MailMessage[]> {
  const gmail = await client()
  const res = await gmail.users.threads.get({ userId: 'me', id: threadId })
  return (res.data.messages || []).map(toMailMessage).sort((a, b) => a.date - b.date)
}

/** The signed-in account's own address, used to tell "us" from "them". */
let cachedSelf: string | null = null
export async function selfAddress(): Promise<string> {
  if (cachedSelf) return cachedSelf
  const gmail = await client()
  const res = await gmail.users.getProfile({ userId: 'me' })
  cachedSelf = (res.data.emailAddress || '').toLowerCase()
  return cachedSelf
}

export interface ReplyInput {
  threadId: string
  inReplyTo: string
  references?: string
  to: string
  subject: string
  body: string
}

/** Send into an existing thread. Throws on failure — the caller must know. */
export async function replyInThread(input: ReplyInput): Promise<string> {
  const gmail = await client()
  const subject = /^re:/i.test(input.subject) ? input.subject : `Re: ${input.subject}`
  const raw = makeEmail({
    to: input.to,
    subject,
    body: input.body,
    inReplyTo: input.inReplyTo,
    references: [input.references, input.inReplyTo].filter(Boolean).join(' ')
  })
  const res = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw, threadId: input.threadId }
  })
  return res.data.id || ''
}

/** Save a draft in Gmail so a blocked reply is still one click from sending. */
export async function saveDraft(input: {
  to: string
  subject: string
  body: string
  threadId?: string
}): Promise<string> {
  const gmail = await client()
  const raw = makeEmail({ to: input.to, subject: input.subject, body: input.body })
  const res = await gmail.users.drafts.create({
    userId: 'me',
    requestBody: { message: { raw, threadId: input.threadId } }
  })
  return res.data.id || ''
}
