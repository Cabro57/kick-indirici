; Derleme: ISCC /DAppVersion=1.0.5 installer\KickIndirici.iss  (dist\ icinde KickIndirici.exe ve ffmpeg.exe olmali)
#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif

[Setup]
AppId={{6B1E2A54-8C3F-4D7A-9E21-5F0A7C3D4B18}
AppName={cm:AppName}
AppVersion={#AppVersion}
AppPublisher=Cabro57
AppPublisherURL=https://github.com/Cabro57/kick-indirici
; AppName dile gore degistigi icin exe surum bilgisi sabit verilir
VersionInfoProductName=Kick Downloader
VersionInfoDescription=Kick Downloader Setup
DefaultDirName={autopf}\KickIndirici
DefaultGroupName={cm:AppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
UninstallDisplayName={cm:AppName}
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
; Kurulum Windows diline gore acilir; Turkce degilse Ingilizce (ilk dil varsayilan).
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "turkish"; MessagesFile: "compiler:Languages\Turkish.isl"

[CustomMessages]
english.AppName=Kick Downloader
turkish.AppName=Kick İndirici
english.DesktopIcon=Create a desktop shortcut
turkish.DesktopIcon=Masaüstüne kısayol koy
english.OpenApp=Open Kick Downloader
turkish.OpenApp=Kick İndirici'yi aç

[Tasks]
Name: "desktopicon"; Description: "{cm:DesktopIcon}"; Flags: unchecked

[Files]
Source: "..\dist\KickIndirici.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\dist\ffmpeg.exe"; DestDir: "{app}"; Flags: ignoreversion comparetimestamp
Source: "LICENSE-ffmpeg.txt"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\{cm:AppName}"; Filename: "{app}\KickIndirici.exe"
Name: "{autodesktop}\{cm:AppName}"; Filename: "{app}\KickIndirici.exe"; Tasks: desktopicon

[InstallDelete]
; Ingilizce kurulumda eski Turkce adli kisayollar kalmasin
Type: files; Name: "{autoprograms}\Kick İndirici.lnk"; Languages: english
Type: files; Name: "{autodesktop}\Kick İndirici.lnk"; Languages: english

[Run]
; Sessiz kurulumda (otomatik guncelleme) de calisir: uygulama kendiliginden yeniden acilir.
; Guncelleyen eski exe'nin PyInstaller ortam degiskenleri temizlenir; yoksa yeni exe, kapanan surumun
; gecici klasorunu (_MEI...) kullanmaya calisir ve "Failed to load Python DLL" der.
Filename: "{cmd}"; Parameters: "/c set _PYI_APPLICATION_HOME_DIR=& set _PYI_ARCHIVE_FILE=& set _PYI_PARENT_PROCESS_LEVEL=& set _MEIPASS2=& set PYINSTALLER_RESET_ENVIRONMENT=1& start """" ""{app}\KickIndirici.exe"""; Description: "{cm:OpenApp}"; Flags: runhidden nowait postinstall; Check: not NoRun

[Code]
{ Kurulum her zaman kullanici klasorune: uygulama-ici guncelleyici dosyalari yerinde degistirebilsin.
  Kurucuyla kapanista guncelleme /NORUN=1 ile gelir: programi kullanici bir sonraki sefer kendisi acar. }
function NoRun: Boolean;
begin
  Result := ExpandConstant('{param:norun|0}') = '1';
end;
