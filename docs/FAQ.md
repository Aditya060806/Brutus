# Brutus — FAQ

### Do I need an API key?

To get real work done, yes — one. Gemini's free tier covers every feature.

You can explore the entire interface without one: choose **Skip — explore in demo mode** in the setup wizard.

### Does Brutus cost anything?

Brutus is MIT-licensed and free. You pay whatever your chosen AI provider charges, directly to them. Several have free tiers. Local providers — Ollama, the Brain Node — cost nothing at all.

### Do my API keys leave my computer?

Only to the provider they belong to. They are encrypted at rest with the Windows Data Protection API, and the Brutus interface never receives them back — it only ever sees a mask.

### Does Brutus send my data anywhere?

There is no Brutus server. Nothing is uploaded, no telemetry, no analytics, no account required for the app itself.

When you use a cloud provider, that request goes to that provider — the same as if you had used their website. On the edge path (Brain Node or Ollama), nothing leaves your network.

### Can it work offline?

Partly, and the honest split is:

**Works offline:** dictation (bundled Whisper model), every file and disk tool, Studio with locally-installed CLIs, notes, macros, phone control over USB, robot control, the whole interface.

**Needs a network:** any cloud provider, web search, deep research, email. A Brain Node or Ollama on your LAN counts as offline for these purposes.

### Why is the download 315 MB?

About 210 MB is Electron and Chromium — the browser engine the interface runs in. Roughly 77 MB is the bundled Whisper speech model, which ships so that on-device dictation works without a download. The rest is Brutus.

That is the trade for "nothing to install separately".

### Why does Windows say the publisher is unknown?

The installer is not code-signed yet. A certificate has to be purchased and validated against a legal identity. Click **More info → Run anyway**, or verify the SHA-256 against the release page.

### Is my data deleted if I uninstall?

No, unless you say so. The uninstaller asks once and defaults to keeping it.

### Can I move my setup to another PC?

**Settings → API Keys → Export config.** Choose whether to include your keys. Import on the other machine.

### Does Studio use my Claude or ChatGPT subscription?

Yes — that is the point. Studio runs the real `claude`, `codex` and `gemini` CLIs in real terminals, so whatever you already pay for is what does the work. It is not an API reimplementation.

### Can an agent damage my files?

Every tool call passes a policy engine that decides `allow`, `deny` or `ask`, and `ask` genuinely blocks the agent until you answer. Catastrophic commands — `rm -rf /`, `git reset --hard`, `curl | sh`, force pushes — are never auto-approved at **any** autonomy level.

For real safety on parallel work, turn on **worktree isolation** in Settings → Studio. Each agent then works on its own git branch in its own directory, and you merge deliberately. Nothing here force-pushes, resets or discards.

### Why did my agents keep running after I closed the workspace?

Deliberate. An agent mid-build is doing minutes of real work against your repository, and losing that because you switched tabs would be worse than the surprise. Use **Stop all** in the canvas rail. Quitting Brutus stops everything.

### What is demo mode?

Setup completed without a provider. The interface is fully explorable and every local feature works; anything needing a provider explains that instead of failing silently. Add a key any time in Settings.

### Does it work on ARM64 Windows?

It runs under emulation. There is no native ARM64 build, because that needs its own tested build of every native component. Diagnostics tells you if you are emulated.

### Mac or Linux?

Build targets exist and the code is cross-platform, but Windows is what is tested and supported for 1.0. `npm run build:mac` / `build:linux` from source if you want to try.

### How do I know something is actually broken?

**Settings → Diagnostics → Re-run.** It checks devices, permissions, models, storage and every configured provider, and each result comes with what to do about it.

### Where are the logs?

`%APPDATA%\Brutus\logs\`, one file per day, seven days kept. **Settings → Diagnostics → Open folder.**

### How do I report a bug?

**Settings → Diagnostics → Report bug.** It gathers your diagnostics and optionally the recent log into one file. Nothing is transmitted — you get the file and choose what to do with it. Read it first; logs can contain paths and text you typed.
