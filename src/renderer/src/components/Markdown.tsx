import { memo, type ReactElement, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/**
 * BRUTUS — shared Markdown renderer
 * ----------------------------------
 * Agent and model output is Markdown. Rendering it as plain text is why answers
 * showed literal `**asterisks**`, `###` and `-` instead of formatting. This
 * component renders it properly and styles it to match the app: one red accent,
 * the documented radius scale, and a real vertical rhythm.
 *
 * Sized in two densities because the same content appears in a wide answer
 * panel and in a narrow task card.
 */

type Density = 'comfortable' | 'compact'

interface MarkdownProps {
  children: string
  density?: Density
  className?: string
}

const SIZES: Record<Density, { body: string; h1: string; h2: string; h3: string; gap: string }> = {
  comfortable: {
    body: 'text-[13px] leading-[1.7]',
    h1: 'text-[17px]',
    h2: 'text-[15px]',
    h3: 'text-[13px]',
    gap: 'space-y-3'
  },
  compact: {
    body: 'text-[11px] leading-[1.65]',
    h1: 'text-[13px]',
    h2: 'text-[12px]',
    h3: 'text-[11px]',
    gap: 'space-y-2'
  }
}

function Markdown({
  children,
  density = 'comfortable',
  className = ''
}: MarkdownProps): ReactElement {
  const s = SIZES[density]

  return (
    <div className={`${s.body} ${s.gap} text-zinc-300 ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => (
            <h1
              className={`${s.h1} font-semibold text-zinc-100 tracking-tight mt-4 first:mt-0 mb-1.5`}
            >
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2
              className={`${s.h2} font-semibold text-zinc-100 tracking-tight mt-4 first:mt-0 mb-1.5`}
            >
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3
              className={`${s.h3} font-semibold text-zinc-200 tracking-tight mt-3 first:mt-0 mb-1`}
            >
              {children}
            </h3>
          ),
          p: ({ children }) => <p className="text-zinc-300">{children}</p>,
          strong: ({ children }) => (
            <strong className="font-semibold text-zinc-100">{children}</strong>
          ),
          em: ({ children }) => <em className="italic text-zinc-200">{children}</em>,
          // Custom marker so bullets read as design, not as leftover asterisks.
          ul: ({ children }) => <ul className="space-y-1.5 my-1">{children}</ul>,
          ol: ({ children }) => (
            <ol className="space-y-1.5 my-1 list-decimal marker:text-zinc-600 pl-4">{children}</ol>
          ),
          li: ({ children, ...props }) => {
            const ordered = 'index' in (props as Record<string, unknown>)
            return ordered ? (
              <li className="text-zinc-300 pl-1">{children}</li>
            ) : (
              <li className="relative pl-4 text-zinc-300 before:absolute before:left-0 before:top-[0.62em] before:h-1 before:w-1 before:rounded-full before:bg-red-500/70">
                {children}
              </li>
            )
          },
          a: ({ children, href }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="text-red-400 underline decoration-red-500/30 underline-offset-2 hover:decoration-red-400 transition-colors"
            >
              {children}
            </a>
          ),
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-red-500/30 pl-3 text-zinc-400 italic">
              {children}
            </blockquote>
          ),
          hr: () => <hr className="border-white/[0.08] my-3" />,
          code: ({ className: cls, children }: { className?: string; children?: ReactNode }) => {
            // react-markdown marks fenced blocks with a language- class; inline
            // code has none. That distinction is what decides the treatment.
            const fenced = Boolean(cls?.startsWith('language-'))
            return fenced ? (
              <code className="block bg-black/50 border border-white/[0.06] rounded-lg p-3 font-mono text-[11px] leading-relaxed overflow-x-auto text-zinc-300">
                {children}
              </code>
            ) : (
              <code className="bg-white/[0.06] text-red-300 px-1.5 py-0.5 rounded font-mono text-[0.9em]">
                {children}
              </code>
            )
          },
          pre: ({ children }) => <pre className="my-2 overflow-x-auto">{children}</pre>,
          table: ({ children }) => (
            <div className="overflow-x-auto my-2 rounded-lg border border-white/[0.06]">
              <table className="w-full border-collapse text-left">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="bg-white/[0.03]">{children}</thead>,
          th: ({ children }) => (
            <th className="px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-400 border-b border-white/[0.06]">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="px-3 py-2 border-b border-white/[0.04] text-zinc-300 align-top">
              {children}
            </td>
          )
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}

export default memo(Markdown)
