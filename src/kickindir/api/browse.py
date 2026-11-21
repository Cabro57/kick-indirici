"""Kanal ve VOD gozatma: klipler, kaynak adresleri, serit onizlemeleri."""

import re
import time
from curl_cffi import requests as cffi_requests

from kickindir.config import log
from kickindir.core.i18n import t
from kickindir.services.kick import fetch_clips, kick_get, playlist_duration
from kickindir.services.media import MediaStrip, ThumbCache


class BrowseMixin:
    """Kanal ve VOD gozatma: klipler, kaynak adresleri, serit onizlemeleri."""

    def list_clips(self, slug, sort="date", cursor=None):
        try:
            clips, nxt = fetch_clips(slug, sort, cursor)
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": t("err.clips", e=str(e)[:120])}
        return {"ok": True, "clips": clips, "cursor": nxt if clips else None}

    def vod_source(self, uuid, live=False):
        """Kesit secicideki onizleme oynaticisi icin VOD'un HLS adresi. Suren yayinin VOD'u da
        acilir: listesi her istekte yayinin birkac sn gerisine kadar uzar. live ise o anki
        uzunluk da doner (duration); oynatici sondan baslasin."""
        try:
            v = kick_get(f"https://kick.com/api/v1/video/{uuid}")
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

    def thumb_cache_info(self):
        """Ayarlar: kare onbelleginin diskte kapladigi bayt ve siniri (MB)."""
        return {"bytes": ThumbCache.size(), "limitMB": ThumbCache.limit >> 20}

    def thumb_cache_clear(self):
        """Ayarlar: diskteki kare onbelleginin tamamini siler; acik seritlerin bellekteki kareleri kalir."""
        ThumbCache.clear()
        return self.thumb_cache_info()

    def strip_thumbs(self, uuid, indices):
        """Uzak gorunum icin parcalarin ilk kareleri: {"i": data URL ya da ""}. Tam veriden hizli."""
        strip = self._strips.get(uuid)
        if not strip:
            return {}
        idx = [i for i in indices or [] if 0 <= i < len(strip.segments)][:64]
        try:
            t0 = time.monotonic()
            out = {str(i): f for i, f in zip(idx, self._strip_pool.map(strip.thumb, idx))}
            log.info("perf serit kareleri: %d parca, %.2f sn", len(idx), time.monotonic() - t0)
            return out
        except Exception as e:  # noqa: BLE001
            log.info("serit kareleri alinamadi: %s", e)
            return {}
