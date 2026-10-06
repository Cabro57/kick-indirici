; Derleme: ISCC /DAppVersion=1.0.5 installer\KickIndirici.iss  (dist\ icinde KickIndirici.exe ve ffmpeg.exe olmali)
#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif

[Setup]
AppId={{6B1E2A54-8C3F-4D7A-9E21-5F0A7C3D4B18}
AppName=Kick İndirici
AppVersion={#AppVersion}
AppPublisher=Cabro57
AppPublisherURL=https://github.com/Cabro57/kick-indirici
DefaultDirName={autopf}\KickIndirici
DefaultGroupName=Kick İndirici
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
OutputDir=..\dist
OutputBaseFilename=KickIndirici-Setup-{#AppVersion}
SetupIconFile=..\assets\app.ico
UninstallDisplayIcon={app}\KickIndirici.exe
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
CloseApplications=force
CloseApplicationsFilter=KickIndirici.exe
RestartApplications=no
ArchitecturesInstallIn64BitMode=x64compatible

[Languages]
Name: "turkish"; MessagesFile: "compiler:Languages\Turkish.isl"

[Tasks]
Name: "desktopicon"; Description: "Masaüstüne kısayol koy"; Flags: unchecked

[Files]
Source: "..\dist\KickIndirici.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\dist\ffmpeg.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "LICENSE-ffmpeg.txt"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\Kick İndirici"; Filename: "{app}\KickIndirici.exe"
Name: "{autodesktop}\Kick İndirici"; Filename: "{app}\KickIndirici.exe"; Tasks: desktopicon

[Run]
; sessiz kurulumda (otomatik guncelleme) de calisir: uygulama kendiliginden yeniden acilir
Filename: "{app}\KickIndirici.exe"; Description: "Kick İndirici'yi aç"; Flags: nowait postinstall
