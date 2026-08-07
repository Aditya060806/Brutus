/**
 * Bundle entry for the adapter registry.
 *
 * `getAdapter()` only knows about an agent because importing that agent's file
 * registers it. Bundling registry.ts alone would therefore produce an empty
 * roster, so this entry re-exports the registry and pulls in all four adapters.
 */
export * from '../src/main/services/studio/adapters/registry'
import '../src/main/services/studio/adapters/claude'
import '../src/main/services/studio/adapters/codex'
import '../src/main/services/studio/adapters/gemini'
import '../src/main/services/studio/adapters/shell'
