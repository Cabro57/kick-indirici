"""Pencere, tek kopya denetimi ve programin giris noktasi."""

import ctypes
import logging
import os
import shutil
import sys
import tempfile
import threading
import time
import webview

from kickindir.api import Api
from kickindir.config import ACTIVE_ALL, DATA_DIR, INSTANCE_PID, LOG_PATH, WEBVIEW2_PAGE, WEBVIEW2_URL, app_dir, log, resource_dir
from kickindir.core.i18n import detect_lang, set_lang, t
from kickindir.core.storage import load_settings
from kickindir.services import updater
from kickindir.services.notify import register_toast_app


def webview2_ok():
    """pywebview, WebView2 Runtime ya da .NET 4.6.2 yoksa sessizce eski IE motoruna duser;
    o motor bu arayuzu calistiramaz ve pencere bos/siyah kalir. Bunu once biz kontrol ederiz."""
    import winreg
    try:
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full") as k:
            if winreg.QueryValueEx(k, "Release")[0] < 394802:
                return False, ".NET Framework 4.6.2"
    except OSError:
        return False, ".NET Framework 4.6.2"
    guid = "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
    # Kayit defteri tek basina yetmez: bozuk kurulumda surum kayitli ama dosyalar silinmis olabiliyor
    # (pywebview "Couldn't find a compatible Webview2 Runtime" verip pencereyi siyah birakir).
    bases = [os.path.join(os.environ[v], "Microsoft", "EdgeWebView", "Application")
             for v in ("ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA") if os.environ.get(v)]
    broken = False
    for root, path in ((winreg.HKEY_LOCAL_MACHINE, rf"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{guid}"),
                       (winreg.HKEY_LOCAL_MACHINE, rf"SOFTWARE\Microsoft\EdgeUpdate\Clients\{guid}"),
                       (winreg.HKEY_CURRENT_USER, rf"SOFTWARE\Microsoft\EdgeUpdate\Clients\{guid}")):
        try:
            with winreg.OpenKey(root, path) as k:
                pv = str(winreg.QueryValueEx(k, "pv")[0])
                if int(pv.split(".")[0]) >= 86:
                    if any(os.path.isfile(os.path.join(b, pv, "msedgewebview2.exe")) for b in bases):
                        return True, pv
                    log.info("WebView2 %s kayitli ama dosyalari yok", pv)
                    broken = True
        except (OSError, ValueError):
            pass
    return False, "broken" if broken else "Microsoft Edge WebView2 Runtime"


def message_box(text, yes_no=False):
    flags = (0x04 if yes_no else 0x00) | 0x30   # MB_YESNO / MB_OK + uyari ikonu
    return ctypes.windll.user32.MessageBoxW(None, text, t("app.name"), flags) == 6   # 6 = IDYES


def setup_logging():
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        logging.basicConfig(filename=LOG_PATH, filemode="w", level=logging.INFO, encoding="utf-8",
                            format="%(asctime)s %(name)s %(levelname)s %(message)s")
    except OSError:
        pass


def dark_titlebar(window):
    """Windows 11 baslik cubugunu koyu yapar (pencere arka planiyla ayni renk)."""
    try:
        hwnd = window.native.Handle.ToInt32()
        dwm = ctypes.windll.dwmapi
        on = ctypes.c_int(1)
        dwm.DwmSetWindowAttribute(hwnd, 20, ctypes.byref(on), ctypes.sizeof(on))
        color = ctypes.c_int(0x00101010)  # #101010 (COLORREF = 0x00BBGGRR)
        dwm.DwmSetWindowAttribute(hwnd, 35, ctypes.byref(color), ctypes.sizeof(color))
    except Exception:  # noqa: BLE001 - eski Windows'ta sessizce gec
        pass


def single_instance():
    """Program zaten aciksa onun penceresini one getirir ve False doner; degilse True.
    Isimli mutex surec kapaninca (cokse bile) Windows'ca birakilir; pid dosyasi pencereyi bulmak icin."""
    kernel32, user32 = ctypes.windll.kernel32, ctypes.windll.user32
    kernel32.CreateMutexW.restype = ctypes.c_void_p
    # guncellemeden sonra acilan yeni surum: eski surec kapanana kadar (en fazla 20 sn) bekler
    tries = 80 if "--after-update" in sys.argv else 1
    for _ in range(tries):
        single_instance.mutex = kernel32.CreateMutexW(None, False, "Local\\KickIndirici.SingleInstance")
        if kernel32.GetLastError() != 183:      # ERROR_ALREADY_EXISTS
            break
        kernel32.CloseHandle(ctypes.c_void_p(single_instance.mutex))
        time.sleep(0.25)
    else:
        single_instance.mutex = None
    if single_instance.mutex:
        try:
            os.makedirs(DATA_DIR, exist_ok=True)
            with open(INSTANCE_PID, "w") as f:
                f.write(str(os.getpid()))
        except OSError:
            pass
        return True
    try:
        with open(INSTANCE_PID) as f:
            pid = int(f.read().strip())
    except (OSError, ValueError):
        return False
    found = []
    proc = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)

    def each(hwnd, _):
        owner = ctypes.c_ulong()
        user32.GetWindowThreadProcessId(ctypes.c_void_p(hwnd), ctypes.byref(owner))
        if owner.value == pid and user32.IsWindowVisible(ctypes.c_void_p(hwnd)) \
                and user32.GetWindowTextLengthW(ctypes.c_void_p(hwnd)):
            found.append(hwnd)
            return False
        return True

    user32.EnumWindows(proc(each), None)
    if found:
        hwnd = ctypes.c_void_p(found[0])
        if user32.IsIconic(hwnd):
            user32.ShowWindow(hwnd, 9)      # SW_RESTORE
        user32.SetForegroundWindow(hwnd)
    return False


def main():
    if not single_instance():
        return
    setup_logging()
    set_lang(load_settings().get("lang") or detect_lang())   # pencereden onceki uyarilar da secili dilde
    # isaret dosyasi (1.0.2+) ya da eski exe kopyasi (isareti yazmayan eski surumden gecis)
    frozen = getattr(sys, "frozen", False)
    just_updated = updater.just_updated(DATA_DIR) or (frozen and os.path.exists(os.path.join(app_dir(), "KickIndirici.exe.old")))
    if frozen:     # onceki guncellemeden kalan .old dosyalari
        threading.Thread(target=updater.cleanup, args=(app_dir(),), daemon=True).start()
    build = sys.getwindowsversion().build
    ok, what = webview2_ok()
    log.info("Windows build %s, WebView2/.NET: %s %s", build, ok, what)
    if not ok:
        name = t("startup.webview2_broken") if what == "broken" else what
        if message_box(t("startup.missing", what=name), yes_no=True):
            os.startfile(WEBVIEW2_PAGE if what == "broken" else WEBVIEW2_URL if "WebView2" in what else "https://dotnet.microsoft.com/download/dotnet-framework")
        return
    # Bazi ekran karti suruculerinde (ozellikle Windows 10) WebView2 siyah cizer; orada GPU'yu kapat.
    # --gpu / --no-gpu ile elle secilebilir.
    if "--no-gpu" in sys.argv or (build < 22000 and "--gpu" not in sys.argv):
        os.environ["WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"] = "--disable-features=ElasticOverscroll --disable-gpu"
        log.info("GPU kapali")
    register_toast_app()

    api = Api()
    api._just_updated = just_updated
    window = webview.create_window(
        t("app.name"), os.path.join(resource_dir(), "web", "index.html"), js_api=api,
        width=1360, height=880, min_size=(980, 660), background_color="#101010")
    api._window = window
    window.events.shown += lambda: dark_titlebar(window)

    class Webview2Failed(logging.Handler):
        """pywebview, WebView2 baslatilamazsa sadece log yazip pencereyi siyah birakir; kullaniciya gosterir."""
        def emit(self, record):
            if "WebView2 initialization failed" not in record.getMessage():
                return
            def report():   # arayuz thread'ini bekletmemek icin ayri thread
                if message_box(t("startup.webview2_failed"), yes_no=True):
                    os.startfile(WEBVIEW2_PAGE)
                window.destroy()
            threading.Thread(target=report, daemon=True).start()

    logging.getLogger("pywebview").addHandler(Webview2Failed())

    def on_closing():
        # Arayuz thread'inde calisir: evaluate_js'e giden hicbir sey (or. cancel_all -> _push) cagrilmamali.
        busy = any(d.status in ACTIVE_ALL for d in api._downloads.values())
        if busy and not api._exit_ok:
            # onay uygulamanin kendi penceresinde sorulur; kapanma simdilik iptal, evet denirse exit_now kapatir
            threading.Thread(target=lambda: window.evaluate_js("askExit()"), daemon=True).start()
            return False
        api._closing = True
        api._dirty.set()
        for d in list(api._downloads.values()):
            d.cancel = True
        # pencere kapandiktan sonra bazi thread'ler (WebView2 .NET) sureci acik tutabiliyor; kurucu
        # exe'yi yazamaz. Kuyruk kaydedilir, ffmpeg durdurulur, sonra surec zorla bitirilir.
        def hard_exit():
            cleanup = threading.Thread(target=lambda: (api._stop_recordings(), api._persist_queue()), daemon=True)
            cleanup.start()
            cleanup.join(3)
            api._apply_pending_update()
            os._exit(0)
        timer = threading.Timer(4, hard_exit)
        timer.daemon = True
        timer.start()
        return True

    window.events.closing += on_closing
    # Her acilista temiz WebView2 profili: eski surumun onbellege alinmis HTML/CSS'i gelmesin
    profile = tempfile.mkdtemp(prefix="kickindirici-")
    # pencere/gorev cubugu ikonu: verilmezse pywebview Python ikonunu kullanir
    icon = os.path.join(resource_dir(), "assets", "app.ico")
    webview.start(debug="--debug" in sys.argv, private_mode=True, storage_path=profile, icon=icon)
    api._stop_recordings()
    api._persist_queue()
    api._apply_pending_update()
    shutil.rmtree(profile, ignore_errors=True)
    os._exit(0)


if __name__ == "__main__":
    main()
