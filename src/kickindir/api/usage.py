"""Anonim kullanim verisinin olaylari (izin Ayarlar'da / ilk acilista). Gonderim: services.telemetry."""

import re
import threading
import time

from kickindir.config import MAX_PARALLEL
from kickindir.core.i18n import lang
from kickindir.services.kick import parse_link
from kickindir.services.telemetry import hardware, scrub

# arayuzun bildirebilecegi ozellik olaylari (baska ad gelirse yok sayilir)
UI_EVENTS = {"cut_editor_open", "cut_download", "chat_panel", "chat_image", "chat_video_selection", "chat_video_file",
             "watch_open", "channel_open", "favorite_add", "live_record", "cuts_import", "cuts_export", "settings_open"}


class UsageMixin:
    def _usage_start(self):
        """Acilis olayi: surum, dil, ayarlar ve donanim (donanim okumasi ~3 sn, arka planda)."""
        if self._usage_started:
            return
        self._usage_started = True

        def run():
            props = {"lang": lang(), "quality": self._quality, "parallel": self._parallel, "frag_threads": self._threads,
                     "speed_limit": self._prefs["speedLimit"], "chat_auto": self._prefs["chatAuto"],
                     "chat_formats": self._prefs["chatFormats"], "favorites": len(self._favorites),
                     "history": len(self._history), "ffmpeg": bool(self._ffmpeg), "max_parallel": MAX_PARALLEL}
            try:
                props.update(hardware(self._folder))
            except Exception as e:  # noqa: BLE001 - donanim okunamazsa acilis olayi yine gider
                props["hardware_error"] = scrub(e)[:200]
            self._usage.track("app_start", props)
        threading.Thread(target=run, daemon=True).start()

    def track(self, name, props=None):
        """Arayuzden ozellik kullanimi."""
        if name in UI_EVENTS:
            clean = {k: v for k, v in (props or {}).items() if isinstance(k, str) and isinstance(v, (str, int, float, bool))}
            self._usage.track(name, {k: (v[:80] if isinstance(v, str) else v) for k, v in list(clean.items())[:10]})

    def client_error(self, message, source="", line=0, stack=""):
        """Arayuzdeki yakalanmamis hata: log'a ve (izin varsa) hata takibine."""
        self.client_log(f"{message} @{line}")
        self._usage.js_error(message, source, line if isinstance(line, int) else 0, stack)

    def _usage_download(self, d):
        """Biten / hata veren indirme: tur, kanal, boyut, sure, hiz, ayarlar. Adres ve baslik gonderilmez."""
        if d.live:
            kind = "live"
        elif d.chat:
            kind = "chat_video" if d.formats == ["video"] else "chat"
        else:
            kind = "merged" if d.sections else "section" if d.section else "clip" if d.short else "vod"
        took = time.time() - d.began if d.began else 0
        props = {"kind": kind, "status": d.status, "channel": self._channel_of(d.url), "bytes": d.size,
                 "seconds": round(took, 1), "parallel_level": self._parallel_limit(), "parallel": self._parallel,
                 "frag_threads": self._frag_threads(), "quality": self._quality,
                 "speed_limit": self._prefs["speedLimit"], "concurrent": self._busy_count()}
        if d.section:
            props["section_seconds"] = sum(b - a for a, b in d.sections) if d.sections else d.section[1] - d.section[0]
        if d.chat:
            props["chat_formats"] = d.formats or self._prefs["chatFormats"]
        if d.status == "done" and took > 0 and d.size and not d.chat:
            props["mb_per_s"] = round(d.size / took / 1024 / 1024, 2)
        if d.status == "error":
            props["error"] = scrub(d.error)[:300]
            props["friendly"] = d.friendly
        self._usage.track("download", props)

    @staticmethod
    def _channel_of(url):
        return parse_link(url)[0] or (re.match(r"https://kick\.com/([\w-]+)/clips?/", url or "") or [None, ""])[1] or ""

    def _busy_count(self):
        return sum(1 for d in list(self._downloads.values()) if d.status in ("preparing", "downloading", "merging"))

    def _usage_close(self):
        self._usage.track("app_close", {"minutes": round((time.time() - self._usage_t0) / 60, 1),
                                        "peak_total_mb_per_s": round(self._usage_peak / 1024 / 1024, 2)})
        self._usage.close()
