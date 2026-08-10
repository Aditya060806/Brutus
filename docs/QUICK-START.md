# Brutus — Quick Start

Five minutes from installer to talking to Brutus.

---

## 1. Install

Run **Brutus-Setup-1.0.1.exe** and follow the wizard.

- It installs for **your user account only**, so Windows will not ask for an administrator password.
- You get a desktop shortcut and a Start menu entry.
- Brutus launches itself when the installer finishes.

> **"Windows protected your PC"** — this appears because the installer is not yet code-signed.
> Click **More info → Run anyway**. See [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for why.

Prefer not to install? Use **Brutus-Portable-1.0.1.exe** instead. It runs from anywhere, including a USB stick, and keeps its settings beside itself.

---

## 2. First launch

Brutus walks you through four short steps.

| Step | What it asks |
|:--|:--|
| **You** | Your name. |
| **Look** | An accent colour. |
| **Brain** | **The one that matters** — an AI provider and its key. |
| **Voice** | Which voice Brutus speaks with. |

---

## 3. Connect a brain

Pick a provider, paste its key, press **Test connection**.

**Gemini is recommended** — its free tier covers every Brutus feature, including voice, vision, Studio and the document tools.

Get a key: <https://aistudio.google.com/apikey>

Nothing is saved until the test passes, so a key that is stored is a key that works.

| If the test says | It means |
|:--|:--|
| Connected | Done. Press Continue. |
| Rejected that key | Usually a partial copy or a trailing space. Paste it again. |
| Rate-limiting it | The key is fine. Wait a minute — Brutus saves it anyway. |
| Could not reach | Your network, not your key. Check the connection. |

**No key yet?** Choose **Skip — explore in demo mode**. The whole interface opens and you can add a key later in **Settings → API Keys**.

---

## 4. Say something

Press the **red call button** at the bottom of the Home screen and talk.

Try:

- *"What is on my screen?"*
- *"Open Notepad."*
- *"Search the web for the Electron 41 release notes."*
- *"Remind me in ten minutes to check the build."*

---

## 5. Take the tour

Every screen has a **help button**. It knows which screen you are on and walks you through it, pointing at the real controls. Available in English and Hindi.

Start with **Studio** — the agent canvas is the thing Brutus is really for.

---

## Where things are

| I want to… | Go to |
|:--|:--|
| Add or change an API key | Settings → API Keys |
| Check why something is not working | Settings → **Diagnostics** |
| Point Brutus at a local Brain Node | Settings → Brain Node |
| Turn off features I do not use | Settings → Diagnostics → Features |
| Move my setup to another PC | Settings → API Keys → Export config |
| Find the log files | Settings → Diagnostics → Open folder |

---

## Next

- [INSTALLATION.md](INSTALLATION.md) — install options, portable mode, uninstalling
- [API-KEYS.md](API-KEYS.md) — every provider, what each unlocks
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) — when something is wrong
- [SHORTCUTS.md](SHORTCUTS.md) — keyboard shortcuts
- [FAQ.md](FAQ.md)
