# Changelog

## 1.0.1 — Release standard

The first build meant to be handed to someone else. The goal: download, install,
launch, paste a key, start working — no terminal, no dependencies to install by
hand, no configuration files to edit.

### Setup

- **First-run wizard now connects a brain.** Four steps — name, accent, provider,
  voice. Seven providers: Gemini, Groq, OpenAI, Anthropic, OpenRouter, Ollama and
  the Brutus Brain Node.
- **Test connection before saving.** Every provider is verified with a real
  authenticated request, so a stored key is a working key. Failures are
  classified — a rejected key, a rate-limited key and a dead network are three
  different problems with three different answers.
- **Demo mode.** Skip the key and explore the whole interface first.

### Reliability

- **Diagnostics panel.** One pass over devices, permissions, models, storage and
  every configured provider. Each result carries what to do about it.
- **Friendly errors.** An unhandled fault now shows a sentence and offers to keep
  working, open the log, or restart — instead of ending the app with a stack
  trace. Most faults no longer close anything.
- **File logging.** `%APPDATA%\Brutus\logs`, one file per day, seven days kept,
  size-capped.
- **Crash recovery.** A session marker distinguishes a clean exit from a crash, so
  the next launch can say so rather than pretending nothing happened.
- **Bug reports.** Assembles diagnostics and, with explicit consent, the recent
  log into one file. Nothing is uploaded.

### Keys and configuration

- **Multi-provider vault.** Keyed by provider instead of two fixed fields;
  migrates the old Gemini/Groq vault automatically.
- **The interface never receives a key back** — only a mask. Nothing that can be
  screenshotted or inspected contains a secret.
- **Honest about encryption.** Where no secure keyring exists, the key is stored
  obfuscated and the panel says so rather than implying encryption.
- **Config export and import.** Secrets excluded by default; including them is a
  separate, warned choice.
- **Feature toggles.** Switch off modules you do not use.

### Packaging

- **Fixed the app identity.** `appId` was still Electron's placeholder
  `com.electron.app`, which is why notifications were attributed to "electron".
  Now `com.brutus.ai`, product name `Brutus`, executable `Brutus.exe`.
- **Portable build.** Runs from a USB stick with no installation.
- **Installer wizard.** Per-user by default so there is no UAC prompt, choosable
  location, desktop and Start menu shortcuts, proper uninstall entry.
- **Uninstall asks before deleting your data**, and defaults to keeping it. It
  never asks during an update.
- **Refuses to install over a running copy** instead of leaving a half-updated one.
- **Installer artwork at correct NSIS sizes.** The bundled sidebar was 1024×1536,
  which NSIS cannot use; it is now generated at 164×314 by a script.
- **~120 MB smaller.** The package was shipping the test bundles (81 MB), README
  screenshots (25 MB) and a Downloads folder (10 MB).
- **`node-pty` explicitly unpacked** from the ASAR, so Studio's terminals work in
  a packaged build.

### Documentation

Bundled with the app and readable offline: Quick Start, Installation, API Keys,
Troubleshooting, FAQ, Shortcuts, Releasing.

### Studio

- **Task records.** Every run persists, searchable, with derived completeness and
  validation warnings.
- **Review packets** as Markdown, JSON and a **branded PDF**.
- **Source checklist** before Run — advisory, never blocking.
- **Prompts actually submit.** Writing `"text\r"` in one call did not submit,
  because Ink reads one pty read as a single input event and appended the lot to
  the input box. The carriage return is now its own keystroke.
- **Sessions survive leaving the workspace**, and are re-adopted on return.
- **Previews** for dev servers and static HTML files, port-filtered and
  loopback-only, following the agent's edits.
- **Nine guided tours**, English and Hindi.

### Known gaps

- Not code-signed — SmartScreen warns. See `RELEASING.md`.
- x64 only; ARM64 runs under emulation.
- Windows is the tested platform.
- Portable builds cannot carry API keys between machines (DPAPI is
  account-bound); use export-with-secrets.
