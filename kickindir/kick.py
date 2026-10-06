"""Kick API'si: kanal, VOD, klip ve canli yayin bilgisi, HLS listeleri."""

import calendar
import re
import urllib.request
from curl_cffi import requests as cffi_requests

from .config import QUALITIES


# ---------- Kick API ----------
def kick_get(url):
    r = cffi_requests.get(url, impersonate="chrome", timeout=20)
    if r.status_code == 404:
        raise LookupError("Kanal ya da video bulunamadi.")
    r.raise_for_status()
    return r.json()


def parse_link(text):
    """Linkten (kanal_slug, vod_uuid, klip_mi) cikarir."""
    text = text.strip()
    if re.search(r"/clips?/|[?&]clip=", text):
        return None, None, True
    m = re.search(r"kick\.com/video/([0-9a-f-]{36})", text)
    if m:
        return None, m.group(1), False
    m = re.search(r"kick\.com/([A-Za-z0-9_-]+)(?:/videos/([0-9a-f-]{36}))?", text)
    if m:
        return m.group(1).lower(), m.group(2), False
    if re.fullmatch(r"[A-Za-z0-9_-]+", text):   # sadece kanal adi yazildiysa
        return text.lower(), None, False
    return None, None, False


def kick_error(e):
    if isinstance(e, LookupError):
        return str(e).replace("bulunamadi", "bulunamadı")
    return f"Kick'e ulaşılamadı. İnternet bağlantını kontrol edip tekrar dene. ({str(e)[:120]})"


def vod_channel(uuid):
    return kick_get(f"https://kick.com/api/v1/video/{uuid}")["livestream"]["channel"]["slug"]


def live_info(ch):
    """Kanal su an canliysa yayin bilgisi, degilse None. (playback_url kapaliyken de dolu gelir.)"""
    ls = ch.get("livestream")
    if not ls or not ls.get("is_live") or not ch.get("playback_url"):
        return None
    return {
        "title": ls.get("session_title") or "",
        "viewers": ls.get("viewer_count") or 0,
        "start": ls.get("start_time") or ls.get("created_at") or "",
        "thumb": (ls.get("thumbnail") or {}).get("url") or "",
        "category": ((ls.get("categories") or [{}])[0] or {}).get("name", ""),
        "source": ch.get("playback_url") or "",     # HLS: arayuzdeki canli oynatici
    }


def hls_variants(master_url):
    """Ana HLS listesindeki surumler. name: '1080p60' gibi (cozunurluk + kare hizi)."""
    master = cffi_requests.get(master_url, impersonate="chrome", timeout=20).text
    out, inf = [], None
    for line in master.splitlines():
        line = line.strip()
        if line.startswith("#EXT-X-STREAM-INF"):
            inf = line
        elif line and not line.startswith("#") and inf is not None:
            bw = re.search(r"BANDWIDTH=(\d+)", inf)
            res = re.search(r"RESOLUTION=\d+x(\d+)", inf)
            fps = re.search(r"FRAME-RATE=([\d.]+)", inf)
            name = f"{res.group(1)}p{round(float(fps.group(1))) if fps else ''}" if res else ""
            out.append({"name": name, "bw": int(bw.group(1)) if bw else 0, "video": bool(res),
                        "url": urllib.parse.urljoin(master_url, line)})
            inf = None
    return out


def live_variant(master_url, quality):
    """Canli kayit icin secilen kalitenin medya listesi; yoksa en iyisi.
    ffmpeg'e ana liste verilirse tum surumleri birden ceker, o yuzden tek surum secilir."""
    video = [v for v in hls_variants(master_url) if v["video"]]
    if not video:
        return master_url
    match = [v for v in video if quality != QUALITIES[0] and v["name"].startswith(quality)]
    return max(match or video, key=lambda v: v["bw"])["url"]


def fetch_channel(slug):
    ch = kick_get(f"https://kick.com/api/v2/channels/{slug}")
    user = ch.get("user") or {}
    vods = []
    for v in kick_get(f"https://kick.com/api/v2/channels/{slug}/videos"):
        video = v.get("video") or {}
        if not video.get("uuid"):
            continue
        vods.append({
            "url": f"https://kick.com/{slug}/videos/{video['uuid']}",
            "uuid": video["uuid"],
            "title": v.get("session_title") or video["uuid"],
            "start": v.get("start_time") or v.get("created_at") or "",
            "duration": round((v.get("duration") or 0) / 1000),
            "views": video.get("views") or v.get("views") or 0,
            "thumb": (v.get("thumbnail") or {}).get("src") or "",
            "category": ((v.get("categories") or [{}])[0] or {}).get("name", ""),
            # API'nin verdigi tum kategoriler (zaman bilgisi yok)
            "categories": [c["name"] for c in v.get("categories") or [] if c and c.get("name")],
            "live": bool(v.get("is_live")),     # suren yayin da listede gelir
            "source": v.get("source") or "",     # HLS ana listesi: kart uzerinde onizleme / oynatici
        })
    return {
        "id": ch.get("id"),
        "slug": slug,
        "name": user.get("username") or slug,
        "avatar": user.get("profile_pic") or "",
        "followers": ch.get("followers_count") or 0,
        "verified": bool(ch.get("verified")),
        "live": live_info(ch),
    }, vods


def fetch_clips(slug, sort="date", cursor=None):
    """Kanalin kliplerinden bir sayfa (20 adet) ve sonraki sayfanin cursor'u."""
    url = f"https://kick.com/api/v2/channels/{slug}/clips"
    params = ["sort=view", "time=all"] if sort == "view" else []
    if cursor:
        params.append("cursor=" + urllib.parse.quote(cursor))
    if params:
        url += "?" + "&".join(params)
    data = kick_get(url)
    clips = []
    for c in data.get("clips") or []:
        clips.append({
            "url": f"https://kick.com/{slug}/clips/{c['id']}",
            "uuid": c["id"],
            "title": c.get("title") or c["id"],
            "start": c.get("created_at") or "",
            "duration": c.get("duration") or 0,
            "views": c.get("views") or c.get("view_count") or 0,
            "thumb": c.get("thumbnail_url") or "",
            "category": (c.get("category") or {}).get("name", ""),
            "creator": (c.get("creator") or {}).get("username", ""),
            "source": c.get("video_url") or c.get("clip_url") or "",   # HLS: onizleme / oynatici
        })
    return clips, data.get("nextCursor")


def kick_time(text):
    """Kick'in tarih metni ('2026-10-03 20:36:38', '...T20:36:38Z', '+00:00') -> epoch sn (UTC)."""
    m = re.match(r"(\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d):(\d\d)", text or "")
    if not m:
        raise ValueError(f"tarih anlaşılamadı: {text!r}")
    return calendar.timegm(tuple(int(x) for x in m.groups()) + (0, 0, 0))


def playlist_duration(master_url):
    """VOD suresi API'de yoksa (yayin yeni bittiyse 0 gelir) en dusuk surumun parca sureleri toplami."""
    variants = hls_variants(master_url)
    url = min(variants, key=lambda x: x["bw"] or 1 << 40)["url"] if variants else master_url
    text = cffi_requests.get(url, impersonate="chrome", timeout=20).text
    return sum(float(x[8:].split(",")[0]) for x in text.splitlines() if x.startswith("#EXTINF:"))
