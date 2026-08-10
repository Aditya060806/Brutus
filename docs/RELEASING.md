# Brutus — Release procedure

For whoever cuts the build. Everything here is mechanical except step 4, which needs a purchased certificate.

---

## 1. Bump the version

`package.json` → `version`. This drives the installer filename, the uninstall entry and the auto-updater's comparison. Update `docs/CHANGELOG.md` in the same commit.

---

## 2. Verify before packaging

```bash
npm run typecheck        # both node and web
npm run lint
npm test                 # the full engine suite, no Electron needed
```

All three must pass. `npm run build` runs the typecheck itself, so a type error cannot reach an installer.

---

## 3. Build

```bash
npm run build:win
```

Produces in `dist/`:

| Artifact | What it is |
|:--|:--|
| `Brutus-Setup-<version>.exe` | The NSIS installer |
| `Brutus-Portable-<version>.exe` | Single-file portable build |
| `latest.yml` | Auto-updater manifest — **must** be published alongside |
| `*.blockmap` | Enables differential updates |

Regenerate the installer artwork only if the branding changes:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/make-installer-art.ps1
```

NSIS does not scale these. The sidebar must be exactly **164×314** and the header **150×57**; anything else misrenders.

---

## 4. Code signing — the one step that needs buying something

**This is not done yet, and it is the only reason Windows says "Unknown publisher".**

Without a signature:

- SmartScreen warns on every download until the file earns reputation
- the publisher shows as unknown in the UAC and uninstall entries
- some corporate environments block it outright

### What to buy

| Type | Cost/yr | SmartScreen |
|:--|:--|:--|
| **OV** (Organisation Validation) | ~$200–400 | Warns until reputation accrues |
| **EV** (Extended Validation) | ~$300–600 | Trusted immediately |

Since June 2023 both require the private key on hardware — a FIPS token or a cloud HSM (Azure Key Vault, DigiCert KeyLocker). You cannot keep a `.pfx` on disk any more.

### Wiring it in

electron-builder signs automatically when it finds the credentials. For a token or HSM, add to `electron-builder.yml`:

```yaml
win:
  signtoolOptions:
    publisherName: 'Your Legal Entity Name'
    certificateSubjectName: 'Your Legal Entity Name'   # from the installed cert
    signingHashAlgorithms: ['sha256']
    rfc3161TimeStampServer: 'http://timestamp.digicert.com'
```

Always timestamp. Without it, every signature expires with the certificate.

`publisherName` must match the certificate's subject exactly, or the updater will reject its own downloads.

### Verify

```powershell
Get-AuthenticodeSignature .\dist\Brutus-Setup-1.0.1.exe | Format-List
```

`Status` must be `Valid`.

---

## 5. Publish

Create a GitHub release tagged `v<version>` on `Aditya060806/Brutus` and attach **all** of:

- `Brutus-Setup-<version>.exe`
- `Brutus-Portable-<version>.exe`
- `latest.yml`
- `*.blockmap`

> Omitting `latest.yml` silently breaks auto-update for every existing install. It is the most common release mistake.

Publish the SHA-256 of each executable in the release notes so users can verify while signing is pending:

```powershell
Get-FileHash .\dist\Brutus-Setup-1.0.1.exe -Algorithm SHA256
```

---

## 6. Pre-release checklist

Run on a **clean** Windows VM with no dev tools and no Brutus data.

**Install**
- [ ] Installer runs with no admin prompt (per-user default)
- [ ] Desktop and Start menu shortcuts appear
- [ ] Uninstall entry shows `Brutus <version>` with the icon
- [ ] Brutus launches when the installer finishes

**First run**
- [ ] Setup wizard appears
- [ ] All four steps complete
- [ ] Each provider's **Test connection** gives the right verdict for a good key, a deliberately broken key, and with the network off
- [ ] A rejected key is **not** saved
- [ ] Demo mode reaches the main interface
- [ ] Tutorial opens and its steps point at real controls, in both languages

**Core**
- [ ] Diagnostics: every row correct on this machine
- [ ] Microphone, speaker, camera detected
- [ ] Voice connects and replies
- [ ] Dictation works with the network **off** (bundled Whisper)
- [ ] Studio launches an installed agent CLI
- [ ] Studio permission prompt blocks the agent until answered
- [ ] Preview opens on a dev server and on a static HTML file
- [ ] Records: search, then export MD, JSON and PDF
- [ ] Screen capture and OCR (`Ctrl+Alt+X`)
- [ ] Phantom (`Ctrl+Alt+Space`)

**Robustness**
- [ ] Log file written to `%APPDATA%\Brutus\logs`
- [ ] Kill the process, relaunch → "did not close properly" appears once
- [ ] Update check reaches GitHub and reports a version
- [ ] Config export and import round-trips
- [ ] Portable exe runs from a USB stick and keeps settings between launches

**Uninstall**
- [ ] Asks about removing data, defaults to keeping it
- [ ] "No" leaves `%APPDATA%\Brutus` intact
- [ ] "Yes" removes it
- [ ] Program files fully removed either way

**Performance**
- [ ] Cold start under ~8 s
- [ ] Idle memory reasonable (~400–700 MB for an Electron app this size)

---

## Known gaps in 1.0

State these in the release notes rather than letting users discover them:

1. **Not code-signed** — SmartScreen warns. Step 4 above.
2. **x64 only** — ARM64 runs emulated; Diagnostics says so.
3. **Windows is the tested platform** — mac/Linux targets build but are unverified.
4. **Portable keys do not travel** — DPAPI is account-bound. Use export-with-secrets.
5. **MSI target removed** — NSIS plus portable covers the same ground; MSI doubled build time. Re-add a `msi` target if enterprise GPO deployment is needed.
