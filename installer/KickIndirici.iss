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
english.UsageTitle=Anonymous usage data
turkish.UsageTitle=Anonim kullanım verisi
english.UsageSub=Help make Kick Downloader better
turkish.UsageSub=Kick İndirici'yi geliştirmeye yardım et
english.UsageText=The app can send anonymous usage data: app and Windows version, language, hardware (processor, memory, graphics card, screen, SSD/HDD), download type, channel name, size, speed and settings, used features and errors. It never sends your IP address, video links or titles, file names or your user name. Data goes to PostHog servers in the EU. The app asks again on first start, and you can change it any time in Settings → App.
turkish.UsageText=Uygulama anonim kullanım verisi gönderebilir: uygulama ve Windows sürümü, dil, donanım (işlemci, bellek, ekran kartı, ekran, SSD/HDD), indirme türü, kanal adı, boyut, hız ve ayarlar, kullanılan özellikler ve hatalar. IP adresin, video linkleri ve başlıkları, dosya adları ve kullanıcı adın asla gönderilmez. Veriler PostHog'un AB'deki sunucularına gider. Uygulama ilk açılışta yine sorar; Ayarlar → Uygulama'dan istediğin zaman değiştirebilirsin.
english.UsageCheck=Send anonymous usage data
turkish.UsageCheck=Anonim kullanım verisi gönder

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

{ Anonim kullanim verisi izni: sihirbazda bir sayfa. Secim uygulamanin veri klasorune yazilir; uygulama
  ilk acilista yine sorar. Sessiz kurulumda (guncelleme) sayfa yok, onceki secime dokunulmaz. }
var
  UsagePage: TInputOptionWizardPage;

procedure InitializeWizard;
begin
  UsagePage := CreateInputOptionPage(wpSelectTasks, CustomMessage('UsageTitle'), CustomMessage('UsageSub'),
    CustomMessage('UsageText'), False, False);
  UsagePage.Add(CustomMessage('UsageCheck'));
  UsagePage.Values[0] := True;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Dir: String;
begin
  if (CurStep = ssPostInstall) and not WizardSilent then
  begin
    Dir := ExpandConstant('{userappdata}\KickIndirici');
    ForceDirectories(Dir);
    if UsagePage.Values[0] then
      SaveStringToFile(Dir + '\telemetry-consent', '1', False)
    else
      SaveStringToFile(Dir + '\telemetry-consent', '0', False);
  end;
end;
