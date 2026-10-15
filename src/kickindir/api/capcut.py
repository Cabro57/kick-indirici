"""CapCut'a aktarma: indirilen videodan ya da kesit editorundeki kesitlerden CapCut taslagi."""

import json
import os
import subprocess
import threading
import time

from kickindir.config import ACTIVE_ALL, log
from kickindir.services import capcut
from kickindir.core.i18n import t
from kickindir.core.util import UserError, fmt_hms


def chat_video_for(path):
    """Videonun yanindaki sohbet videosu (.chat.mp4 / .chat.webm); yoksa None."""
    base = os.path.splitext(path)[0]
    return next((base + ext for ext in (".chat.mp4", ".chat.webm") if os.path.isfile(base + ext)), None)


class CapcutMixin:
    """CapCut'a aktarma: indirilen videodan ya da kesit editorundeki kesitlerden CapCut taslagi."""

    def _capcut_draft(self, clips, name):
        """Taslagi yazar, CapCut'i acar. Doner: {"ok", "name"} ya da {"ok": False, "error"}."""
        try:
            folder = capcut.write_draft(self._ffmpeg, clips, name)
        except UserError as err:
            return {"ok": False, "error": str(err)}
        except (OSError, subprocess.SubprocessError) as err:
            log.info("capcut taslagi yazilamadi: %s", err)
            return {"ok": False, "error": t("err.capcutWrite")}
        capcut.launch()
        return {"ok": True, "name": os.path.basename(folder)}

    def capcut_open(self, path, with_chat=False):
        """Indirilenler'deki videodan taslak. with_chat: yanindaki sohbet videosu ust ize eklenir."""
        with self._lock:
            e = next((x for x in self._history if x["file"] == path and not x.get("chat")), None)
        if not e or not os.path.isfile(path):
            return {"ok": False, "error": t("err.fileGone")}
        if not capcut.capcut_exe():
            return {"ok": False, "error": t("err.capcutMissing")}
        name = os.path.splitext(os.path.basename(path))[0]
        if e.get("channel") and e.get("section"):
            name = f"{e['channel']} {fmt_hms(e['section'][0])}-{fmt_hms(e['section'][1])}"
        return self._capcut_draft([(path, chat_video_for(path) if with_chat else None)], name)

    def capcut_cuts(self, items, name):
        """Kesit editorunden: kesitleri siraya koyar (enqueue ile ayni ogeler), hepsi inince tek taslakta
        arka arkaya dizer ve CapCut'i acar. Sonuc arayuze bildirim olarak gider."""
        if not capcut.capcut_exe():
            return {"ok": False, "error": t("err.capcutMissing")}
        keys = []
        for it in items or []:
            secs, section = self._spans(it)
            if secs is False or not it.get("url"):
                continue
            span = ("#" + ",".join(f"{a}-{b}" for a, b in secs) if secs
                    else f"#{section[0]}-{section[1]}" if section else "")
            keys.append((it["url"] + span, it["url"] + "#chat" + span if it.get("withChat") else None))
        if not keys:
            return {"ok": False, "error": t("err.fileGone")}
        added = self.enqueue(items)
        threading.Thread(target=self._capcut_wait, args=(keys, name), daemon=True).start()
        return {"ok": True, "added": added}

    def _capcut_wait(self, keys, name):
        """Kesitlerin (ve istendiyse sohbetlerinin) inmesini bekler. Biri hata verir, durur ya da listeden
        kalkarsa vazgecer."""
        def latest(key):
            found = [d for d in list(self._downloads.values()) if d.key == key]
            return max(found, key=lambda d: d.id) if found else None

        while not self._closing:
            time.sleep(2)
            videos = [latest(v) for v, _ in keys]
            if any(d is None or d.status in ("error", "stopped") for d in videos):
                self._capcut_notify({"ok": False, "error": t("capcut.cutsFailed")})
                return
            chats = [latest(c) for _, c in keys if c]
            if any(d.status not in ("done",) for d in videos) or \
                    any(d and (d.status == "queued" or d.status in ACTIVE_ALL) for d in chats):
                continue
            clips = [(d.filename, chat_video_for(d.filename) if c else None) for d, (_, c) in zip(videos, keys)]
            self._capcut_notify(self._capcut_draft(clips, name))
            return

    def _capcut_notify(self, result):
        if self._window:
            self._window.evaluate_js(f"window.app && window.app.capcutDone({json.dumps(result, ensure_ascii=False)})")
