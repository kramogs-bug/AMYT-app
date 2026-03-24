; ============================================================
;  AMYT — Inno Setup Installer Script
;  Inno Setup 6.x  →  https://jrsoftware.org/isdl.php
;
;  PUT THIS FILE IN:  macro-app\  (your project root)
;
;  BEFORE COMPILING — download these 2 files into macro-app\:
;
;    MicrosoftEdgeWebview2Setup.exe
;    → https://go.microsoft.com/fwlink/p/?LinkId=2124703
;
;    vc_redist.x64.exe
;    → https://aka.ms/vs/17/release/vc_redist.x64.exe
;
;  Then compile:  Build → Compile  (or press F9)
;  Output goes to:  macro-app\installer_output\AMYT_Setup_v1.0.0.exe
; ============================================================

#define AppName    "AMYT"
#define AppVersion "1.0.1"
#define AppExeName "AMYT.exe"
#define AppURL     "https://github.com/kramogs-bug/AMYT-app"
#define BuildDir   "dist\AMYT"

[Setup]
AppId={{B7F3A291-4D2E-4C8A-9F1B-3E5D7A8C6B4F}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher=kramogs-bug
AppPublisherURL={#AppURL}
AppSupportURL={#AppURL}/issues
AppUpdatesURL={#AppURL}/releases

; Installs to AppData\Local\AMYT — no admin / UAC prompt needed
DefaultDirName={localappdata}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes

; Output
OutputDir=installer_output
OutputBaseFilename=AMYT_Setup_v{#AppVersion}

; logo.ico must be in macro-app\ (same folder as this .iss file)
SetupIconFile=logo.ico
UninstallDisplayIcon={app}\{#AppExeName}
UninstallDisplayName={#AppName} {#AppVersion}

; Compression
Compression=lzma2/ultra64
SolidCompression=yes
LZMAUseSeparateProcess=yes

; UI
WizardStyle=modern

; Version info shown in Windows file properties
VersionInfoVersion={#AppVersion}
VersionInfoDescription={#AppName} Setup
VersionInfoProductName={#AppName}
VersionInfoProductVersion={#AppVersion}

; No admin needed
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog

; Windows 10 v1803+ required (WebView2 minimum)
MinVersion=10.0.17134

; 64-bit only
ArchitecturesInstallIn64BitMode=x64os
ArchitecturesAllowed=x64os

; Register .amyt file association
ChangesAssociations=yes

; Warn user if AMYT is running during upgrade
CloseApplications=yes
CloseApplicationsFilter={#AppExeName}
RestartApplications=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

; ── FILES ─────────────────────────────────────────────────────────────────────

[Files]
; Main app — everything inside dist\AMYT\
Source: "{#BuildDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

; Prerequisites — both files must be in macro-app\ (your project root)
Source: "vc_redist.x64.exe"; DestDir: "{tmp}"; Flags: deleteafterinstall
Source: "MicrosoftEdgeWebview2Setup.exe"; DestDir: "{tmp}"; Flags: deleteafterinstall

; ── SHORTCUTS ─────────────────────────────────────────────────────────────────

[Icons]
; Start Menu
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExeName}"; Comment: "Macro Automation Tool"
Name: "{group}\Uninstall {#AppName}"; Filename: "{uninstallexe}"

; Desktop
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExeName}"; Comment: "Macro Automation Tool"

; ── FILE ASSOCIATION — double-clicking .amyt opens AMYT ───────────────────────

[Registry]
Root: HKCU; Subkey: "Software\Classes\.amyt"; ValueType: string; ValueName: ""; ValueData: "AMYTFile"; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\Classes\AMYTFile"; ValueType: string; ValueName: ""; ValueData: "AMYT Script Package"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\AMYTFile\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: "{app}\{#AppExeName},0"
Root: HKCU; Subkey: "Software\Classes\AMYTFile\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\{#AppExeName}"" ""%1"""

; ── RUN AFTER INSTALL ─────────────────────────────────────────────────────────

[Run]
; 1. Install VC++ Runtime silently (the installer itself skips if already present)
Filename: "{tmp}\vc_redist.x64.exe"; Parameters: "/install /quiet /norestart"; StatusMsg: "Installing Visual C++ Runtime..."; Flags: shellexec waituntilterminated

; 2. Install WebView2 Runtime silently (bootstrapper skips if already present)
Filename: "{tmp}\MicrosoftEdgeWebview2Setup.exe"; Parameters: "/silent /install"; StatusMsg: "Installing WebView2 Runtime..."; Flags: shellexec waituntilterminated

; 3. Launch AMYT when install finishes
Filename: "{app}\{#AppExeName}"; Description: "Launch {#AppName}"; Flags: nowait postinstall skipifsilent

; ── UNINSTALL ─────────────────────────────────────────────────────────────────

[UninstallDelete]
; Remove logs on uninstall — storage/ is intentionally kept so user data is safe
Type: filesandordirs; Name: "{app}\logs"

; ── CODE — preserve scripts and templates on upgrade ──────────────────────────

[Code]
var
  StorageBackup: String;
  LogsBackup:    String;
  HadStorage:    Boolean;
  HadLogs:       Boolean;

procedure CurStepChanged(CurStep: TSetupStep);
var
  AppPath: String;
begin
  AppPath := ExpandConstant('{app}');

  if CurStep = ssInstall then
  begin
    // Back up storage/ and logs/ before new files are written
    StorageBackup := ExpandConstant('{tmp}') + '\amyt_storage_bak';
    LogsBackup    := ExpandConstant('{tmp}') + '\amyt_logs_bak';

    HadStorage := DirExists(AppPath + '\storage');
    HadLogs    := DirExists(AppPath + '\logs');

    if HadStorage then RenameFile(AppPath + '\storage', StorageBackup);
    if HadLogs    then RenameFile(AppPath + '\logs',    LogsBackup);
  end;

  if CurStep = ssPostInstall then
  begin
    // Restore storage/ and logs/ after new files are in place
    if HadStorage and DirExists(StorageBackup) then
    begin
      if DirExists(AppPath + '\storage') then
        DelTree(AppPath + '\storage', True, True, True);
      RenameFile(StorageBackup, AppPath + '\storage');
    end;

    if HadLogs and DirExists(LogsBackup) then
    begin
      if DirExists(AppPath + '\logs') then
        DelTree(AppPath + '\logs', True, True, True);
      RenameFile(LogsBackup, AppPath + '\logs');
    end;
  end;
end;

function InitializeSetup(): Boolean;
var
  PrevVersion: String;
  PrevUninstall: String;
begin
  Result := True;

  // Detect previous install and show upgrade notice
  if RegQueryStringValue(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{B7F3A291-4D2E-4C8A-9F1B-3E5D7A8C6B4F}_is1',
    'DisplayVersion', PrevVersion) then
  begin
    if PrevVersion <> '{#AppVersion}' then
      MsgBox('Upgrading AMYT from v' + PrevVersion + ' to v{#AppVersion}.' + #13#10 +
             'Your scripts and templates will be preserved.', mbInformation, MB_OK);
  end;

  if not Is64BitInstallMode then
  begin
    MsgBox(
      'AMYT requires a 64-bit version of Windows (10 or later).' + #13#10 +
      'This installer cannot continue.',
      mbError, MB_OK
    );
    Result := False;
  end;
end;
