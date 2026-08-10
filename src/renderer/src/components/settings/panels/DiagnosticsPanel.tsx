import { useCallback, useEffect, useState, type ReactElement } from 'react'
import {
  RiAlertLine,
  RiCheckLine,
  RiCloseCircleLine,
  RiFileCopyLine,
  RiFolderOpenLine,
  RiLoader4Line,
  RiPlugLine,
  RiRefreshLine,
  RiBugLine
} from 'react-icons/ri'
import { Button, Card, Switch, Textarea, cn } from '@renderer/components/ui'
import {
  deviceChecks,
  diagnosticsText,
  getKeys,
  getLogs,
  openLogs,
  runDiagnostics,
  sendBugReport,
  testProvider,
  type Check,
  type CheckStatus,
  type DiagnosticsReport,
  type KeyStatus,
  type ProviderId
} from '@renderer/services/release-client'

/**
 * One button that answers "is anything wrong with my setup?".
 *
 * Every check names what it found and, when something is off, what to do about
 * it. That second half is the point: a red row with no fix is just anxiety, and
 * the most common support question — "why is voice not working?" — is answered
 * here by a line saying the microphone permission is denied and where to grant it.
 *
 * ── WHY IT RUNS MAIN AND RENDERER CHECKS TOGETHER ──────────────────────────
 * Main can prove OS permission state, hardware, models and disk. Only the
 * renderer can enumerate actual devices. Neither half is a complete answer, so
 * both run and the results are merged before anything is shown.
 */

const ICON: Record<CheckStatus, ReactElement> = {
  ok: <RiCheckLine size={13} className="text-emerald-400" />,
  warn: <RiAlertLine size={13} className="text-amber-400" />,
  fail: <RiCloseCircleLine size={13} className="text-red-400" />,
  checking: <RiLoader4Line size={13} className="animate-spin text-content-muted" />
}

const GROUP_LABEL: Record<Check['group'], string> = {
  system: 'System',
  devices: 'Microphone, speaker and camera',
  models: 'On-device models',
  providers: 'AI providers',
  storage: 'Storage'
}

const GROUP_ORDER: Check['group'][] = ['system', 'devices', 'providers', 'models', 'storage']

export default function DiagnosticsPanel(): ReactElement {
  const [report, setReport] = useState<DiagnosticsReport | null>(null)
  const [devices, setDevices] = useState<Check[]>([])
  const [providers, setProviders] = useState<Check[]>([])
  const [busy, setBusy] = useState(false)
  const [logDir, setLogDir] = useState('')
  const [copied, setCopied] = useState(false)

  // Bug report
  const [reportOpen, setReportOpen] = useState(false)
  const [description, setDescription] = useState('')
  const [attachLogs, setAttachLogs] = useState(true)
  const [reportBusy, setReportBusy] = useState(false)
  const [reportNote, setReportNote] = useState<string | null>(null)

  /**
   * Test every configured provider.
   *
   * Only the configured ones: reporting "OpenAI: no key" as a warning on a
   * machine that deliberately only uses Gemini would be noise dressed as a
   * problem.
   */
  const checkProviders = useCallback(async (keys: KeyStatus[]): Promise<Check[]> => {
    const live = keys.filter((k) => (k.needsKey ? k.present : Boolean(k.url)))
    if (!live.length) {
      return [
        {
          id: 'providers',
          label: 'AI providers',
          status: 'fail',
          detail: 'None configured',
          fix: 'Add a key in Settings → API Keys. Brutus cannot answer anything without one.',
          group: 'providers'
        }
      ]
    }
    const results = await Promise.all(
      live.map(async (k) => {
        const res = await testProvider(k.provider as ProviderId)
        const status: CheckStatus =
          res.verdict === 'ok' ? 'ok' : res.verdict === 'rate-limited' ? 'warn' : 'fail'
        return {
          id: `provider-${k.provider}`,
          label: k.label,
          status,
          detail: res.message,
          fix:
            res.verdict === 'bad-key'
              ? 'Replace the key in Settings → API Keys.'
              : res.verdict === 'unreachable'
                ? 'Check your internet connection.'
                : undefined,
          group: 'providers' as const
        }
      })
    )
    return results
  }, [])

  const run = useCallback(async () => {
    setBusy(true)
    setCopied(false)
    try {
      // Started together; the provider probes are the slow part and there is no
      // reason for the local checks to wait behind them.
      const [main, dev, logs, keys] = await Promise.all([
        runDiagnostics(),
        deviceChecks(),
        getLogs(),
        getKeys()
      ])
      setReport(main)
      setDevices(dev)
      setLogDir(logs.dir)
      setProviders(await checkProviders(keys.keys))
    } finally {
      setBusy(false)
    }
  }, [checkProviders])

  useEffect(() => {
    void run()
  }, [run])

  const all = [...(report?.checks ?? []), ...devices, ...providers]
  const fails = all.filter((c) => c.status === 'fail').length
  const warns = all.filter((c) => c.status === 'warn').length

  const copy = useCallback(async () => {
    const res = await diagnosticsText([...devices, ...providers])
    await navigator.clipboard.writeText(res.text)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 2500)
  }, [devices, providers])

  const submit = useCallback(async () => {
    setReportBusy(true)
    setReportNote(null)
    try {
      const res = await sendBugReport({
        description,
        includeLogs: attachLogs,
        rendererChecks: [...devices, ...providers]
      })
      if (res.ok) {
        setReportNote(`Saved to ${res.path}`)
        setDescription('')
      } else if (!res.canceled) {
        setReportNote(res.error ?? 'Could not write the report.')
      }
    } finally {
      setReportBusy(false)
    }
  }, [description, attachLogs, devices, providers])

  return (
    <div className="flex flex-col gap-4" data-tour="settings.diagnostics">
      {/* ── Verdict ── */}
      <Card
        tone="surface"
        className={cn(
          'flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3',
          fails > 0 && 'border-red-500/30'
        )}
      >
        <span className="flex items-center gap-2 text-[13px] font-medium text-content">
          {busy ? (
            <>
              <RiLoader4Line size={14} className="animate-spin text-content-muted" /> Checking…
            </>
          ) : fails > 0 ? (
            <>
              <RiCloseCircleLine size={14} className="text-red-400" /> {fails} problem
              {fails === 1 ? '' : 's'} found
            </>
          ) : warns > 0 ? (
            <>
              <RiAlertLine size={14} className="text-amber-400" /> Working, with {warns} note
              {warns === 1 ? '' : 's'}
            </>
          ) : (
            <>
              <RiCheckLine size={14} className="text-emerald-400" /> Everything checks out
            </>
          )}
        </span>

        {report && (
          <span className="text-[11px] text-content-faint">
            Brutus {report.version} · {report.arch} · Electron {report.electron}
            {report.packaged ? '' : ' · development build'}
          </span>
        )}

        <span className="ml-auto flex items-center gap-1.5">
          <Button
            size="sm"
            variant="tertiary"
            onClick={() => void run()}
            disabled={busy}
            leadingIcon={<RiRefreshLine size={13} />}
          >
            Re-run
          </Button>
          <Button
            size="sm"
            variant="tertiary"
            onClick={() => void copy()}
            leadingIcon={<RiFileCopyLine size={13} />}
          >
            {copied ? 'Copied' : 'Copy report'}
          </Button>
        </span>
      </Card>

      {/* ── The checks ── */}
      {GROUP_ORDER.map((group) => {
        const rows = all.filter((c) => c.group === group)
        if (!rows.length) return null
        return (
          <div key={group} className="flex flex-col gap-1.5">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-content-faint">
              {GROUP_LABEL[group]}
            </p>
            <Card tone="surface" className="divide-y divide-line/60">
              {rows.map((c) => (
                <div key={c.id} className="flex items-start gap-3 px-3.5 py-2.5">
                  <span className="mt-0.5 shrink-0">{ICON[c.status]}</span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-baseline gap-x-2">
                      <span className="text-[12.5px] font-medium text-content">{c.label}</span>
                      <span className="text-[11px] text-content-muted">{c.detail}</span>
                    </span>
                    {c.fix && (
                      <span className="mt-1 block text-[11px] leading-snug text-amber-300/80">
                        {c.fix}
                      </span>
                    )}
                  </span>
                </div>
              ))}
            </Card>
          </div>
        )
      })}

      {/* ── Logs ── */}
      <div className="flex flex-col gap-1.5">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-content-faint">
          Logs
        </p>
        <Card tone="surface" className="flex flex-wrap items-center gap-3 px-3.5 py-3">
          <span className="min-w-0 flex-1">
            <span className="block text-[12.5px] text-content">
              Kept for 7 days on this machine
            </span>
            <span className="mt-0.5 block truncate font-mono text-[10.5px] text-content-faint">
              {logDir || '—'}
            </span>
          </span>
          <Button
            size="sm"
            variant="tertiary"
            onClick={() => void openLogs()}
            leadingIcon={<RiFolderOpenLine size={13} />}
          >
            Open folder
          </Button>
        </Card>
      </div>

      {/* ── Bug report ── */}
      <div className="flex flex-col gap-1.5">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-content-faint">
          Report a problem
        </p>
        <Card tone="surface" className="flex flex-col gap-3 px-3.5 py-3">
          {!reportOpen ? (
            <div className="flex items-center gap-3">
              <span className="flex-1 text-[12.5px] text-content-muted">
                Builds a file containing your diagnostics and, if you allow it, the recent log.
              </span>
              <Button
                size="sm"
                variant="tertiary"
                onClick={() => setReportOpen(true)}
                leadingIcon={<RiBugLine size={13} />}
              >
                Report bug
              </Button>
            </div>
          ) : (
            <>
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
                placeholder="What were you doing, and what happened instead?"
              />
              {/* Consent is explicit and the consequence is stated, because a log
                  can contain file paths and prompt text. */}
              <label className="flex items-start gap-2.5">
                <Switch
                  checked={attachLogs}
                  onChange={setAttachLogs}
                  aria-label="Attach the recent log to the report"
                />
                <span className="text-[11.5px] leading-snug text-content-muted">
                  Attach the recent log. It may contain file paths and things you typed — read the
                  file before sharing it.
                </span>
              </label>
              <div className="flex items-center gap-2">
                <Button size="sm" onClick={() => void submit()} disabled={reportBusy}>
                  {reportBusy ? 'Saving…' : 'Save report'}
                </Button>
                <Button size="sm" variant="tertiary" onClick={() => setReportOpen(false)}>
                  Cancel
                </Button>
                {reportNote && (
                  <span className="min-w-0 truncate text-[11px] text-content-faint">
                    {reportNote}
                  </span>
                )}
              </div>
            </>
          )}
        </Card>
      </div>

      {/* Nothing here leaves the machine on its own. */}
      <p className="flex items-center gap-1.5 text-[10.5px] text-content-faint">
        <RiPlugLine size={11} />
        Provider checks make one authenticated request each. Nothing is uploaded anywhere.
      </p>
    </div>
  )
}
