"""README ekran goruntuleri: uygulamayi gecici bir veri klasoruyle (gercek ayarlara dokunmadan) acar,
her sahneyi arayuzde JS ile kurar ve pencereyi yakalar. Indirme baslatmaz; inen / inmis gorunumleri
gercek VOD bilgisiyle arayuze verilen sahte durumdur.

Kullanim: python tools/screenshots.py [en|tr] [kanal ...]
  Dil verilmezse en. Kanal verilmezse gercek ayarlardaki favoriler kullanilir; ilk canli olan kanal
  sayfasi icin secilir. Cikti: docs/img/<dil>/*.jpg
"""

import ctypes
import json
import os
import shutil
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LANG = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] in ("en", "tr") else "en"
SLUGS = [a for a in sys.argv[1:] if a not in ("en", "tr")]
OUT = os.path.join(ROOT, "docs", "img", LANG)
SIZE = (1347, 718)          # pencere icerigi (mantiksal px); %125 olcekte 1684x897 civari

# gercek veri klasorune dokunmamak icin APPDATA gecici klasore; kickindir ice aktarilmadan once
real_data = os.path.join(os.environ["APPDATA"], "KickIndirici")
tmp = tempfile.mkdtemp(prefix="kick-shots-")
os.environ["APPDATA"] = tmp
os.makedirs(os.path.join(tmp, "KickIndirici"))
favorites = []
try:
    with open(os.path.join(real_data, "settings.json"), encoding="utf-8") as f:
        favorites = [{k: v for k, v in x.items() if k in ("slug", "name", "avatar")}
                     for x in json.load(f).get("favorites") or []]
except OSError:
    pass
if SLUGS:
    favorites = [{"slug": s, "name": s, "avatar": ""} for s in SLUGS]
with open(os.path.join(tmp, "KickIndirici", "settings.json"), "w", encoding="utf-8") as f:
    json.dump({"lang": LANG, "favorites": favorites, "updateCheck": False, "clipboardWatch": False,
               "notifyLive": False, "folder": r"C:\Users\you\Downloads\Kick"}, f)   # indirme olmaz; gercek kullanici adi gorunmesin

sys.path.insert(0, os.path.join(ROOT, "src"))
import webview                                   # noqa: E402
from kickindir import app                        # noqa: E402

user32 = ctypes.windll.user32
gdi32 = ctypes.windll.gdi32


def capture(hwnd, path):
    """Pencereyi (baslik cubuguyla) PrintWindow ile yakalar; ustunde baska pencere olsa da olur."""
    from PIL import Image

    class RECT(ctypes.Structure):
        _fields_ = [("l", ctypes.c_long), ("t", ctypes.c_long), ("r", ctypes.c_long), ("b", ctypes.c_long)]

    r = RECT()
    ctypes.windll.dwmapi.DwmGetWindowAttribute(hwnd, 9, ctypes.byref(r), ctypes.sizeof(r))   # golgesiz cerceve
    full = RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(full))
    w, h = full.r - full.l, full.b - full.t
    hdc = user32.GetWindowDC(hwnd)
    mem = gdi32.CreateCompatibleDC(hdc)
    bmp = gdi32.CreateCompatibleBitmap(hdc, w, h)
    gdi32.SelectObject(mem, bmp)
    user32.PrintWindow(hwnd, mem, 2)              # PW_RENDERFULLCONTENT: WebView2 icerigi de gelir
    buf = ctypes.create_string_buffer(w * h * 4)
    bmi = (ctypes.c_uint32 * 10)(40, w, -h, 1 | (32 << 16), 0, 0, 0, 0, 0, 0)
    gdi32.GetDIBits(mem, bmp, 0, h, buf, bmi, 0)
    img = Image.frombuffer("RGBA", (w, h), buf, "raw", "BGRA", 0, 1).convert("RGB")
    img = img.crop((r.l - full.l, r.t - full.t, r.r - full.l, r.b - full.t))
    gdi32.DeleteObject(bmp)
    gdi32.DeleteDC(mem)
    user32.ReleaseDC(hwnd, hdc)
    img.save(path, quality=88)
    print("kaydedildi", os.path.relpath(path, ROOT), img.size, flush=True)


def driver(window):
    js = window.evaluate_js

    def wait(cond, timeout=30):
        end = time.time() + timeout
        while time.time() < end:
            try:
                if js(cond):
                    return True
            except Exception:  # noqa: BLE001
                pass
            time.sleep(0.3)
        print("bekleme doldu:", cond, flush=True)
        return False

    def shot(name, settle=1.5):
        hwnd = window.native.Handle.ToInt32()
        if user32.IsIconic(hwnd):             # simge durumuna kucultulduyse odak calmadan geri ac
            user32.ShowWindow(hwnd, 4)        # SW_SHOWNOACTIVATE
            time.sleep(1)
        time.sleep(settle)
        capture(hwnd, os.path.join(OUT, name + ".jpg"))

    def reset():
        js("document.activeElement && document.activeElement.blur(); closeCardMenu(false); closeWatch(); if ($('cutter').open) closeCutter(); if ($('keysDlg').open) $('keysDlg').close();"
           "state.selected.clear(); $('selList').hidden = true; hover.stop(); selectionChanged();")

    wait("!!(window.state && state.api && state.cfg)")
    window.resize(*SIZE)
    os.makedirs(OUT, exist_ok=True)
    wait("Object.keys(state.favStatus).length > 0", 40)

    # canli bir favori varsa onun sayfasi; yoksa ilk favori
    live = js("(state.favorites.find((f) => state.liveFavs.has(f.slug) || (state.favStatus[f.slug] || {}).live) || state.favorites[0] || {}).slug")
    if not live:
        print("favori yok; kanal adi verin: python tools/screenshots.py en <kanal>")
        window.destroy()
        return
    js(f"openChannel({json.dumps(live)})")
    wait("state.view === 'channel' && state.vods.length > 0", 40)
    time.sleep(2)

    # gercek VOD'lardan sahte indirme durumu ve gecmis
    js("""(() => {
      const v = state.vods, now = Date.now() / 1000;
      const dl = (i, status, pct, extra) => Object.assign({ id: 100 + i, url: v[i].url, title: cleanTitle(v[i].title), thumb: v[i].thumb,
        status, pct, size: 4.2 * 1024 ** 3, exact: false, speed: status === 'downloading' ? 4.3 * 1024 ** 2 : 0, eta: 900,
        error: '', friendly: false, filename: '', section: null, sections: null, live: false, chat: false, started: 0 }, extra || {});
      window.SHOT_DL = [dl(0, 'queued', 0), dl(1, 'queued', 0), dl(2, 'queued', 0), dl(3, 'downloading', 4), dl(4, 'downloading', 11)].filter((d) => d.url);
      window.SHOT_LIB = v.slice(5, 11).map((x, i) => ({ file: "C:/Videos/" + i + ".mp4", title: x.title, thumb: x.thumb, url: x.url,
        channel: state.channel.slug, size: (1.2 + i * 0.7) * 1024 ** 3, done: now - i * 40000, exists: true,
        section: i === 1 ? [3720, 3780] : null, sections: null, live: false, chat: false }));
      state.api.library = async () => SHOT_LIB;          // Indirilenler ve ana sayfa bu gecmisi gostersin
      window.SHOT_SYNC = window.app.sync;
    })()""")
    print("sahte veri:", js("String(!!window.SHOT_DL && SHOT_DL.length) + '/' + String(!!window.SHOT_LIB && SHOT_LIB.length)"), flush=True)

    # 1 kanal sayfasi (canli serit en ustte)
    js("showView('channel'); $('gridWrap').scrollTop = 0")
    shot("channel")

    # 2 canli serit: onizleme oynasin
    if js("!!$('grid').querySelector('.livecard')"):
        js("hover.start($('grid').querySelector('.livecard'))")
        wait("!!document.querySelector('.livecard video.on')", 20)
        shot("live-strip", 2.5)
        js("hover.stop()")

    # 3 kart onizlemesi: ilk satirdaki ucuncu kart, odakli (Kesit al ve menu dugmesi gorunur)
    js("const g = $('gridWrap'); const c = $('grid').querySelectorAll('.card:not(.livecard)')[2];"
       "g.scrollTop = c.offsetTop - 80; c.focus({ preventScroll: true }); hover.start(c)")
    wait("!!document.querySelector('.card video.on')", 20)
    shot("preview", 2.5)
    reset()

    # 4 izleme penceresi
    js("focusItem(state.vods[1].url)")
    wait("$('player').classList.contains('playing')", 25)
    shot("watch", 2.5)
    reset()

    # 5 secim: dort video secili, liste acik
    js("$('gridWrap').scrollTop = $('grid').querySelector('.card:not(.livecard)').offsetTop - 80;"
       "state.vods.slice(0, 4).forEach((x) => state.selected.add(x.url)); selectionChanged(); toggleSelList()")
    shot("selection")
    reset()

    # 6 kart menusu
    js("const c = $('grid').querySelectorAll('.card:not(.livecard)')[2]; $('gridWrap').scrollTop = c.offsetTop - 80;"
       "setTimeout(() => openCardMenu(c.dataset.url, null, c.querySelector('.more')), 50)")
    shot("card-menu")
    reset()

    # 7 indirme suruyor: kartlarda durum, alt cubuk, baslikta ilerleme
    js("window.app.sync = () => {}; SHOT_SYNC({ downloads: SHOT_DL, liveFavorites: [...state.liveFavs], totalSpeed: 8.9 * 1024 ** 2, free: 165 * 1024 ** 3,"
       " speedLimit: 0, afterDone: 'none' }); $('gridWrap').scrollTop = $('grid').querySelector('.card:not(.livecard)').offsetTop - 160")
    window.set_title(js("t('title.progress', { pct: t('pct', { p: 7 }), speed: '8.9 MB/s'.replace('.', i18n.lang === 'tr' ? ',' : '.'), n: 2, app: t('app.name') })"))
    shot("downloading")

    # 8 Indirilenler: suren indirmeler ve gun gun gecmis
    js("showView('library')")
    shot("downloads", 2.5)
    js("window.app.sync = SHOT_SYNC; SHOT_SYNC({ downloads: [], liveFavorites: [...state.liveFavs], totalSpeed: 0, free: 165 * 1024 ** 3, speedLimit: 0, afterDone: 'none' })")
    window.set_title(js("t('app.name')"))

    # 9 ana sayfa
    js("showView('home')")
    shot("home", 2.5)

    # 10 kesit editoru: uc kesit, serit ve ses dalgasi yuklensin
    js(f"openChannel({json.dumps(live)})")
    wait("state.view === 'channel' && !!state.channel && state.vods.length > 0", 40)
    js("const v = state.vods[1]; state.cuts.set(v.url, [{ id: 901, a: 70, b: 100, name: '', note: '' },"
       " { id: 902, a: 280, b: 310, name: '', note: '' }, { id: 903, a: 500, b: 530, name: '', note: '' }]);"
       " openCutter(v); cut.sel = 903; renderCutter()")
    wait("$('cutVideo').readyState >= 2", 30)
    js("seekTo(310)")
    wait("!!(cut.strip && cut.strip.segs) && $('waveNote').hidden", 90)
    shot("cut-editor", 6)
    js("closeCutter()")

    # 11 kisayollar
    js("showView('home'); $('keysDlg').showModal()")
    shot("shortcuts")
    js("$('keysDlg').close()")

    # 12 ayarlar
    js("showView('settings')")
    shot("settings")
    window.destroy()


app.single_instance = lambda: True             # acik olan uygulama bu kopyayi engellemesin
_start = webview.start
webview.start = lambda **kw: _start(driver, webview.windows[0], **kw)
try:
    app.main()
finally:
    shutil.rmtree(tmp, ignore_errors=True)
