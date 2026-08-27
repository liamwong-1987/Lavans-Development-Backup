#define MyAppName "Lavans"
#define MyAppVersion "1.0.7"
#define MyAppExeName "Lavans.exe"

[Setup]
AppId={{5DEA3BFE-2732-4FB2-A620-692CF01DAEB5}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
UninstallDisplayName={#MyAppName}
DefaultDirName={localappdata}\Programs\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
OutputDir=..\release\installer
OutputBaseFilename=Lavans-Setup-{#MyAppVersion}-x64
SetupIconFile=..\electron\assets\logo.ico
UninstallDisplayIcon={app}\{#MyAppExeName}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes
RestartApplications=no
UsePreviousAppDir=yes
VersionInfoVersion=1.0.7.0
VersionInfoProductName={#MyAppName}
VersionInfoDescription={#MyAppName} Windows Installer
VersionInfoCompany={#MyAppName}

[Files]
Source: "..\release\Lavans-win32-x64\*"; DestDir: "{app}"; Excludes: "\debug.log,*.log,\resources\output\*,\resources\uploads\*,\resources\logs\*,\resources\backend\output\*,\resources\backend\uploads\*,\resources\backend\cache\*,\resources\backend\logs\*,\resources\backend\asset-library.json,\resources\backend\canvas-config.json,\resources\backend\config.json,\resources\backend\creative-config.json,\resources\backend\creative-history.json,\resources\backend\sessions.json"; Flags: ignoreversion recursesubdirs

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加快捷方式："; Flags: unchecked

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "启动 {#MyAppName}"; WorkingDir: "{app}"; Flags: nowait postinstall skipifsilent
