"""Kapak resminin "parazit / statik" olup olmadigini anlar (Kick bazi yayinlara duz bir gurultu resmi koyabilir).
Muhafazakar sezgi: gri tonlu + yuksek frekansli (komsu piksel farki buyuk) + genis duz bolge yok. Olculer
gercek kapak resimleri ve sentetik statik uzerinde ayarlandi (PERF/DESIGN notlarina bak: esikler asagida)."""

import io
import json
import os
import threading
import urllib.parse

from curl_cffi import requests as cffi_requests
from PIL import Image

from kickindir.config import DATA_DIR, log

CROP = (96, 54)              # olceklemeden alinan pencereler: gurultu piksel olceginde gorunur (kucultme onu siler)
SPOTS = ((.25, .25), (.75, .25), (.25, .75), (.75, .75), (.5, .5))   # pencere merkezleri (genislik / yukseklik orani)
# esikler: (doygunluk <, komsu fark >, duz piksel payi <, parazit sayilan pencere sayisi >=)
LOOSE = (0.06, 10.0, 0.12, 4)    # VOD / indirilen dosya: yanlis alarm ucuz (yerine gercek kare gelir)
STRICT = (0.04, 14.0, 0.08, 5)   # klip: yerine gercek kare yok, yalnizca yedek poster; daha siki

MAX_BYTES = 2 << 20          # kapak resimleri 1-200 KB; daha buyugu indirilmez
MAX_PIXELS = 4096 * 4096

_lock = threading.Lock()
_mem = {}
_path = os.path.join(DATA_DIR, "thumbs", "noise-check.json")


def _window(im, cx, cy):
    w, h = im.size
    cw, ch = min(CROP[0], w), min(CROP[1], h)
    x0 = max(0, min(w - cw, int(w * cx - cw / 2)))
    y0 = max(0, min(h - ch, int(h * cy - ch / 2)))
    win = im.crop((x0, y0, x0 + cw, y0 + ch))
    px = list(win.getdata())
    sat = 0.0
    for r, g, b in px:
        m = max(r, g, b)
        sat += (m - min(r, g, b)) / m if m else 0.0
    sat /= len(px)
    gray = list(win.convert("L").getdata())
    diff = n = flat = 0
    for y in range(ch - 1):
        row = y * cw
        for x in range(cw - 1):
            i = row + x
            dh = abs(gray[i + 1] - gray[i])
            dv = abs(gray[i + cw] - gray[i])
            diff += dh + dv
            n += 2
            if max(dh, dv) <= 4:
                flat += 1
    return sat, diff / n, flat / (n / 2)


def metrics(raw):
    """Resim baytlarindan pencere basina (doygunluk, komsu fark, duz pay) listesi. Cozulemezse None."""
    try:
        im = Image.open(io.BytesIO(raw))
        if im.size[0] * im.size[1] > MAX_PIXELS:     # cozmeden once boyut siniri
            return None
        im.load()
    except Exception:  # noqa: BLE001
        return None
    im = im.convert("RGB")
    return [_window(im, cx, cy) for cx, cy in SPOTS]


def is_noise(ms, limits=LOOSE):
    """Pencerelerin yeterince cogu gri + yuksek frekansli + duz bolgesiz ise parazit."""
    if not ms:
        return False
    sat, diff, flat, need = limits
    return sum(1 for m in ms if m[0] < sat and m[1] > diff and m[2] < flat) >= need


def _load():
    global _mem
    try:
        with open(_path, encoding="utf-8") as f:
            _mem = json.load(f)
    except (OSError, ValueError):
        _mem = {}


def _kick_host(url):
    """Kapaklar yalnizca Kick'ten gelir: https ve *.kick.com (images.kick.com, clips.kick.com)."""
    u = urllib.parse.urlsplit(url)
    return u.scheme == "https" and (u.hostname or "").endswith(".kick.com")


def _fetch(url):
    """Govdeyi en cok MAX_BYTES okur; fazlasi ya da hata None."""
    r = cffi_requests.get(url, impersonate="chrome", timeout=20, stream=True)
    try:
        r.raise_for_status()
        if int(r.headers.get("content-length") or 0) > MAX_BYTES:
            return None
        buf = bytearray()
        for chunk in r.iter_content():
            buf += chunk
            if len(buf) > MAX_BYTES:
                return None
        return bytes(buf)
    finally:
        r.close()


def check(url, strict=False):
    """{"noise": bool}; sonuc URL basina bellekte ve diskte (kucuk json) onbelleklenir. Alinamazsa noise False."""
    if not _kick_host(url):
        return {"noise": False}
    with _lock:
        if not _mem:
            _load()
        hit = _mem.get(url)
    if hit is None:
        try:
            raw = _fetch(url)
            hit = [[round(v, 4) for v in w] for w in (metrics(raw) if raw else None) or ()]
        except Exception as e:  # noqa: BLE001 - ag / cozme hatasi: parazit sayma
            log.info("kapak kontrolu yapilamadi: %s", e)
            return {"noise": False}
        with _lock:
            _mem[url] = hit
            try:
                os.makedirs(os.path.dirname(_path), exist_ok=True)
                with open(_path, "w", encoding="utf-8") as f:
                    json.dump(_mem, f)
            except OSError:
                pass
    noise = is_noise(hit, STRICT if strict else LOOSE)
    if noise:
        log.info("noise thumb: %s %s", url, hit)
    return {"noise": noise}
