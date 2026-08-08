import type { ChecklistItem, TaskRecord, TaskSection } from './records'

/**
 * Demonstration records.
 *
 * ── WHY THESE EXIST ────────────────────────────────────────────────────────
 * Every part of the review surface — the search, the filters, the missing-data
 * flag, the validation warnings, the export — is invisible on an empty store.
 * Someone opening Records for the first time would see a blank panel and have no
 * way to tell whether the feature works or is simply new.
 *
 * ── AND WHY THEY ARE HONEST ABOUT IT ───────────────────────────────────────
 * Silently mixing fabricated runs into someone's real history would be
 * indefensible: the whole point of a record is that it says what actually
 * happened. So they are seeded ONLY into a completely empty store, every one
 * carries `sample: true`, the panel badges them, and removing them is one click.
 *
 * The three are chosen to cover the three states the UI has to render:
 * a clean complete run, one with missing data, and one that failed.
 */

const HOUR = 3600_000

const tick = (
  id: string,
  label: string,
  done: boolean,
  value?: string,
  required = true
): ChecklistItem => ({
  id,
  label,
  required,
  done,
  value,
  origin: 'derived'
})

const section = (over: Partial<TaskSection> & Pick<TaskSection, 'ref' | 'title'>): TaskSection => ({
  role: 'Build',
  agentKind: 'claude',
  brief: '',
  status: 'done',
  ...over
})

/**
 * The judge-ready one: complete checklist, three sections, real output.
 *
 * Deliberately the richest record — it is the one an export is demonstrated on,
 * so its packet has to have something in every part.
 */
function completedSample(now: number): TaskRecord {
  const started = now - 6 * HOUR
  return {
    id: 'rec_sample_complete',
    workspaceId: 'sample',
    task: 'Add a dark mode toggle to the settings page and make sure nothing else broke',
    summary: 'Build the dark mode toggle, review the diff, then verify the test suite still passes',
    complexity: 'standard',
    createdAt: started,
    finishedAt: started + 11 * 60_000,
    status: 'done',
    sample: true,
    notes:
      'Checked on both themes at 1280 and 375. The toggle persists across a restart. Worth folding the token list into the design system before we add a third theme.',
    checklist: [
      tick('chk.folder', 'Working folder confirmed', true, 'D:/work/acme-web'),
      tick(
        'chk.done',
        'What "finished" means',
        true,
        'Toggle works, persists, and no test regressions'
      ),
      tick(
        'chk.frontend',
        'Design reference or existing styles',
        true,
        'src/styles/tokens.css — reuse the existing --surface vars',
        false
      ),
      tick('chk.tests', 'How the tests are run', true, 'npm test'),
      tick(
        'chk.review',
        'What the reviewer should be strict about',
        true,
        'Contrast ratios, and any hard-coded colour that bypasses the tokens',
        false
      )
    ],
    sections: [
      section({
        ref: 'a',
        title: 'Apollo',
        role: 'Build',
        agentKind: 'claude',
        brief:
          'Add a dark mode toggle to the settings page, wiring it to the existing theme tokens and persisting the choice.',
        startedAt: started,
        finishedAt: started + 5 * 60_000,
        output:
          'Added ThemeToggle to Settings.tsx and wired it to the existing --surface and --content token groups in tokens.css. The choice is stored under the brutus_theme key and read on boot before first paint, so there is no flash of the wrong theme. Touched 4 files: Settings.tsx, ThemeToggle.tsx, tokens.css, theme-store.ts.'
      }),
      section({
        ref: 'b',
        title: 'Atlas',
        role: 'Review',
        agentKind: 'codex',
        brief: 'Review the dark mode diff for missed surfaces and contrast problems.',
        startedAt: started + 5 * 60_000,
        finishedAt: started + 8 * 60_000,
        output:
          'Reviewed all 4 changed files. Two findings, both fixed: the modal backdrop used a hard-coded #0b0b0d instead of the token, and the disabled button state fell below 4.5:1 contrast in dark mode. Everything else reuses the tokens correctly. No hard-coded colours remain.'
      }),
      section({
        ref: 'c',
        title: 'Orion',
        role: 'Verify',
        agentKind: 'gemini',
        brief: 'Run the full test suite and report exactly which tests pass and which fail.',
        startedAt: started + 8 * 60_000,
        finishedAt: started + 11 * 60_000,
        output:
          'Ran npm test. 1396 assertions across 13 suites, 0 failed. Typecheck clean. Build clean at 2.0s. No snapshot changes. The two contrast fixes are covered by the existing a11y assertions in test-settings-registry.'
      })
    ]
  }
}

/** Missing data: two required inputs never supplied, one section with no output. */
function missingDataSample(now: number): TaskRecord {
  const started = now - 2 * HOUR
  return {
    id: 'rec_sample_missing',
    workspaceId: 'sample',
    task: 'Wire the signup form up to the users table and send a welcome email',
    summary: 'Connect signup to the database, then add the welcome email on success',
    complexity: 'standard',
    createdAt: started,
    finishedAt: started + 4 * 60_000,
    status: 'done',
    sample: true,
    notes: 'Started this before we had the schema. Needs another pass once the migration lands.',
    checklist: [
      tick('chk.folder', 'Working folder confirmed', true, 'D:/work/acme-api'),
      tick('chk.done', 'What "finished" means', false),
      tick('chk.database', 'Schema or connection details', false),
      tick('chk.auth', 'Which auth provider and where its config lives', false),
      tick('chk.backend', 'API contract or endpoint list', true, 'POST /api/signup')
    ],
    sections: [
      section({
        ref: 'a',
        title: 'Vega',
        role: 'Build',
        agentKind: 'claude',
        brief: 'Wire the signup form to the users table and send a welcome email on success.',
        startedAt: started,
        finishedAt: started + 4 * 60_000,
        output:
          'Added the POST /api/signup handler and the form submit path. Could not complete the database insert: no schema was supplied, so the users table columns are guesses and the insert is stubbed behind a TODO. The welcome email is not implemented — no provider was specified.'
      }),
      // Finished, produced nothing. This is what a missing-data flag is for.
      section({
        ref: 'b',
        title: 'Lyra',
        role: 'Verify',
        agentKind: 'codex',
        brief: 'Check the signup path end to end and report what works.',
        startedAt: started + 4 * 60_000,
        finishedAt: started + 4 * 60_000 + 20_000,
        status: 'done',
        output: ''
      })
    ]
  }
}

/** A failed section, so a validation warning is visible without contriving one. */
function failedSample(now: number): TaskRecord {
  const started = now - 30 * 60_000
  return {
    id: 'rec_sample_failed',
    workspaceId: 'sample',
    task: 'Migrate the build from webpack to vite',
    summary: 'Port the build config to Vite, then confirm the app still runs',
    complexity: 'complex',
    createdAt: started,
    finishedAt: started + 9 * 60_000,
    status: 'failed',
    sample: true,
    notes: '',
    checklist: [
      tick('chk.folder', 'Working folder confirmed', true, 'D:/work/legacy-dash'),
      tick('chk.done', 'What "finished" means', true, 'npm run build succeeds and the app boots'),
      tick('chk.deploy', 'Target environment', false),
      tick('chk.tests', 'How the tests are run', true, 'npm test')
    ],
    sections: [
      section({
        ref: 'a',
        title: 'Rigel',
        role: 'Build',
        agentKind: 'claude',
        brief: 'Port the webpack build to Vite, keeping the existing aliases and env handling.',
        startedAt: started,
        finishedAt: started + 7 * 60_000,
        output:
          'Wrote vite.config.ts with the alias map and env prefix ported across. Six webpack loaders had no direct equivalent; four were dropped as unnecessary under Vite and two — the custom SVG sprite loader and the legacy handlebars loader — still need replacing.'
      }),
      section({
        ref: 'b',
        title: 'Nova',
        role: 'Verify',
        agentKind: 'gemini',
        brief: 'Run the build and the test suite and report what passes.',
        startedAt: started + 7 * 60_000,
        finishedAt: started + 9 * 60_000,
        status: 'failed',
        note: 'The terminal exited with code 1 before this step reported anything.',
        output: ''
      })
    ]
  }
}

/** The three demonstration records, newest last. */
export function sampleRecords(now: number = Date.now()): TaskRecord[] {
  return [completedSample(now), missingDataSample(now), failedSample(now)]
}
