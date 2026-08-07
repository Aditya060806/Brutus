/**
 * BRUTUS Studio — policy server
 * ------------------------------
 * A tiny HTTP endpoint that Claude Code's `PreToolUse` hook calls before every
 * tool executes. Brutus answers `allow` / `deny` / `ask` / `defer`, which makes
 * permission handling deterministic instead of pattern-matching a TUI.
 *
 * Security posture, because this endpoint can authorise an agent to act:
 *   • binds 127.0.0.1 only — never reachable off the machine;
 *   • listens on an ephemeral port chosen by the OS;
 *   • requires a per-session bearer token that only the hook config knows;
 *   • rejects anything that is not the expected path and method.
 *
 * Response shape follows Claude Code's hook contract exactly:
 *   { hookSpecificOutput: { hookEventName, permissionDecision, ... } }
 */
import crypto from 'crypto'
import http from 'http'
import type { PolicyRequest, PolicyResult } from './types'

export interface PolicyServerHandle {
  port: number
  token: string
  url: string
  close: () => void
}

export type PolicyResolver = (req: PolicyRequest) => Promise<PolicyResult>

const MAX_BODY_BYTES = 256 * 1024

export async function startPolicyServer(resolve: PolicyResolver): Promise<PolicyServerHandle> {
  const token = crypto.randomBytes(24).toString('hex')

  const server = http.createServer((req, res) => {
    const reply = (code: number, body: unknown): void => {
      const json = JSON.stringify(body)
      res.writeHead(code, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(json),
        // This endpoint is for the local hook only; no browser should reach it.
        'Access-Control-Allow-Origin': 'null'
      })
      res.end(json)
    }

    if (req.method !== 'POST' || !req.url?.startsWith('/studio/permission')) {
      reply(404, { error: 'not found' })
      return
    }

    const auth = req.headers.authorization ?? ''
    const provided = auth.replace(/^Bearer\s+/i, '').trim()
    // Constant-time compare so the token cannot be probed byte by byte.
    const expected = Buffer.from(token)
    const got = Buffer.from(provided)
    if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) {
      reply(401, { error: 'unauthorized' })
      return
    }

    let body = ''
    let tooBig = false
    req.on('data', (chunk: Buffer) => {
      if (tooBig) return
      body += chunk.toString('utf8')
      if (body.length > MAX_BODY_BYTES) {
        tooBig = true
        reply(413, { error: 'payload too large' })
        req.destroy()
      }
    })

    req.on('end', () => {
      if (tooBig) return
      let payload: Record<string, unknown>
      try {
        payload = JSON.parse(body || '{}')
      } catch {
        reply(400, { error: 'invalid json' })
        return
      }

      const policyReq: PolicyRequest = {
        sessionId: String(payload.brutus_session_id ?? ''),
        toolName: String(payload.tool_name ?? ''),
        toolInput: (payload.tool_input as Record<string, unknown>) ?? {},
        cwd: String(payload.cwd ?? ''),
        agentSessionId: typeof payload.session_id === 'string' ? payload.session_id : undefined
      }

      void resolve(policyReq)
        .then((result) => {
          reply(200, {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: result.decision,
              permissionDecisionReason: result.reason,
              ...(result.updatedInput ? { updatedInput: result.updatedInput } : {})
            }
          })
        })
        .catch((err) => {
          // A policy failure must never silently allow. Defer to Claude Code's
          // own prompt so a human still sees it.
          console.error('[Studio] policy resolve failed:', err)
          reply(200, {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'ask',
              permissionDecisionReason: 'Brutus could not evaluate this call.'
            }
          })
        })
    })
  })

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject)
    // Port 0 → OS picks a free ephemeral port. Host is explicit loopback.
    server.listen(0, '127.0.0.1', resolveListen)
  })

  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0

  return {
    port,
    token,
    url: `http://127.0.0.1:${port}/studio/permission`,
    close: () => {
      try {
        server.close()
      } catch {
        /* already closed */
      }
    }
  }
}
