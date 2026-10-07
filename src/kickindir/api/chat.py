"""Uygulama icindeki sohbet paneli: videoyla eszamanli mesajlar (VOD, klip, indirilen dosya, canli yayin)
ve secilen mesajlarin resmi (PNG)."""

import base64
import json
import os
import re
import threading
import time

import webview

from kickindir.config import LIVE_CHAT_LAG, log
from kickindir.core.i18n import t
from kickindir.services.chat import CHUNK, chat_entry, fetch_range
from kickindir.services.chat_image import render_chat
from kickindir.services.kick import kick_get, kick_time

PUSHER = "wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.4.0&flash=false"
PART = 20                 # panelin 5 dk'lik parcasi 20 sn'lik dilimlerle paralel cekilir: ~1 sn
LIVE_KEEP = 2000          # canli panelde tutulan en fazla mesaj


class ChatSource:
    """Bir videonun sohbeti. Zaman cizelgesi videonun basindan saniye; ranges onu yayindaki gercek
    zamana esler: [(epoch baslangic, epoch bitis, videodaki yeri)]. Dosyanin yaninda .chat.json varsa
    mesajlar hazir (messages)."""

    def __init__(self, channel_id=None, ranges=(), messages=None, live=False):
        self.channel_id, self.ranges, self.messages = channel_id, list(ranges), messages
        self.live = live                # suren yayinin VOD'u: sondaki parca sonradan tekrar cekilir
        self.chunks = {}                # parca no -> mesajlar
        self.lock = threading.Lock()

    def chunk(self, k):
        """[k*CHUNK, (k+1)*CHUNK) araligindaki mesajlar, zamana gore sirali. (mesajlar, tamam mi)"""
        a, b = k * CHUNK, (k + 1) * CHUNK
        if self.messages is not None:
            return [m for m in self.messages if a <= m["t"] < b], True
        with self.lock:
            if k in self.chunks:
                return self.chunks[k], True
        out, final = [], True
        for ra, rb, off in self.ranges:
            lo, hi = max(a, off), min(b, off + (rb - ra))
            if lo >= hi:
                continue
            ea, eb = ra + lo - off, ra + hi - off
            if self.live and eb > time.time() - LIVE_CHAT_LAG:
                final = False
            for m in fetch_range(self.channel_id, ea, eb, part=PART, workers=16):
                try:
                    e = chat_entry(m, ra)
                except ValueError:
                    continue
                e["t"] = round(e["t"] + off, 1)
                out.append(e)
        out.sort(key=lambda e: e["t"])
        if final:
            with self.lock:
                self.chunks[k] = out
        return out, final


class LiveChat:
    """Canli yayinin sohbeti: Kick'in Pusher kanalindan anlik mesajlar. Acilista son dakikalar gecmis
    API'sinden gelir; o API ~20 sn geriden verdigi icin 40 sn sonra bir kez daha okunup aradaki bosluk
    doldurulur. Mesajlarin t'si epoch saniyedir; arayuz oynaticinin gosterdigi ana gore suzer."""

    def __init__(self, channel_id, chatroom_id):
        self.channel_id, self.chatroom_id = channel_id, chatroom_id
        self.items, self.ids, self.seq = [], set(), 0     # items: (sira no, kayit)
        self.lock = threading.Lock()
        self.stopped = False
        self.polled = time.time()
        threading.Thread(target=self._history, args=(180,), daemon=True).start()
        threading.Thread(target=self._socket, daemon=True).start()

    def _add(self, msgs):
        with self.lock:
            for m in sorted(msgs, key=lambda m: m.get("created_at") or ""):
                if m.get("id") in self.ids or not m.get("content"):
                    continue
                try:
                    e = chat_entry(m, 0)
                except ValueError:
                    continue
                self.ids.add(m.get("id"))
                self.seq += 1
                self.items.append((self.seq, e))
            if len(self.items) > LIVE_KEEP:
                self.items = self.items[-LIVE_KEEP:]

    def _history(self, back):
        try:
            now = time.time()
            self._add(fetch_range(self.channel_id, now - back, now + 5))
            time.sleep(40)
            if not self.stopped:
                self._add(fetch_range(self.channel_id, now - LIVE_CHAT_LAG, time.time()))
        except Exception as e:  # noqa: BLE001 - gecmis gelmezse canli akis yine calisir
            log.info("canli sohbet gecmisi alinamadi: %s", e)

    def _socket(self):
        from curl_cffi import requests as cffi_requests
        while not self.stopped:
            ws = None
            try:
                ws = cffi_requests.Session(impersonate="chrome").ws_connect(PUSHER)
                ws.send(json.dumps({"event": "pusher:subscribe",
                                    "data": {"auth": "", "channel": f"chatrooms.{self.chatroom_id}.v2"}}).encode())
                while not self.stopped:
                    if time.time() - self.polled > 60:      # arayuz artik sormuyor: pencere kapanmis
                        self.stopped = True
                        break
                    msg = json.loads(ws.recv()[0])
                    ev = msg.get("event") or ""
                    if ev == "pusher:ping":
                        ws.send(b'{"event":"pusher:pong","data":{}}')
                    elif ev.endswith("ChatMessageEvent"):
                        self._add([json.loads(msg.get("data") or "{}")])
            except Exception as e:  # noqa: BLE001 - baglanti koptu: biraz bekleyip yeniden
                if not self.stopped:
                    log.info("canli sohbet baglantisi koptu: %s", e)
                    time.sleep(3)
            finally:
                if ws is not None:
                    try:
                        ws.close()
                    except Exception:  # noqa: BLE001
                        pass

    def since(self, seq):
        self.polled = time.time()
        with self.lock:
            return [e for s, e in self.items if s > seq], self.seq


class ChatMixin:
    """Sohbet paneli icin JS cagrilari."""

    def chat_open(self, spec):
        """Panelin kaynagini hazirlar. spec: {"vod": uuid} | {"clip": klip no} | {"file": yol} | {"live": kanal}.
        Doner: {"ok", "id", "live"}; sonra chat_chunk (canlida chat_live) ile mesajlar istenir."""
        try:
            key = json.dumps(spec, sort_keys=True)
            with self._chat_lock:
                src = self._chats.get(key)
            if isinstance(src, LiveChat) and src.stopped:
                src = None
            if src is None:
                src = self._chat_source(spec)
                if src is None:
                    return {"ok": False, "error": t("chat.panel.none")}
                with self._chat_lock:
                    self._chats[key] = src
            return {"ok": True, "id": key, "live": isinstance(src, LiveChat)}
        except Exception as e:  # noqa: BLE001
            log.info("sohbet acilamadi (%s): %s", spec, e)
            return {"ok": False, "error": t("chat.panel.failed", e=str(e)[:120])}

    def _chat_source(self, spec):
        if spec.get("live"):
            ch = kick_get(f"https://kick.com/api/v2/channels/{spec['live']}")
            return LiveChat(ch["id"], (ch.get("chatroom") or {}).get("id") or ch["id"])
        if spec.get("clip"):
            c = kick_get(f"https://kick.com/api/v2/clips/{spec['clip']}").get("clip") or {}
            try:
                a = kick_time(c.get("started_at"))
            except ValueError:
                a = 0
            if a < 946684800 or not c.get("channel_id"):
                return None
            return ChatSource(c["channel_id"], [(a, a + (c.get("duration") or 60), 0.0)])
        if spec.get("vod"):
            return self._vod_source(spec["vod"])
        path = spec.get("file") or ""
        with self._lock:
            entry = next((e for e in self._history if e["file"] == path), None)
        if not entry:
            return None
        side = os.path.splitext(path)[0] + ".chat.json"
        if os.path.isfile(side):
            with open(side, encoding="utf-8") as fh:
                msgs = json.load(fh).get("messages") or []
            return ChatSource(messages=sorted((m for m in msgs if isinstance(m, dict) and "t" in m), key=lambda m: m["t"]))
        url = entry.get("url") or ""
        m = re.search(r"(clip_[A-Za-z0-9]+)", url)
        if m:
            return self._chat_source({"clip": m.group(1)})
        m = re.search(r"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})", url)
        if not m or entry.get("live"):
            return None
        spans = entry.get("sections") or ([entry["section"]] if entry.get("section") else None)
        return self._vod_source(m.group(1), spans)

    @staticmethod
    def _vod_source(uuid, spans=None):
        v = kick_get(f"https://kick.com/api/v1/video/{uuid}")
        ls = v.get("livestream") or {}
        when = kick_time(ls.get("start_time") or ls.get("created_at"))
        if not spans:
            return ChatSource(ls["channel_id"], [(when, when + 7 * 86400, 0.0)], live=bool(ls.get("is_live")))
        ranges, off = [], 0.0
        for sa, sb in spans:
            ranges.append((when + sa, when + sb, off))
            off += sb - sa
        return ChatSource(ls["channel_id"], ranges)

    def chat_chunk(self, cid, k):
        """Videonun k. CHUNK'lik parcasindaki mesajlar. final False ise (suren yayinin sonu) sonra yine sorulur."""
        with self._chat_lock:
            src = self._chats.get(cid)
        if not isinstance(src, ChatSource) or not isinstance(k, int) or k < 0:
            return {"ok": False, "error": t("chat.panel.none")}
        try:
            msgs, final = src.chunk(k)
        except Exception as e:  # noqa: BLE001
            log.info("sohbet parcasi alinamadi (%s, %s): %s", cid, k, e)
            return {"ok": False, "error": t("chat.panel.failed", e=str(e)[:120])}
        return {"ok": True, "messages": msgs, "final": final, "size": CHUNK}

    def chat_live(self, cid, seq=0):
        """Canli sohbette seq'ten sonra gelen mesajlar ve son sira no."""
        with self._chat_lock:
            src = self._chats.get(cid)
        if not isinstance(src, LiveChat):
            return {"ok": False, "error": t("chat.panel.none")}
        msgs, last = src.since(seq if isinstance(seq, int) else 0)
        return {"ok": True, "messages": msgs, "seq": last}

    def chat_close(self, cid):
        with self._chat_lock:
            src = self._chats.get(cid)
            if isinstance(src, LiveChat):
                src.stopped = True
                del self._chats[cid]

    def chat_image(self, messages, opts, action="copy"):
        """Secilen mesajlarin resmi. action "copy": PNG'nin base64'u doner (arayuz panoya yazar);
        "save": kaydetme penceresi acilir."""
        try:
            png = render_chat(messages or [], opts or {})
        except Exception as e:  # noqa: BLE001
            log.info("sohbet resmi cizilemedi: %s", e)
            return {"ok": False, "error": t("chat.img.failed")}
        if action != "save":
            return {"ok": True, "png": base64.b64encode(png).decode()}
        res = self._window.create_file_dialog(webview.FileDialog.SAVE, directory=self._folder,
                                              save_filename="chat.png", file_types=("PNG (*.png)",))
        path = res[0] if isinstance(res, (list, tuple)) and res else res
        if not path:
            return {"ok": True, "saved": ""}
        if not path.lower().endswith(".png"):
            path += ".png"
        with open(path, "wb") as fh:
            fh.write(png)
        return {"ok": True, "saved": path}
