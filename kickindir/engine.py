"""Indirme motoru: hiz sinirlayici, otomatik ayar, indirme kaydi."""

import collections
import itertools
import re
import threading
import time
from yt_dlp.downloader.common import FileDownloader

from .config import MAX_PARALLEL, NAME_TOKENS
from .util import fmt_hms


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
        self.discard = False   # kullanici iptal etti: yarim kalan dosyalar silinir (kapanista silinmez, devam edilir)
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
