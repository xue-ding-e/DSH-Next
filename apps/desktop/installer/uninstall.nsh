; Electron user data and updater downloads leave with the application; the Harness home is never touched.
!include FileFunc.nsh
Var UnTarget
Var UnHome

; The helper refuses unsafe roots, the installation and the Harness home, and never descends into reparse points;
; a locked file leaves residue and never fails the uninstall. customCheckAppRunning extracts window-frame.dll first.
Function un.RemoveData
  System::Call '$PLUGINSDIR\window-frame.dll::UninstallRemoveData(w "$UnTarget", w "$INSTDIR", w "$UnHome") ?c'
FunctionEnd

; Electron registers this per-user scheme at first launch. Remove it only while
; it still belongs to this exact Next installation, never an official or different-command
; handler. Restore the caller's registry view after each fixed view operation.
!macro NextRemoveOwnedProtocol View
  SetRegView ${View}
  ReadRegStr $0 HKCU "Software\Classes\dsh-next\shell\open\command" ""
  StrCpy $1 '$\"$INSTDIR\DSH Next.exe$\" $\"%1$\"'
  StrCmpS $0 $1 0 +2
    DeleteRegKey HKCU "Software\Classes\dsh-next"
  SetRegView lastused
!macroend

Function un.RemoveOwnedNextProtocol
  Push $0
  Push $1
  Push $2
  StrCpy $2 0
  ${If} ${Errors}
    StrCpy $2 1
  ${EndIf}
  !insertmacro NextRemoveOwnedProtocol 32
  !insertmacro NextRemoveOwnedProtocol 64
  ${If} $2 == 1
    SetErrors
  ${Else}
    ClearErrors
  ${EndIf}
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

Function un.CleanData
  !ifdef APP_PACKAGE_NAME
    !if "${APP_PACKAGE_NAME}" == "dsh-next-desktop"
      Call un.RemoveOwnedNextProtocol
      ; Next uninstall removes the application only. Preserve its profiles, preferences and caches,
      ; including an explicit DSH_NEXT_HOME nested in an Electron data directory. Reinstallation is
      ; non-destructive even when the uninstaller cannot observe a process-local environment override.
      Return
    !endif
  !endif
  ${If} ${isUpdated}
    Return
  ${EndIf}
  ; The installer runs an older uninstaller with /KEEP_APP_DATA when replacing it from another directory.
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/KEEP_APP_DATA" $R1
  ${IfNot} ${Errors}
    Return
  ${EndIf}
  ; Only a DSH_HOME published as a Windows environment variable is visible here.
  ReadEnvStr $UnHome DSH_HOME
  ClearErrors
  StrCpy $UnTarget "$APPDATA\${PRODUCT_FILENAME}"
  Call un.RemoveData
  !ifdef APP_PACKAGE_NAME
    ; Electron derives user data from the package name; a scoped name nests it one directory deeper.
    StrCpy $UnTarget "$APPDATA\${APP_PACKAGE_NAME}"
    Call un.RemoveData
    System::Call '$PLUGINSDIR\window-frame.dll::UninstallRemoveEmptyParents(w "$UnTarget", w "$APPDATA") ?c'
  !endif
  StrCpy $UnTarget "$LOCALAPPDATA\${DSH_UPDATER_CACHE_NAME}"
  Call un.RemoveData
FunctionEnd
