"""Indirme kuyrugu: ekleme, iptal, yeniden deneme, zamanlayici, arayuze itme."""

import ctypes
import json
import os
import re
import subprocess
import threading
import time

from kickindir.config import ACTIVE_ALL, ACTIVE_NET, DISK_RESERVE, FRAG_THREADS, HISTORY_MAX, MAX_PARALLEL, QUALITIES, log
from kickindir.core.engine import Download
from kickindir.services.kick import parse_link
from kickindir.services.notify import toast
from kickindir.core.storage import save_history, save_queue, save_settings
from kickindir.core.i18n import t
from kickindir.core.util import UserError, fmt_size, fmt_speed, free_space


class QueueMixin:
    """Indirme kuyrugu: ekleme, iptal, yeniden deneme, zamanlayici, arayuze itme."""

    def enqueue(self, items):
        added = 0
        with self._lock:
            known = {d.key for d in self._downloads.values()}
            active = {d.key for d in self._downloads.values() if d.status in ("queued",) + ACTIVE_ALL}
            for it in items or []:
                if not it.get("url"):
                    continue
                if it.get("live") or it.get("chat"):
                    # canli: ayni kanal ayni anda bir kez kaydedilir; bitmis kayit engel degil. sohbet de oyle.
                    secs, section = self._spans(it)
                    if secs is False:
                        continue
                    d = Download(it["url"], it.get("title") or it["url"], it.get("thumb") or "",
                                 section=None if it.get("live") else section, sections=None if it.get("live") else secs,
                                 live=bool(it.get("live")), chat=bool(it.get("chat")) and not it.get("live"),
                                 with_chat=it.get("withChat") if isinstance(it.get("withChat"), bool) else None)
                    if d.chat:
                        d.duration = it.get("duration") if type(it.get("duration")) is int else 0
                    if d.key not in active:
                        self._downloads[d.id] = d
                        active.add(d.key)
                        added += 1
                    continue
                secs, section = self._spans(it)
                if secs is False:
                    continue
                d = Download(it["url"], it.get("title") or it["url"], it.get("thumb") or "", section, sections=secs,
                             with_chat=it.get("withChat") if isinstance(it.get("withChat"), bool) else None)
                if d.key not in known:
                    self._downloads[d.id] = d
                    known.add(d.key)
                    added += 1
        self._push(force=True)
        return added

    @staticmethod
    def _spans(it):
        """Arayuzden gelen aralik: (birden fazla kesit ya da None, tek kesit ya da None).
        Gecersizse (False, None)."""
        if it.get("sections"):   # birden fazla kesit, tek video
            try:
                secs = sorted((max(0, int(a)), int(b)) for a, b in it["sections"])
            except (TypeError, ValueError):
                return False, None
            secs = [x for x in secs if x[1] > x[0]]
            return (secs, None) if secs else (False, None)
        if it.get("end"):
            try:
                section = (max(0, int(it.get("start") or 0)), int(it["end"]))
            except (TypeError, ValueError):
                return False, None
            return (None, section) if section[1] > section[0] else (False, None)
        return None, None

    def cancel(self, did, discard=False):
        """Durdurur (yarim dosya kalir, devam edilebilir). discard: iptal; yarim dosyalar silinir, satir kalkar."""
        d = self._downloads.get(did)
        if d and d.status in ("queued",) + ACTIVE_ALL:
            d.cancel = True
            d.discard = discard and not d.live
            if d.status == "queued":
                d.status = "stopped"
        self._push(force=True)

    def abort(self, did):
        """Iptal et: indirmeyi durdurur, diskte biraktigi yarim dosyalari ve listedeki satirini siler."""
        d = self._downloads.get(did)
        if not d or d.live or d.status == "done":
            return
        if d.status in ACTIVE_ALL:
            self.cancel(did, discard=True)    # is parcacigi durunca temizler
            return
        d.discard = True
        self._discard_partial(d, self._work_dir(d) if d.sections else None)
        with self._lock:
            self._downloads.pop(did, None)
        self._push(force=True)

    def exit_now(self):
        """Cikis onayi verildi: kapanma olayi bu sefer onay sormadan gecer."""
        self._exit_ok = True
        threading.Thread(target=self._window.destroy, daemon=True).start()

    def cancel_all(self):
        for d in list(self._downloads.values()):
            self.cancel(d.id)

    def retry(self, did):
        d = self._downloads.get(did)
        if d and d.status in ("stopped", "error"):
            d.cancel = d.discard = False
            d.error = ""
            d.status = "queued"
        self._push(force=True)

    def remove(self, did):
        with self._lock:
            d = self._downloads.get(did)
            if d and d.status not in ACTIVE_ALL:
                d.cancel = True
                del self._downloads[did]
            else:
                d = None
        if d and d.status in ("stopped", "error", "queued") and not d.live:
            self._discard_partial(d, self._work_dir(d) if d.sections else None)   # listeden kalkan indirmenin yarim dosyasi kalmasin
        self._push(force=True)

    def clear_done(self):
        with self._lock:
            for did in [i for i, d in self._downloads.items() if d.status == "done"]:
                del self._downloads[did]
        self._push(force=True)

    def set_quality(self, q):
        if q in QUALITIES:
            self._quality = q
            self._save()

    def _save(self):
        save_settings({"folder": self._folder, "quality": self._quality, "parallel": self._parallel,
                       "fragThreads": self._threads, **self._prefs, "favorites": self.favorites(),
                       "cuts": self._cuts_snapshot()})

    def _frag_threads(self):
        return FRAG_THREADS if self._threads == "auto" else self._threads

    def _parallel_limit(self):
        return self._tuner.level if self._parallel == "auto" else self._parallel

    def _push(self, force=False):
        """Arayuzu guncelleme istegi. Asil isi _pusher yapar: evaluate_js arayuz thread'inin
        cevabini bekler, arayuz thread'inden (or. pencere kapanirken) cagrilirsa kilitlenir."""
        self._force = self._force or force
        self._dirty.set()

    def _pusher(self):
        while True:
            self._dirty.wait()
            self._dirty.clear()
            force, self._force = self._force, False
            if self._closing:
                return
            if self._ready and self._window:
                self._send(force)

    def _send(self, force):
        items = list(self._downloads.values())
        net = [d for d in items if d.status in ACTIVE_NET]
        payload = json.dumps({
            "downloads": [d.to_dict() for d in items],
            "level": self._parallel_limit(),
            "autoParallel": self._parallel == "auto",
            "liveFavorites": sorted(self._live_favs),
            "totalSpeed": sum(d.speed for d in net),
            "free": self._free_space(),
            "afterDone": self._after,
            "shutdownAt": self._shutdown_at,
            "speedLimit": self._prefs["speedLimit"],
        }, ensure_ascii=False)
        self._update_title(items)
        if force or payload != self._last_push:
            self._last_push = payload
            try:
                self._window.evaluate_js(f"window.app && window.app.sync({payload})")
            except Exception:  # noqa: BLE001 - pencere kapanirken
                pass

    def _update_title(self, items):
        """Pencere basligina toplam ilerleme: kucultulmusken gorev cubugunda okunur."""
        active = [d for d in items if d.status in ACTIVE_ALL]
        title = t("app.name")
        if active:
            total = sum(d.size for d in active if d.size and not d.live)    # canli kaydin sonu belli degil
            done = sum(d.size * d.pct / 100 for d in active if d.size and not d.live)
            pct = int(100 * done / total) if total else 0
            speed = sum(d.speed for d in active) / (1024 * 1024)
            title = t("title.progress", pct=t("pct", p=pct), speed=fmt_speed(speed), n=len(active), app=t("app.name"))
        if title != getattr(self, "_title", None):
            self._title = title
            try:
                self._window.set_title(title)
            except Exception:  # noqa: BLE001
                pass

    def _free_space(self):
        """Indirme klasorunun diskindeki bos alan; 5 sn'de bir olculur."""
        at, value = self._free
        if time.monotonic() - at > 5:
            value = free_space(self._folder)
            self._free = (time.monotonic(), value)
        return value

    def _check_space(self, d, need):
        """need bayt daha yazilacaksa diskte yer var mi; yoksa indirme hatayla durur.
        Ayni anda inen diger videolarin kalan kismi da hesaba katilir."""
        free = free_space(self._folder)
        if not free or not need:
            return
        others = sum(o.size * (1 - o.pct / 100) for o in list(self._downloads.values())
                     if o is not d and o.status in ACTIVE_NET and o.size and not o.live)
        if need + others + DISK_RESERVE > free:
            raise UserError(t("err.diskFull", need=fmt_size(need), free=fmt_size(free))
                            + (t("err.diskOthers", others=fmt_size(others)) if others > 1 << 28 else "")
                            + t("err.diskFix"))

    def _persist_queue(self):
        """Bitmemis indirmeleri queue.json'a yazar (yalnizca degisince). Canli kayit kaydedilmez:
        yayin o zamana bitmis olur."""
        items = [d.to_saved() for d in list(self._downloads.values()) if d.status != "done" and not d.live and d.video_msgs is None]
        if items != self._saved_queue:
            self._saved_queue = items
            save_queue(items)

    def _run_after_done(self, items):
        """Kuyruk bittiginde secilen is: uyku ya da kapatma. En az bir indirme bittiyse calisir
        (kullanici hepsini durdurduysa calismaz). Kapatma 60 sn gecikmeli, iptal edilebilir."""
        mode, self._after = self._after, "none"
        if mode == "none" or not any(d.status == "done" for d in items):
            return
        log.info("kuyruk bitti, %s", mode)
        if mode == "shutdown":
            subprocess.run(["shutdown", "/s", "/t", "60", "/c", t("shutdown.reason", app=t("app.name"))],
                           capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW)
            self._shutdown_at = time.time() + 60
        elif mode == "sleep":
            self._push(force=True)
            time.sleep(3)       # arayuz son durumu gostersin
            ctypes.windll.powrprof.SetSuspendState(False, False, False)

    def _scheduler(self):
        batch = set()       # bu calisma turunda kuyruga girenler: tur bitince tek bildirim
        while True:
            time.sleep(0.5)
            items = list(self._downloads.values())
            busy = [d for d in items if d.status in ("queued",) + ACTIVE_ALL]
            batch.update(d.id for d in busy)
            if batch and not busy:
                done = [d for d in items if d.id in batch]
                self._notify_done(done)
                self._run_after_done(done)
                batch = set()
            self._persist_queue()
            net = [d for d in items if d.status in ACTIVE_NET and not d.live and not d.chat]
            pending = [d for d in items if d.status == "queued" and not d.live and not d.chat]
            # canli kayit hemen baslar ve sira tutmaz: yayin beklemez, saatlerce surer.
            # sohbet kaydi da: kucuk JSON istekleri, video sirasini bekletmesin
            for d in [d for d in items if d.status == "queued" and (d.live or d.chat)]:
                d.status = "preparing"
                target = self._record_live if d.live else self._download_chat
                threading.Thread(target=target, args=(d,), daemon=True).start()
            self._tuner.step(sum(d.speed for d in net), len(net), bool(pending))
            # Klipler otomatik modda tavandan baslar: tek basina hatti dolduramazlar ve birkac
            # saniyede bittikleri icin tuner'in olcumu oturmaz (12 klip: 4,7 -> 7,7 MB/s).
            # Kesitte fark olculmedi (6,6 -> 6,5 MB/s); VOD ve kesitlerde tuner aynen gecerli.
            running, limit = len(net), self._parallel_limit()
            for d in pending:
                cap = MAX_PARALLEL if d.short and self._parallel == "auto" else limit
                if running < cap:
                    running += 1
                    d.status = "preparing"
                    threading.Thread(target=self._download, args=(d,), daemon=True).start()
            self._push()

    def _notify_done(self, items):
        done = sum(1 for d in items if d.status == "done")
        failed = sum(1 for d in items if d.status == "error")
        if not self._prefs["notifyDone"] or not (done or failed):
            return
        if done + failed == 1:
            d = next(d for d in items if d.status in ("done", "error"))
            toast(t("toast.dlDone") if done else t("toast.dlFailed"), d.title)
        else:
            toast(t("sb.allDone"), t("toast.dlSummary", n=done) + (t("toast.dlSummaryErr", n=failed) if failed else ""))

    def _remember(self, d, path=None):
        """Biten indirmeyi Indirilenler gecmisine yazar (ayni dosya tekrar inerse guncellenir).
        path: indirmenin ikinci dosyasi (or. sohbetin yanindaki sohbet videosu)."""
        path = path or d.filename
        if not path or not os.path.isfile(path):
            return
        thumb = d.thumb
        if (d.section or d.sections) and self._ffmpeg:
            thumb = self._frame_thumb(path) or thumb    # kesitin kapagi yayininki degil, kesitin kendi karesi
        entry = {"file": path, "title": d.title, "thumb": thumb, "url": d.url,
                 "section": list(d.section) if d.section else None,
                 "sections": [list(x) for x in d.sections] if d.sections else None, "live": d.live, "chat": d.chat,
                 "channel": parse_link(d.url)[0] or (re.match(r"https://kick\.com/([\w-]+)/clips?/", d.url) or [None, ""])[1],
                 "size": os.path.getsize(path), "done": time.time()}
        with self._lock:
            self._history = [e for e in self._history if e["file"] != path] + [entry]
            self._history = self._history[-HISTORY_MAX:]
            save_history(self._history)
        self._queue_chat_for(d)

    def _queue_chat_for(self, d):
        """Video (tam, kesit, klip ya da canli kayit) bitti: istendiyse sohbeti de ayni adla sirada.
        Program kapanirken durdurulan canli kayit da buraya gelir; sohbeti queue.json'la sonraki acilisa kalir."""
        want = d.with_chat if d.with_chat is not None else self._prefs["chatAuto"]
        if d.chat or not want:
            return
        c = Download(d.url, d.title, d.thumb, section=None if d.sections else d.section, sections=d.sections, chat=True)
        c.chat_base = os.path.splitext(d.filename)[0]
        if d.live:
            if not d.started:
                return
            c.chat_range = (d.started, d.ended or time.time())
            c.key += f"@{int(d.started)}"
        with self._lock:
            if any(o.key == c.key and o.status in ("queued",) + ACTIVE_ALL for o in self._downloads.values()):
                return
            self._downloads[c.id] = c
        self._push(force=True)

    def _stop_recordings(self):
        """Program kapanirken: ffmpeg alt surecleri programdan sonra da calismaya devam eder."""
        for d in list(self._downloads.values()):
            proc = d.proc
            if proc:
                self._stop_proc(proc)
