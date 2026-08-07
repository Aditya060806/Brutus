import { type ReactNode } from 'react'
import {
  RiCheckboxCircleLine,
  RiErrorWarningLine,
  RiInformationLine,
  RiLoader4Line
} from 'react-icons/ri'
import { cn } from '@renderer/components/ui'
import type { StatusMessage, StatusTone } from './types'

/**
 * The settings vocabulary.
 *
 * Every panel is assembled from these five pieces, so a row in Account and a
 * row in Brain Node are the same object rather than two similar-looking divs
 * that drift apart. The old Settings.tsx had three shared class strings
 * (`cardClass`, `inputContainerClass`, `titleClass`) and hand-built everything
 * else, which is how it reached 1550 lines and 143 colour literals.
 */

// ─── Panel heading ──────────────────────────────────────────────────────────

export interface SettingsHeaderProps {
  title: string
  description?: string
  /** Right-aligned actions — a Save button, a version chip. */
  actions?: ReactNode
  /** Id so the dialog can be `aria-labelledby` this heading. */
  id?: string
}

export const SettingsHeader = ({
  title,
  description,
  actions,
  id
}: SettingsHeaderProps): React.JSX.Element => (
  <div className="mb-6 flex items-start justify-between gap-4">
    <div className="min-w-0">
      <h2 id={id} className="text-xl font-semibold tracking-tight text-content">
        {title}
      </h2>
      {description && (
        <p className="mt-1 text-[13px] leading-relaxed text-content-muted">{description}</p>
      )}
    </div>
    {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
  </div>
)

// ─── Section ────────────────────────────────────────────────────────────────

export interface SettingsSectionProps {
  title?: string
  description?: string
  /** Right-aligned content in the section header — a status chip. */
  aside?: ReactNode
  children: ReactNode
  className?: string
}

/**
 * A bordered group of rows.
 *
 * Rows are separated by `divide-y` rather than each row drawing its own bottom
 * border, so the last row never leaves a dangling line above the section edge.
 */
export const SettingsSection = ({
  title,
  description,
  aside,
  children,
  className
}: SettingsSectionProps): React.JSX.Element => (
  <section className={cn('overflow-hidden rounded-xl border border-line bg-surface', className)}>
    {(title || aside) && (
      <div className="flex items-start justify-between gap-3 px-4 pb-1 pt-4">
        <div className="min-w-0">
          {title && (
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-content-muted">
              {title}
            </h3>
          )}
          {description && (
            <p className="mt-1.5 text-xs leading-relaxed text-content-faint">{description}</p>
          )}
        </div>
        {aside && <div className="shrink-0">{aside}</div>}
      </div>
    )}
    <div className="divide-y divide-line-subtle">{children}</div>
  </section>
)

// ─── Row ────────────────────────────────────────────────────────────────────

export interface SettingsRowProps {
  /** Binds the label to the control. Pass the control's id. */
  htmlFor?: string
  label?: ReactNode
  description?: ReactNode
  control?: ReactNode
  /** Put the control on its own line below the label — for wide inputs. */
  stacked?: boolean
  disabled?: boolean
  className?: string
  children?: ReactNode
}

export const SettingsRow = ({
  htmlFor,
  label,
  description,
  control,
  stacked = false,
  disabled = false,
  className,
  children
}: SettingsRowProps): React.JSX.Element => {
  const labelBlock = (label || description) && (
    <div className={stacked ? 'mb-2' : 'min-w-0 flex-1'}>
      {label &&
        (htmlFor ? (
          <label htmlFor={htmlFor} className="cursor-pointer text-[13px] font-medium text-content">
            {label}
          </label>
        ) : (
          <span className="text-[13px] font-medium text-content">{label}</span>
        ))}
      {description && (
        <p className="mt-0.5 text-xs leading-relaxed text-content-muted">{description}</p>
      )}
    </div>
  )

  return (
    <div
      className={cn(
        'px-4 py-3.5',
        stacked ? 'block' : 'flex items-center justify-between gap-4',
        disabled && 'pointer-events-none opacity-50',
        className
      )}
    >
      {labelBlock}
      {control && <div className={stacked ? 'w-full' : 'shrink-0'}>{control}</div>}
      {children}
    </div>
  )
}

// ─── Status line ────────────────────────────────────────────────────────────

const STATUS_STYLES: Record<StatusTone, { wrap: string; icon: ReactNode }> = {
  success: {
    wrap: 'border-sage-500/30 bg-sage-500/10 text-sage-400',
    icon: <RiCheckboxCircleLine size={14} />
  },
  error: {
    wrap: 'border-coral-500/30 bg-coral-500/10 text-coral-400',
    icon: <RiErrorWarningLine size={14} />
  },
  info: {
    wrap: 'border-line bg-surface-muted text-content-secondary',
    icon: <RiInformationLine size={14} />
  }
}

/**
 * Inline result feedback.
 *
 * This is what replaced the `alert()` calls. A native alert in Electron is a
 * modal OS dialog: it blocks the renderer, steals focus from the field you were
 * editing, and cannot say "saved" without demanding a click to dismiss it. This
 * appears in place, next to the control that caused it, and can simply fade.
 */
export const SettingsStatus = ({
  status,
  className
}: {
  status: StatusMessage | null
  className?: string
}): React.JSX.Element | null => {
  if (!status) return null
  const style = STATUS_STYLES[status.tone]
  return (
    <div
      role="status"
      className={cn(
        'flex items-center gap-2 rounded-lg border px-3 py-2 text-xs',
        'animate-in fade-in slide-in-from-bottom-2',
        style.wrap,
        className
      )}
    >
      <span className="shrink-0">{style.icon}</span>
      <span className="leading-relaxed">{status.text}</span>
    </div>
  )
}

// ─── Busy indicator ─────────────────────────────────────────────────────────

export const SettingsSpinner = ({ label }: { label?: string }): React.JSX.Element => (
  <span className="inline-flex items-center gap-2 text-xs text-content-muted">
    <RiLoader4Line className="animate-spin" size={14} />
    {label}
  </span>
)

// ─── Empty state ────────────────────────────────────────────────────────────

export const SettingsEmptyState = ({
  icon,
  title,
  description
}: {
  icon?: ReactNode
  title: string
  description?: string
}): React.JSX.Element => (
  <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
    {icon && <span className="text-content-faint">{icon}</span>}
    <p className="text-sm font-medium text-content-secondary">{title}</p>
    {description && <p className="max-w-sm text-xs text-content-faint">{description}</p>}
  </div>
)

// ─── Read-only code / output block ──────────────────────────────────────────

export const SettingsOutput = ({ children }: { children: ReactNode }): React.JSX.Element => (
  <pre className="scrollbar-small max-h-56 overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-canvas p-3 font-mono text-[11px] leading-relaxed text-content-secondary">
    {children}
  </pre>
)
