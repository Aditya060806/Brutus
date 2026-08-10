# Brutus — Installation

## Requirements

| | Minimum | Comfortable |
|:--|:--|:--|
| **OS** | Windows 10 64-bit (build 1809+) | Windows 11 |
| **RAM** | 4 GB | 8 GB or more |
| **Disk** | 1.2 GB free | 3 GB |
| **CPU** | 4 cores | 8 cores |
| **Network** | Optional — needed only for cloud providers | — |

Nothing else. **You do not need to install** Python, Node, Git, FFmpeg, Visual Studio, the Visual C++ redistributable, or CUDA. Everything Brutus runs on ships inside it.

> **On the VC++ redistributable:** Electron applications do not need it. Electron carries its own runtime, and every native component in Brutus (`node-pty`, `sharp`, `onnxruntime-node`) is a prebuilt N-API binary. Installing a redistributable you do not need is its own failure mode, so Brutus does not bundle one.

---

## Option 1 — Installer (recommended)

Download **`Brutus-Setup-1.0.1.exe`** and run it.

| | |
|:--|:--|
| Install scope | **Your user account only** — no administrator password needed |
| Default location | `%LOCALAPPDATA%\Programs\Brutus` |
| Change location | Yes, the wizard offers it |
| Desktop shortcut | Created |
| Start menu entry | Created |
| Uninstall entry | Appears in Apps & features as **Brutus 1.0.1** |
| Launches when done | Yes |

You can choose an all-users install in the wizard; that one does prompt for elevation.

### SmartScreen

On first download Windows may say *"Windows protected your PC"*. Click **More info → Run anyway**. The installer is not yet code-signed — see [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

Verify the download if you want to:

```powershell
Get-FileHash .\Brutus-Setup-1.0.1.exe -Algorithm SHA256
```

---

## Option 2 — Portable

Download **`Brutus-Portable-1.0.1.exe`**. Double-click it. That is the whole procedure.

- No installation, no registry entries, no shortcuts.
- Keeps its settings **beside the executable**, so a USB stick carries your whole setup.
- Runs on a machine where you cannot install software.

Two caveats, both honest consequences of how portable mode works:

1. **First launch is slower** — it unpacks itself to a temporary folder each time it starts.
2. **API keys will not travel between machines.** Encryption is tied to a Windows account, so a key saved on one PC cannot be decrypted on another. Brutus will simply show the key as unset. Use **Export config with secrets** to move keys deliberately.

---

## What gets installed

```
%LOCALAPPDATA%\Programs\Brutus\
├── Brutus.exe                    the application
├── resources\
│   ├── app.asar                  Brutus itself
│   ├── app.asar.unpacked\        native binaries (pty, sharp, onnx)
│   ├── models\                   bundled Whisper speech model
│   └── docs\                     this documentation
├── locales\
└── *.dll                         Electron and Chromium runtime
```

Your data lives separately, and survives uninstalling:

```
%APPDATA%\Brutus\
├── brutus-keys.json    encrypted API keys
├── config.json         settings
├── brutus_studio\      Studio workspaces and task records
└── logs\               7 days of logs
```

---

## Updating

Brutus checks for updates on request, not on launch.

**Settings → Updates → Check for updates.** If one exists you get the version and release notes, and **Update now** downloads and installs it. Your settings, keys and workspaces carry over.

---

## Uninstalling

**Apps & features → Brutus → Uninstall**, or the Start menu entry.

The uninstaller asks one question:

> **Remove your Brutus data as well?**
> This deletes your settings, saved API keys, Studio workspaces, task records and logs.

- **No** (default) — keeps everything for a future reinstall.
- **Yes** — removes `%APPDATA%\Brutus` too.

It never deletes your data silently, and it never asks during an update.

For the portable build: delete the `.exe`. Its data sits beside it.

---

## Installing the Studio agent CLIs (optional)

Studio drives your real coding agents. Install whichever you use — Studio detects them and greys out the rest with the install command shown.

```bash
npm install -g @anthropic-ai/claude-code   # Claude Code
npm install -g @openai/codex               # Codex
npm install -g @google/gemini-cli          # Gemini CLI
```

Run each once in a normal terminal to complete its login before using it in Studio.

---

## Building from source

```bash
git clone https://github.com/Aditya060806/Brutus.git
cd Brutus
npm install
npm run dev                # develop
npm run build:win          # produce the installer and portable exe
```

Artifacts land in `dist/`. See [RELEASING.md](RELEASING.md) for the full release procedure, including code signing.
