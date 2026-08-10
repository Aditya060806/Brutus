# Brutus — Troubleshooting

**Start here: Settings → Diagnostics → Re-run.** It checks every device, permission, model and provider in one pass and tells you what to do about anything it finds. Most of this page is what that panel would have told you.

---

## Installing

### "Windows protected your PC" / SmartScreen

**Click More info → Run anyway.**

This appears because the installer is not code-signed. A signing certificate has to be bought from a certificate authority and validated against a legal identity; until that is done, Windows cannot verify the publisher and warns about every new download. It is not a statement that anything is wrong with the file.

To verify the download yourself, compare its SHA-256 against the checksum on the release page:

```powershell
Get-FileHash .\Brutus-Setup-1.0.1.exe -Algorithm SHA256
```

### The installer says Brutus is already running

It is. Close it from the tray or task manager, or let the installer close it for you when it offers.

### Install fails part-way

Check free disk space — Brutus needs about **1.2 GB** installed. If it persists, download again; a truncated download fails at the extraction step.

---

## First launch

### The window is blank or white

Almost always graphics-driver related. Update your GPU driver. To confirm, launch once with software rendering:

```powershell
& "$env:LOCALAPPDATA\Programs\Brutus\Brutus.exe" --disable-gpu
```

If that works, it is the driver.

### It launched but nothing responds to what I say

Check, in this order:

1. **Settings → Diagnostics** — is a provider connected?
2. Is the **red call button** actually on? It toggles.
3. Is the microphone muted? The mic button is beside the call button.

### The setup wizard did not appear

It runs once. Re-run it from **Settings → Account → Reset setup**.

---

## Voice

### "Edge server not reachable at http://…"

Brutus is set to use a local Brain Node that is not running. Either start the node, or switch to cloud:

**Settings → Voice → Voice Uplink → Cloud**

### The microphone is not picked up

- **Windows Settings → Privacy & security → Microphone** → allow desktop apps.
- Diagnostics shows the permission state directly.
- Bluetooth headsets sometimes expose two devices; pick the one Windows lists as default.

### Brutus talks over itself, or cuts out

Another application holding the audio device exclusively. Close other voice apps and reconnect.

### Dictation does nothing

Dictation uses the bundled on-device Whisper model. If Diagnostics reports **On-device speech model: not found** or *looks incomplete*, the install is missing files — reinstall.

---

## Studio

### An agent is greyed out on the dock

Its CLI is not installed. The dock shows the install command. Studio shells out to the real binary — it does not reimplement them.

### An agent window opens then immediately exits

Run the CLI once in a normal terminal first. Most need a one-time login, and they cannot prompt for it inside Studio.

### I typed a prompt and it just sits there

Fixed in 1.0.1. If you see it, the CLI was still starting — Brutus waits for it to report ready before typing. Restart that agent from its window.

### Agents kept running after I closed the workspace

Intended. An agent mid-build is doing real work, and closing a tab should not throw it away. Use **Stop all** in the canvas rail, which appears whenever something is running.

### Preview window shows nothing

- It only accepts **loopback** URLs — `localhost` or `127.0.0.1`. This is deliberate: agent output is untrusted and must not be able to load an arbitrary site inside Brutus.
- It needs a **port**. A bare `http://localhost` is ignored, because in a README that is prose, not a server.
- For a static page, only **HTML** files are previewed.

---

## Providers

### A key that works elsewhere is rejected here

Almost always the paste. Re-copy it, and check for a trailing space or newline. Use the eye icon to confirm what actually landed in the field.

### "Rate-limiting it right now"

Your key is valid. Brutus saves it. Free tiers throttle aggressively; wait a minute.

### Everything says "Could not reach"

A firewall, VPN or corporate proxy is blocking outbound HTTPS. Everything on-device still works — dictation, file tools, Studio with local CLIs.

---

## Performance

### It feels slow

- Diagnostics reports RAM. Below 8 GB, several agents at once will struggle.
- Turn off what you do not use: **Settings → Diagnostics → Features**.
- Studio culls off-screen terminals automatically; a canvas of fifteen agents is still fifteen processes.

### High memory use

Each Studio agent is a real CLI process. Closing agent windows releases them. **Stop all** ends everything.

---

## Data and recovery

### "Brutus did not close properly"

The previous session ended without a clean shutdown. Your work is on disk — workspaces, records and notes are saved as you go. Dismiss it and carry on.

### Where is my data?

```
%APPDATA%\Brutus\
├── brutus-keys.json      encrypted API keys
├── config.json           settings
├── brutus_studio\        workspaces and task records
└── logs\                 7 days of logs
```

Portable builds keep this beside the executable instead.

### Reset everything

Uninstall and choose **Yes** when asked about removing data. Or delete `%APPDATA%\Brutus` while Brutus is closed.

---

## Getting help

**Settings → Diagnostics → Report bug.** It assembles your diagnostics and, with your permission, the recent log into one file.

Nothing is uploaded. Brutus has no server to send it to — you get a file and decide where it goes. **Read it before sharing**: a log can contain file paths and text you typed.
