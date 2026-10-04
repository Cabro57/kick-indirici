"""Kick VOD indirici - pywebview arayuzu + yt-dlp motoru.

- Kanal / VOD linki ver -> kanalin tum VOD'lari listelenir, sectiklerin iner.
- Bir VOD'un icinden bir ya da birden fazla kesit secilip yalnizca o araliklar indirilebilir.
- Hiz ayari otomatik: her video parcalari (HLS fragment) N thread ile ceker,
  ayni anda kac video inecegi toplam hiz olculerek kendiliginden ayarlanir.
  Ayarlardan ikisi de elle sabitlenebilir.
- Favori yayincilar: canli mi, son bakistan beri kac yeni VOD var.
- Canli yayin kaydi (beta): yayin su andan itibaren ffmpeg ile kaydedilir.

Arayuz web/ klasorundeki HTML/CSS/JS; Python tarafi js_api ile cagrilir,
durum degisiklikleri app.sync() ile arayuze itilir.
"""

import array
import base64
import calendar
import collections
import http.server
import copy
import ctypes
import hashlib
import itertools
import mimetypes
import secrets
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from xml.sax.saxutils import escape as xml_escape
from concurrent.futures import ThreadPoolExecutor

import webview
import yt_dlp
from curl_cffi import requests as cffi_requests
from yt_dlp.downloader.common import FileDownloader
from yt_dlp.utils import DownloadCancelled

VERSION = "1.0.4"
UPDATE_REPO = "Cabro57/kick-indirici"         # surumler bu GitHub deposunun release'lerinden okunur
QUALITIES = ["En iyi", "1080p60", "720p60", "480p", "360p", "160p"]
# Dosya adi sablonu: kullanici {kanal} {baslik} {tarih} {id} yazar, yt-dlp sablonuna cevrilir.
NAME_DEFAULT = "{kanal} - {baslik} [{id}]"
NAME_TOKENS = {"kanal": "%(channel,uploader|kick)s", "baslik": "%(title).90B",
               "tarih": "%(upload_date>%Y-%m-%d|)s", "id": "%(id).12s"}

CPU = os.cpu_count() or 4
FRAG_THREADS = max(8, min(32, CPU * 2))      # her video icin parca thread sayisi
MAX_PARALLEL = max(2, min(6, CPU // 2))      # otomatik ayarin cikabilecegi ust sinir
ACTIVE_NET = ("preparing", "downloading")
ACTIVE_ALL = ACTIVE_NET + ("merging", "recording")
FRAG_THREADS_MAX = 64

DATA_DIR = os.path.join(os.environ.get("APPDATA", os.path.expanduser("~")), "KickIndirici")
SETTINGS_PATH = os.path.join(DATA_DIR, "settings.json")
LOG_PATH = os.path.join(DATA_DIR, "log.txt")
HISTORY_PATH = os.path.join(DATA_DIR, "history.json")
HISTORY_MAX = 1000
QUEUE_PATH = os.path.join(DATA_DIR, "queue.json")   # bitmemis indirmeler: sonraki acilista geri gelir
DISK_RESERVE = 512 * 1024 * 1024             # indirme sonrasi diskte kalmasi gereken en az bos alan
CHAT_WINDOW = 5                              # sohbet API'si her istekte bu kadar saniyelik mesaj verir
WEBVIEW2_URL = "https://go.microsoft.com/fwlink/p/?LinkId=2124703"
# bozuk kurulumda bootstrapper "zaten kurulu" sanabiliyor; bagimsiz kurucunun oldugu sayfa
WEBVIEW2_PAGE = "https://developer.microsoft.com/microsoft-edge/webview2/#download"
log = logging.getLogger("kick")


def app_dir():
    return os.path.dirname(sys.executable if getattr(sys, "frozen", False) else os.path.abspath(__file__))


def resource_dir():
    return getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))


def find_ffmpeg():
    local = os.path.join(app_dir(), "ffmpeg.exe")
    if os.path.exists(local):
        return local
    return shutil.which("ffmpeg")


def load_settings():
    try:
        with open(SETTINGS_PATH, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_settings(data):
    try:
        os.makedirs(os.path.dirname(SETTINGS_PATH), exist_ok=True)
        with open(SETTINGS_PATH, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
    except OSError:
        pass


# ---------- Kick API ----------
def kick_get(url):
    r = cffi_requests.get(url, impersonate="chrome", timeout=20)
    if r.status_code == 404:
        raise LookupError("Kanal ya da video bulunamadi.")
    r.raise_for_status()
    return r.json()


def parse_link(text):
    """Linkten (kanal_slug, vod_uuid, klip_mi) cikarir."""
    text = text.strip()
    if re.search(r"/clips?/|[?&]clip=", text):
        return None, None, True
    m = re.search(r"kick\.com/video/([0-9a-f-]{36})", text)
    if m:
        return None, m.group(1), False
    m = re.search(r"kick\.com/([A-Za-z0-9_-]+)(?:/videos/([0-9a-f-]{36}))?", text)
    if m:
        return m.group(1).lower(), m.group(2), False
    if re.fullmatch(r"[A-Za-z0-9_-]+", text):   # sadece kanal adi yazildiysa
        return text.lower(), None, False
    return None, None, False


def kick_error(e):
    if isinstance(e, LookupError):
        return str(e).replace("bulunamadi", "bulunamadı")
    return f"Kick'e ulaşılamadı. İnternet bağlantını kontrol edip tekrar dene. ({str(e)[:120]})"


def vod_channel(uuid):
    return kick_get(f"https://kick.com/api/v1/video/{uuid}")["livestream"]["channel"]["slug"]


def live_info(ch):
    """Kanal su an canliysa yayin bilgisi, degilse None. (playback_url kapaliyken de dolu gelir.)"""
    ls = ch.get("livestream")
    if not ls or not ls.get("is_live") or not ch.get("playback_url"):
        return None
    return {
        "title": ls.get("session_title") or "",
        "viewers": ls.get("viewer_count") or 0,
        "start": ls.get("start_time") or ls.get("created_at") or "",
        "thumb": (ls.get("thumbnail") or {}).get("url") or "",
        "category": ((ls.get("categories") or [{}])[0] or {}).get("name", ""),
        "source": ch.get("playback_url") or "",     # HLS: arayuzdeki canli oynatici
    }


def hls_variants(master_url):
    """Ana HLS listesindeki surumler. name: '1080p60' gibi (cozunurluk + kare hizi)."""
    master = cffi_requests.get(master_url, impersonate="chrome", timeout=20).text
    out, inf = [], None
    for line in master.splitlines():
        line = line.strip()
        if line.startswith("#EXT-X-STREAM-INF"):
            inf = line
        elif line and not line.startswith("#") and inf is not None:
            bw = re.search(r"BANDWIDTH=(\d+)", inf)
            res = re.search(r"RESOLUTION=\d+x(\d+)", inf)
            fps = re.search(r"FRAME-RATE=([\d.]+)", inf)
            name = f"{res.group(1)}p{round(float(fps.group(1))) if fps else ''}" if res else ""
            out.append({"name": name, "bw": int(bw.group(1)) if bw else 0, "video": bool(res),
                        "url": urllib.parse.urljoin(master_url, line)})
            inf = None
    return out


def live_variant(master_url, quality):
    """Canli kayit icin secilen kalitenin medya listesi; yoksa en iyisi.
    ffmpeg'e ana liste verilirse tum surumleri birden ceker, o yuzden tek surum secilir."""
    video = [v for v in hls_variants(master_url) if v["video"]]
    if not video:
        return master_url
    match = [v for v in video if quality != QUALITIES[0] and v["name"].startswith(quality)]
    return max(match or video, key=lambda v: v["bw"])["url"]


def fetch_channel(slug):
    ch = kick_get(f"https://kick.com/api/v2/channels/{slug}")
    user = ch.get("user") or {}
    vods = []
    for v in kick_get(f"https://kick.com/api/v2/channels/{slug}/videos"):
        video = v.get("video") or {}
        if not video.get("uuid"):
            continue
        vods.append({
            "url": f"https://kick.com/{slug}/videos/{video['uuid']}",
            "uuid": video["uuid"],
            "title": v.get("session_title") or video["uuid"],
            "start": v.get("start_time") or v.get("created_at") or "",
            "duration": round((v.get("duration") or 0) / 1000),
            "views": video.get("views") or v.get("views") or 0,
            "thumb": (v.get("thumbnail") or {}).get("src") or "",
            "category": ((v.get("categories") or [{}])[0] or {}).get("name", ""),
            # API'nin verdigi tum kategoriler (zaman bilgisi yok)
            "categories": [c["name"] for c in v.get("categories") or [] if c and c.get("name")],
            "live": bool(v.get("is_live")),     # suren yayin da listede gelir
            "source": v.get("source") or "",     # HLS ana listesi: kart uzerinde onizleme / oynatici
        })
    return {
        "id": ch.get("id"),
        "slug": slug,
        "name": user.get("username") or slug,
        "avatar": user.get("profile_pic") or "",
        "followers": ch.get("followers_count") or 0,
        "verified": bool(ch.get("verified")),
        "live": live_info(ch),
    }, vods


def fetch_clips(slug, sort="date", cursor=None):
    """Kanalin kliplerinden bir sayfa (20 adet) ve sonraki sayfanin cursor'u."""
    url = f"https://kick.com/api/v2/channels/{slug}/clips"
    params = ["sort=view", "time=all"] if sort == "view" else []
    if cursor:
        params.append("cursor=" + urllib.parse.quote(cursor))
    if params:
        url += "?" + "&".join(params)
    data = kick_get(url)
    clips = []
    for c in data.get("clips") or []:
        clips.append({
            "url": f"https://kick.com/{slug}/clips/{c['id']}",
            "uuid": c["id"],
            "title": c.get("title") or c["id"],
            "start": c.get("created_at") or "",
            "duration": c.get("duration") or 0,
            "views": c.get("views") or c.get("view_count") or 0,
            "thumb": c.get("thumbnail_url") or "",
            "category": (c.get("category") or {}).get("name", ""),
            "creator": (c.get("creator") or {}).get("username", ""),
            "source": c.get("video_url") or c.get("clip_url") or "",   # HLS: onizleme / oynatici
        })
    return clips, data.get("nextCursor")


def fmt_hms(sec, sep="."):
    sec = int(sec)
    return f"{sec // 3600:02d}{sep}{sec % 3600 // 60:02d}{sep}{sec % 60:02d}"


def trim_playlist(text, start, end):
    """HLS medya listesinden yalnizca [start, end] araligina degen parcalari birakir.

    Dondurur: (yeni liste, ilk parcanin basindan kesit basina kadar saniye).
    """
    header, segments, tags, t = [], [], [], 0.0
    for line in text.splitlines():
        line = line.strip()
        if not line or line == "#EXT-X-ENDLIST":
            continue
        if not line.startswith("#"):
            dur = next((float(x[8:].split(",")[0]) for x in tags if x.startswith("#EXTINF:")), 0.0)
            segments.append((t, t + dur, tags + [line]))
            t += dur
            tags = []
        elif segments or tags or line.startswith(("#EXTINF", "#EXT-X-PROGRAM-DATE-TIME", "#EXT-X-DISCONTINUITY")):
            tags.append(line)
        else:
            header.append(line)
    keep = [seg for seg in segments if seg[1] > start and seg[0] < end]
    if not keep:
        raise ValueError("Seçilen aralık yayının süresi dışında.")
    header = [h for h in header if not h.startswith("#EXT-X-PLAYLIST-TYPE")]
    body = [line for seg in keep for line in seg[2]]
    return "\n".join(header + ["#EXT-X-PLAYLIST-TYPE:VOD"] + body + ["#EXT-X-ENDLIST"]) + "\n", start - keep[0][0]


def fmt_size(n):
    return f"{n / 1024 ** 3:.1f} GB".replace(".", ",") if n >= 1024 ** 3 else f"{n / 1024 ** 2:.0f} MB"


def fill_name(template, kanal, baslik, tarih, vid):
    """Dosya adi sablonunu yt-dlp olmadan doldurur (canli kayit, sohbet)."""
    name = template
    for key, value in (("kanal", kanal), ("baslik", baslik[:70]), ("tarih", tarih), ("id", vid)):
        name = name.replace("{" + key + "}", value)
    return re.sub(r'[\\/:*?"<>|\r\n]+', "_", name).strip()


def free_space(folder):
    """Klasorun bulundugu diskteki bos alan (bayt). Klasor henuz yoksa var olan ilk ust klasore bakar."""
    path = os.path.abspath(folder)
    while not os.path.exists(path) and os.path.dirname(path) != path:
        path = os.path.dirname(path)
    try:
        return shutil.disk_usage(path).free
    except OSError:
        return None


def clipboard_text():
    """Panodaki metin (Win32, ek kutuphane yok); metin yoksa ya da pano mesgulse ""."""
    user32, kernel32 = ctypes.windll.user32, ctypes.windll.kernel32
    user32.GetClipboardData.restype = ctypes.c_void_p
    kernel32.GlobalLock.argtypes = [ctypes.c_void_p]
    kernel32.GlobalLock.restype = ctypes.c_void_p
    kernel32.GlobalUnlock.argtypes = [ctypes.c_void_p]
    if not user32.OpenClipboard(None):
        return ""
    try:
        handle = user32.GetClipboardData(13)      # CF_UNICODETEXT
        if not handle:
            return ""
        ptr = kernel32.GlobalLock(handle)
        if not ptr:
            return ""
        try:
            return ctypes.wstring_at(ptr)[:2000]
        finally:
            kernel32.GlobalUnlock(handle)
    finally:
        user32.CloseClipboard()


def kick_time(text):
    """Kick'in tarih metni ('2026-10-03 20:36:38', '...T20:36:38Z', '+00:00') -> epoch sn (UTC)."""
    m = re.match(r"(\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d):(\d\d)", text or "")
    if not m:
        raise ValueError(f"tarih anlaşılamadı: {text!r}")
    return calendar.timegm(tuple(int(x) for x in m.groups()) + (0, 0, 0))


def playlist_duration(master_url):
    """VOD suresi API'de yoksa (yayin yeni bittiyse 0 gelir) en dusuk surumun parca sureleri toplami."""
    variants = hls_variants(master_url)
    url = min(variants, key=lambda x: x["bw"] or 1 << 40)["url"] if variants else master_url
    text = cffi_requests.get(url, impersonate="chrome", timeout=20).text
    return sum(float(x[8:].split(",")[0]) for x in text.splitlines() if x.startswith("#EXTINF:"))


def chat_window(channel_id, start, tries=3):
    """Sohbetin [start, start + CHAT_WINDOW) araligindaki mesajlari (Kick'in tekrar oynatma API'si)."""
    stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(start))
    for i in range(tries):
        try:
            data = kick_get(f"https://kick.com/api/v2/channels/{channel_id}/messages?start_time={stamp}")
            return (data.get("data") or {}).get("messages") or []
        except Exception:  # noqa: BLE001 - gecici ag hatasi: biraz bekleyip tekrar
            if i == tries - 1:
                raise
            time.sleep(1 + i)
    return []


def chat_entry(m, vod_start):
    """API mesajindan sade kayit: t (yayin basindan sn), kullanici, renk, metin."""
    sender = m.get("sender") or {}
    text = re.sub(r"\[emote:\d+:([^\]]*)\]", r"\1", m.get("content") or "")
    return {"t": round(kick_time(m.get("created_at")) - vod_start, 1), "user": sender.get("username") or "?",
            "color": (sender.get("identity") or {}).get("color") or "#FFFFFF",
            "text": re.sub(r"\s+", " ", text).strip(), "id": m.get("id")}


def ass_time(sec):
    sec = max(0.0, sec)
    return f"{int(sec // 3600)}:{int(sec % 3600 // 60):02d}:{sec % 60:05.2f}"


def chat_ass(messages, lines=10, hold=10):
    """Sohbet altyazisi: her mesajda sol ustteki kutu son `lines` mesaji gosterir; sonraki mesaja
    (en fazla `hold` sn) kadar ekranda kalir. Oynatici videoyla ayni adli .ass dosyasini kendisi acar."""
    def esc(s):
        return s.replace("\\", "∖").replace("{", "(").replace("}", ")")

    def color(hexcode):
        h = hexcode.lstrip("#")
        return f"&H{h[4:6]}{h[2:4]}{h[0:2]}&" if re.fullmatch(r"[0-9A-Fa-f]{6}", h) else "&HFFFFFF&"

    out = ["[Script Info]", "ScriptType: v4.00+", "PlayResX: 1920", "PlayResY: 1080", "WrapStyle: 0", "",
           "[V4+ Styles]",
           "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, "
           "Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, "
           "MarginR, MarginV, Encoding",
           "Style: Chat,Segoe UI,30,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,0,7,24,1380,24,1",
           "", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text"]
    shown = collections.deque(maxlen=lines)
    for i, m in enumerate(messages):
        shown.append(f"{{\\c{color(m['color'])}\\b1}}{esc(m['user'])}{{\\c&HFFFFFF&\\b0}}: {esc(m['text'][:200])}")
        end = min(messages[i + 1]["t"], m["t"] + hold) if i + 1 < len(messages) else m["t"] + hold
        if end > m["t"]:
            text = "\\N".join(shown)
            out.append(f"Dialogue: 0,{ass_time(m['t'])},{ass_time(end)},Chat,,0,0,0,,{text}")
    return "\n".join(out) + "\n"


class MediaStrip:
    """Kesit secicinin zaman cizelgesi icin bir yayinin kare seridi ve ses dalgasi.

    Yayinin en dusuk kaliteli (160p) parca listesini kullanir: her 10 sn'lik parca bir kez
    indirilir, ffmpeg ondan 2 sn aralikli kucuk kareler ve saniyede 20 ses tepe degeri cikarir.
    Sonuclar bellekte tutulur; ayni parca ikinci kez islenmez.

    thumb(): uzak gorunumde parcanin yalnizca basini (THUMB_BYTES) Range ile ceker ve ilk
    kareyi cikarir. Parcalar anahtar kareyle basladigi icin kare hep cikar.
    """

    PEAKS_PER_SEC = 20
    FRAME_EVERY = 2
    THUMB_BYTES = 32768

    def __init__(self, uuid, ffmpeg):
        self.ffmpeg = ffmpeg
        v = kick_get(f"https://kick.com/api/v1/video/{uuid}")
        master_url = v["source"]
        # en dusuk GORUNTULU surum: bazi yayinlarda listede daha dusuk bant genislikli,
        # goruntusuz "audio_only" surumu de var; onu secersek hic kare cikmaz
        variants = hls_variants(master_url)
        variants = [x for x in variants if x["video"]] or variants
        self.media_url = min(variants, key=lambda x: x["bw"] or 1 << 40)["url"] if variants else master_url
        log.info("serit kaynagi: %s", self.media_url)
        self.cache = {}
        self.thumbs = {}
        self.lock = threading.Lock()
        self.refresh()

    def refresh(self):
        """Parca listesini yeniden okur. Suren yayinda liste yalnizca sondan uzar: eski parcalarin
        sirasi, dolayisiyla onbellek gecerli kalir."""
        playlist = cffi_requests.get(self.media_url, impersonate="chrome", timeout=20).text
        segments, t, dur = [], 0.0, 0.0     # (baslangic, sure, adres)
        for line in playlist.splitlines():
            line = line.strip()
            if line.startswith("#EXTINF:"):
                dur = float(line[8:].split(",")[0])
            elif line and not line.startswith("#"):
                segments.append((t, dur, urllib.parse.urljoin(self.media_url, line)))
                t += dur
        self.segments = segments

    def index(self):
        return [[round(a, 3), round(d, 3)] for a, d, _ in self.segments]

    def get(self, i):
        with self.lock:
            if i in self.cache:
                return self.cache[i]
        out = self._process(i)
        if out["frames"] or out["peaks"]:      # bos sonucu saklama: ag hatasiysa sonra tekrar denensin
            with self.lock:
                self.cache[i] = out
        return out

    def thumb(self, i):
        """Parcanin ilk karesi (data URL); alinamazsa ""."""
        with self.lock:
            if i in self.cache and self.cache[i]["frames"]:
                return self.cache[i]["frames"][0]
            if i in self.thumbs:
                return self.thumbs[i]
        work = tempfile.mkdtemp(prefix="kickthumb-")
        try:
            r = cffi_requests.get(self.segments[i][2], impersonate="chrome", timeout=30,
                                  headers={"Range": f"bytes=0-{self.THUMB_BYTES - 1}"})
            r.raise_for_status()
            src, jpg = os.path.join(work, "p.ts"), os.path.join(work, "f.jpg")
            with open(src, "wb") as f:
                f.write(r.content)
            subprocess.run([self.ffmpeg, "-nostdin", "-v", "error", "-y", "-i", src, "-map", "0:v:0", "-frames:v", "1",
                            "-vf", "scale=-2:88", "-q:v", "7", jpg],
                           stdin=subprocess.DEVNULL, capture_output=True, timeout=30,
                           creationflags=subprocess.CREATE_NO_WINDOW)
            if not os.path.exists(jpg):
                return ""
            with open(jpg, "rb") as f:
                out = "data:image/jpeg;base64," + base64.b64encode(f.read()).decode()
            with self.lock:
                self.thumbs[i] = out
            return out
        except Exception as e:  # noqa: BLE001 - kare yoksa tam parca gelince dolar
            log.info("serit karesi %s alinamadi: %s", i, e)
            return ""
        finally:
            shutil.rmtree(work, ignore_errors=True)

    def _process(self, i):
        _, dur, url = self.segments[i]
        work = tempfile.mkdtemp(prefix="kickstrip-")
        try:
            r = cffi_requests.get(url, impersonate="chrome", timeout=30)
            r.raise_for_status()
            src = os.path.join(work, "p.ts")
            with open(src, "wb") as f:
                f.write(r.content)
            raw = os.path.join(work, "a.raw")
            audio = ["-map", "0:a:0?", "-ac", "1", "-ar", "2000", "-f", "s16le", raw]
            video = ["-map", "0:v:0?", "-vf", f"fps=1/{self.FRAME_EVERY},scale=-2:88", "-q:v", "7",
                     "-f", "image2", os.path.join(work, "f%02d.jpg")]
            run = lambda outs: subprocess.run(   # noqa: E731
                [self.ffmpeg, "-nostdin", "-v", "error", "-y", "-i", src, *outs],
                stdin=subprocess.DEVNULL, capture_output=True, timeout=60,
                creationflags=subprocess.CREATE_NO_WINDOW)
            proc = run(audio + video)
            if proc.returncode != 0:      # parcada goruntu (ya da ses) yoksa ffmpeg hepsini birakir: ayri dene
                run(audio)
                proc = run(video)
            peaks = []
            if os.path.exists(raw):
                samples = array.array("h")
                with open(raw, "rb") as f:
                    samples.frombytes(f.read())
                step = 2000 // self.PEAKS_PER_SEC
                for k in range(0, len(samples), step):
                    chunk = samples[k:k + step]
                    peak = max(max(chunk), -min(chunk)) / 32768
                    peaks.append(min(255, int(peak ** 0.6 * 255)))   # sessiz kisimlar da okunsun
            frames = []
            for name in sorted(n for n in os.listdir(work) if n.endswith(".jpg")):
                with open(os.path.join(work, name), "rb") as f:
                    frames.append("data:image/jpeg;base64," + base64.b64encode(f.read()).decode())
            if not frames or not peaks:
                log.info("serit parcasi %s: %d kare, %d ses degeri, %d bayt, ffmpeg=%s cikis %s: %s",
                         i, len(frames), len(peaks), len(r.content), self.ffmpeg, proc.returncode,
                         proc.stderr.decode("utf-8", "ignore").strip()[-300:])
            return {"peaks": peaks, "frames": frames, "dur": dur}
        except Exception as e:  # noqa: BLE001 - tek parca bozuksa cizelgede bos kalir
            log.info("serit parcasi %s alinamadi: %s", i, e)
            return {"peaks": [], "frames": [], "dur": dur, "failed": True}
        finally:
            shutil.rmtree(work, ignore_errors=True)


class AutoTuner:
    """Ayni anda kac video inecegini toplam hiza bakarak ayarlar (hill climbing).

    1 videoyla baslar. Yeni video eklemek toplam hizi %15+ arttiriyorsa bir tane daha
    acar; artirmiyorsa baglanti doymus demektir, bir geri cekilir. 90 sn'de bir yeniden dener.
    """

    def __init__(self):
        self.level = 1
        self.best_speed = 0.0
        self.changed_at = time.monotonic()
        self.saturated_at = None
        self.samples = collections.deque(maxlen=5)

    def step(self, total_speed, active, has_pending):
        now = time.monotonic()
        if active == 0:
            self._reset_window(now)
            return
        if now - self.changed_at >= 5:     # ilk 5 sn isinma, olcmeye katma
            self.samples.append(total_speed)
        if not has_pending:
            return
        if self.saturated_at and now - self.saturated_at > 90:
            self.saturated_at = None
            self.best_speed = 0.0
        if self.saturated_at or active < self.level or len(self.samples) < 5:
            return
        speed = sum(self.samples) / len(self.samples)
        if speed > self.best_speed * 1.15 and self.level < MAX_PARALLEL:
            self.best_speed = speed
            self.level += 1
        elif speed <= self.best_speed * 1.15:
            self.level = max(1, self.level - 1)
            self.saturated_at = now
        self._reset_window(now)

    def _reset_window(self, now):
        self.changed_at = now
        self.samples.clear()


class RateLimiter:
    """Tum indirmelerin toplam hizina ortak ust sinir (bayt/sn; 0 = sinirsiz).

    yt-dlp'nin kendi 'ratelimit'i her parca indiricisine ayri uygulanir; parca thread'leri ve paralel
    videolarla carpilir. Bunun yerine FileDownloader.slow_down tum thread'lerin ortak sayacina baglanir.
    """

    BURST = 0.5     # bosta kalinca biriktirilebilecek sure (sn)

    def __init__(self):
        self.rate = 0
        self.lock = threading.Lock()
        self.clock = 0.0             # sanal saat: o ana kadar gecen baytlarin sinirla "bitecegi" an
        self.local = threading.local()

    def consume(self, n):
        rate = self.rate
        if not rate or n <= 0:
            return
        with self.lock:
            now = time.monotonic()
            self.clock = max(self.clock, now - self.BURST) + n / rate
            wait = self.clock - now
        if wait > 0:
            time.sleep(wait)


LIMITER = RateLimiter()


def _slow_down(self, start_time, now, byte_counter):
    # byte_counter bu indirme dongusunun toplami; thread basina son degerden farki harcanir
    loc = LIMITER.local
    if getattr(loc, "start", None) != start_time:
        loc.start, loc.count = start_time, 0
    LIMITER.consume(byte_counter - loc.count)
    loc.count = byte_counter


FileDownloader.slow_down = _slow_down


class Download:
    _ids = itertools.count(1)

    def __init__(self, url, title, thumb, section=None, live=False, sections=None, chat=False):
        self.id = next(self._ids)
        self.url = url
        self.sections = sections        # birden fazla kesit tek videoda: [(bas, son), ...] ya da None
        if sections:
            section = (sections[0][0], sections[-1][1])
        self.section = section          # (baslangic_sn, bitis_sn) ya da None = tum video
        self.live = live                # canli yayin kaydi (beta)
        self.chat = chat                # yalnizca VOD'un sohbet kaydi (.json + .ass)
        self.duration = 0               # sohbet: arayuzden gelen VOD suresi (sn), yoksa API'den
        self.key = url + ("#live" if live else "#chat" if chat else
                          "#" + ",".join(f"{a}-{b}" for a, b in sections) if sections
                          else f"#{section[0]}-{section[1]}" if section else "")
        self.started = None             # canli kaydin basladigi an (epoch sn)
        self.proc = None                # canli kaydi yapan ffmpeg
        self.title = title
        self.thumb = thumb
        self.status = "queued"
        self.pct = 0.0
        self.size = 0
        self.speed = 0.0
        self.eta = None
        self.error = ""
        self.filename = ""
        self.exact = False
        self.cancel = False
        # klip: az parcali, sabit hazirlik/birlestirme payi yuksek
        self.short = bool(re.search(r"/clips?/|[?&]clip=", url))

    def to_dict(self):
        return {k: getattr(self, k) for k in
                ("id", "url", "section", "sections", "live", "chat", "started", "title", "thumb", "status", "pct", "size",
                 "exact", "speed", "eta", "error", "filename")}

    def to_saved(self):
        """queue.json kaydi: sonraki acilista ayni indirme yeniden kurulur (.part'tan devam eder)."""
        return {"url": self.url, "title": self.title, "thumb": self.thumb, "chat": self.chat,
                "duration": self.duration, "section": list(self.section) if self.section and not self.sections else None,
                "sections": [list(x) for x in self.sections] if self.sections else None}


def load_queue():
    try:
        with open(QUEUE_PATH, encoding="utf-8") as f:
            data = json.load(f)
        return [e for e in data if isinstance(e, dict) and e.get("url")]
    except (OSError, ValueError):
        return []


def save_queue(items):
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        tmp = QUEUE_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(items, f, ensure_ascii=False)
        os.replace(tmp, QUEUE_PATH)
    except OSError as e:
        log.info("kuyruk yazilamadi: %s", e)


def load_history():
    try:
        with open(HISTORY_PATH, encoding="utf-8") as f:
            data = json.load(f)
        return [e for e in data if isinstance(e, dict) and e.get("file")]
    except (OSError, ValueError):
        return []


def save_history(items):
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        tmp = HISTORY_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(items, f, ensure_ascii=False)
        os.replace(tmp, HISTORY_PATH)
    except OSError as e:
        log.info("gecmis yazilamadi: %s", e)


def recycle(path):
    """Dosyayi Geri Donusum Kutusu'na tasir (kalici silmez). Basarili mi."""
    class SHFILEOPSTRUCTW(ctypes.Structure):
        _fields_ = [("hwnd", ctypes.c_void_p), ("wFunc", ctypes.c_uint), ("pFrom", ctypes.c_wchar_p),
                    ("pTo", ctypes.c_wchar_p), ("fFlags", ctypes.c_ushort), ("fAnyOperationsAborted", ctypes.c_int),
                    ("hNameMappings", ctypes.c_void_p), ("lpszProgressTitle", ctypes.c_wchar_p)]
    FO_DELETE, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_SILENT, FOF_NOERRORUI = 3, 0x40, 0x10, 0x4, 0x400
    op = SHFILEOPSTRUCTW(None, FO_DELETE, os.path.abspath(path) + "\0", None,
                         FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI, 0, None, None)
    return ctypes.windll.shell32.SHFileOperationW(ctypes.byref(op)) == 0 and not os.path.exists(path)


class MediaServer:
    """Indirilen dosyalari uygulamanin icindeki oynaticiya 127.0.0.1 uzerinden verir.
    Yalnizca kayitli dosyalar, tahmin edilemeyen bir anahtarla; Range destekli (ileri sarma)."""

    def __init__(self):
        self.files = {}         # anahtar -> dosya yolu
        self.lock = threading.Lock()
        files, lock = self.files, self.lock

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                with lock:
                    path = files.get(self.path.rsplit("/", 1)[-1])
                if not path or not os.path.isfile(path):
                    self.send_error(404)
                    return
                size = os.path.getsize(path)
                start, end = 0, size - 1
                m = re.match(r"bytes=(\d*)-(\d*)", self.headers.get("Range", ""))
                if m and (m.group(1) or m.group(2)):
                    if m.group(1):
                        start = int(m.group(1))
                        end = min(int(m.group(2)), size - 1) if m.group(2) else size - 1
                    else:
                        start = max(0, size - int(m.group(2)))
                    if start > end:
                        self.send_response(416)
                        self.send_header("Content-Range", f"bytes */{size}")
                        self.end_headers()
                        return
                    self.send_response(206)
                    self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
                else:
                    self.send_response(200)
                kind = mimetypes.guess_type(path)[0] or "application/octet-stream"
                self.send_header("Content-Type", "video/mp2t" if path.lower().endswith(".ts") else kind)
                self.send_header("Accept-Ranges", "bytes")
                self.send_header("Content-Length", str(end - start + 1))
                self.end_headers()
                try:
                    with open(path, "rb") as f:
                        f.seek(start)
                        left = end - start + 1
                        while left > 0:
                            chunk = f.read(min(1 << 20, left))
                            if not chunk:
                                break
                            self.wfile.write(chunk)
                            left -= len(chunk)
                except (ConnectionError, OSError):
                    pass        # oynatici istegi yarida birakti (ileri sarma)

        self.httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.httpd.daemon_threads = True
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def url(self, path):
        with self.lock:
            key = next((k for k, v in self.files.items() if v == path), None) or secrets.token_urlsafe(16)
            self.files[key] = path
        return f"http://127.0.0.1:{self.httpd.server_address[1]}/m/{key}"


def int_or_auto(value, lo, hi):
    return value if type(value) is int and lo <= value <= hi else "auto"


def valid_name(value):
    """Dosya adi sablonu gecerliyse kendisi, degilse None. {baslik} ya da {id} sart: yoksa
    her indirme ayni adi alir ve birbirinin ustune yazar."""
    if not isinstance(value, str) or not value.strip() or len(value) > 120:
        return None
    value = value.strip()
    if re.search(r'[\\/:*?"<>|{}]', re.sub(r"\{[a-z]+\}", "", value)):
        return None
    if any(t not in NAME_TOKENS for t in re.findall(r"\{([a-z]+)\}", value)):
        return None
    return value if "{baslik}" in value or "{id}" in value else None


def flag(value):
    return value if isinstance(value, bool) else None


def ranged(lo, hi):
    return lambda v: v if type(v) is int and lo <= v <= hi else None


# Kullanici tercihleri: ad -> (varsayilan, dogrulayici). Dogrulayici gecersizde None doner,
# o zaman eski deger kalir. Arayuz bunlari get_settings / set_settings ile okur ve yazar.
PREFS = {
    "hoverPreview": (True, flag),            # kartin uzerine gelince onizleme oynasin
    "previewMuted": (False, flag),           # incelemedeki oynatici sessiz baslasin (karttaki onizleme hep sessiz)
    "volume": (50, ranged(0, 100)),          # oynatici ses seviyesi
    "nameTemplate": (NAME_DEFAULT, valid_name),
    "notifyDone": (True, flag),              # kuyruk bitince Windows bildirimi
    "notifyLive": (True, flag),              # favori yayinci canliya gecince Windows bildirimi
    "sectionLength": ("auto", lambda v: v if v == "auto" or (type(v) is int and 5 <= v <= 600) else None),
    "liveRemux": (True, flag),               # canli kayit bitince .ts -> .mp4
    "speedLimit": (0, ranged(0, 1000)),      # toplam indirme hizi siniri, MB/s (0 = sinirsiz)
    "clipboardWatch": (True, flag),          # pencereye donunce panodaki Kick linkini oner
    "updateCheck": (True, flag),             # acilista yeni surum var mi bak
}
AFTER_DONE = ("none", "sleep", "shutdown")   # kuyruk bitince: hicbir sey / uyku / bilgisayari kapat
LIVE_POLL = 120                              # favorilerin canli durumunu kontrol araligi (sn)


def out_template(name, section, count=1):
    """Kullanici sablonundan yt-dlp sablonu. Kesitte sona kesit saatleri eklenir; birlesik
    videoda kesit sayisi da."""
    t = name.replace("%", "%%")
    for key, value in NAME_TOKENS.items():
        if key == "baslik" and section:
            value = value.replace(".90B", ".70B")
        t = t.replace("{" + key + "}", value)
    if section:
        t += (f" {count} kesit" if count > 1 else "") + f" {fmt_hms(section[0])}-{fmt_hms(section[1])}"
    return t + ".%(ext)s"


TOAST_APP_ID = "Cabro57.KickIndirici"


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


class Api:
    """JS tarafinin cagirdigi metotlar. '_' ile baslayan ozellikler JS'e acilmaz."""

    def __init__(self):
        s = load_settings()
        self._folder = s.get("folder") or os.path.join(os.path.expanduser("~"), "Downloads", "Kick")
        self._quality = s.get("quality") if s.get("quality") in QUALITIES else QUALITIES[0]
        self._parallel = int_or_auto(s.get("parallel"), 1, MAX_PARALLEL)
        self._threads = int_or_auto(s.get("fragThreads"), 1, FRAG_THREADS_MAX)
        self._prefs = {}
        for key, (default, check) in PREFS.items():
            value = check(s[key]) if key in s else None
            self._prefs[key] = default if value is None else value
        # favori: {"slug", "name", "avatar", "seen": en son gorulen VOD'un baslangic zamani}
        self._favorites = [f for f in s.get("favorites") or [] if isinstance(f, dict) and f.get("slug")]
        self._fav_lock = threading.Lock()
        self._ffmpeg = find_ffmpeg()
        self._downloads = {}
        self._lock = threading.Lock()
        self._tuner = AutoTuner()
        self._window = None
        self._ready = False
        self._last_push = ""
        self._strips = {}
        # ilk kareler (strip_thumbs) 32'li gruplar halinde gelir; CDN gecikmesi belirleyici oldugundan
        # cok paralel istek: 8 -> 32 is parcacigi ilk karelerde 17-21 -> 50-65 parca/sn (PERF.md)
        self._strip_pool = ThreadPoolExecutor(max_workers=32)
        self._closing = False
        self._dirty = threading.Event()
        self._force = False
        self._live_favs = set()         # su an canli olan favoriler (sync ile arayuze gider)
        self._history = load_history()  # Indirilenler: biten her dosya, liste temizlense de kalir
        self._media = None              # MediaServer; ilk oynatmada acilir
        LIMITER.rate = self._prefs["speedLimit"] * 1024 * 1024
        self._after = "none"            # kuyruk bitince yapilacak (AFTER_DONE); her seferinde sifirlanir
        self._shutdown_at = None        # kapatma komutu verildiyse zamani (iptal edilebilir)
        self._free = (0.0, None)        # (olcum zamani, bos alan): sync'te diskteki bos yer
        self._auto_started = {}         # otomatik kayit: kanal -> kaydi baslatilan yayinin baslangici
        self._live_wake = threading.Event()   # favori ayari degisince canli kontrolunu hemen yaptirir
        self._restored = 0              # onceki oturumdan geri gelen indirme sayisi
        for e in load_queue():
            try:
                d = Download(e["url"], e.get("title") or e["url"], e.get("thumb") or "",
                             tuple(e["section"]) if e.get("section") else None,
                             sections=[tuple(x) for x in e["sections"]] if e.get("sections") else None,
                             chat=bool(e.get("chat")))
            except (TypeError, ValueError, IndexError):
                continue
            d.duration = e.get("duration") or 0
            d.status = "stopped"            # kendiliginden baslamaz; kullanici "devam" der
            self._downloads[d.id] = d
            self._restored += 1
        self._saved_queue = None
        threading.Thread(target=self._scheduler, daemon=True).start()
        threading.Thread(target=self._pusher, daemon=True).start()
        threading.Thread(target=self._watch_live, daemon=True).start()

    # ---------- JS'e acik ----------
    def init(self):
        self._ready = True
        return {"folder": self._folder, "quality": self._quality, "qualities": QUALITIES,
                "ffmpeg": bool(self._ffmpeg), "fragThreads": self._frag_threads(), "maxParallel": MAX_PARALLEL,
                "settings": self.get_settings(), "favorites": self.favorites(), "version": VERSION,
                "restored": self._restored}

    # ---------- kullanim kolayliklari ----------
    def clipboard_link(self):
        """Panoda Kick linki varsa o link, yoksa "". Arayuz pencere odaga gelince sorar."""
        try:
            text = clipboard_text()
        except Exception as e:  # noqa: BLE001 - pano baska programda kilitli olabilir
            log.info("pano okunamadi: %s", e)
            return ""
        m = re.search(r"(?:https?://)?(?:www\.)?kick\.com/[^\s\"'<>]+", text)
        return m.group(0) if m else ""

    def resume_all(self):
        """Durmus ve hatali indirmelerin hepsini yeniden kuyruga alir (or. onceki oturumdan gelenler)."""
        for d in list(self._downloads.values()):
            if d.status in ("stopped", "error") and not d.live:
                d.cancel, d.error, d.status = False, "", "queued"
        self._push(force=True)

    def set_after_done(self, mode):
        """Kuyruk bitince: "none" | "sleep" | "shutdown". Tek seferlik; is bitince "none"a doner."""
        if mode in AFTER_DONE:
            self._after = mode
        self._push(force=True)
        return self._after

    def cancel_shutdown(self):
        """Verilmis kapatma komutunu geri alir (Windows 60 sn bekler)."""
        if self._shutdown_at:
            subprocess.run(["shutdown", "/a"], capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW)
            self._shutdown_at = None
        self._push(force=True)

    def check_update(self):
        """GitHub'daki son surum bundan yeniyse {"update": True, "version", "url", "notes"}."""
        # curl_cffi'nin Chrome taklidi GitHub API'sinde baglantiyi kopariyor; duz urllib yeterli
        req = urllib.request.Request(f"https://api.github.com/repos/{UPDATE_REPO}/releases/latest",
                                     headers={"Accept": "application/vnd.github+json", "User-Agent": f"KickIndirici/{VERSION}"})
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                rel = json.load(r)
        except urllib.error.HTTPError as e:
            if e.code == 404:                 # henuz surum yayinlanmamis
                return {"ok": True, "update": False, "current": VERSION}
            log.info("guncelleme kontrolu: %s", e)
            return {"ok": False, "update": False, "current": VERSION}
        except Exception as e:  # noqa: BLE001 - guncelleme kontrolu hicbir seyi durdurmaz
            log.info("guncelleme kontrolu: %s", e)
            return {"ok": False, "update": False, "current": VERSION}
        latest = (rel.get("tag_name") or "").lstrip("vV")

        def parts(v):
            return tuple(int(x) for x in re.findall(r"\d+", v)[:3])
        return {"ok": True, "update": bool(latest) and parts(latest) > parts(VERSION), "current": VERSION,
                "version": latest, "url": rel.get("html_url") or f"https://github.com/{UPDATE_REPO}/releases",
                "notes": (rel.get("body") or "")[:600]}

    def open_url(self, url):
        """Tarayicida acar. Yalnizca GitHub surum sayfasi ve kick.com: arayuz baska adres acamaz."""
        if isinstance(url, str) and (url.startswith(f"https://github.com/{UPDATE_REPO}/") or url.startswith("https://kick.com/")):
            os.startfile(url)
            return True
        return False

    def list_link(self, text):
        """Kanali ve VOD'larini listeler. Kanal favoriyse 'seenBefore' onceki bakisin zamanidir:
        start'i bundan buyuk VOD'lar yenidir. Bu cagri bakisi gunceller."""
        slug, uuid, is_clip = parse_link(text or "")
        if is_clip:
            return {"ok": True, "kind": "clip", "url": text.strip()}
        if not slug and not uuid:
            return {"ok": False, "error": "Link anlaşılamadı. Kanal linki (kick.com/kanal), kanal adı ya da VOD linki yapıştır."}
        try:
            channel, vods = fetch_channel(slug or vod_channel(uuid))
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": kick_error(e)}
        seen_before = self._mark_seen(channel["slug"], vods)
        return {"ok": True, "kind": "channel", "channel": channel, "vods": vods, "focus": uuid,
                "favorite": seen_before is not None, "seenBefore": seen_before or ""}

    # ---------- ayarlar ----------
    def get_settings(self):
        """parallel / fragThreads: "auto" ya da sabit sayi. Diger alanlar icin bkz. PREFS."""
        return {"folder": self._folder, "quality": self._quality, "qualities": QUALITIES,
                "parallel": self._parallel, "maxParallel": MAX_PARALLEL,
                "fragThreads": self._threads, "autoFragThreads": FRAG_THREADS, "maxFragThreads": FRAG_THREADS_MAX,
                **self._prefs, "nameTokens": list(NAME_TOKENS), "nameDefault": NAME_DEFAULT}

    def set_settings(self, data):
        """Yalnizca gelen alanlari degistirir; gecersiz sayi "auto" olur. Gecersiz tercih
        (or. hatali dosya adi sablonu) degismez ve "rejected" listesinde doner."""
        data = data or {}
        rejected = []
        for key, (_, check) in PREFS.items():
            if key in data:
                value = check(data[key])
                if value is None:
                    rejected.append(key)
                else:
                    self._prefs[key] = value
        if data.get("quality") in QUALITIES:
            self._quality = data["quality"]
        if "parallel" in data:
            self._parallel = int_or_auto(data["parallel"], 1, MAX_PARALLEL)
        if "fragThreads" in data:
            self._threads = int_or_auto(data["fragThreads"], 1, FRAG_THREADS_MAX)
        if isinstance(data.get("folder"), str) and data["folder"].strip():
            self._folder = data["folder"].strip()
        LIMITER.rate = self._prefs["speedLimit"] * 1024 * 1024
        self._free = (0.0, None)        # klasor degismis olabilir: bos alan yeniden olculsun
        self._save()
        return {**self.get_settings(), "rejected": rejected}

    # ---------- favori yayincilar ----------
    def favorites(self):
        with self._fav_lock:
            return [dict(f) for f in self._favorites]

    def favorite_add(self, text):
        """Kanal adi, kanal linki ya da VOD linkiyle favori ekler."""
        slug, uuid, is_clip = parse_link(text or "")
        if is_clip or (not slug and not uuid):
            return {"ok": False, "error": "Kanal anlaşılamadı. Kanal adı ya da kanal linki yaz."}
        try:
            channel, vods = fetch_channel(slug or vod_channel(uuid))
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": kick_error(e)}
        fav = {"slug": channel["slug"], "name": channel["name"], "avatar": channel["avatar"],
               "seen": max((v["start"] for v in vods), default="")}
        with self._fav_lock:
            if not any(f["slug"] == fav["slug"] for f in self._favorites):
                self._favorites.append(fav)
        self._save()
        return {"ok": True, "favorite": fav, "favorites": self.favorites()}

    def favorite_set(self, slug, data):
        """Favorinin otomatik islerini acar/kapatir: autoDownload (yeni VOD gelince indir),
        autoRecord (canliya gecince kaydet). autoDownload acilinca o ana kadarki VOD'lar
        indirilmez; yalnizca bundan sonra gelenler."""
        data = data or {}
        with self._fav_lock:
            fav = next((f for f in self._favorites if f["slug"] == slug), None)
        if fav is None:
            return {"ok": False, "error": "Favori bulunamadı."}
        auto_seen = None
        if data.get("autoDownload") is True and not fav.get("autoDownload"):
            try:
                _, vods = fetch_channel(slug)
            except Exception as e:  # noqa: BLE001
                return {"ok": False, "error": kick_error(e)}
            auto_seen = max((v["start"] for v in vods), default="")
        with self._fav_lock:
            for key in ("autoDownload", "autoRecord"):
                if isinstance(data.get(key), bool):
                    fav[key] = data[key]
            if auto_seen is not None:
                fav["autoSeen"] = auto_seen
        self._save()
        if fav.get("autoRecord") or fav.get("autoDownload"):
            self._live_wake.set()       # bir sonraki turu beklemeden kontrol et
        return {"ok": True, "favorites": self.favorites()}

    def favorite_remove(self, slug):
        with self._fav_lock:
            self._favorites = [f for f in self._favorites if f["slug"] != slug]
        self._save()
        return self.favorites()

    def favorites_refresh(self):
        """Her favori icin: canli mi (live), son bakistan beri kac yeni VOD var (newVods),
        en yeni VOD (latest). Kick'e ulasilamayan kanal {"ok": False} doner."""
        def check(f):
            try:
                channel, vods = fetch_channel(f["slug"])
            except Exception as e:  # noqa: BLE001 - bir kanal hatasi digerlerini durdurmaz
                log.info("favori %s alinamadi: %s", f["slug"], e)
                return f["slug"], {"ok": False, "error": kick_error(e)}
            seen = f.get("seen") or ""
            return f["slug"], {
                "ok": True, "name": channel["name"], "avatar": channel["avatar"], "live": channel["live"],
                "newVods": sum(1 for v in vods if seen and v["start"] > seen),
                "latest": max(vods, key=lambda v: v["start"]) if vods else None,
            }

        favs = self.favorites()
        if not favs:
            return {}
        with ThreadPoolExecutor(max_workers=min(6, len(favs))) as pool:
            status = dict(pool.map(check, favs))
        with self._fav_lock:      # yayinci adini ya da resmini degistirdiyse sakla
            for f in self._favorites:
                st = status.get(f["slug"])
                if st and st["ok"]:
                    f["name"], f["avatar"] = st["name"], st["avatar"]
        self._save()
        return status

    # ---------- canli yayin (beta) ----------
    def live_status(self, slug):
        """Kanal su an canliysa yayin bilgisi. Kayit icin enqueue([{"url": kanal linki, "live": True}])."""
        try:
            ch = kick_get(f"https://kick.com/api/v2/channels/{slug}")
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": kick_error(e)}
        return {"ok": True, "live": live_info(ch)}

    def list_clips(self, slug, sort="date", cursor=None):
        try:
            clips, nxt = fetch_clips(slug, sort, cursor)
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": f"Klipler alınamadı. ({str(e)[:120]})"}
        return {"ok": True, "clips": clips, "cursor": nxt if clips else None}

    def vod_source(self, uuid, live=False):
        """Kesit secicideki onizleme oynaticisi icin VOD'un HLS adresi. Suren yayinin VOD'u da
        acilir: listesi her istekte yayinin birkac sn gerisine kadar uzar. live ise o anki
        uzunluk da doner (duration); oynatici sondan baslasin."""
        try:
            v = kick_get(f"https://kick.com/api/v1/video/{uuid}")
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": f"Video açılamadı. ({str(e)[:120]})"}
        if not v.get("source"):
            return {"ok": False, "error": "Bu yayının video kaynağı yok."}
        out = {"ok": True, "source": v["source"]}
        if live:
            try:
                out["duration"] = playlist_duration(v["source"])
            except Exception as e:  # noqa: BLE001 - sure yoksa bastan acilir
                log.info("canli VOD suresi alinamadi (%s): %s", uuid, e)
        return out

    def live_master(self, url):
        """Canli yayinin HLS ana listesinin metni. Kick'in ana listesi CORS'u yalniz kick.com'a acar,
        arayuz dogrudan cekemez; alt listeler ve parcalar herkese acik (tam adresli), arayuz onlari
        kendisi ceker."""
        if not re.match(r"https://[\w.-]+\.live-video\.net/", url or ""):
            return {"ok": False, "error": "Geçersiz canlı yayın adresi."}
        try:
            r = cffi_requests.get(url, impersonate="chrome", timeout=15)
            r.raise_for_status()
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": f"Canlı yayın açılamadı. ({str(e)[:120]})"}
        return {"ok": True, "text": r.text}

    def strip_index(self, uuid, fresh=False):
        """Zaman cizelgesindeki kare/ses seridinin parca listesi: [[baslangic, sure], ...].
        fresh: suren yayinda listeyi yeniden okur (yeni parcalar sona eklenir)."""
        log.info("serit listesi istendi: %s (ffmpeg: %s)", uuid, self._ffmpeg)
        if not self._ffmpeg:
            return {"ok": False, "error": "ffmpeg yok; çizelgede kare ve ses dalgası gösterilemiyor."}
        try:
            if uuid not in self._strips:
                self._strips[uuid] = MediaStrip(uuid, self._ffmpeg)
            elif fresh:
                self._strips[uuid].refresh()
        except Exception as e:  # noqa: BLE001
            log.info("serit listesi alinamadi (%s): %s", uuid, e)
            return {"ok": False, "error": f"Çizelge şeridi alınamadı. ({str(e)[:120]})"}
        return {"ok": True, "segments": self._strips[uuid].index(),
                "peaksPerSec": MediaStrip.PEAKS_PER_SEC, "frameEvery": MediaStrip.FRAME_EVERY}

    def strip_data(self, uuid, indices):
        """Istenen parcalarin karelerini ve ses tepe degerlerini paralel isleyip dondurur."""
        strip = self._strips.get(uuid)
        if not strip:
            log.info("serit verisi istendi ama liste yok: %s", uuid)
            return {}
        idx = [i for i in indices or [] if 0 <= i < len(strip.segments)][:16]
        try:
            t = time.monotonic()
            out = {str(i): d for i, d in zip(idx, self._strip_pool.map(strip.get, idx))}
            log.info("serit verisi: %d parca, %d karesi dolu, %.1f sn", len(out),
                     sum(1 for d in out.values() if d["frames"]), time.monotonic() - t)
            return out
        except Exception as e:  # noqa: BLE001
            log.info("serit parcalari alinamadi: %s", e)
            return {}

    def strip_thumbs(self, uuid, indices):
        """Uzak gorunum icin parcalarin ilk kareleri: {"i": data URL ya da ""}. Tam veriden hizli."""
        strip = self._strips.get(uuid)
        if not strip:
            return {}
        idx = [i for i in indices or [] if 0 <= i < len(strip.segments)][:64]
        try:
            return {str(i): f for i, f in zip(idx, self._strip_pool.map(strip.thumb, idx))}
        except Exception as e:  # noqa: BLE001
            log.info("serit kareleri alinamadi: %s", e)
            return {}

    def client_log(self, msg):
        """Arayuz tarafindaki hatalari ayni log dosyasina yazar."""
        log.info("arayuz: %s", str(msg)[:500])

    def enqueue(self, items):
        added = 0
        with self._lock:
            known = {d.key for d in self._downloads.values()}
            active = {d.key for d in self._downloads.values() if d.status in ("queued",) + ACTIVE_ALL}
            for it in items or []:
                if not it.get("url"):
                    continue
                if it.get("live") or it.get("chat"):
                    # canli: ayni kanal ayni anda bir kez kaydedilir; bitmis kayit engel degil. sohbet de oyle.
                    d = Download(it["url"], it.get("title") or it["url"], it.get("thumb") or "",
                                 live=bool(it.get("live")), chat=bool(it.get("chat")) and not it.get("live"))
                    if d.chat:
                        d.duration = it.get("duration") if type(it.get("duration")) is int else 0
                    if d.key not in active:
                        self._downloads[d.id] = d
                        active.add(d.key)
                        added += 1
                    continue
                if it.get("sections"):   # birden fazla kesit, tek video
                    try:
                        secs = sorted((max(0, int(a)), int(b)) for a, b in it["sections"])
                    except (TypeError, ValueError):
                        continue
                    secs = [x for x in secs if x[1] > x[0]]
                    if not secs:
                        continue
                    d = Download(it["url"], it.get("title") or it["url"], it.get("thumb") or "", sections=secs)
                    if d.key not in known:
                        self._downloads[d.id] = d
                        known.add(d.key)
                        added += 1
                    continue
                section = None
                if it.get("end"):
                    section = (max(0, int(it.get("start") or 0)), int(it["end"]))
                    if section[1] <= section[0]:
                        continue
                d = Download(it["url"], it.get("title") or it["url"], it.get("thumb") or "", section)
                if d.key not in known:
                    self._downloads[d.id] = d
                    known.add(d.key)
                    added += 1
        self._push(force=True)
        return added

    def cancel(self, did):
        d = self._downloads.get(did)
        if d and d.status in ("queued",) + ACTIVE_ALL:
            d.cancel = True
            if d.status == "queued":
                d.status = "stopped"
        self._push(force=True)

    def cancel_all(self):
        for d in list(self._downloads.values()):
            self.cancel(d.id)

    def retry(self, did):
        d = self._downloads.get(did)
        if d and d.status in ("stopped", "error"):
            d.cancel = False
            d.error = ""
            d.status = "queued"
        self._push(force=True)

    def remove(self, did):
        with self._lock:
            d = self._downloads.get(did)
            if d and d.status not in ACTIVE_ALL:
                d.cancel = True
                del self._downloads[did]
        self._push(force=True)

    def clear_done(self):
        with self._lock:
            for did in [i for i, d in self._downloads.items() if d.status == "done"]:
                del self._downloads[did]
        self._push(force=True)

    def set_quality(self, q):
        if q in QUALITIES:
            self._quality = q
            self._save()

    def pick_folder(self):
        res = self._window.create_file_dialog(webview.FileDialog.FOLDER, directory=self._folder)
        if res:
            self._folder = res[0]
            self._save()
        return self._folder

    # ---------- Indirilenler ----------
    def library(self):
        """Biten indirmeler, en yenisi once. exists: dosya hala diskte mi."""
        with self._lock:
            items = [dict(e) for e in self._history]
        for e in items:
            e["exists"] = os.path.isfile(e["file"])
        return sorted(items, key=lambda e: e.get("done", 0), reverse=True)

    def library_remove(self, path, delete_file=False):
        """Kaydi listeden kaldirir; delete_file ise dosyayi Geri Donusum Kutusu'na tasir."""
        trashed = False
        if delete_file and os.path.isfile(path):
            trashed = recycle(path)
            if not trashed:
                return {"ok": False, "error": "Dosya silinemedi. Başka bir program açık tutuyor olabilir."}
        with self._lock:
            self._history = [e for e in self._history if e["file"] != path]
            save_history(self._history)
        return {"ok": True, "trashed": trashed}

    def media_url(self, path):
        """Indirilen dosyanin uygulama icindeki oynaticida acilacak adresi."""
        with self._lock:
            known = any(e["file"] == path for e in self._history) or \
                any(d.filename == path and d.status == "done" for d in self._downloads.values())
        if not known or not os.path.isfile(path):
            return {"ok": False, "error": "Dosya bulunamadı. Taşınmış ya da silinmiş olabilir."}
        if self._media is None:
            self._media = MediaServer()
        return {"ok": True, "url": self._media.url(path), "playable": not path.lower().endswith(".ts")}

    def open_file(self, path):
        """Dosyayi Windows'un varsayilan oynaticisinda acar."""
        if os.path.isfile(path):
            os.startfile(path)
            return True
        return False

    def reveal_file(self, path):
        if os.path.isfile(path):
            subprocess.Popen(["explorer", "/select,", path])
        else:
            self.open_folder()

    def open_folder(self):
        os.makedirs(self._folder, exist_ok=True)
        os.startfile(self._folder)

    def reveal(self, did):
        d = self._downloads.get(did)
        if d and d.filename and os.path.exists(d.filename):
            subprocess.Popen(["explorer", "/select,", d.filename])
        else:
            self.open_folder()

    # ---------- ic isler ----------
    def _save(self):
        save_settings({"folder": self._folder, "quality": self._quality, "parallel": self._parallel,
                       "fragThreads": self._threads, **self._prefs, "favorites": self.favorites()})

    def _frag_threads(self):
        return FRAG_THREADS if self._threads == "auto" else self._threads

    def _parallel_limit(self):
        return self._tuner.level if self._parallel == "auto" else self._parallel

    def _mark_seen(self, slug, vods):
        """Favori kanal acildiysa son bakisi gunceller ve oncekini dondurur; favori degilse None."""
        latest = max((v["start"] for v in vods), default="")
        with self._fav_lock:
            fav = next((f for f in self._favorites if f["slug"] == slug), None)
            if fav is None:
                return None
            before = fav.get("seen") or ""
            fav["seen"] = max(before, latest)
        if fav["seen"] != before:
            self._save()
        return before

    def _push(self, force=False):
        """Arayuzu guncelleme istegi. Asil isi _pusher yapar: evaluate_js arayuz thread'inin
        cevabini bekler, arayuz thread'inden (or. pencere kapanirken) cagrilirsa kilitlenir."""
        self._force = self._force or force
        self._dirty.set()

    def _pusher(self):
        while True:
            self._dirty.wait()
            self._dirty.clear()
            force, self._force = self._force, False
            if self._closing:
                return
            if self._ready and self._window:
                self._send(force)

    def _send(self, force):
        items = list(self._downloads.values())
        net = [d for d in items if d.status in ACTIVE_NET]
        payload = json.dumps({
            "downloads": [d.to_dict() for d in items],
            "level": self._parallel_limit(),
            "autoParallel": self._parallel == "auto",
            "liveFavorites": sorted(self._live_favs),
            "totalSpeed": sum(d.speed for d in net),
            "free": self._free_space(),
            "afterDone": self._after,
            "shutdownAt": self._shutdown_at,
            "speedLimit": self._prefs["speedLimit"],
        }, ensure_ascii=False)
        self._update_title(items)
        if force or payload != self._last_push:
            self._last_push = payload
            try:
                self._window.evaluate_js(f"window.app && window.app.sync({payload})")
            except Exception:  # noqa: BLE001 - pencere kapanirken
                pass

    def _update_title(self, items):
        """Pencere basligina toplam ilerleme: kucultulmusken gorev cubugunda okunur."""
        active = [d for d in items if d.status in ACTIVE_ALL]
        title = "Kick İndirici"
        if active:
            total = sum(d.size for d in active if d.size and not d.live)    # canli kaydin sonu belli degil
            done = sum(d.size * d.pct / 100 for d in active if d.size and not d.live)
            pct = int(100 * done / total) if total else 0
            speed = sum(d.speed for d in active) / (1024 * 1024)
            title = f"%{pct} · {speed:.1f} MB/s · {len(active)} iniyor — Kick İndirici".replace(".", ",", 1)
        if title != getattr(self, "_title", None):
            self._title = title
            try:
                self._window.set_title(title)
            except Exception:  # noqa: BLE001
                pass

    def _free_space(self):
        """Indirme klasorunun diskindeki bos alan; 5 sn'de bir olculur."""
        at, value = self._free
        if time.monotonic() - at > 5:
            value = free_space(self._folder)
            self._free = (time.monotonic(), value)
        return value

    def _check_space(self, d, need):
        """need bayt daha yazilacaksa diskte yer var mi; yoksa indirme hatayla durur.
        Ayni anda inen diger videolarin kalan kismi da hesaba katilir."""
        free = free_space(self._folder)
        if not free or not need:
            return
        others = sum(o.size * (1 - o.pct / 100) for o in list(self._downloads.values())
                     if o is not d and o.status in ACTIVE_NET and o.size and not o.live)
        if need + others + DISK_RESERVE > free:
            raise RuntimeError(f"Diskte yer yok: bu video ~{fmt_size(need)} istiyor, boş alan {fmt_size(free)}"
                               + (f" (inmekte olanlar ~{fmt_size(others)} daha yazacak)" if others > 1 << 28 else "")
                               + ". Yer açıp tekrar dene ya da indirme klasörünü değiştir.")

    def _persist_queue(self):
        """Bitmemis indirmeleri queue.json'a yazar (yalnizca degisince). Canli kayit kaydedilmez:
        yayin o zamana bitmis olur."""
        items = [d.to_saved() for d in list(self._downloads.values()) if d.status != "done" and not d.live]
        if items != self._saved_queue:
            self._saved_queue = items
            save_queue(items)

    def _run_after_done(self, items):
        """Kuyruk bittiginde secilen is: uyku ya da kapatma. En az bir indirme bittiyse calisir
        (kullanici hepsini durdurduysa calismaz). Kapatma 60 sn gecikmeli, iptal edilebilir."""
        mode, self._after = self._after, "none"
        if mode == "none" or not any(d.status == "done" for d in items):
            return
        log.info("kuyruk bitti, %s", mode)
        if mode == "shutdown":
            subprocess.run(["shutdown", "/s", "/t", "60", "/c", "Kick İndirici: indirmeler bitti, bilgisayar kapanıyor."],
                           capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW)
            self._shutdown_at = time.time() + 60
        elif mode == "sleep":
            self._push(force=True)
            time.sleep(3)       # arayuz son durumu gostersin
            ctypes.windll.powrprof.SetSuspendState(False, False, False)

    def _scheduler(self):
        batch = set()       # bu calisma turunda kuyruga girenler: tur bitince tek bildirim
        while True:
            time.sleep(0.5)
            items = list(self._downloads.values())
            busy = [d for d in items if d.status in ("queued",) + ACTIVE_ALL]
            batch.update(d.id for d in busy)
            if batch and not busy:
                done = [d for d in items if d.id in batch]
                self._notify_done(done)
                self._run_after_done(done)
                batch = set()
            self._persist_queue()
            net = [d for d in items if d.status in ACTIVE_NET and not d.live and not d.chat]
            pending = [d for d in items if d.status == "queued" and not d.live and not d.chat]
            # canli kayit hemen baslar ve sira tutmaz: yayin beklemez, saatlerce surer.
            # sohbet kaydi da: kucuk JSON istekleri, video sirasini bekletmesin
            for d in [d for d in items if d.status == "queued" and (d.live or d.chat)]:
                d.status = "preparing"
                target = self._record_live if d.live else self._download_chat
                threading.Thread(target=target, args=(d,), daemon=True).start()
            self._tuner.step(sum(d.speed for d in net), len(net), bool(pending))
            # Klipler otomatik modda tavandan baslar: tek basina hatti dolduramazlar ve birkac
            # saniyede bittikleri icin tuner'in olcumu oturmaz (12 klip: 4,7 -> 7,7 MB/s).
            # Kesitte fark olculmedi (6,6 -> 6,5 MB/s); VOD ve kesitlerde tuner aynen gecerli.
            running, limit = len(net), self._parallel_limit()
            for d in pending:
                cap = MAX_PARALLEL if d.short and self._parallel == "auto" else limit
                if running < cap:
                    running += 1
                    d.status = "preparing"
                    threading.Thread(target=self._download, args=(d,), daemon=True).start()
            self._push()

    def _download(self, d):
        os.makedirs(self._folder, exist_ok=True)
        if d.sections:
            self._download_merged(d)
            return
        q = self._quality
        anchor = None
        cut = None   # kesitte: (ilk parcadan kesit basina saniye, kesit uzunlugu)

        def hook(info):
            if d.cancel:
                raise DownloadCancelled()
            if info["status"] == "downloading":
                d.status = "downloading"
                d.speed = info.get("speed") or 0.0
                if info.get("fragment_count"):
                    d.pct = 100 * (info.get("fragment_index") or 0) / info["fragment_count"]
                # yt-dlp'nin tahmini ilk parcalarda cok sapar (3 GB'lik video 40 GB gorunur);
                # parcalarin %3'u inene kadar bit hizi x sureden hesaplanan boyutu goster
                est = info.get("total_bytes") or info.get("total_bytes_estimate")
                if est and (info.get("total_bytes") or d.pct >= 3 or not anchor):
                    d.size = est
                elif anchor:
                    d.size = anchor
                if not info.get("fragment_count") and d.size:
                    d.pct = 100 * (info.get("downloaded_bytes") or 0) / d.size
                # kalan sureyi de ayni boyuttan hesapla, yoksa ETA da ilk saniyelerde sacmalar
                d.eta = d.size * (1 - d.pct / 100) / d.speed if d.size and d.speed else info.get("eta")
            elif info["status"] == "finished":
                d.speed = 0.0
                d.pct = 100.0
                d.status = "merging"

        opts = {
            "format": "best" if q == "En iyi" else f"{q}/best",
            "outtmpl": os.path.join(self._folder, out_template(self._prefs["nameTemplate"], d.section)),
            "concurrent_fragment_downloads": self._frag_threads(),
            "retries": 10,
            "fragment_retries": 20,
            "windowsfilenames": True,
            "progress_hooks": [hook],
            "quiet": True,
            "noprogress": True,
            "no_warnings": True,
        }
        if self._ffmpeg:
            opts["ffmpeg_location"] = self._ffmpeg
        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = ydl.extract_info(d.url, download=False)
                if d.title == d.url:
                    d.title = info.get("title") or d.url
                if not d.thumb:
                    d.thumb = info.get("thumbnail") or ""
                d.filename = ydl.prepare_filename(info)
                duration = info.get("duration")
                if d.section:
                    if os.path.exists(d.filename):     # onceden inip kesilmis; tekrar kesme
                        d.size = os.path.getsize(d.filename)
                        d.status, d.pct, d.eta = "done", 100.0, 0
                        return
                    cut = self._prepare_section(ydl, info, d.section)
                    duration = cut[1]
                if info.get("tbr") and duration:
                    anchor = int(info["tbr"] * 125 * duration)   # kbit/s -> bayt
                d.exact = bool(info.get("filesize"))
                part = d.filename + ".part"
                self._check_space(d, (info.get("filesize") or anchor or 0)
                                  - (os.path.getsize(part) if os.path.exists(part) else 0))
                if d.cancel:
                    raise DownloadCancelled()
                ydl.process_info(info)
            if cut and self._ffmpeg:
                d.status = "merging"
                self._push(force=True)
                self._cut(d.filename, *cut)
                d.size = os.path.getsize(d.filename)
            d.status, d.pct, d.eta = "done", 100.0, 0
        except Exception as e:  # noqa: BLE001 - hatayi kullaniciya goster
            if d.cancel or isinstance(e, DownloadCancelled):
                d.status = "stopped"
            else:
                d.status = "error"
                d.error = re.sub(r"^ERROR:\s*(\[[^\]]+\]\s*)?", "", str(e))[:200]
        finally:
            d.speed = 0.0
            if d.status == "done":
                self._remember(d)
            self._push(force=True)

    def _download_merged(self, d):
        """Birden fazla kesit tek videoda: her kesitin parcalari ayni cok thread'li motorla
        gecici bir klasore iner ve kirpilir, sonra ffmpeg concat ile yeniden kodlamadan
        arka arkaya eklenir. Bitmis kesitler isaretlenir; durdurup devam edince bastan inmez."""
        q = self._quality
        total = sum(b - a for a, b in d.sections) or 1
        prog = {"base": 0.0, "share": 0.0}   # bitmis kesitlerin suresi, sureninki
        anchor = None
        work = os.path.join(self._folder, ".kesitler-" + hashlib.md5(d.key.encode()).hexdigest()[:10])

        def hook(info):
            if d.cancel:
                raise DownloadCancelled()
            if info["status"] == "downloading":
                d.status = "downloading"
                d.speed = info.get("speed") or 0.0
                frac = 0.0
                if info.get("fragment_count"):
                    frac = (info.get("fragment_index") or 0) / info["fragment_count"]
                elif info.get("total_bytes"):
                    frac = (info.get("downloaded_bytes") or 0) / info["total_bytes"]
                d.pct = min(99.0, 100 * (prog["base"] + frac * prog["share"]) / total)
                if anchor:
                    d.size = anchor
                d.eta = d.size * (1 - d.pct / 100) / d.speed if d.size and d.speed else None

        opts = {
            "format": "best" if q == "En iyi" else f"{q}/best",
            "concurrent_fragment_downloads": self._frag_threads(),
            "retries": 10,
            "fragment_retries": 20,
            "windowsfilenames": True,
            "progress_hooks": [hook],
            "quiet": True,
            "noprogress": True,
            "no_warnings": True,
        }
        if self._ffmpeg:
            opts["ffmpeg_location"] = self._ffmpeg
        try:
            if not self._ffmpeg:
                raise RuntimeError("Kesitleri birleştirmek için ffmpeg gerekli.")
            name = out_template(self._prefs["nameTemplate"], d.section, len(d.sections))
            with yt_dlp.YoutubeDL({**opts, "outtmpl": os.path.join(self._folder, name)}) as ydl:
                info = ydl.extract_info(d.url, download=False)
                if d.title == d.url:
                    d.title = info.get("title") or d.url
                if not d.thumb:
                    d.thumb = info.get("thumbnail") or ""
                d.filename = ydl.prepare_filename(info)
            if os.path.exists(d.filename):          # onceden birlestirilmis
                d.size = os.path.getsize(d.filename)
                d.status, d.pct, d.eta = "done", 100.0, 0
                return
            if info.get("tbr"):
                anchor = int(info["tbr"] * 125 * total)   # kbit/s -> bayt
                d.size = anchor
                # parcalar + birlestirilmis kopya ayni anda diskte durur: iki kat yer
                have = sum(e.stat().st_size for e in os.scandir(work) if e.is_file()) if os.path.isdir(work) else 0
                self._check_space(d, 2 * anchor - have)
            os.makedirs(work, exist_ok=True)
            parts = []
            for i, sec in enumerate(d.sections):
                prog["share"] = sec[1] - sec[0]
                ext = os.path.splitext(d.filename)[1]
                ready = os.path.join(work, f"{i:03d}.hazir{ext}")
                if not os.path.exists(ready):
                    if d.cancel:
                        raise DownloadCancelled()
                    with yt_dlp.YoutubeDL({**opts, "outtmpl": os.path.join(work, f"{i:03d}.%(ext)s")}) as ydl:
                        part_info = copy.deepcopy(info)
                        part = ydl.prepare_filename(part_info)
                        cut = self._prepare_section(ydl, part_info, sec)
                        d.status = "downloading"
                        ydl.process_info(part_info)
                    d.status = "merging"
                    self._push(force=True)
                    self._cut(part, *cut)
                    os.replace(part, ready)
                parts.append(ready)
                prog["base"] += prog["share"]
            d.status, d.speed, d.eta = "merging", 0.0, None
            d.pct = 100.0
            self._push(force=True)
            listing = os.path.join(work, "liste.txt")
            with open(listing, "w", encoding="utf-8") as f:
                for part in parts:
                    f.write("file '" + part.replace("\\", "/").replace("'", "'\\''") + "'\n")
            tmp = d.filename + ".birlesik" + os.path.splitext(d.filename)[1]
            cmd = [self._ffmpeg, "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", listing,
                   "-map", "0", "-c", "copy", "-movflags", "+faststart", tmp]
            r = subprocess.run(cmd, capture_output=True, text=True, creationflags=subprocess.CREATE_NO_WINDOW)
            if r.returncode != 0 or not os.path.exists(tmp):
                raise RuntimeError("Kesitler birleştirilemedi: " + (r.stderr or "").strip()[-160:])
            os.replace(tmp, d.filename)
            shutil.rmtree(work, ignore_errors=True)
            d.size = os.path.getsize(d.filename)
            d.status, d.pct, d.eta = "done", 100.0, 0
        except Exception as e:  # noqa: BLE001 - hatayi kullaniciya goster
            if d.cancel or isinstance(e, DownloadCancelled):
                d.status = "stopped"
            else:
                d.status = "error"
                d.error = re.sub(r"^ERROR:\s*(\[[^\]]+\]\s*)?", "", str(e))[:200]
        finally:
            d.speed = 0.0
            if d.status == "done":
                self._remember(d)
            self._push(force=True)

    @staticmethod
    def _prepare_section(ydl, info, section):
        """Secilen formatin parca listesini kesite gore daraltir; yt-dlp yalnizca o parcalari
        her zamanki gibi cok thread'le indirir. Parca sinirlarindan tasan kisim sonra kesilir."""
        if not str(info.get("protocol", "")).startswith("m3u8"):
            raise ValueError("Bu video kesit almayı desteklemiyor.")
        start, end = section
        playlist = ydl.urlopen(info["url"]).read().decode("utf-8", "ignore")
        info["hls_media_playlist_data"], offset = trim_playlist(playlist, start, end)
        info.pop("filesize", None)
        info.pop("filesize_approx", None)
        # yayin hala suruyorsa yt-dlp ffmpeg'le canli kayda gecer; daraltilmis liste ise bitmis bir liste
        info["is_live"], info["live_status"] = False, "was_live"
        return offset, end - start

    def _cut(self, path, offset, length):
        tmp = path + ".kesit" + os.path.splitext(path)[1]
        cmd = [self._ffmpeg, "-y", "-v", "error", "-ss", f"{offset:.3f}", "-i", path, "-t", f"{length:.3f}",
               "-map", "0", "-c", "copy", "-avoid_negative_ts", "make_zero", "-movflags", "+faststart", tmp]
        r = subprocess.run(cmd, capture_output=True, text=True, creationflags=subprocess.CREATE_NO_WINDOW)
        if r.returncode != 0 or not os.path.exists(tmp):
            raise RuntimeError("Kesit kırpılamadı: " + (r.stderr or "").strip()[-160:])
        os.replace(tmp, path)

    def _record_live(self, d):
        """Beta: canli yayini su andan itibaren .ts olarak kaydeder (cokme/kapanmada bile okunur).
        Durdurulunca ya da yayin bitince mp4'e cevrilir. Durdurmak hata degil: kayit 'done' olur."""
        errlog = tempfile.TemporaryFile()
        try:
            if not self._ffmpeg:
                raise RuntimeError("Canlı kayıt için ffmpeg gerekli.")
            slug = parse_link(d.url)[0]
            ch = kick_get(f"https://kick.com/api/v2/channels/{slug}")
            live = live_info(ch)
            if not live:
                raise RuntimeError("Yayıncı şu an canlı değil.")
            src = live_variant(ch["playback_url"], self._quality)
            if d.title == d.url:
                d.title = live["title"] or slug
            d.thumb = d.thumb or live["thumb"]
            os.makedirs(self._folder, exist_ok=True)
            name = self._prefs["nameTemplate"]
            for key, value in (("kanal", slug), ("baslik", d.title[:70]), ("tarih", time.strftime("%Y-%m-%d")),
                               ("id", f"canlı {time.strftime('%Y-%m-%d %H.%M')}")):
                name = name.replace("{" + key + "}", value)
            name = re.sub(r'[\\/:*?"<>|\r\n]+', "_", name)
            base = os.path.join(self._folder, name.strip())
            ts, d.filename = base + ".ts", base + ".mp4"
            d.proc = subprocess.Popen(
                [self._ffmpeg, "-v", "error", "-y", "-i", src, "-map", "0", "-c", "copy", "-f", "mpegts", ts],
                stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=errlog,
                creationflags=subprocess.CREATE_NO_WINDOW)
            d.status, d.started = "recording", time.time()
            self._push(force=True)
            last, t = 0, time.monotonic()
            while d.proc.poll() is None:
                if d.cancel:
                    self._stop_proc(d.proc)
                    break
                time.sleep(1)
                size = os.path.getsize(ts) if os.path.exists(ts) else 0
                now = time.monotonic()
                d.speed, d.size, last, t = (size - last) / (now - t), size, size, now
            if not os.path.exists(ts) or os.path.getsize(ts) == 0:
                if d.cancel:
                    raise DownloadCancelled()
                errlog.seek(0)
                raise RuntimeError("Kayıt alınamadı: " + errlog.read().decode("utf-8", "ignore").strip()[-160:])
            if not self._prefs["liveRemux"]:      # .ts olarak kalsin
                d.filename = ts
                d.size = os.path.getsize(ts)
                d.status, d.pct, d.eta = "done", 100.0, 0
                return
            d.status, d.speed = "merging", 0.0
            self._push(force=True)
            r = subprocess.run([self._ffmpeg, "-y", "-v", "error", "-i", ts, "-map", "0", "-c", "copy",
                                "-movflags", "+faststart", d.filename],
                               capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW)
            if r.returncode == 0 and os.path.exists(d.filename):
                os.remove(ts)
            else:                       # mp4'e cevrilemezse .ts kalsin, o da oynar
                log.info("canli kayit mp4'e cevrilemedi: %s", r.stderr.decode("utf-8", "ignore")[-300:])
                d.filename = ts
            d.size = os.path.getsize(d.filename)
            d.status, d.pct, d.eta = "done", 100.0, 0
        except Exception as e:  # noqa: BLE001 - hatayi kullaniciya goster
            if d.cancel or isinstance(e, DownloadCancelled):
                d.status = "stopped"
            else:
                d.status = "error"
                d.error = str(e)[:200]
        finally:
            if d.proc and d.proc.poll() is None:
                d.proc.kill()
            d.proc = None
            d.speed = 0.0
            errlog.close()
            if d.status == "done":
                self._remember(d)
            self._push(force=True)

    def _download_chat(self, d):
        """VOD'un sohbetini indirir: Kick'in tekrar oynatma API'si 5 sn'lik pencereler verir, bunlar
        paralel cekilir. Cikti videoyla ayni adla: .ass (oynatici videonun ustunde gosterir) ve
        .chat.json (ham kayit). Video daha once indiyse onun dosya adi kullanilir."""
        try:
            m = re.search(r"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})", d.url)
            if not m:
                raise ValueError("Sohbet yalnızca yayın (VOD) linkinden alınabilir.")
            uuid = m.group(1)
            v = kick_get(f"https://kick.com/api/v1/video/{uuid}")
            ls = v.get("livestream") or {}
            if ls.get("is_live"):
                raise RuntimeError("Yayın hâlâ sürüyor; sohbet yayın bitince alınabilir.")
            slug = (ls.get("channel") or {}).get("slug") or parse_link(d.url)[0] or "kick"
            if d.title == d.url:
                d.title = ls.get("session_title") or uuid
            vod_start = kick_time(ls.get("start_time") or ls.get("created_at"))
            duration = d.duration or round((ls.get("duration") or 0) / 1000) or playlist_duration(v["source"])
            with self._lock:
                video = next((e["file"] for e in reversed(self._history) if e.get("url") == d.url and not e.get("section")
                              and not e.get("chat") and os.path.isfile(e["file"])), None)
            if video:
                base = os.path.splitext(video)[0]
            else:
                os.makedirs(self._folder, exist_ok=True)
                base = os.path.join(self._folder, fill_name(self._prefs["nameTemplate"], slug, d.title,
                                                            time.strftime("%Y-%m-%d", time.gmtime(vod_start)), uuid[:12]))
            d.filename = base + ".ass"
            starts = list(range(0, int(duration) + 1, CHAT_WINDOW))
            d.status = "downloading"
            self._push(force=True)

            def fetch(offset):
                if d.cancel:
                    raise DownloadCancelled()
                return chat_window(ls["channel_id"], vod_start + offset)

            seen, messages, t0 = set(), [], time.monotonic()
            pool = ThreadPoolExecutor(max_workers=8)
            try:
                for i, batch in enumerate(pool.map(fetch, starts), 1):
                    for msg in batch:
                        if msg.get("id") in seen or not msg.get("content"):
                            continue
                        seen.add(msg.get("id"))
                        try:
                            messages.append(chat_entry(msg, vod_start))
                        except ValueError:
                            continue
                    d.pct = 100 * i / len(starts)
                    elapsed = time.monotonic() - t0
                    d.eta = elapsed / i * (len(starts) - i)
            finally:        # hata ya da durdurmada kalan binlerce istek beklenmesin
                pool.shutdown(wait=False, cancel_futures=True)
            messages.sort(key=lambda x: x["t"])
            d.status = "merging"
            self._push(force=True)
            with open(base + ".chat.json", "w", encoding="utf-8") as f:
                json.dump({"url": d.url, "channel": slug, "title": d.title, "start": ls.get("start_time"),
                           "duration": duration, "messages": messages}, f, ensure_ascii=False)
            with open(d.filename, "w", encoding="utf-8-sig") as f:
                f.write(chat_ass(messages))
            d.size = os.path.getsize(d.filename)
            d.status, d.pct, d.eta = "done", 100.0, 0
            log.info("sohbet indi: %s, %d mesaj", uuid, len(messages))
        except Exception as e:  # noqa: BLE001 - hatayi kullaniciya goster
            if d.cancel or isinstance(e, DownloadCancelled):
                d.status = "stopped"
            else:
                d.status = "error"
                d.error = str(e)[:200]
        finally:
            d.speed = 0.0
            if d.status == "done":
                self._remember(d)
            self._push(force=True)

    @staticmethod
    def _stop_proc(proc):
        """ffmpeg'e 'q' yollar: dosyayi duzgun kapatip cikar. 10 sn'de cikmazsa oldurulur."""
        try:
            proc.stdin.write(b"q")
            proc.stdin.flush()
            proc.wait(10)
        except Exception:  # noqa: BLE001
            proc.kill()

    def _notify_done(self, items):
        done = sum(1 for d in items if d.status == "done")
        failed = sum(1 for d in items if d.status == "error")
        if not self._prefs["notifyDone"] or not (done or failed):
            return
        if done + failed == 1:
            d = next(d for d in items if d.status in ("done", "error"))
            toast("İndirme bitti" if done else "İndirme başarısız", d.title)
        else:
            toast("İndirmeler bitti", f"{done} indirme tamamlandı" + (f", {failed} hata" if failed else ""))

    def _watch_live(self):
        """Favorilerin canli durumunu LIVE_POLL saniyede bir kontrol eder. Canliya gecen olursa
        bildirim (notifyLive) ve sync'te liveFavorites. Ilk tur yalnizca durumu ogrenir.

        Otomatik isler (favori basina, favorite_set ile acilir):
        - autoRecord: canli yayin kaydi baslatilir. Yayin basina bir kez: kullanici kaydi durdurursa
          ayni yayin icin yeniden baslamaz. Program acildiginda yayin suruyorsa da baslar.
        - autoDownload: autoSeen'den yeni ve bitmis VOD'lar kuyruga girer (program kapaliyken
          gelenler de). Suren yayinin VOD'u yayin bitince alinir."""
        first = True
        while not self._closing:
            favs = self.favorites()
            if favs:
                def check(f):
                    try:
                        if f.get("autoDownload"):
                            channel, vods = fetch_channel(f["slug"])
                            return f, channel["live"], vods
                        return f, live_info(kick_get(f"https://kick.com/api/v2/channels/{f['slug']}")), None
                    except Exception as e:  # noqa: BLE001 - bir kanal hatasi digerlerini durdurmaz
                        log.info("canli kontrolu %s: %s", f["slug"], e)
                        return f, False, None     # bilinmiyor: eski durum kalsin
                with ThreadPoolExecutor(max_workers=min(6, len(favs))) as pool:
                    results = list(pool.map(check, favs))
                now = set(self._live_favs)
                for f, live, vods in results:
                    if live is False:
                        continue
                    if live and f["slug"] not in now:
                        now.add(f["slug"])
                        if not first and self._prefs["notifyLive"]:
                            toast(f"{f['name']} canlı yayında", live["title"] or f["name"])
                    elif not live:
                        now.discard(f["slug"])
                    if live and f.get("autoRecord") and self._auto_started.get(f["slug"]) != live["start"]:
                        self._auto_started[f["slug"]] = live["start"]
                        log.info("otomatik kayit: %s", f["slug"])
                        self.enqueue([{"url": f"https://kick.com/{f['slug']}", "live": True,
                                       "title": live["title"] or f["name"], "thumb": live["thumb"]}])
                    if vods is not None:
                        self._auto_download(f, vods)
                now &= {f["slug"] for f in favs}
                if now != self._live_favs:
                    self._live_favs = now
                    self._push(force=True)
                first = False
            self._live_wake.wait(LIVE_POLL)
            self._live_wake.clear()

    def _auto_download(self, f, vods):
        """autoDownload acik favorinin yeni VOD'larini kuyruga ekler ve autoSeen'i ilerletir."""
        seen = f.get("autoSeen") or ""
        new = [v for v in vods if v["start"] > seen]
        live_starts = [v["start"] for v in new if v["live"]]
        # suren yayindan once biten VOD'lar alinir; autoSeen suren yayini gecmesin ki bitince o da alinsin
        ready = [v for v in new if not v["live"] and (not live_starts or v["start"] < min(live_starts))]
        if not ready:
            return
        log.info("otomatik indirme: %s, %d VOD", f["slug"], len(ready))
        self.enqueue([{"url": v["url"], "title": v["title"], "thumb": v["thumb"]} for v in ready])
        with self._fav_lock:
            for fav in self._favorites:
                if fav["slug"] == f["slug"]:
                    fav["autoSeen"] = max(v["start"] for v in ready)
        self._save()
        toast(f"{f['name']}: yeni yayın indiriliyor",
              ready[0]["title"] if len(ready) == 1 else f"{len(ready)} yeni yayın kuyruğa eklendi")

    def _frame_thumb(self, path):
        """Dosyanin ilk saniyelerinden kucuk bir kare (data URI). Alinamazsa ''."""
        work = tempfile.mkdtemp(prefix="kickthumb-")
        jpg = os.path.join(work, "f.jpg")
        try:
            for ss in ("1", "0"):
                subprocess.run([self._ffmpeg, "-nostdin", "-v", "error", "-y", "-ss", ss, "-i", path, "-map", "0:v:0",
                                "-frames:v", "1", "-vf", "scale=-2:180", "-q:v", "5", jpg],
                               stdin=subprocess.DEVNULL, capture_output=True, timeout=30,
                               creationflags=subprocess.CREATE_NO_WINDOW)
                if os.path.exists(jpg):
                    with open(jpg, "rb") as f:
                        return "data:image/jpeg;base64," + base64.b64encode(f.read()).decode()
            return ""
        except Exception as e:  # noqa: BLE001 - kapak yoksa eski kapak kalir
            log.info("kesit kapagi alinamadi: %s", e)
            return ""
        finally:
            shutil.rmtree(work, ignore_errors=True)

    def _remember(self, d):
        """Biten indirmeyi Indirilenler gecmisine yazar (ayni dosya tekrar inerse guncellenir)."""
        if not d.filename or not os.path.isfile(d.filename):
            return
        thumb = d.thumb
        if (d.section or d.sections) and self._ffmpeg:
            thumb = self._frame_thumb(d.filename) or thumb    # kesitin kapagi yayininki degil, kesitin kendi karesi
        entry = {"file": d.filename, "title": d.title, "thumb": thumb, "url": d.url,
                 "section": list(d.section) if d.section else None,
                 "sections": [list(x) for x in d.sections] if d.sections else None, "live": d.live, "chat": d.chat,
                 "channel": parse_link(d.url)[0] or (re.match(r"https://kick\.com/([\w-]+)/clips?/", d.url) or [None, ""])[1],
                 "size": os.path.getsize(d.filename), "done": time.time()}
        with self._lock:
            self._history = [e for e in self._history if e["file"] != d.filename] + [entry]
            self._history = self._history[-HISTORY_MAX:]
            save_history(self._history)

    def _stop_recordings(self):
        """Program kapanirken: ffmpeg alt surecleri programdan sonra da calismaya devam eder."""
        for d in list(self._downloads.values()):
            proc = d.proc
            if proc:
                self._stop_proc(proc)


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
    return False, "Microsoft Edge WebView2 Runtime" + (" (kurulum bozuk, yeniden kurulmalı)" if broken else "")


def message_box(text, yes_no=False):
    flags = (0x04 if yes_no else 0x00) | 0x30   # MB_YESNO / MB_OK + uyari ikonu
    return ctypes.windll.user32.MessageBoxW(None, text, "Kick İndirici", flags) == 6   # 6 = IDYES


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


INSTANCE_PID = os.path.join(DATA_DIR, "instance.pid")


def single_instance():
    """Program zaten aciksa onun penceresini one getirir ve False doner; degilse True.
    Isimli mutex surec kapaninca (cokse bile) Windows'ca birakilir; pid dosyasi pencereyi bulmak icin."""
    kernel32, user32 = ctypes.windll.kernel32, ctypes.windll.user32
    kernel32.CreateMutexW.restype = ctypes.c_void_p
    single_instance.mutex = kernel32.CreateMutexW(None, False, "Local\\KickIndirici.SingleInstance")
    if kernel32.GetLastError() != 183:      # ERROR_ALREADY_EXISTS
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
    build = sys.getwindowsversion().build
    ok, what = webview2_ok()
    log.info("Windows build %s, WebView2/.NET: %s %s", build, ok, what)
    if not ok:
        if message_box(f"Bu bilgisayarda {what} yok. Program onsuz açılamaz (pencere siyah kalır).\n\n"
                       "İndirme sayfası açılsın mı? Kurduktan sonra programı yeniden aç.", yes_no=True):
            os.startfile(WEBVIEW2_PAGE if "bozuk" in what else WEBVIEW2_URL if "WebView2" in what else "https://dotnet.microsoft.com/download/dotnet-framework")
        return
    # Bazi ekran karti suruculerinde (ozellikle Windows 10) WebView2 siyah cizer; orada GPU'yu kapat.
    # --gpu / --no-gpu ile elle secilebilir.
    if "--no-gpu" in sys.argv or (build < 22000 and "--gpu" not in sys.argv):
        os.environ["WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"] = "--disable-features=ElasticOverscroll --disable-gpu"
        log.info("GPU kapali")
    register_toast_app()

    api = Api()
    window = webview.create_window(
        "Kick İndirici", os.path.join(resource_dir(), "web", "index.html"), js_api=api,
        width=1360, height=880, min_size=(980, 660), background_color="#101010")
    api._window = window
    window.events.shown += lambda: dark_titlebar(window)

    class Webview2Failed(logging.Handler):
        """pywebview, WebView2 baslatilamazsa sadece log yazip pencereyi siyah birakir; kullaniciya gosterir."""
        def emit(self, record):
            if "WebView2 initialization failed" not in record.getMessage():
                return
            def report():   # arayuz thread'ini bekletmemek icin ayri thread
                if message_box("WebView2 başlatılamadı, kurulumu bozuk görünüyor (pencere siyah kalır).\n\n"
                               "Çözüm: açılacak sayfada \"Evergreen Bağımsız Kurulum\" → x64'ü indirip yönetici "
                               "olarak kur. \"Zaten kurulu\" derse önce Uygulamalar'dan WebView2 Runtime'ı kaldır.\n\n"
                               "İndirme sayfası açılsın mı?", yes_no=True):
                    os.startfile(WEBVIEW2_PAGE)
                window.destroy()
            threading.Thread(target=report, daemon=True).start()

    logging.getLogger("pywebview").addHandler(Webview2Failed())

    def on_closing():
        # Arayuz thread'inde calisir: evaluate_js'e giden hicbir sey (or. cancel_all -> _push) cagrilmamali.
        busy = any(d.status in ACTIVE_ALL for d in api._downloads.values())
        if busy and not window.create_confirmation_dialog(
                "Çıkış", "İndirmeler sürüyor. Durdurup çıkılsın mı? (Yarım kalanlar sonra kaldığı yerden devam eder.)"):
            return False
        api._closing = True
        api._dirty.set()
        for d in list(api._downloads.values()):
            d.cancel = True
        return True

    window.events.closing += on_closing
    # Her acilista temiz WebView2 profili: eski surumun onbellege alinmis HTML/CSS'i gelmesin
    profile = tempfile.mkdtemp(prefix="kickindirici-")
    # paketli exe ikonunu kendi dosyasindan alir; kaynaktan calisirken pencereye ayrica ver
    icon = None if getattr(sys, "frozen", False) else os.path.join(app_dir(), "assets", "app.ico")
    webview.start(debug="--debug" in sys.argv, private_mode=True, storage_path=profile, icon=icon)
    api._stop_recordings()
    api._persist_queue()
    shutil.rmtree(profile, ignore_errors=True)
    os._exit(0)


if __name__ == "__main__":
    main()
