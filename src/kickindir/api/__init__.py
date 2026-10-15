"""JS'e acilan Api nesnesi: pywebview bu sinifin acik yontemlerini arayuze verir."""

import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from kickindir.config import FRAG_THREADS_MAX, MAX_PARALLEL, QUALITIES, find_ffmpeg
from kickindir.core.engine import AutoTuner, Download, LIMITER
from kickindir.core.i18n import set_lang
from kickindir.core.prefs import PREFS, int_or_auto
from kickindir.core.storage import clean_cut_set, load_history, load_queue, load_settings
from kickindir.api.general import AppMixin
from kickindir.api.updates import UpdateMixin
from kickindir.api.cuts import CutsMixin
from kickindir.api.favorites import FavoritesMixin
from kickindir.api.browse import BrowseMixin
from kickindir.api.queue_control import QueueMixin
from kickindir.api.library import LibraryMixin
from kickindir.api.workers import WorkerMixin
from kickindir.api.chat import ChatMixin
from kickindir.api.usage import UsageMixin
from kickindir.api.capcut import CapcutMixin
from kickindir.services.telemetry import Telemetry, installer_consent


class Api(AppMixin, UpdateMixin, CutsMixin, FavoritesMixin, BrowseMixin, QueueMixin, LibraryMixin, WorkerMixin, ChatMixin, UsageMixin, CapcutMixin):
    """JS tarafinin cagirdigi metotlar. '_' ile baslayan ozellikler JS'e acilmaz."""

    def __init__(self):
        s = load_settings()
        self._folder = s.get("folder") or os.path.join(os.path.expanduser("~"), "Downloads", "Kick")
        self._quality = s.get("quality") if s.get("quality") in QUALITIES else QUALITIES[0]   # eski "En iyi" -> "best"
        self._parallel = int_or_auto(s.get("parallel"), 1, MAX_PARALLEL)
        self._threads = int_or_auto(s.get("fragThreads"), 1, FRAG_THREADS_MAX)
        self._prefs = {}
        for key, (default, check) in PREFS.items():
            value = check(s[key]) if key in s else None
            self._prefs[key] = default if value is None else value
        set_lang(self._prefs["lang"])
        # kullanim verisi: ilk acilista arayuz sorar. Cevaba kadar olaylar bekler; kurulum sihirbazinda
        # "hayir" dendiyse cevaba kadar hic olay tutulmaz.
        consent = self._prefs["telemetry"]
        self._usage = Telemetry(consent if consent is not None else False if installer_consent() is False else None)
        self._usage_started, self._usage_t0, self._usage_peak = False, time.time(), 0.0
        # favori: {"slug", "name", "avatar", "seen": en son gorulen VOD'un baslangic zamani}
        self._favorites = [f for f in s.get("favorites") or [] if isinstance(f, dict) and f.get("slug")]
        self._fav_lock = threading.Lock()
        # kayitli kesitler: {vod url: {"uuid", "title", "thumb", "start", "duration", "channel", "updated",
        #                              "clips": [{"a", "b", "name", "note"}]}}
        self._cuts = {}
        for url, entry in (s.get("cuts") or {}).items() if isinstance(s.get("cuts"), dict) else ():
            entry = clean_cut_set(url, entry)
            if entry:
                self._cuts[url] = entry
        self._cuts_lock = threading.Lock()
        self._ffmpeg = find_ffmpeg()
        self._downloads = {}
        self._lock = threading.Lock()
        self._tuner = AutoTuner()
        self._window = None
        self._ready = False
        self._last_push = ""
        self._strips = {}
        self._chats = {}                # sohbet paneli kaynaklari (api.chat)
        self._chat_lock = threading.Lock()
        # ilk kareler (strip_thumbs) 32'li gruplar halinde gelir; CDN gecikmesi belirleyici oldugundan
        # cok paralel istek: 8 -> 32 is parcacigi ilk karelerde 17-21 -> 50-65 parca/sn (PERF.md)
        self._strip_pool = ThreadPoolExecutor(max_workers=32)
        self._closing = False
        self._exit_ok = False
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
                             chat=bool(e.get("chat")), with_chat=e.get("withChat") if isinstance(e.get("withChat"), bool) else None)
            except (TypeError, ValueError, IndexError):
                continue
            d.duration = e.get("duration") or 0
            d.chat_range = tuple(e["chatRange"]) if e.get("chatRange") else None
            d.chat_base = e.get("chatBase") or ""
            d.formats = e.get("formats") if isinstance(e.get("formats"), list) else None
            d.video_src = e.get("videoSrc") or ""
            if d.video_src:
                d.key += "#video"
            d.status = "stopped"            # kendiliginden baslamaz; kullanici "devam" der
            self._downloads[d.id] = d
            self._restored += 1
        self._saved_queue = None
        threading.Thread(target=self._scheduler, daemon=True).start()
        threading.Thread(target=self._pusher, daemon=True).start()
        threading.Thread(target=self._watch_live, daemon=True).start()
