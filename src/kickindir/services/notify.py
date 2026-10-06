"""Windows bildirimleri (toast)."""

import os
import shutil
import subprocess
from xml.sax.saxutils import escape as xml_escape

from kickindir.config import DATA_DIR, TOAST_APP_ID, log, resource_dir


def register_toast_app():
    """Bildirimde 'Windows PowerShell' yerine uygulamanin adi ve ikonu gorunsun: paketsiz uygulama
    kimligi (AUMID) HKCU altina ad + ikonla kaydedilir. Ikon kalici bir yere kopyalanir; tek dosyalik
    exe her acilista baska gecici klasore acildigindan _MEIPASS yolu kullanilamaz."""
    import winreg
    icon = os.path.join(DATA_DIR, "app.png")
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        shutil.copyfile(os.path.join(resource_dir(), "assets", "logo-1024.png"), icon)
    except OSError as e:
        log.info("bildirim ikonu kopyalanamadi: %s", e)
    try:
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, rf"Software\Classes\AppUserModelId\{TOAST_APP_ID}") as k:
            winreg.SetValueEx(k, "DisplayName", 0, winreg.REG_SZ, "Kick İndirici")
            if os.path.exists(icon):
                winreg.SetValueEx(k, "IconUri", 0, winreg.REG_SZ, icon)
    except OSError as e:
        log.info("bildirim kimligi kaydedilemedi: %s", e)


def toast(title, text):
    """Windows bildirimi. Ek kutuphane yok: PowerShell uzerinden WinRT, kimlik olarak TOAST_APP_ID.
    Metin ortam degiskeniyle gecer, komut satirina girmez; tirnak ya da ozel karakter komutu bozamaz."""
    xml = ("<toast><visual><binding template='ToastGeneric'>"
           f"<text>{xml_escape(title)}</text><text>{xml_escape(text)}</text></binding></visual></toast>")
    ps = ("[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]>$null;"
          "[Windows.Data.Xml.Dom.XmlDocument,Windows.Data.Xml.Dom.XmlDocument,ContentType=WindowsRuntime]>$null;"
          "$x=New-Object Windows.Data.Xml.Dom.XmlDocument;$x.LoadXml($env:KICK_TOAST);"
          f"[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{TOAST_APP_ID}')"
          ".Show([Windows.UI.Notifications.ToastNotification]::new($x))")
    try:
        subprocess.Popen(["powershell", "-NoProfile", "-NonInteractive", "-Command", ps],
                         env=dict(os.environ, KICK_TOAST=xml), stdin=subprocess.DEVNULL,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         creationflags=subprocess.CREATE_NO_WINDOW)
    except OSError as e:
        log.info("bildirim gosterilemedi: %s", e)
