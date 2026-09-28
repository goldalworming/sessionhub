; Windows installer for sessionhub.
;
; Build it anywhere NSIS 3 runs — Windows, or Linux with `apt install nsis` —
; from the release binary:
;
;     makensis -DVERSION=0.0.43 -DBINARY=path\to\sessionhubd.exe ^
;              -DOUTFILE=sessionhub-0.0.43-windows-x86_64-setup.exe ^
;              installer\windows\sessionhub.nsi
;
; OUTFILE is optional; without it the installer lands next to this script.
; makensis runs from this script's folder, so relative BINARY and OUTFILE
; paths are taken from here, not from where the command was typed — pass
; absolute paths, or use `build-installer.sh`, which does.
;
; Per-user, no administrator prompt. The self-updater (`src/update.rs`)
; downloads the new binary beside the running one and swaps it in place, so
; the folder has to stay writable by the user who runs the daemon — which
; Program Files is not. `%LOCALAPPDATA%\Programs` is where per-user programs
; go on Windows, and it keeps self-update working after an installed copy.
;
; The daemon's home (`%USERPROFILE%\.sessionhub`, with the token and saved
; terminals) is not the program folder and the uninstaller leaves it alone
; unless asked.
;
; The name must NOT end in `windows-x86_64.exe`: that suffix is how the
; updater picks the plain binary out of a release, and a setup.exe matching it
; would be "installed" over the daemon.

Unicode true
SetCompressor /SOLID lzma
RequestExecutionLevel user

!ifndef VERSION
  !error "pass -DVERSION=<version>, e.g. -DVERSION=0.0.43"
!endif
!ifndef BINARY
  !error "pass -DBINARY=<path to sessionhubd.exe>"
!endif
!ifndef OUTFILE
  !define OUTFILE "sessionhub-${VERSION}-windows-x86_64-setup.exe"
!endif

!define APP       "sessionhub"
!define EXE       "sessionhubd.exe"
!define PUBLISHER "goldalworming"
!define URL       "https://github.com/goldalworming/sessionhub"
!define UNINST    "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP}"
!define ICON      "../../assets/sessionhub.ico"

Name "${APP}"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Programs\${APP}"
InstallDirRegKey HKCU "${UNINST}" "InstallLocation"
BrandingText "${APP} ${VERSION}"

; A numeric four-part version is all VIProductVersion accepts. 0.0.43 → 0.0.43.0.
VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName"     "${APP}"
VIAddVersionKey "ProductVersion"  "${VERSION}"
VIAddVersionKey "FileVersion"     "${VERSION}"
VIAddVersionKey "FileDescription" "${APP} installer"
VIAddVersionKey "CompanyName"     "${PUBLISHER}"
VIAddVersionKey "LegalCopyright"  "${PUBLISHER}"

!include "MUI2.nsh"
!include "LogicLib.nsh"

!define MUI_ICON   "${ICON}"
!define MUI_UNICON "${ICON}"
!define MUI_ABORTWARNING
!define MUI_COMPONENTSPAGE_SMALLDESC

!define MUI_FINISHPAGE_RUN "$INSTDIR\${EXE}"
!define MUI_FINISHPAGE_RUN_PARAMETERS "start"
!define MUI_FINISHPAGE_RUN_TEXT "Start sessionhub now"
!define MUI_FINISHPAGE_LINK "${URL}"
!define MUI_FINISHPAGE_LINK_LOCATION "${URL}"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "Indonesian"

; ------------------------------------------------------------------ helpers

; A running daemon or tray icon holds the exe open, and Windows will not
; overwrite or delete a file in use. `stop` ends the daemon cleanly (it takes
; its terminals with it); the tray has no stop of its own, so it is killed.
!macro StopRunning
  ${If} ${FileExists} "$INSTDIR\${EXE}"
    DetailPrint "Stopping a running sessionhub…"
    nsExec::Exec '"$INSTDIR\${EXE}" stop'
    Pop $0
  ${EndIf}
  nsExec::Exec 'taskkill /F /IM ${EXE}'
  Pop $0
  Sleep 500
!macroend

; The user PATH lives in HKCU\Environment and is routinely longer than NSIS's
; 1024-character strings, so PowerShell edits it rather than ReadRegStr.
!macro EditUserPath VERB DIR
  nsExec::Exec `powershell -NoProfile -ExecutionPolicy Bypass -Command "\
    $$d = '${DIR}'; \
    $$p = [Environment]::GetEnvironmentVariable('Path', 'User'); \
    $$parts = @(); if ($$p) { $$parts = $$p.Split(';') | Where-Object { $$_ -and ($$_.TrimEnd('\') -ne $$d.TrimEnd('\')) } }; \
    if ('${VERB}' -eq 'add') { $$parts += $$d }; \
    [Environment]::SetEnvironmentVariable('Path', ($$parts -join ';'), 'User')"`
  Pop $0
!macroend

; ------------------------------------------------------------------ install

Section "sessionhub" SecMain
  SectionIn RO
  !insertmacro StopRunning

  SetOutPath "$INSTDIR"
  File "/oname=${EXE}" "${BINARY}"
  File "/oname=sessionhub.ico" "${ICON}"
  ; A failed self-update leaves these behind; a fresh install supersedes them.
  Delete "$INSTDIR\sessionhubd-new.exe"
  Delete "$INSTDIR\sessionhub-swap.log"

  WriteUninstaller "$INSTDIR\uninstall.exe"

  WriteRegStr   HKCU "${UNINST}" "DisplayName"     "${APP}"
  WriteRegStr   HKCU "${UNINST}" "DisplayVersion"  "${VERSION}"
  WriteRegStr   HKCU "${UNINST}" "Publisher"       "${PUBLISHER}"
  WriteRegStr   HKCU "${UNINST}" "URLInfoAbout"    "${URL}"
  WriteRegStr   HKCU "${UNINST}" "DisplayIcon"     "$INSTDIR\${EXE}"
  WriteRegStr   HKCU "${UNINST}" "InstallLocation" "$INSTDIR"
  WriteRegStr   HKCU "${UNINST}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr   HKCU "${UNINST}" "QuietUninstallString" '"$INSTDIR\uninstall.exe" /S'
  WriteRegDWORD HKCU "${UNINST}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST}" "NoRepair" 1
SectionEnd

Section "Start menu shortcut" SecStartMenu
  CreateDirectory "$SMPROGRAMS\${APP}"
  CreateShortCut "$SMPROGRAMS\${APP}\${APP}.lnk" "$INSTDIR\${EXE}" "start" "$INSTDIR\sessionhub.ico"
  CreateShortCut "$SMPROGRAMS\${APP}\Stop ${APP}.lnk" "$INSTDIR\${EXE}" "stop" "$INSTDIR\sessionhub.ico"
  CreateShortCut "$SMPROGRAMS\${APP}\Uninstall ${APP}.lnk" "$INSTDIR\uninstall.exe"
SectionEnd

Section /o "Desktop shortcut" SecDesktop
  CreateShortCut "$DESKTOP\${APP}.lnk" "$INSTDIR\${EXE}" "start" "$INSTDIR\sessionhub.ico"
SectionEnd

; A shortcut in the Startup folder rather than a Run key: only a shortcut can
; ask for a minimised window, so the console `start` opens does not flash up
; at every login. `--no-wait` lets it close without anyone pressing Enter.
Section "Start at login" SecLogin
  CreateShortCut "$SMSTARTUP\${APP}.lnk" "$INSTDIR\${EXE}" "start --no-open --no-wait" \
    "$INSTDIR\sessionhub.ico" 0 SW_SHOWMINIMIZED
SectionEnd

Section "Add to PATH" SecPath
  !insertmacro EditUserPath add "$INSTDIR"
  ; Open terminals keep their old PATH; new ones pick this up.
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
SectionEnd

LangString DESC_Main      ${LANG_ENGLISH} "The sessionhubd program."
LangString DESC_StartMenu ${LANG_ENGLISH} "Start, Stop and Uninstall entries in the Start menu."
LangString DESC_Desktop   ${LANG_ENGLISH} "A sessionhub icon on the desktop."
LangString DESC_Login     ${LANG_ENGLISH} "Start the daemon in the background when you sign in."
LangString DESC_Path      ${LANG_ENGLISH} "Run sessionhubd from any new terminal."

LangString DESC_Main      ${LANG_INDONESIAN} "Program sessionhubd."
LangString DESC_StartMenu ${LANG_INDONESIAN} "Menu Start untuk Start, Stop, dan Uninstall."
LangString DESC_Desktop   ${LANG_INDONESIAN} "Ikon sessionhub di desktop."
LangString DESC_Login     ${LANG_INDONESIAN} "Jalankan daemon di latar belakang saat login."
LangString DESC_Path      ${LANG_INDONESIAN} "Jalankan sessionhubd dari terminal mana pun."

!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SecMain}      $(DESC_Main)
  !insertmacro MUI_DESCRIPTION_TEXT ${SecStartMenu} $(DESC_StartMenu)
  !insertmacro MUI_DESCRIPTION_TEXT ${SecDesktop}   $(DESC_Desktop)
  !insertmacro MUI_DESCRIPTION_TEXT ${SecLogin}     $(DESC_Login)
  !insertmacro MUI_DESCRIPTION_TEXT ${SecPath}      $(DESC_Path)
!insertmacro MUI_FUNCTION_DESCRIPTION_END

; ------------------------------------------------------------------ uninstall

LangString ASK_Home ${LANG_ENGLISH} "Also delete your sessionhub settings in $PROFILE\.sessionhub?$\r$\n$\r$\nThat folder holds the access token, saved terminals and paired machines. Keep it if you might install sessionhub again."
LangString ASK_Home ${LANG_INDONESIAN} "Hapus juga pengaturan sessionhub di $PROFILE\.sessionhub?$\r$\n$\r$\nFolder itu berisi token akses, terminal tersimpan, dan mesin yang dipasangkan. Simpan jika Anda mungkin memasang sessionhub lagi."

Section "Uninstall"
  !insertmacro StopRunning

  Delete "$INSTDIR\${EXE}"
  Delete "$INSTDIR\sessionhub.ico"
  Delete "$INSTDIR\sessionhubd-new.exe"
  Delete "$INSTDIR\sessionhub-swap.log"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"

  Delete "$SMPROGRAMS\${APP}\${APP}.lnk"
  Delete "$SMPROGRAMS\${APP}\Stop ${APP}.lnk"
  Delete "$SMPROGRAMS\${APP}\Uninstall ${APP}.lnk"
  RMDir "$SMPROGRAMS\${APP}"
  Delete "$DESKTOP\${APP}.lnk"
  Delete "$SMSTARTUP\${APP}.lnk"

  !insertmacro EditUserPath remove "$INSTDIR"
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000

  DeleteRegKey HKCU "${UNINST}"

  ; Silent uninstalls (/S) never touch the user's data.
  IfSilent done
  MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 $(ASK_Home) IDNO done
    RMDir /r "$PROFILE\.sessionhub"
  done:
SectionEnd

Function .onInit
  !insertmacro MUI_LANGDLL_DISPLAY
FunctionEnd

Function un.onInit
  !insertmacro MUI_UNGETLANGUAGE
FunctionEnd
