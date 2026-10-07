"""Indirilenler kutuphanesi: liste, dosya ve klasor islemleri."""

import base64
import os
import shutil
import subprocess
import tempfile

from kickindir.config import log
from kickindir.services.media import MediaServer
from kickindir.core.storage import save_history
from kickindir.core.i18n import t
from kickindir.core.util import recycle


class LibraryMixin:
    """Indirilenler kutuphanesi: liste, dosya ve klasor islemleri."""

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
                return {"ok": False, "error": t("err.deleteFile")}
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
            return {"ok": False, "error": t("err.fileGone")}
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
