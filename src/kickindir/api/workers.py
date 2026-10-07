"""Indirme is parcaciklari: video, kesit, canli kayit, sohbet."""

import copy
import glob
import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
import time
import yt_dlp
from concurrent.futures import ThreadPoolExecutor
from yt_dlp.utils import DownloadCancelled

from kickindir.services.chat import chat_ass, chat_entry, chat_window
from kickindir.config import CHAT_WINDOW, log
from kickindir.core.engine import out_template
from kickindir.core.i18n import t
from kickindir.services.kick import kick_get, kick_time, live_info, live_variant, parse_link, playlist_duration
from kickindir.core.util import UserError, fill_name, trim_playlist


class WorkerMixin:
    """Indirme is parcaciklari: video, kesit, canli kayit, sohbet."""

    def _download(self, d):
        os.makedirs(self._folder, exist_ok=True)
        if d.sections:
            self._download_merged(d)
            return
        q = self._quality
        anchor = None
        cut = None   # kesitte: (ilk parcadan kesit basina saniye, kesit uzunlugu)

        def hook(info):
            if d.cancel:
                raise DownloadCancelled()
            if info["status"] == "downloading":
                d.status = "downloading"
                d.speed = info.get("speed") or 0.0
                if info.get("fragment_count"):
                    d.pct = 100 * (info.get("fragment_index") or 0) / info["fragment_count"]
                # yt-dlp'nin tahmini ilk parcalarda cok sapar (3 GB'lik video 40 GB gorunur);
                # parcalarin %3'u inene kadar bit hizi x sureden hesaplanan boyutu goster
                est = info.get("total_bytes") or info.get("total_bytes_estimate")
                if est and (info.get("total_bytes") or d.pct >= 3 or not anchor):
                    d.size = est
                elif anchor:
                    d.size = anchor
                if not info.get("fragment_count") and d.size:
                    d.pct = 100 * (info.get("downloaded_bytes") or 0) / d.size
                # kalan sureyi de ayni boyuttan hesapla, yoksa ETA da ilk saniyelerde sacmalar
                d.eta = d.size * (1 - d.pct / 100) / d.speed if d.size and d.speed else info.get("eta")
            elif info["status"] == "finished":
                d.speed = 0.0
                d.pct = 100.0
                d.status = "merging"

        opts = {
            "format": "best" if q == "best" else f"{q}/best",
            "outtmpl": os.path.join(self._folder, out_template(self._prefs["nameTemplate"], d.section)),
            "concurrent_fragment_downloads": self._frag_threads(),
            "retries": 10,
            "fragment_retries": 20,
            "windowsfilenames": True,
            "progress_hooks": [hook],
            "quiet": True,
            "noprogress": True,
            "no_warnings": True,
        }
        if self._ffmpeg:
            opts["ffmpeg_location"] = self._ffmpeg
        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = ydl.extract_info(d.url, download=False)
                if d.title == d.url:
                    d.title = info.get("title") or d.url
                if not d.thumb:
                    d.thumb = info.get("thumbnail") or ""
                d.filename = ydl.prepare_filename(info)
                duration = info.get("duration")
                if d.section:
                    if os.path.exists(d.filename):     # onceden inip kesilmis; tekrar kesme
                        d.size = os.path.getsize(d.filename)
                        d.status, d.pct, d.eta = "done", 100.0, 0
                        return
                    cut = self._prepare_section(ydl, info, d.section)
                    duration = cut[1]
                if info.get("tbr") and duration:
                    anchor = int(info["tbr"] * 125 * duration)   # kbit/s -> bayt
                d.exact = bool(info.get("filesize"))
                part = d.filename + ".part"
                self._check_space(d, (info.get("filesize") or anchor or 0)
                                  - (os.path.getsize(part) if os.path.exists(part) else 0))
                if d.cancel:
                    raise DownloadCancelled()
                ydl.process_info(info)
            if cut and self._ffmpeg:
                d.status = "merging"
                self._push(force=True)
                self._cut(d.filename, *cut)
                d.size = os.path.getsize(d.filename)
            d.status, d.pct, d.eta = "done", 100.0, 0
        except Exception as e:  # noqa: BLE001 - hatayi kullaniciya goster
            if d.cancel or isinstance(e, DownloadCancelled):
                d.status = "stopped"
            else:
                d.status = "error"
                d.error = re.sub(r"^ERROR:\s*(\[[^\]]+\]\s*)?", "", str(e))[:200]
                d.friendly = isinstance(e, UserError)
        finally:
            d.speed = 0.0
            if d.status == "done":
                self._remember(d)
            elif d.status == "stopped" and d.discard:
                self._discard_partial(d)
                self._downloads.pop(d.id, None)
            self._push(force=True)

    def _download_merged(self, d):
        """Birden fazla kesit tek videoda: her kesitin parcalari ayni cok thread'li motorla
        gecici bir klasore iner ve kirpilir, sonra ffmpeg concat ile yeniden kodlamadan
        arka arkaya eklenir. Bitmis kesitler isaretlenir; durdurup devam edince bastan inmez."""
        q = self._quality
        total = sum(b - a for a, b in d.sections) or 1
        prog = {"base": 0.0, "share": 0.0}   # bitmis kesitlerin suresi, sureninki
        anchor = None
        work = self._work_dir(d)

        def hook(info):
            if d.cancel:
                raise DownloadCancelled()
            if info["status"] == "downloading":
                d.status = "downloading"
                d.speed = info.get("speed") or 0.0
                frac = 0.0
                if info.get("fragment_count"):
                    frac = (info.get("fragment_index") or 0) / info["fragment_count"]
                elif info.get("total_bytes"):
                    frac = (info.get("downloaded_bytes") or 0) / info["total_bytes"]
                d.pct = min(99.0, 100 * (prog["base"] + frac * prog["share"]) / total)
                if anchor:
                    d.size = anchor
                d.eta = d.size * (1 - d.pct / 100) / d.speed if d.size and d.speed else None

        opts = {
            "format": "best" if q == "best" else f"{q}/best",
            "concurrent_fragment_downloads": self._frag_threads(),
            "retries": 10,
            "fragment_retries": 20,
            "windowsfilenames": True,
            "progress_hooks": [hook],
            "quiet": True,
            "noprogress": True,
            "no_warnings": True,
        }
        if self._ffmpeg:
            opts["ffmpeg_location"] = self._ffmpeg
        try:
            if not self._ffmpeg:
                raise UserError(t("err.mergeNeedsFfmpeg"))
            name = out_template(self._prefs["nameTemplate"], d.section, len(d.sections))
            with yt_dlp.YoutubeDL({**opts, "outtmpl": os.path.join(self._folder, name)}) as ydl:
                info = ydl.extract_info(d.url, download=False)
                if d.title == d.url:
                    d.title = info.get("title") or d.url
                if not d.thumb:
                    d.thumb = info.get("thumbnail") or ""
                d.filename = ydl.prepare_filename(info)
            if os.path.exists(d.filename):          # onceden birlestirilmis
                d.size = os.path.getsize(d.filename)
                d.status, d.pct, d.eta = "done", 100.0, 0
                return
            if info.get("tbr"):
                anchor = int(info["tbr"] * 125 * total)   # kbit/s -> bayt
                d.size = anchor
                # parcalar + birlestirilmis kopya ayni anda diskte durur: iki kat yer
                have = sum(e.stat().st_size for e in os.scandir(work) if e.is_file()) if os.path.isdir(work) else 0
                self._check_space(d, 2 * anchor - have)
            os.makedirs(work, exist_ok=True)
            parts = []
            for i, sec in enumerate(d.sections):
                prog["share"] = sec[1] - sec[0]
                ext = os.path.splitext(d.filename)[1]
                ready = os.path.join(work, f"{i:03d}.hazir{ext}")
                if not os.path.exists(ready):
                    if d.cancel:
                        raise DownloadCancelled()
                    with yt_dlp.YoutubeDL({**opts, "outtmpl": os.path.join(work, f"{i:03d}.%(ext)s")}) as ydl:
                        part_info = copy.deepcopy(info)
                        part = ydl.prepare_filename(part_info)
                        cut = self._prepare_section(ydl, part_info, sec)
                        d.status = "downloading"
                        ydl.process_info(part_info)
                    d.status = "merging"
                    self._push(force=True)
                    self._cut(part, *cut)
                    os.replace(part, ready)
                parts.append(ready)
                prog["base"] += prog["share"]
            d.status, d.speed, d.eta = "merging", 0.0, None
            d.pct = 100.0
            self._push(force=True)
            listing = os.path.join(work, "liste.txt")
            with open(listing, "w", encoding="utf-8") as f:
                for part in parts:
                    f.write("file '" + part.replace("\\", "/").replace("'", "'\\''") + "'\n")
            tmp = d.filename + ".birlesik" + os.path.splitext(d.filename)[1]
            cmd = [self._ffmpeg, "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", listing,
                   "-map", "0", "-c", "copy", "-movflags", "+faststart", tmp]
            r = subprocess.run(cmd, capture_output=True, text=True, creationflags=subprocess.CREATE_NO_WINDOW)
            if r.returncode != 0 or not os.path.exists(tmp):
                raise UserError(t("err.mergeFailed", e=(r.stderr or "").strip()[-160:]))
            os.replace(tmp, d.filename)
            shutil.rmtree(work, ignore_errors=True)
            d.size = os.path.getsize(d.filename)
            d.status, d.pct, d.eta = "done", 100.0, 0
        except Exception as e:  # noqa: BLE001 - hatayi kullaniciya goster
            if d.cancel or isinstance(e, DownloadCancelled):
                d.status = "stopped"
            else:
                d.status = "error"
                d.error = re.sub(r"^ERROR:\s*(\[[^\]]+\]\s*)?", "", str(e))[:200]
                d.friendly = isinstance(e, UserError)
        finally:
            d.speed = 0.0
            if d.status == "done":
                self._remember(d)
            elif d.status == "stopped" and d.discard:
                self._discard_partial(d, work)
                self._downloads.pop(d.id, None)
            self._push(force=True)

    def _work_dir(self, d):
        return os.path.join(self._folder, ".kesitler-" + hashlib.md5(d.key.encode()).hexdigest()[:10])

    @staticmethod
    def _discard_partial(d, work=None):
        """Iptal edilen indirmenin diskte biraktigi yarim dosyalari siler (.part, parca dosyalari,
        .ytdl, kesit/birlestirme gecicileri, kesit klasoru). Bitmis dosyaya dokunmaz."""
        if work:
            shutil.rmtree(work, ignore_errors=True)
        if not d.filename:
            return
        base = glob.escape(d.filename)
        for pat in (base + ".part*", base + ".ytdl", base + ".kesit*", base + ".birlesik*"):
            for f in glob.glob(pat):
                try:
                    os.remove(f)
                except OSError:
                    pass

    @staticmethod
    def _prepare_section(ydl, info, section):
        """Secilen formatin parca listesini kesite gore daraltir; yt-dlp yalnizca o parcalari
        her zamanki gibi cok thread'le indirir. Parca sinirlarindan tasan kisim sonra kesilir."""
        if not str(info.get("protocol", "")).startswith("m3u8"):
            raise UserError(t("err.noCutSupport"))
        start, end = section
        playlist = ydl.urlopen(info["url"]).read().decode("utf-8", "ignore")
        info["hls_media_playlist_data"], offset = trim_playlist(playlist, start, end)
        info.pop("filesize", None)
        info.pop("filesize_approx", None)
        # yayin hala suruyorsa yt-dlp ffmpeg'le canli kayda gecer; daraltilmis liste ise bitmis bir liste
        info["is_live"], info["live_status"] = False, "was_live"
        return offset, end - start

    def _cut(self, path, offset, length):
        tmp = path + ".kesit" + os.path.splitext(path)[1]
        cmd = [self._ffmpeg, "-y", "-v", "error", "-ss", f"{offset:.3f}", "-i", path, "-t", f"{length:.3f}",
               "-map", "0", "-c", "copy", "-avoid_negative_ts", "make_zero", "-movflags", "+faststart", tmp]
        r = subprocess.run(cmd, capture_output=True, text=True, creationflags=subprocess.CREATE_NO_WINDOW)
        if r.returncode != 0 or not os.path.exists(tmp):
            raise UserError(t("err.trimFailed", e=(r.stderr or "").strip()[-160:]))
        os.replace(tmp, path)

    def _record_live(self, d):
        """Beta: canli yayini su andan itibaren .ts olarak kaydeder (cokme/kapanmada bile okunur).
        Durdurulunca ya da yayin bitince mp4'e cevrilir. Durdurmak hata degil: kayit 'done' olur."""
        errlog = tempfile.TemporaryFile()
        try:
            if not self._ffmpeg:
                raise UserError(t("err.liveNeedsFfmpeg"))
            slug = parse_link(d.url)[0]
            ch = kick_get(f"https://kick.com/api/v2/channels/{slug}")
            live = live_info(ch)
            if not live:
                raise UserError(t("herr.notLive"))
            src = live_variant(ch["playback_url"], self._quality)
            if d.title == d.url:
                d.title = live["title"] or slug
            d.thumb = d.thumb or live["thumb"]
            os.makedirs(self._folder, exist_ok=True)
            name = fill_name(self._prefs["nameTemplate"], slug, d.title, time.strftime("%Y-%m-%d"),
                             t("file.live", when=time.strftime("%Y-%m-%d %H.%M")))
            base = os.path.join(self._folder, name)
            ts, d.filename = base + ".ts", base + ".mp4"
            d.proc = subprocess.Popen(
                [self._ffmpeg, "-v", "error", "-y", "-i", src, "-map", "0", "-c", "copy", "-f", "mpegts", ts],
                stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=errlog,
                creationflags=subprocess.CREATE_NO_WINDOW)
            d.status, d.started = "recording", time.time()
            self._push(force=True)
            last, tick = 0, time.monotonic()
            while d.proc.poll() is None:
                if d.cancel:
                    self._stop_proc(d.proc)
                    break
                time.sleep(1)
                size = os.path.getsize(ts) if os.path.exists(ts) else 0
                now = time.monotonic()
                d.speed, d.size, last, tick = (size - last) / (now - tick), size, size, now
            if not os.path.exists(ts) or os.path.getsize(ts) == 0:
                if d.cancel:
                    raise DownloadCancelled()
                errlog.seek(0)
                raise UserError(t("err.recFailed", e=errlog.read().decode("utf-8", "ignore").strip()[-160:]))
            if not self._prefs["liveRemux"]:      # .ts olarak kalsin
                d.filename = ts
                d.size = os.path.getsize(ts)
                d.status, d.pct, d.eta = "done", 100.0, 0
                return
            d.status, d.speed = "merging", 0.0
            self._push(force=True)
            r = subprocess.run([self._ffmpeg, "-y", "-v", "error", "-i", ts, "-map", "0", "-c", "copy",
                                "-movflags", "+faststart", d.filename],
                               capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW)
            if r.returncode == 0 and os.path.exists(d.filename):
                os.remove(ts)
            else:                       # mp4'e cevrilemezse .ts kalsin, o da oynar
                log.info("canli kayit mp4'e cevrilemedi: %s", r.stderr.decode("utf-8", "ignore")[-300:])
                d.filename = ts
            d.size = os.path.getsize(d.filename)
            d.status, d.pct, d.eta = "done", 100.0, 0
        except Exception as e:  # noqa: BLE001 - hatayi kullaniciya goster
            if d.cancel or isinstance(e, DownloadCancelled):
                d.status = "stopped"
            else:
                d.status = "error"
                d.error = str(e)[:200]
                d.friendly = isinstance(e, UserError)
        finally:
            if d.proc and d.proc.poll() is None:
                d.proc.kill()
            d.proc = None
            d.speed = 0.0
            errlog.close()
            if d.status == "done":
                self._remember(d)
            self._push(force=True)

    def _download_chat(self, d):
        """VOD'un sohbetini indirir: Kick'in tekrar oynatma API'si 5 sn'lik pencereler verir, bunlar
        paralel cekilir. Cikti videoyla ayni adla: .ass (oynatici videonun ustunde gosterir) ve
        .chat.json (ham kayit). Video daha once indiyse onun dosya adi kullanilir."""
        try:
            m = re.search(r"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})", d.url)
            if not m:
                raise UserError(t("err.chatVodOnly"))
            uuid = m.group(1)
            v = kick_get(f"https://kick.com/api/v1/video/{uuid}")
            ls = v.get("livestream") or {}
            if ls.get("is_live"):
                raise UserError(t("err.chatStillLive"))
            slug = (ls.get("channel") or {}).get("slug") or parse_link(d.url)[0] or "kick"
            if d.title == d.url:
                d.title = ls.get("session_title") or uuid
            vod_start = kick_time(ls.get("start_time") or ls.get("created_at"))
            duration = d.duration or round((ls.get("duration") or 0) / 1000) or playlist_duration(v["source"])
            with self._lock:
                video = next((e["file"] for e in reversed(self._history) if e.get("url") == d.url and not e.get("section")
                              and not e.get("chat") and os.path.isfile(e["file"])), None)
            if video:
                base = os.path.splitext(video)[0]
            else:
                os.makedirs(self._folder, exist_ok=True)
                base = os.path.join(self._folder, fill_name(self._prefs["nameTemplate"], slug, d.title,
                                                            time.strftime("%Y-%m-%d", time.gmtime(vod_start)), uuid[:12]))
            d.filename = base + ".ass"
            starts = list(range(0, int(duration) + 1, CHAT_WINDOW))
            d.status = "downloading"
            self._push(force=True)

            def fetch(offset):
                if d.cancel:
                    raise DownloadCancelled()
                return chat_window(ls["channel_id"], vod_start + offset)

            seen, messages, t0 = set(), [], time.monotonic()
            pool = ThreadPoolExecutor(max_workers=8)
            try:
                for i, batch in enumerate(pool.map(fetch, starts), 1):
                    for msg in batch:
                        if msg.get("id") in seen or not msg.get("content"):
                            continue
                        seen.add(msg.get("id"))
                        try:
                            messages.append(chat_entry(msg, vod_start))
                        except ValueError:
                            continue
                    d.pct = 100 * i / len(starts)
                    elapsed = time.monotonic() - t0
                    d.eta = elapsed / i * (len(starts) - i)
            finally:        # hata ya da durdurmada kalan binlerce istek beklenmesin
                pool.shutdown(wait=False, cancel_futures=True)
            messages.sort(key=lambda x: x["t"])
            d.status = "merging"
            self._push(force=True)
            with open(base + ".chat.json", "w", encoding="utf-8") as f:
                json.dump({"url": d.url, "channel": slug, "title": d.title, "start": ls.get("start_time"),
                           "duration": duration, "messages": messages}, f, ensure_ascii=False)
            with open(d.filename, "w", encoding="utf-8-sig") as f:
                f.write(chat_ass(messages))
            d.size = os.path.getsize(d.filename)
            d.status, d.pct, d.eta = "done", 100.0, 0
            log.info("sohbet indi: %s, %d mesaj", uuid, len(messages))
        except Exception as e:  # noqa: BLE001 - hatayi kullaniciya goster
            if d.cancel or isinstance(e, DownloadCancelled):
                d.status = "stopped"
            else:
                d.status = "error"
                d.error = str(e)[:200]
                d.friendly = isinstance(e, UserError)
        finally:
            d.speed = 0.0
            if d.status == "done":
                self._remember(d)
            self._push(force=True)

    @staticmethod
    def _stop_proc(proc):
        """ffmpeg'e 'q' yollar: dosyayi duzgun kapatip cikar. 10 sn'de cikmazsa oldurulur."""
        try:
            proc.stdin.write(b"q")
            proc.stdin.flush()
            proc.wait(10)
        except Exception:  # noqa: BLE001
            proc.kill()
