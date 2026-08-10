import { app, systemPreferences } from 'electron'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { bundledModelsDir } from '../voice/model-store'

/**
 * BRUTUS — startup and on-demand diagnostics.
 *
 * The failure this exists to prevent: a feature quietly does nothing, and the
 * user cannot tell whether it is broken, unconfigured, or unsupported on their
 * machine. Every check below answers that in one line, with a fix attached.
 *
 * ── WHY EVERY CHECK IS ADVISORY ────────────────────────────────────────────
 * Nothing here blocks startup. A machine with no camera is a perfectly good
 * machine for Studio, Desk and text chat, and refusing to launch over a missing
 * webcam would be absurd. Checks report `ok`, `warn` or `fail`, and the UI
 * decides how loudly to say so.
 *
 * ── WHY DEVICE CHECKS ARE SPLIT IN TWO ─────────────────────────────────────
 * The main process can see OS-level *permission*, but only the renderer can
 * enumerate actual devices — `navigator.mediaDevices` does not exist here. So
 * main reports what it can prove (permission state, hardware, models, disk) and
 * the renderer contributes microphone, speaker and camera presence. Pretending
 * to check a webcam from the main process would produce a confident wrong
 * answer, which is worse than an honest split.
 */

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'checking'

export interface Check {
  id: string
  label: string
  status: CheckStatus
  /** What was found, in one line. */
  detail: string
  /** What to do about it, when there is something to do. */
  fix?: string
  /** Grouping for the Diagnostics panel. */
  group: 'system' | 'devices' | 'models' | 'providers' | 'storage'
}

const GB = 1024 ** 3

/** Windows reports permission through `systemPreferences`; other platforms vary. */
function mediaPermission(kind: 'microphone' | 'camera'): string {
  try {
    // Only implemented on macOS and Windows; elsewhere it throws or returns
    // 'unknown', and 'unknown' is not a failure.
    return systemPreferences.getMediaAccessStatus(kind)
  } catch {
    return 'unknown'
  }
}

function checkRam(): Check {
  const totalGb = os.totalmem() / GB
  const freeGb = os.freemem() / GB
  const detail = `${totalGb.toFixed(1)} GB installed, ${freeGb.toFixed(1)} GB free`
  if (totalGb < 4) {
    return {
      id: 'ram',
      label: 'Memory',
      group: 'system',
      status: 'fail',
      detail,
      fix: 'Brutus needs about 4 GB to run comfortably. Voice and Studio may be unusable below that.'
    }
  }
  if (totalGb < 8) {
    return {
      id: 'ram',
      label: 'Memory',
      group: 'system',
      status: 'warn',
      detail,
      fix: 'Enough to run, but expect slowdowns with several agents open at once.'
    }
  }
  return { id: 'ram', label: 'Memory', group: 'system', status: 'ok', detail }
}

function checkCpu(): Check {
  const cpus = os.cpus()
  const model = cpus[0]?.model?.trim() ?? 'unknown'
  const detail = `${cpus.length} logical cores · ${model}`
  return {
    id: 'cpu',
    label: 'Processor',
    group: 'system',
    status: cpus.length >= 4 ? 'ok' : 'warn',
    detail,
    fix: cpus.length < 4 ? 'Fewer than 4 cores; multi-agent runs will be slow.' : undefined
  }
}

function checkOs(): Check {
  const release = os.release()
  const detail = `${os.type()} ${release} (${process.arch})`
  // Windows 10 is 10.0.10240+; anything reporting below that is unsupported.
  const supported = process.platform !== 'win32' || Number(release.split('.')[0]) >= 10
  return {
    id: 'os',
    label: 'Operating system',
    group: 'system',
    status: supported ? 'ok' : 'fail',
    detail,
    fix: supported ? undefined : 'Brutus supports Windows 10 and 11 (64-bit).'
  }
}

function checkArch(): Check {
  // x64 is what ships. ARM64 Windows runs it under emulation, which works but is
  // slow enough that the user deserves to know rather than wonder.
  const emulated = process.arch !== 'x64' && process.platform === 'win32'
  return {
    id: 'arch',
    label: 'Architecture',
    group: 'system',
    status: emulated ? 'warn' : 'ok',
    detail: process.arch,
    fix: emulated
      ? 'This is the x64 build running under emulation. It works, but native performance is better.'
      : undefined
  }
}

function checkDisk(): Check {
  const dir = app.getPath('userData')
  try {
    fs.mkdirSync(dir, { recursive: true })
    // Proving writability by writing is the only check that cannot be wrong.
    const probe = path.join(dir, '.write-probe')
    fs.writeFileSync(probe, 'ok')
    fs.unlinkSync(probe)
    return {
      id: 'storage',
      label: 'Data folder',
      group: 'storage',
      status: 'ok',
      detail: dir
    }
  } catch (err) {
    return {
      id: 'storage',
      label: 'Data folder',
      group: 'storage',
      status: 'fail',
      detail: dir,
      fix: `Brutus cannot write here (${String((err as { code?: string })?.code ?? 'error')}). Settings and keys will not save.`
    }
  }
}

function checkMicPermission(): Check {
  const state = mediaPermission('microphone')
  const denied = state === 'denied' || state === 'restricted'
  return {
    id: 'mic-permission',
    label: 'Microphone permission',
    group: 'devices',
    status: denied ? 'fail' : state === 'unknown' ? 'warn' : 'ok',
    detail: state,
    fix: denied
      ? 'Windows Settings → Privacy & security → Microphone → allow desktop apps.'
      : state === 'unknown'
        ? 'Windows will ask the first time voice is used.'
        : undefined
  }
}

function checkCameraPermission(): Check {
  const state = mediaPermission('camera')
  const denied = state === 'denied' || state === 'restricted'
  return {
    id: 'camera-permission',
    label: 'Camera permission',
    group: 'devices',
    status: denied ? 'warn' : 'ok',
    detail: state,
    fix: denied
      ? 'Vision features need this. Windows Settings → Privacy & security → Camera.'
      : undefined
  }
}

/** The bundled Whisper model, which is what makes offline dictation work. */
function checkBundledModels(): Check {
  try {
    const dir = bundledModelsDir()
    const onnx = path.join(dir, 'Xenova', 'whisper-base.en', 'onnx')
    if (!fs.existsSync(onnx)) {
      return {
        id: 'asr-model',
        label: 'On-device speech model',
        group: 'models',
        status: 'warn',
        detail: 'Not found',
        fix: 'Offline dictation is unavailable. Reinstalling restores the bundled model.'
      }
    }
    const bytes = fs
      .readdirSync(onnx)
      .map((f) => fs.statSync(path.join(onnx, f)).size)
      .reduce((a, b) => a + b, 0)
    // A truncated download is worse than a missing one, because it fails at use
    // time rather than at startup.
    if (bytes < 20 * 1024 * 1024) {
      return {
        id: 'asr-model',
        label: 'On-device speech model',
        group: 'models',
        status: 'warn',
        detail: `Present but only ${(bytes / 1024 / 1024).toFixed(0)} MB — looks incomplete`,
        fix: 'Run `npm run fetch:models`, or reinstall Brutus.'
      }
    }
    return {
      id: 'asr-model',
      label: 'On-device speech model',
      group: 'models',
      status: 'ok',
      detail: `whisper-base.en · ${(bytes / 1024 / 1024).toFixed(0)} MB`
    }
  } catch (err) {
    return {
      id: 'asr-model',
      label: 'On-device speech model',
      group: 'models',
      status: 'warn',
      detail: String((err as { message?: string })?.message ?? err)
    }
  }
}

/**
 * Is there a working route to the internet?
 *
 * Deliberately a real request rather than `os.networkInterfaces()`: a machine can
 * have an IP, a gateway and a captive portal, and still not reach anything.
 */
async function checkInternet(): Promise<Check> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5000)
  const started = Date.now()
  try {
    // A 204-no-content endpoint: smallest possible answer, no parsing, and it
    // does not require any provider to be configured.
    const res = await fetch('https://cloudflare.com/cdn-cgi/trace', {
      method: 'GET',
      signal: controller.signal,
      cache: 'no-store'
    })
    const ms = Date.now() - started
    return {
      id: 'internet',
      label: 'Internet',
      group: 'system',
      status: res.ok ? 'ok' : 'warn',
      detail: res.ok ? `Reachable in ${ms} ms` : `Unexpected response (${res.status})`,
      fix: res.ok
        ? undefined
        : 'A proxy or captive portal may be interfering. On-device features still work.'
    }
  } catch {
    return {
      id: 'internet',
      label: 'Internet',
      group: 'system',
      status: 'warn',
      detail: 'Not reachable',
      fix: 'Cloud providers will be unavailable. Voice on the Brain Node and all local tools still work.'
    }
  } finally {
    clearTimeout(timer)
  }
}

/** GPU information, reported rather than judged — Electron always has a renderer. */
function checkGpu(): Check {
  try {
    const info = app.getGPUFeatureStatus() as unknown as Record<string, string>
    const accelerated = Object.values(info).some((v) => v.startsWith('enabled'))
    return {
      id: 'gpu',
      label: 'Graphics acceleration',
      group: 'system',
      status: accelerated ? 'ok' : 'warn',
      detail: accelerated ? 'Hardware accelerated' : 'Software rendering',
      fix: accelerated
        ? undefined
        : 'The interface will still work but animations may stutter. Updating your graphics driver usually fixes it.'
    }
  } catch {
    return {
      id: 'gpu',
      label: 'Graphics acceleration',
      group: 'system',
      status: 'warn',
      detail: 'Unknown'
    }
  }
}

export interface DiagnosticsReport {
  generatedAt: number
  version: string
  platform: string
  arch: string
  electron: string
  node: string
  packaged: boolean
  checks: Check[]
  summary: { ok: number; warn: number; fail: number }
}

/**
 * Run every main-process check.
 *
 * The renderer appends its own device checks before showing the result, so this
 * returns a partial report by design.
 */
export async function runDiagnostics(): Promise<DiagnosticsReport> {
  const checks: Check[] = [
    checkOs(),
    checkArch(),
    checkCpu(),
    checkRam(),
    checkGpu(),
    await checkInternet(),
    checkMicPermission(),
    checkCameraPermission(),
    checkBundledModels(),
    checkDisk()
  ]

  return {
    generatedAt: Date.now(),
    version: app.getVersion(),
    platform: `${os.type()} ${os.release()}`,
    arch: process.arch,
    electron: process.versions.electron,
    node: process.versions.node,
    packaged: app.isPackaged,
    checks,
    summary: {
      ok: checks.filter((c) => c.status === 'ok').length,
      warn: checks.filter((c) => c.status === 'warn').length,
      fail: checks.filter((c) => c.status === 'fail').length
    }
  }
}

/** A plain-text version, for pasting into a bug report. */
export function formatReport(report: DiagnosticsReport, extra: Check[] = []): string {
  const L: string[] = []
  L.push('BRUTUS DIAGNOSTICS')
  L.push('='.repeat(50))
  L.push(`Version    : ${report.version}${report.packaged ? '' : ' (development)'}`)
  L.push(`Platform   : ${report.platform} ${report.arch}`)
  L.push(`Electron   : ${report.electron}  ·  Node ${report.node}`)
  L.push(`Generated  : ${new Date(report.generatedAt).toISOString()}`)
  L.push('')
  const icon = (s: CheckStatus): string =>
    s === 'ok' ? '[ ok ]' : s === 'warn' ? '[warn]' : '[FAIL]'
  for (const c of [...report.checks, ...extra]) {
    L.push(`${icon(c.status)} ${c.label}: ${c.detail}`)
    if (c.fix) L.push(`         -> ${c.fix}`)
  }
  return L.join('\n')
}
