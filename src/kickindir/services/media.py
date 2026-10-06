"""Videoyu izlemek icin: serit onizlemeleri ve yerel medya sunucusu."""

import array
import base64
import http.server
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

from kickindir.config import log
from kickindir.services.kick import hls_variants, kick_get


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
        v = kick_get(f"https://kick.com/api/v1/video/{uuid}")
        master_url = v["source"]
        # en dusuk GORUNTULU surum: bazi yayinlarda listede daha dusuk bant genislikli,
        # goruntusuz "audio_only" surumu de var; onu secersek hic kare cikmaz
        variants = hls_variants(master_url)
        variants = [x for x in variants if x["video"]] or variants
        self.media_url = min(variants, key=lambda x: x["bw"] or 1 << 40)["url"] if variants else master_url
        log.info("serit kaynagi: %s", self.media_url)
        self.cache = {}
        self.thumbs = {}
        self.lock = threading.Lock()
        self.refresh()

    def refresh(self):
        """Parca listesini yeniden okur. Suren yayinda liste yalnizca sondan uzar: eski parcalarin
        sirasi, dolayisiyla onbellek gecerli kalir."""
        playlist = cffi_requests.get(self.media_url, impersonate="chrome", timeout=20).text
        segments, t, dur = [], 0.0, 0.0     # (baslangic, sure, adres)
        for line in playlist.splitlines():
            line = line.strip()
            if line.startswith("#EXTINF:"):
                dur = float(line[8:].split(",")[0])
            elif line and not line.startswith("#"):
                segments.append((t, dur, urllib.parse.urljoin(self.media_url, line)))
                t += dur
        self.segments = segments

    def index(self):
        return [[round(a, 3), round(d, 3)] for a, d, _ in self.segments]

    def get(self, i):
        with self.lock:
            if i in self.cache:
                return self.cache[i]
        out = self._process(i)
        if out["frames"] or out["peaks"]:      # bos sonucu saklama: ag hatasiysa sonra tekrar denensin
            with self.lock:
                self.cache[i] = out
        return out

    def thumb(self, i):
        """Parcanin ilk karesi (data URL); alinamazsa ""."""
        with self.lock:
            if i in self.cache and self.cache[i]["frames"]:
                return self.cache[i]["frames"][0]
            if i in self.thumbs:
                return self.thumbs[i]
        work = tempfile.mkdtemp(prefix="kickthumb-")
        try:
            r = cffi_requests.get(self.segments[i][2], impersonate="chrome", timeout=30,
                                  headers={"Range": f"bytes=0-{self.THUMB_BYTES - 1}"})
            r.raise_for_status()
            src, jpg = os.path.join(work, "p.ts"), os.path.join(work, "f.jpg")
            with open(src, "wb") as f:
                f.write(r.content)
            subprocess.run([self.ffmpeg, "-nostdin", "-v", "error", "-y", "-i", src, "-map", "0:v:0", "-frames:v", "1",
                            "-vf", "scale=-2:88", "-q:v", "7", jpg],
                           stdin=subprocess.DEVNULL, capture_output=True, timeout=30,
                           creationflags=subprocess.CREATE_NO_WINDOW)
            if not os.path.exists(jpg):
                return ""
            with open(jpg, "rb") as f:
                out = "data:image/jpeg;base64," + base64.b64encode(f.read()).decode()
            with self.lock:
                self.thumbs[i] = out
            return out
        except Exception as e:  # noqa: BLE001 - kare yoksa tam parca gelince dolar
            log.info("serit karesi %s alinamadi: %s", i, e)
            return ""
        finally:
            shutil.rmtree(work, ignore_errors=True)

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
            frames = []
            for name in sorted(n for n in os.listdir(work) if n.endswith(".jpg")):
                with open(os.path.join(work, name), "rb") as f:
                    frames.append("data:image/jpeg;base64," + base64.b64encode(f.read()).decode())
            if not frames or not peaks:
                log.info("serit parcasi %s: %d kare, %d ses degeri, %d bayt, ffmpeg=%s cikis %s: %s",
                         i, len(frames), len(peaks), len(r.content), self.ffmpeg, proc.returncode,
                         proc.stderr.decode("utf-8", "ignore").strip()[-300:])
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
