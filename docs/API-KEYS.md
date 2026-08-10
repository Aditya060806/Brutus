# Brutus — API keys

Brutus does not ship with credentials. You bring your own, and they stay on your machine.

---

## The short version

**One Gemini key is enough to start.** Everything else adds capability.

Get one free: <https://aistudio.google.com/apikey>

Paste it into **Settings → API Keys → Google Gemini**, press **Test**, done.

---

## What each provider unlocks

| Provider | Unlocks | Free tier | Get a key |
|:--|:--|:--:|:--|
| **Google Gemini** | Live voice, vision, Studio's command bar, Deck Studio, Knowledge Graph, image analysis | yes | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |
| **Groq** | The multi-agent Orchestrator, Deep Research | yes | [console.groq.com/keys](https://console.groq.com/keys) |
| **OpenAI** | Chat and reasoning through the OpenAI API | no | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) |
| **Anthropic** | Claude models through the API | no | [console.anthropic.com](https://console.anthropic.com/settings/keys) |
| **OpenRouter** | One key, many models | partial | [openrouter.ai/keys](https://openrouter.ai/keys) |
| **Ollama** | Models on your own machine. No key, works offline | free | install [ollama.com](https://ollama.com) |
| **Brutus Brain Node** | The Snapdragon edge server on your LAN. No key, nothing leaves your network | free | see the main README |

### Optional extras

Set these in **Settings → API Keys** as well:

| Key | Needed for |
|:--|:--|
| **Tavily** | Deep Research web evidence |
| **Notion** | Exporting research reports |
| **HuggingFace** | AI image and wallpaper generation |

### Not an API key

**Studio** runs your real Claude Code, Codex and Gemini CLI installations. It uses **your existing subscription**, not an API key. Install the CLIs and Studio finds them; ones you do not have appear greyed out with the install command.

---

## How keys are stored

Encrypted with the Windows Data Protection API through Electron `safeStorage`, in:

```
%APPDATA%\Brutus\brutus-keys.json
```

The encryption is tied to your Windows account, so copying that file to another machine gives up nothing.

**Three things worth knowing:**

1. The Brutus interface never receives your key back. It can show that a key exists, test it, and replace it — it only ever sees a mask like `AIza••••••9fQ2`. Nothing that can be screenshotted or inspected contains the secret.
2. If your system has no secure keyring (rare, mostly Linux), Brutus stores the key obfuscated instead and **says so** in the panel. It does not pretend that is encryption.
3. Keys are only ever sent to the provider they belong to.

---

## Testing a key

Every provider has a **Test** button, in the wizard and in Settings.

It makes one cheap authenticated request to a models endpoint. It never generates tokens, so testing costs nothing and cannot fail for quota reasons on a good key.

| Result | Meaning | Action |
|:--|:--|:--|
| **Connected** | Working. | None. |
| **Rejected that key** | Authentication failed. | Re-copy it. Check for a trailing space or a cut-off paste. |
| **Rate-limiting it** | The key is valid but throttled right now. | Nothing — Brutus saves it. Try again in a minute. |
| **Could not reach** | Network or firewall. The key was never seen. | Check your connection. |
| **Ollama has no models** | Ollama runs but is empty. | `ollama pull llama3` |

---

## Moving to another PC

**Settings → API Keys → Export config.**

Two choices:

- **Without secrets** (default) — settings and endpoints only. Safe to email.
- **With secrets** — includes your live API keys. Treat that file like a password.

On the other machine: **Import config**.

> Exported keys are written in plain text, because the encryption is account-specific and could not be read on the other machine anyway. Delete the file after importing.

---

## Removing a key

**Settings → API Keys → Delete** next to the provider. It is removed from disk immediately.

To remove everything, uninstall Brutus and choose **Yes** when it asks about removing your data.

---

## Using a `.env` instead (developers only)

Running from source, Brutus reads `.env` when the vault is empty:

```env
VITE_GEMINI_API_KEY="..."
MAIN_VITE_GROQ_API_KEY="..."
VITE_TAVILY_API_KEY="..."
```

The vault always wins. Packaged builds ignore `.env` entirely — there is no `.env` inside an installer.
