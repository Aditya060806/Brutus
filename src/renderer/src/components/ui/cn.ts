/**
 * Join class names, dropping anything falsy.
 *
 * ── A LIMITATION WORTH KNOWING ─────────────────────────────────────────────
 * This is a plain joiner, not `tailwind-merge`. If a caller passes `p-6` to a
 * component whose base already sets `p-4`, BOTH classes end up on the element
 * and the winner is decided by the order Tailwind emitted them in the
 * stylesheet — not by the order they appear in the attribute. So a `className`
 * override of a property the component already sets may silently lose.
 *
 * That is deliberate: pulling in `tailwind-merge` would add a dependency to an
 * offline-first desktop app to solve a problem the primitives avoid by design.
 * Each one keeps its base classes to the properties it genuinely owns (colour,
 * radius, height) and leaves layout and spacing to the caller, so a real
 * conflict is rare. When you do need to win, prefer a prop over a class.
 */
export function cn(...parts: unknown[]): string {
  // Keeping only strings, rather than filtering on truthiness, matters more
  // than it looks: `icon && 'pl-9'` where `icon` is a ReactNode narrows to
  // `0 | '' | 'pl-9' | …`, and a bare `0` would otherwise be joined into the
  // class attribute as the literal class "0".
  return parts.filter((part): part is string => typeof part === 'string' && part !== '').join(' ')
}
