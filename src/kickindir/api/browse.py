"""Kanal ve VOD gozatma: klipler, kaynak adresleri, serit onizlemeleri."""

import re
import time
from curl_cffi import requests as cffi_requests

from kickindir.config import log
from kickindir.core.i18n import t
from kickindir.services.kick import fetch_clips, playlist_duration, video_info
from kickindir.services.media import MediaStrip, ThumbCache
from kickindir.services import thumbcheck


class BrowseMixin:
    """Kanal ve VOD gozatma: klipler, kaynak adresleri, serit onizlemeleri."""

    def list_clips(self, slug, sort="date", cursor=None):
        try:
            clips, nxt = fetch_clips(slug, sort, cursor)
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": t("err.clips", e=str(e)[:120])}
        return {"ok": True, "clips": clips, "cursor": nxt if clips else None}

    def vod_source(self, uuid, live=False, fresh=False):
        """Kesit secicideki onizleme oynaticisi icin VOD'un HLS adresi. Suren yayinin VOD'u da
        acilir: listesi her istekte yayinin birkac sn gerisine kadar uzar. live ise o anki
        uzunluk da doner (duration); oynatici sondan baslasin. fresh: diskteki adres olmus
        (VOD silindi / tasindi); diskteki listeyi atar, adres API'den yeniden alinir."""
        if fresh:
            ThumbCache.remove(ThumbCache.dir_for(uuid), "index.json")
            if getattr(self._strips.get(uuid), "final", False):
                self._strips.pop(uuid, None)
            saved = None
        else:
            saved = None if live else MediaStrip.saved_index(uuid)     # bitmis yayin: adres diskte, API cagrisi yok
        if saved:
            return {"ok": True, "source": saved["source"]}
        try:
            v = video_info(uuid)
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": t("err.videoOpen", e=str(e)[:120])}
        if not v.get("source"):
            return {"ok": False, "error": t("err.noSource")}
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
            return {"ok": False, "error": t("err.badLiveUrl")}
        try:
            r = cffi_requests.get(url, impersonate="chrome", timeout=15)
            r.raise_for_status()
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": t("err.liveOpen", e=str(e)[:120])}
        return {"ok": True, "text": r.text}

    def strip_index(self, uuid, fresh=False):
        """Zaman cizelgesindeki kare/ses seridinin parca listesi: [[baslangic, sure], ...].
        fresh: suren yayinda listeyi yeniden okur (yeni parcalar sona eklenir)."""
        log.info("serit listesi istendi: %s (ffmpeg: %s)", uuid, self._ffmpeg)
        if not self._ffmpeg:
            return {"ok": False, "error": t("err.stripNoFfmpeg")}
        t0 = time.monotonic()
        try:
            if uuid not in self._strips:
                self._strips[uuid] = MediaStrip(uuid, self._ffmpeg)
            elif fresh:
                self._strips[uuid].refresh()
        except Exception as e:  # noqa: BLE001
            log.info("serit listesi alinamadi (%s): %s", uuid, e)
            return {"ok": False, "error": t("err.strip", e=str(e)[:120])}
        log.info("perf serit listesi: %.2f sn", time.monotonic() - t0)
        return {"ok": True, "segments": self._strips[uuid].index(),
                "peaksPerSec": MediaStrip.PEAKS_PER_SEC, "frameEvery": MediaStrip.FRAME_EVERY}

    def strip_data(self, uuid, indices, peaks_only=False):
        """Istenen parcalarin karelerini ve ses tepe degerlerini paralel isleyip dondurur.
        peaks_only: kareler yanitta yok ve sunucu da bellekte tutmaz (arka planda tum yayinin dalgasi;
        kareler yalnizca diske yazilir)."""
        strip = self._strips.get(uuid)
        if not strip:
            log.info("serit verisi istendi ama liste yok: %s", uuid)
            return {}
        idx = [i for i in indices or [] if 0 <= i < len(strip.segments)][:16]
        try:
            t = time.monotonic()
            out = {str(i): d for i, d in zip(idx, self._strip_pool.map(strip.peaks if peaks_only else strip.get, idx))}
            log.info("serit verisi: %d parca, %d karesi dolu, %.1f sn%s", len(out),
                     sum(1 for d in out.values() if d.get("frames")), time.monotonic() - t, " (yalniz tepe)" if peaks_only else "")
            return out
        except Exception as e:  # noqa: BLE001
            log.info("serit parcalari alinamadi: %s", e)
            return {}

    def vod_poster(self, uuid, duration=0):
        """Kapagi eksik / bozuk VOD icin gercek kare (data URL; alinamazsa ""): suresinin ~%20'sindeki parcanin
        ilk karesi, tek 32 KB'lik Range istegi, diske onbelleklenir. Ayri havuz (en cok 2 es zamanli)."""
        if not self._ffmpeg or not uuid:
            return ""
        try:
            strip = self._strips.get(uuid)
            if not strip:
                strip = self._strips[uuid] = MediaStrip(uuid, self._ffmpeg)
            if not strip.segments:
                return ""
            total = strip.segments[-1][0] + strip.segments[-1][1]
            i = strip.segment_at(float(duration or total) * 0.2)
            return self._poster_pool.submit(strip.poster, i).result()
        except Exception as e:  # noqa: BLE001
            log.info("vod kapagi alinamadi (%s): %s", uuid, e)
            return ""

    def thumb_check(self, url, strict=False):
        """Kapak resmi parazit / statik mi? {"noise": bool}. Sezgi services/thumbcheck.py'de; sonuc URL basina
        onbelleklenir. strict: klipler (yerine gercek kare yok) icin daha siki esik."""
        if not isinstance(url, str) or not url.startswith(("http://", "https://")):
            return {"noise": False}
        try:
            return self._poster_pool.submit(thumbcheck.check, url, bool(strict)).result()
        except Exception as e:  # noqa: BLE001
            log.info("kapak kontrolu basarisiz: %s", e)
            return {"noise": False}

    def thumb_cache_info(self):
        """Ayarlar: kare onbelleginin diskte kapladigi bayt ve siniri (MB)."""
        return {"bytes": ThumbCache.size(), "limitMB": ThumbCache.limit >> 20}

    def thumb_cache_clear(self):
        """Ayarlar: diskteki kare onbelleginin tamamini siler; acik seritlerin bellekteki kareleri kalir."""
        ThumbCache.clear()
        return self.thumb_cache_info()

    def strip_peek(self, uuid, t):
        """Kart onizlemesinin zaman cubugu: t saniyesindeki kare ("" olabilir) YALNIZCA onbellekten
        (bellek / disk); ag cagrisi yapmaz. Liste bellekte ya da diskte yoksa bos doner."""
        strip = self._strips.get(uuid)
        if not strip and MediaStrip.saved_index(uuid):
            try:
                strip = self._strips[uuid] = MediaStrip(uuid, self._ffmpeg)    # diskten: ag yok
            except Exception as e:  # noqa: BLE001
                log.info("serit onizleme listesi acilamadi (%s): %s", uuid, e)
                return ""
        if not strip or not strip.segments:
            return ""
        try:
            return strip.thumb_cached(strip.segment_at(float(t)))
        except (TypeError, ValueError):
            return ""

    def strip_thumbs(self, uuid, indices):
        """Uzak gorunum icin parcalarin ilk kareleri: {"i": data URL ya da ""}. Tam veriden hizli."""
        strip = self._strips.get(uuid)
        if not strip:
            return {}
        idx = [i for i in indices or [] if 0 <= i < len(strip.segments)][:64]
        try:
            t0 = time.monotonic()
            # basarili: {"f": data URL, "l": ses seviyesi 0..255 ya da None}; basarisiz: ""
            out = {str(i): {"f": f, "l": strip.levels.get(i)} if f else ""
                   for i, f in zip(idx, self._strip_pool.map(strip.thumb, idx))}
            log.info("perf serit kareleri: %d parca, %.2f sn", len(idx), time.monotonic() - t0)
            return out
        except Exception as e:  # noqa: BLE001
            log.info("serit kareleri alinamadi: %s", e)
            return {}
