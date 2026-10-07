"""Guncelleme: GitHub surumunu denetler, manifest.json'a gore degisen dosyalari indirip yerine koyar.

Akis: check_update() -> install_update(restart) -> update_progress() ile "downloading" -> "ready".
"ready" olunca restart_to_update() hemen uygular ve yeni surumu acar; cagrilmazsa program kapanirken
uygulanir, bir sonraki acilis yeni surumle olur. Ayrinti: services/updater.py.
"""

import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import urllib.error
import urllib.parse
import urllib.request

from kickindir.config import ACTIVE_ALL, DATA_DIR, UPDATE_REPO, VERSION, app_dir, log
from kickindir.services import updater

UA = f"KickIndirici/{VERSION}"
BUSY = "Sürmekte olan indirmeler var. Bitince ya da durdurunca güncelle."


def _get_json(url, timeout=10):
    req = urllib.request.Request(url, headers={"Accept": "application/vnd.github+json", "User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def _clean_env():
    """Baslatilan yeni exe bu surecin PyInstaller ortamini miras almasin; yoksa kapanan surumun
    gecici klasorunu (_MEI...) kullanmaya calisir ve "Failed to load Python DLL" der."""
    env = {k: v for k, v in os.environ.items() if not k.startswith("_PYI") and k != "_MEIPASS2"}
    env["PYINSTALLER_RESET_ENVIRONMENT"] = "1"
    return env


def _spawn(args):
    subprocess.Popen(args, creationflags=subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP,
                     close_fds=True, env=_clean_env())


class UpdateMixin:
    """Surum denetimi, indirme, uygulama ve yeniden baslatma."""

    _release = None             # son check_update'in buldugu surum: {"version", "mode", "manifest" | "setup"}
    _update_state = {"phase": "idle", "done": 0, "total": 0, "error": ""}
    _update_ready = None        # "ready" olunca uygulanacak is: ("files", need, remove) ya da ("installer", yol)
    _update_applied = False
    _just_updated = False      # bu acilis bir guncellemeden hemen sonra mi (app.main koyar)
    _apply_lock = threading.Lock()

    def check_update(self):
        """GitHub'daki son surum bundan yeniyse {"update": True, "version", "url", "notes", "auto"}.
        auto: program kendini guncelleyebilir (degilse arayuz surum sayfasini acar)."""
        none = {"ok": True, "update": False, "current": VERSION}
        try:
            rel = _get_json(f"https://api.github.com/repos/{UPDATE_REPO}/releases/latest")
        except urllib.error.HTTPError as e:
            if e.code == 404:                 # henuz surum yayinlanmamis
                return none
            log.info("guncelleme kontrolu: %s", e)
            return {**none, "ok": False}
        except Exception as e:  # noqa: BLE001 - guncelleme kontrolu hicbir seyi durdurmaz
            log.info("guncelleme kontrolu: %s", e)
            return {**none, "ok": False}
        latest = (rel.get("tag_name") or "").lstrip("vV")

        def parts(v):
            return tuple(int(x) for x in re.findall(r"\d+", v)[:3])
        if not latest or parts(latest) <= parts(VERSION):
            return none
        assets = {a.get("name"): a.get("browser_download_url") for a in rel.get("assets") or []}
        self._release = {"version": latest, "mode": None}
        frozen = getattr(sys, "frozen", False)
        manifest = None
        if frozen and assets.get("manifest.json"):
            try:
                manifest = _get_json(assets["manifest.json"])
            except Exception as e:  # noqa: BLE001
                log.info("manifest okunamadi: %s", e)
        setup = (manifest or {}).get("installer") or next(
            (u for n, u in assets.items() if re.fullmatch(r"KickIndirici-Setup-.*\.exe", n or "")), None)
        if manifest and updater.usable(manifest) and updater.writable(app_dir()):
            self._release.update(mode="files", manifest=manifest)
        elif frozen and setup and os.path.exists(os.path.join(app_dir(), "unins000.exe")):
            self._release.update(mode="installer", setup=setup)   # yeni manifest bicimi ya da yazilamayan klasor
        return {"ok": True, "update": True, "current": VERSION, "version": latest,
                "url": rel.get("html_url") or f"https://github.com/{UPDATE_REPO}/releases",
                "auto": bool(self._release["mode"]), "notes": (rel.get("body") or "")[:600]}

    def just_updated(self):
        """Guncellemeden sonraki ilk acilissa {"version", "url"}: arayuz "guncellendi" bildirimi gosterir."""
        if not self._just_updated:
            return None
        return {"version": VERSION, "url": f"https://github.com/{UPDATE_REPO}/releases/tag/v{VERSION}"}

    def install_update(self, restart=True):
        """Guncellemeyi arka planda indirir ve hemen doner; ilerleme update_progress() ile sorulur.
        restart: indirme bitince hemen uygulanir ve yeni surum acilir; degilse "ready" olur."""
        rel = self._release
        if not rel or not rel.get("mode"):
            return {"ok": False, "error": "Bu kurulum kendini güncelleyemiyor; sürüm sayfasından indir."}
        if restart and self._busy():
            return {"ok": False, "error": BUSY}
        phase = self._update_state["phase"]
        if phase in ("downloading", "installing"):
            return {"ok": True, "started": False}
        if phase == "ready":
            return self.restart_to_update() if restart else {"ok": True, "started": False}
        self._update_state = {"phase": "downloading", "done": 0, "total": 0, "error": ""}
        threading.Thread(target=self._update_worker, args=(rel, bool(restart)), daemon=True).start()
        return {"ok": True, "started": True}

    def update_progress(self):
        """{"phase": idle|downloading|ready|installing|error, "done": bayt, "total": bayt (0 = bilinmiyor), "error": metin}"""
        return dict(self._update_state)

    def restart_to_update(self):
        """Hazir guncellemeyi simdi uygular ve programi yeni surumle yeniden acar."""
        if not self._update_ready:
            return {"ok": False, "error": "Uygulanacak güncelleme yok."}
        if self._busy():
            return {"ok": False, "error": BUSY}
        try:
            with self._apply_lock:
                self._apply(relaunch=True)
        except (updater.UpdateError, OSError) as e:
            log.info("guncelleme uygulanamadi: %s", e)
            msg = str(e) if isinstance(e, updater.UpdateError) else "Güncelleme başlatılamadı."
            self._update_state.update(phase="error", error=msg)
            return {"ok": False, "error": msg}
        self._update_state["phase"] = "installing"
        # exe degisti: bu surec artik yeni modul yukleyemez, hemen kapanir; yeni surum kilidin birakilmasini bekler
        threading.Timer(0.6, self.exit_now).start()
        return {"ok": True}

    def _apply_pending_update(self):
        """Program kapanirken, os._exit'ten hemen once: hazir guncelleme varsa uygular, programi yeniden acmaz.
        Son is olmali: exe degistikten sonra bu surec yeni modul yukleyemez (onefile arsivi artik yeni exe)."""
        with self._apply_lock:      # pencere kapanisi ve main() sonu ayni anda gelebilir
            if not self._update_ready or self._update_applied:
                return
            try:
                self._apply(relaunch=False)
            except (updater.UpdateError, OSError) as e:
                log.info("kapanista guncelleme uygulanamadi: %s", e)

    def _busy(self):
        return any(d.status in ACTIVE_ALL for d in self._downloads.values())

    def _apply(self, relaunch):
        kind, *rest = self._update_ready
        if kind == "files":
            need, remove = rest
            updater.apply(need, remove, app_dir())
            updater.set_installed_version(self._release["version"])
            updater.mark_updated(DATA_DIR, self._release["version"])
            if relaunch:
                _spawn([sys.executable, "--after-update"])
        else:
            # kurucu: /SILENT ilerleme penceresi gosterir; kapanista /VERYSILENT ve program yeniden acilmaz
            args = [rest[0], "/SILENT" if relaunch else "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART",
                    "/CLOSEAPPLICATIONS", "/LOG=" + os.path.join(DATA_DIR, "update.log")]
            _spawn(args if relaunch else args + ["/NORUN=1"])
        self._update_applied = True

    def _update_worker(self, rel, restart):
        state = self._update_state

        def progress(done, total):
            state["done"], state["total"] = done, total
        try:
            if rel["mode"] == "files":
                manifest = rel["manifest"]
                need = updater.plan(manifest, app_dir())
                updater.download(need, app_dir(), UA, progress)
                self._update_ready = ("files", need, manifest.get("remove") or [])
            else:
                path = os.path.join(tempfile.gettempdir(), os.path.basename(urllib.parse.urlparse(rel["setup"]).path))
                self._download_plain(rel["setup"], path, progress)
                self._update_ready = ("installer", path)
        except updater.UpdateError as e:
            log.info("guncelleme indirilemedi: %s (%s)", e, e.__cause__)
            state.update(phase="error", error=str(e))
            return
        except Exception as e:  # noqa: BLE001
            log.info("guncelleme indirilemedi: %s", e)
            state.update(phase="error", error="Güncelleme indirilemedi. İnterneti kontrol et.")
            return
        state["phase"] = "ready"
        if restart:
            self.restart_to_update()

    @staticmethod
    def _download_plain(url, path, progress):
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=30) as r, open(path, "wb") as f:
            total, done = int(r.headers.get("Content-Length") or 0), 0
            while chunk := r.read(updater.CHUNK):
                f.write(chunk)
                done += len(chunk)
                progress(done, total)
