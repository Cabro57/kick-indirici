"""Uygulama genelindeki JS cagrilari: baslangic, pano, guncelleme, ayarlar."""

import json
import os
import re
import subprocess
import tempfile
import threading
import time
import urllib.parse
import urllib.request
import webview

from kickindir.config import ACTIVE_ALL, AFTER_DONE, DATA_DIR, FRAG_THREADS, FRAG_THREADS_MAX, MAX_PARALLEL, NAME_DEFAULT, NAME_TOKENS, QUALITIES, UPDATE_REPO, VERSION, app_dir, log
from kickindir.core.engine import LIMITER
from kickindir.services.kick import fetch_channel, kick_error, parse_link, vod_channel
from kickindir.core.prefs import PREFS, int_or_auto
from kickindir.core.util import clipboard_text


class AppMixin:
    """Uygulama genelindeki JS cagrilari: baslangic, pano, guncelleme, ayarlar."""

    def init(self):
        self._ready = True
        return {"folder": self._folder, "quality": self._quality, "qualities": QUALITIES,
                "ffmpeg": bool(self._ffmpeg), "fragThreads": self._frag_threads(), "maxParallel": MAX_PARALLEL,
                "settings": self.get_settings(), "favorites": self.favorites(), "version": VERSION,
                "restored": self._restored}

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
                d.cancel, d.discard, d.error, d.status = False, False, "", "queued"
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
        setup = next((a.get("browser_download_url") for a in rel.get("assets") or []
                      if re.fullmatch(r"KickIndirici-Setup-.*\.exe", a.get("name") or "")), None)
        # uygulama-ici kurulum yalnizca kurucuyla kurulmus surumde (yaninda unins000.exe var) sunulur
        installed = os.path.exists(os.path.join(app_dir(), "unins000.exe"))
        return {"ok": True, "update": bool(latest) and parts(latest) > parts(VERSION), "current": VERSION,
                "version": latest, "url": rel.get("html_url") or f"https://github.com/{UPDATE_REPO}/releases",
                "setup": setup if installed else None, "notes": (rel.get("body") or "")[:600]}

    _update_state = {"phase": "idle", "done": 0, "total": 0, "error": ""}

    def install_update(self, url):
        """Guncellemeyi arka planda baslatir ve hemen doner. Ilerleme update_progress() ile sorulur:
        indirme biter, kurucu sessizce calisir, uygulama kapanir ve kurucu yeni surumu acar."""
        prefix = f"https://github.com/{UPDATE_REPO}/releases/download/"
        if not (isinstance(url, str) and url.startswith(prefix) and url.endswith(".exe")):
            return {"ok": False, "error": "Geçersiz güncelleme adresi."}
        if any(d.status in ACTIVE_ALL for d in self._downloads.values()):
            return {"ok": False, "error": "Sürmekte olan indirmeler var. Bitince ya da durdurunca güncelle."}
        if self._update_state["phase"] in ("downloading", "installing"):
            return {"ok": True, "started": False}
        self._update_state = {"phase": "downloading", "done": 0, "total": 0, "error": ""}
        threading.Thread(target=self._update_worker, args=(url,), daemon=True).start()
        return {"ok": True, "started": True}

    def update_progress(self):
        """{"phase": idle|downloading|installing|error, "done": bayt, "total": bayt (0 = bilinmiyor), "error": metin}"""
        return dict(self._update_state)

    def _update_worker(self, url):
        state = self._update_state
        path = os.path.join(tempfile.gettempdir(), os.path.basename(urllib.parse.urlparse(url).path))
        try:
            req = urllib.request.Request(url, headers={"User-Agent": f"KickIndirici/{VERSION}"})
            with urllib.request.urlopen(req, timeout=30) as r, open(path, "wb") as f:
                state["total"] = int(r.headers.get("Content-Length") or 0)
                while chunk := r.read(256 * 1024):
                    f.write(chunk)
                    state["done"] += len(chunk)
        except Exception as e:  # noqa: BLE001
            log.info("guncelleme indirilemedi: %s", e)
            state.update(phase="error", error="Güncelleme indirilemedi. İnterneti kontrol et.")
            return
        state["phase"] = "installing"
        # kurucunun actigi yeni exe bu surecin PyInstaller ortamini miras almasin
        env = {k: v for k, v in os.environ.items() if not k.startswith("_PYI") and k != "_MEIPASS2"}
        env["PYINSTALLER_RESET_ENVIRONMENT"] = "1"
        try:
            subprocess.Popen([path, "/SILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/CLOSEAPPLICATIONS",
                              "/LOG=" + os.path.join(DATA_DIR, "update.log")],
                             creationflags=subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP,
                             close_fds=True, env=env)
        except OSError as e:
            log.info("kurucu baslatilamadi: %s", e)
            state.update(phase="error", error="Kurucu başlatılamadı.")
            return
        # /SILENT: kurucu kendi ilerleme penceresini gosterir; pencere kapaninca arada bos ekran kalmaz
        time.sleep(1.5)     # arayuz "kuruluyor" durumunu bir an gosterebilsin
        self.exit_now()

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

    def client_log(self, msg):
        """Arayuz tarafindaki hatalari ayni log dosyasina yazar."""
        log.info("arayuz: %s", str(msg)[:500])

    def pick_folder(self):
        res = self._window.create_file_dialog(webview.FileDialog.FOLDER, directory=self._folder)
        if res:
            self._folder = res[0]
            self._save()
        return self._folder
