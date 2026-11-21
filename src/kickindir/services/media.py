"""Videoyu izlemek icin: serit onizlemeleri ve yerel medya sunucusu."""

import array
import base64
import http.server
import json
import mimetypes
import os
import re
import secrets
import shutil
import subprocess
import tempfile
import threading
import urllib.request
from curl_cffi import requests as cffi_requests

from kickindir.config import DATA_DIR, log
from kickindir.services.kick import hls_variants, video_info


class ThumbCache:
    """Serit karelerinin disk onbellegi: DATA_DIR/thumbs/<uuid>/<dosya>. Ham JPEG ve tepe degerleri
    dosya olarak durur. Boyut siniri `limit` (bayt, 0 = kapali); asilinca en eski (mtime) dosyalar silinir,
    okunan dosyanin mtime'i yenilenir (LRU). Temizlik arka planda; serit havuzunu bekletmez."""

    root = os.path.join(DATA_DIR, "thumbs")
    limit = 200 << 20
    _lock = threading.Lock()
    _added = 0              # son temizlikten beri yazilan bayt
    _trimming = False

    @classmethod
    def dir_for(cls, uuid):
        """Yayinin klasoru; uuid beklenen bicimde degilse None (yol karistirmasin)."""
        return os.path.join(cls.root, uuid) if re.fullmatch(r"[0-9a-f-]{36}", str(uuid)) else None

    @classmethod
    def read(cls, folder, name):
        if not folder or not cls.limit:
            return None
        path = os.path.join(folder, name)
        try:
            with open(path, "rb") as f:
                data = f.read()
            os.utime(path)
            return data
        except OSError:
            return None

    @classmethod
    def remove(cls, folder, name):
        try:
            os.remove(os.path.join(folder, name))
        except (OSError, TypeError):
            pass

    @classmethod
    def write(cls, folder, name, data):
        if not folder or not cls.limit:
            return
        try:
            os.makedirs(folder, exist_ok=True)
            path = os.path.join(folder, name)
            tmp = f"{path}.{threading.get_ident()}.tmp"
            with open(tmp, "wb") as f:
                f.write(data)
            os.replace(tmp, path)
        except OSError as e:
            log.info("kare onbellegi yazilamadi: %s", e)
            return
        with cls._lock:
            cls._added += len(data)
            due = cls._added > max(5 << 20, cls.limit // 10) and not cls._trimming
        if due:
            cls.trim_async()

    @classmethod
    def _files(cls):
        out = []
        for base, _, names in os.walk(cls.root):
            for n in names:
                p = os.path.join(base, n)
                try:
                    st = os.stat(p)
                except OSError:
                    continue
                out.append((st.st_mtime, st.st_size, p))
        return out

    @classmethod
    def size(cls):
        return sum(s for _, s, _ in cls._files())

    @classmethod
    def trim(cls):
        """Siniri asan kismi en eski dosyalardan baslayarak siler."""
        with cls._lock:
            if cls._trimming:
                return
            cls._trimming, cls._added = True, 0
        try:
            files = cls._files()
            total = sum(s for _, s, _ in files)
            for _, size, path in sorted(files):
                if total <= cls.limit:
                    break
                try:
                    os.remove(path)
                    total -= size
                except OSError:
                    pass
            for base, _, _ in os.walk(cls.root, topdown=False):     # bosalan yayin klasorleri
                if base != cls.root and not os.listdir(base):
                    os.rmdir(base)
        except OSError as e:
            log.info("kare onbellegi temizlenemedi: %s", e)
        finally:
            cls._trimming = False

    @classmethod
    def trim_async(cls):
        threading.Thread(target=cls.trim, daemon=True).start()

    @classmethod
    def set_limit_mb(cls, mb):
        cls.limit = int(mb) << 20
        cls.trim_async()

    @classmethod
    def clear(cls):
        shutil.rmtree(cls.root, ignore_errors=True)
        with cls._lock:
            cls._added = 0


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
        self.cache = {}
        self.thumbs = {}
        self.levels = {}        # parca -> ilk saniyenin ses tepe degeri (0..255): uzak gorunumde kaba dalga
        self.lock = threading.Lock()
        self.dir = ThumbCache.dir_for(uuid)
        self.final = False      # bitmis yayinin listesi degismez: diskten gelir, yenilenmez
        saved = self.saved_index(uuid)
        if saved:
            self.media_url = saved["media"]
            self._set_segments(saved["segs"])
            self.final = True
            log.info("serit listesi diskten: %d parca", len(self.segments))
            return
        v = video_info(uuid)
        master_url = v["source"]
        # en dusuk GORUNTULU surum: bazi yayinlarda listede daha dusuk bant genislikli,
        # goruntusuz "audio_only" surumu de var; onu secersek hic kare cikmaz
        variants = hls_variants(master_url)
        variants = [x for x in variants if x["video"]] or variants
        self.media_url = min(variants, key=lambda x: x["bw"] or 1 << 40)["url"] if variants else master_url
        log.info("serit kaynagi: %s", self.media_url)
        self.refresh()
        if self.final:      # EXT-X-ENDLIST: yayin bitmis; sonraki acilista ag cagrisi gerekmesin
            ThumbCache.write(self.dir, "index.json", json.dumps(
                {"source": master_url, "media": self.media_url, "segs": self._raw}).encode())

    @staticmethod
    def saved_index(uuid):
        """Diskteki parca listesi ({"source", "media", "segs": [[sure, adres], ...]}) ya da None."""
        raw = ThumbCache.read(ThumbCache.dir_for(uuid), "index.json")
        try:
            data = json.loads(raw) if raw else None
            return data if data and data["source"] and data["media"] and data["segs"] else None
        except (ValueError, KeyError, TypeError):
            return None

    def _set_segments(self, raw):
        segments, t = [], 0.0       # (baslangic, sure, adres)
        for dur, line in raw:
            segments.append((t, dur, urllib.parse.urljoin(self.media_url, line)))
            t += dur
        self._raw = raw
        self.segments = segments

    def refresh(self):
        """Parca listesini yeniden okur. Suren yayinda liste yalnizca sondan uzar: eski parcalarin
        sirasi, dolayisiyla onbellek gecerli kalir."""
        if self.final:
            return
        playlist = cffi_requests.get(self.media_url, impersonate="chrome", timeout=20).text
        raw, dur = [], 0.0
        for line in playlist.splitlines():
            line = line.strip()
            if line.startswith("#EXTINF:"):
                dur = float(line[8:].split(",")[0])
            elif line and not line.startswith("#"):
                raw.append([dur, line])
        self._set_segments(raw)
        self.final = "#EXT-X-ENDLIST" in playlist

    def index(self):
        return [[round(a, 3), round(d, 3)] for a, d, _ in self.segments]

    def get(self, i):
        with self.lock:
            if i in self.cache:
                return self.cache[i]
        out = self._from_disk(i) or self._process(i)
        if out["frames"] or out["peaks"]:      # bos sonucu saklama: ag hatasiysa sonra tekrar denensin
            with self.lock:
                self.cache[i] = out
        return out

    def segment_at(self, t):
        """t saniyesini iceren parcanin sirasi (liste bos degilse)."""
        lo, hi = 0, len(self.segments) - 1
        while lo < hi:
            mid = (lo + hi + 1) >> 1
            if self.segments[mid][0] <= t:
                lo = mid
            else:
                hi = mid - 1
        return lo

    def thumb_cached(self, i):
        """Parcanin ilk karesi yalnizca bellekten / diskten; ag yok. Yoksa ""."""
        with self.lock:
            if i in self.cache and self.cache[i]["frames"]:
                return self.cache[i]["frames"][0]
            if i in self.thumbs and self.thumbs[i]:
                return self.thumbs[i]
        for name in (f"{i}.jpg", f"{i}_00.jpg"):
            raw = ThumbCache.read(self.dir, name)
            if raw:
                out = self._data_url(raw)
                with self.lock:
                    self.thumbs[i] = out
                return out
        return ""

    def _level_of(self, i):
        """Parcanin kaba ses seviyesi (bellek, <i>.lvl, tam veri tepe degerleri); bilinmiyorsa None."""
        with self.lock:
            if i in self.levels:
                return self.levels[i]
            full = self.cache.get(i)
        lvl = max(full["peaks"]) if full and full["peaks"] else None
        if lvl is None:
            b = ThumbCache.read(self.dir, f"{i}.lvl")
            if b:
                lvl = b[0]
            else:
                head = ThumbCache.read(self.dir, f"{i}.peaks")
                lvl = max(head[1:]) if head and len(head) > 1 else None
        if lvl is not None:
            with self.lock:
                self.levels[i] = lvl
        return lvl

    @staticmethod
    def _level(raw):
        """s16le ornekler -> 0..255 (dalga ile ayni olcek: tepe ** 0.6)."""
        samples = array.array("h")
        samples.frombytes(raw[:len(raw) // 2 * 2])
        if not samples:
            return 0
        return min(255, int((max(max(samples), -min(samples)) / 32768) ** 0.6 * 255))

    def thumb(self, i):
        """Parcanin ilk karesi (data URL); alinamazsa "". Ayni ffmpeg cagrisi bastaki ~1 sn'nin ses
        seviyesini de cikarir (levels[i], <i>.lvl): uzak gorunumde kaba dalga icin."""
        url = self.thumb_cached(i)
        if url and self._level_of(i) is not None:
            return url
        work = tempfile.mkdtemp(prefix="kickthumb-")
        try:
            r = cffi_requests.get(self.segments[i][2], impersonate="chrome", timeout=30,
                                  headers={"Range": f"bytes=0-{self.THUMB_BYTES - 1}"})
            r.raise_for_status()
            src, jpg = os.path.join(work, "p.ts"), os.path.join(work, "f.jpg")
            with open(src, "wb") as f:
                f.write(r.content)
            pcm = os.path.join(work, "a.raw")
            subprocess.run([self.ffmpeg, "-nostdin", "-v", "error", "-y", "-i", src, "-map", "0:v:0", "-frames:v", "1",
                            "-vf", "scale=-2:88", "-q:v", "7", jpg,
                            "-map", "0:a:0?", "-ac", "1", "-ar", "2000", "-f", "s16le", pcm],
                           stdin=subprocess.DEVNULL, capture_output=True, timeout=30,
                           creationflags=subprocess.CREATE_NO_WINDOW)
            if not os.path.exists(jpg):
                return ""
            with open(jpg, "rb") as f:
                raw = f.read()
            lvl = 0
            if os.path.exists(pcm):
                with open(pcm, "rb") as f:
                    lvl = self._level(f.read())
            ThumbCache.write(self.dir, f"{i}.jpg", raw)
            ThumbCache.write(self.dir, f"{i}.lvl", bytes([lvl]))
            out = self._data_url(raw)
            with self.lock:
                self.thumbs[i] = out
                self.levels[i] = lvl
            return out
        except Exception as e:  # noqa: BLE001 - kare yoksa tam parca gelince dolar
            log.info("serit karesi %s alinamadi: %s", i, e)
            return ""
        finally:
            shutil.rmtree(work, ignore_errors=True)

    @staticmethod
    def _data_url(raw):
        return "data:image/jpeg;base64," + base64.b64encode(raw).decode()

    def _from_disk(self, i):
        """Daha once islenmis parca: <i>.peaks (ilk bayt kare sayisi, sonra tepe degerleri) + <i>_NN.jpg.
        Kareler eksikse (temizlik sildiyse) yok sayilir."""
        head = ThumbCache.read(self.dir, f"{i}.peaks")
        if not head:
            return None
        frames = []
        for k in range(head[0]):
            raw = ThumbCache.read(self.dir, f"{i}_{k:02d}.jpg")
            if not raw:
                return None
            frames.append(self._data_url(raw))
        return {"peaks": list(head[1:]), "frames": frames, "dur": self.segments[i][1]}

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
            frames, raws = [], []
            for name in sorted(n for n in os.listdir(work) if n.endswith(".jpg")):
                with open(os.path.join(work, name), "rb") as f:
                    raws.append(f.read())
                frames.append(self._data_url(raws[-1]))
            if not frames or not peaks:
                log.info("serit parcasi %s: %d kare, %d ses degeri, %d bayt, ffmpeg=%s cikis %s: %s",
                         i, len(frames), len(peaks), len(r.content), self.ffmpeg, proc.returncode,
                         proc.stderr.decode("utf-8", "ignore").strip()[-300:])
            if frames or peaks:       # .peaks en son yazilir: onu gormek parcanin tam oldugu demek
                for k, raw in enumerate(raws):
                    ThumbCache.write(self.dir, f"{i}_{k:02d}.jpg", raw)
                ThumbCache.write(self.dir, f"{i}.peaks", bytes([len(raws)]) + bytes(peaks))
            return {"peaks": peaks, "frames": frames, "dur": dur}
        except Exception as e:  # noqa: BLE001 - tek parca bozuksa cizelgede bos kalir
            log.info("serit parcasi %s alinamadi: %s", i, e)
            return {"peaks": [], "frames": [], "dur": dur, "failed": True}
        finally:
            shutil.rmtree(work, ignore_errors=True)


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
