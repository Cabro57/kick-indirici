"""Favori yayincilar: canli durumu, yeni VOD sayaci, otomatik indirme."""

from concurrent.futures import ThreadPoolExecutor

from .config import LIVE_POLL, log
from .kick import fetch_channel, kick_error, kick_get, live_info, parse_link, vod_channel
from .notify import toast


class FavoritesMixin:
    """Favori yayincilar: canli durumu, yeni VOD sayaci, otomatik indirme."""

    def favorites(self):
        with self._fav_lock:
            return [dict(f) for f in self._favorites]

    def favorite_add(self, text):
        """Kanal adi, kanal linki ya da VOD linkiyle favori ekler."""
        slug, uuid, is_clip = parse_link(text or "")
        if is_clip or (not slug and not uuid):
            return {"ok": False, "error": "Kanal anlaşılamadı. Kanal adı ya da kanal linki yaz."}
        try:
            channel, vods = fetch_channel(slug or vod_channel(uuid))
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": kick_error(e)}
        fav = {"slug": channel["slug"], "name": channel["name"], "avatar": channel["avatar"],
               "seen": max((v["start"] for v in vods), default="")}
        with self._fav_lock:
            if not any(f["slug"] == fav["slug"] for f in self._favorites):
                self._favorites.append(fav)
        self._save()
        return {"ok": True, "favorite": fav, "favorites": self.favorites()}

    def favorite_set(self, slug, data):
        """Favorinin otomatik islerini acar/kapatir: autoDownload (yeni VOD gelince indir),
        autoRecord (canliya gecince kaydet). autoDownload acilinca o ana kadarki VOD'lar
        indirilmez; yalnizca bundan sonra gelenler."""
        data = data or {}
        with self._fav_lock:
            fav = next((f for f in self._favorites if f["slug"] == slug), None)
        if fav is None:
            return {"ok": False, "error": "Favori bulunamadı."}
        auto_seen = None
        if data.get("autoDownload") is True and not fav.get("autoDownload"):
            try:
                _, vods = fetch_channel(slug)
            except Exception as e:  # noqa: BLE001
                return {"ok": False, "error": kick_error(e)}
            auto_seen = max((v["start"] for v in vods), default="")
        with self._fav_lock:
            for key in ("autoDownload", "autoRecord"):
                if isinstance(data.get(key), bool):
                    fav[key] = data[key]
            if auto_seen is not None:
                fav["autoSeen"] = auto_seen
        self._save()
        if fav.get("autoRecord") or fav.get("autoDownload"):
            self._live_wake.set()       # bir sonraki turu beklemeden kontrol et
        return {"ok": True, "favorites": self.favorites()}

    def favorite_remove(self, slug):
        with self._fav_lock:
            self._favorites = [f for f in self._favorites if f["slug"] != slug]
        self._save()
        return self.favorites()

    def favorites_refresh(self):
        """Her favori icin: canli mi (live), son bakistan beri kac yeni VOD var (newVods),
        en yeni VOD (latest). Kick'e ulasilamayan kanal {"ok": False} doner."""
        def check(f):
            try:
                channel, vods = fetch_channel(f["slug"])
            except Exception as e:  # noqa: BLE001 - bir kanal hatasi digerlerini durdurmaz
                log.info("favori %s alinamadi: %s", f["slug"], e)
                return f["slug"], {"ok": False, "error": kick_error(e)}
            seen = f.get("seen") or ""
            return f["slug"], {
                "ok": True, "name": channel["name"], "avatar": channel["avatar"], "live": channel["live"],
                "newVods": sum(1 for v in vods if seen and v["start"] > seen),
                "latest": max(vods, key=lambda v: v["start"]) if vods else None,
            }

        favs = self.favorites()
        if not favs:
            return {}
        with ThreadPoolExecutor(max_workers=min(6, len(favs))) as pool:
            status = dict(pool.map(check, favs))
        with self._fav_lock:      # yayinci adini ya da resmini degistirdiyse sakla
            for f in self._favorites:
                st = status.get(f["slug"])
                if st and st["ok"]:
                    f["name"], f["avatar"] = st["name"], st["avatar"]
        self._save()
        return status

    def live_status(self, slug):
        """Kanal su an canliysa yayin bilgisi. Kayit icin enqueue([{"url": kanal linki, "live": True}])."""
        try:
            ch = kick_get(f"https://kick.com/api/v2/channels/{slug}")
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": kick_error(e)}
        return {"ok": True, "live": live_info(ch)}

    def _mark_seen(self, slug, vods):
        """Favori kanal acildiysa son bakisi gunceller ve oncekini dondurur; favori degilse None."""
        latest = max((v["start"] for v in vods), default="")
        with self._fav_lock:
            fav = next((f for f in self._favorites if f["slug"] == slug), None)
            if fav is None:
                return None
            before = fav.get("seen") or ""
            fav["seen"] = max(before, latest)
        if fav["seen"] != before:
            self._save()
        return before

    def _watch_live(self):
        """Favorilerin canli durumunu LIVE_POLL saniyede bir kontrol eder. Canliya gecen olursa
        bildirim (notifyLive) ve sync'te liveFavorites. Ilk tur yalnizca durumu ogrenir.

        Otomatik isler (favori basina, favorite_set ile acilir):
        - autoRecord: canli yayin kaydi baslatilir. Yayin basina bir kez: kullanici kaydi durdurursa
          ayni yayin icin yeniden baslamaz. Program acildiginda yayin suruyorsa da baslar.
        - autoDownload: autoSeen'den yeni ve bitmis VOD'lar kuyruga girer (program kapaliyken
          gelenler de). Suren yayinin VOD'u yayin bitince alinir."""
        first = True
        while not self._closing:
            favs = self.favorites()
            if favs:
                def check(f):
                    try:
                        if f.get("autoDownload"):
                            channel, vods = fetch_channel(f["slug"])
                            return f, channel["live"], vods
                        return f, live_info(kick_get(f"https://kick.com/api/v2/channels/{f['slug']}")), None
                    except Exception as e:  # noqa: BLE001 - bir kanal hatasi digerlerini durdurmaz
                        log.info("canli kontrolu %s: %s", f["slug"], e)
                        return f, False, None     # bilinmiyor: eski durum kalsin
                with ThreadPoolExecutor(max_workers=min(6, len(favs))) as pool:
                    results = list(pool.map(check, favs))
                now = set(self._live_favs)
                for f, live, vods in results:
                    if live is False:
                        continue
                    if live and f["slug"] not in now:
                        now.add(f["slug"])
                        if not first and self._prefs["notifyLive"]:
                            toast(f"{f['name']} canlı yayında", live["title"] or f["name"])
                    elif not live:
                        now.discard(f["slug"])
                    if live and f.get("autoRecord") and self._auto_started.get(f["slug"]) != live["start"]:
                        self._auto_started[f["slug"]] = live["start"]
                        log.info("otomatik kayit: %s", f["slug"])
                        self.enqueue([{"url": f"https://kick.com/{f['slug']}", "live": True,
                                       "title": live["title"] or f["name"], "thumb": live["thumb"]}])
                    if vods is not None:
                        self._auto_download(f, vods)
                now &= {f["slug"] for f in favs}
                if now != self._live_favs:
                    self._live_favs = now
                    self._push(force=True)
                first = False
            self._live_wake.wait(LIVE_POLL)
            self._live_wake.clear()

    def _auto_download(self, f, vods):
        """autoDownload acik favorinin yeni VOD'larini kuyruga ekler ve autoSeen'i ilerletir."""
        seen = f.get("autoSeen") or ""
        new = [v for v in vods if v["start"] > seen]
        live_starts = [v["start"] for v in new if v["live"]]
        # suren yayindan once biten VOD'lar alinir; autoSeen suren yayini gecmesin ki bitince o da alinsin
        ready = [v for v in new if not v["live"] and (not live_starts or v["start"] < min(live_starts))]
        if not ready:
            return
        log.info("otomatik indirme: %s, %d VOD", f["slug"], len(ready))
        self.enqueue([{"url": v["url"], "title": v["title"], "thumb": v["thumb"]} for v in ready])
        with self._fav_lock:
            for fav in self._favorites:
                if fav["slug"] == f["slug"]:
                    fav["autoSeen"] = max(v["start"] for v in ready)
        self._save()
        toast(f"{f['name']}: yeni yayın indiriliyor",
              ready[0]["title"] if len(ready) == 1 else f"{len(ready)} yeni yayın kuyruğa eklendi")
