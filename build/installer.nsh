; ─────────────────────────────────────────────────────────────────────────────
;  BRUTUS — NSIS installer customisation
; ─────────────────────────────────────────────────────────────────────────────
;  Two jobs, both about not surprising the user:
;
;   1. On uninstall, OFFER to remove personal data instead of either silently
;      deleting it or silently leaving it behind. Settings, encrypted API keys,
;      Studio workspaces, task records and logs all live in userData; someone
;      reinstalling wants them kept, someone leaving wants them gone, and only
;      they know which.
;
;   2. Refuse to install over a running copy. Overwriting a live Brutus leaves a
;      half-updated install and an app whose code no longer matches its state.
;
;  Note on VC++ runtimes: an Electron application does not need the Visual C++
;  redistributable. Electron ships its own runtime, and every native addon here
;  (node-pty, sharp, onnxruntime-node) is a prebuilt N-API binary. There is
;  deliberately no redist bundled — installing one users do not need is its own
;  failure mode.
; ─────────────────────────────────────────────────────────────────────────────

!macro customInit
  ; A running instance holds locks on the very files we are about to replace.
  nsExec::ExecToStack 'cmd /c tasklist /FI "IMAGENAME eq Brutus.exe" /NH'
  Pop $0
  Pop $1
  ${If} $1 != ""
    StrCpy $2 $1
    ${If} $2 != ""
      ClearErrors
      ; Ask before killing: unsaved notes and running agents belong to the user.
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION \
        "Brutus is currently running.$\n$\nIt needs to close before the install can continue. Any running agents will be stopped." \
        IDOK closeIt IDCANCEL abortIt
      abortIt:
        Abort
      closeIt:
        nsExec::Exec 'taskkill /IM Brutus.exe /F'
        Sleep 1200
    ${EndIf}
  ${EndIf}
!macroend

!macro customUnInstall
  ; Only ask on a genuine uninstall. During an upgrade electron-builder runs the
  ; old uninstaller with /S, and wiping data mid-upgrade would look like the
  ; update itself had destroyed everything.
  ${ifNot} ${isUpdated}
    MessageBox MB_YESNO|MB_ICONQUESTION \
      "Remove your Brutus data as well?$\n$\nThis deletes your settings, saved API keys, Studio workspaces, task records and logs.$\n$\nChoose No to keep them for a future reinstall." \
      /SD IDNO IDYES removeData IDNO keepData

    removeData:
      ; %APPDATA%\Brutus — derived from productName. Kept in step with
      ; electron-builder.yml; if productName ever changes, this must too.
      RMDir /r "$APPDATA\Brutus"
      RMDir /r "$LOCALAPPDATA\Brutus"
      Goto doneData

    keepData:
      DetailPrint "Keeping Brutus user data in $APPDATA\Brutus"

    doneData:
  ${endIf}
!macroend
