; Installer hooks (`bundle.windows.nsis.installerHooks` in tauri.windows.conf.json).

; "Delete the application data" removes the folders Tauri names after the bundle identifier. The app keeps its
; data in folders named like itself (src-tauri/src/data_dir.rs): %APPDATA%\KK-Notes, and its web view's in
; %LOCALAPPDATA%\KK-Notes beside the program. Those go too, and only then; never on an update.
!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    SetShellVarContext current
    RmDir /r "$APPDATA\${PRODUCTNAME}"
    RmDir /r "$LOCALAPPDATA\${PRODUCTNAME}\EBWebView"
    RmDir "$LOCALAPPDATA\${PRODUCTNAME}"
  ${EndIf}
!macroend
