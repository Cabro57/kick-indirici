"""Ayar tanimlari ve dogrulayicilari."""

import re

from kickindir.config import CHAT_FORMATS, NAME_DEFAULT, NAME_TOKENS, norm_name
from kickindir.core.i18n import LANGS, detect_lang


def int_or_auto(value, lo, hi):
    return value if type(value) is int and lo <= value <= hi else "auto"


def valid_name(value):
    """Dosya adi sablonu gecerliyse kendisi, degilse None. {title} ya da {id} sart: yoksa
    her indirme ayni adi alir ve birbirinin ustune yazar. Eski Turkce adlar da gecerli."""
    if not isinstance(value, str) or not value.strip() or len(value) > 120:
        return None
    value = value.strip()
    if re.search(r'[\\/:*?"<>|{}]', re.sub(r"\{[a-z]+\}", "", value)):
        return None
    norm = norm_name(value)
    if any(t not in NAME_TOKENS for t in re.findall(r"\{([a-z]+)\}", norm)):
        return None
    return value if "{title}" in norm or "{id}" in norm else None


def chat_formats(value):
    """Sohbet bicimleri: CHAT_FORMATS'tan en az biri, sirasi sabit."""
    if not isinstance(value, list) or not value or any(v not in CHAT_FORMATS for v in value):
        return None
    return [f for f in CHAT_FORMATS if f in value]


def chat_image(value):
    """Sohbet resmi secenekleri: arka plan, saat, rozetler, emote'lar, genislik."""
    if not isinstance(value, dict) or value.get("bg") not in ("dark", "transparent") or value.get("width") not in (360, 480, 640):
        return None
    if any(not isinstance(value.get(k), bool) for k in ("time", "badges", "emotes")):
        return None
    return {k: value[k] for k in ("bg", "time", "badges", "emotes", "width")}


def chat_video(value):
    """Sohbet videosu: arka plan (yesil perde .mp4 / saydam .webm), olcu, yazi boyutu, gosterilecekler."""
    if not isinstance(value, dict) or value.get("bg") not in ("green", "transparent"):
        return None
    for key, lo, hi in (("width", 200, 1920), ("height", 200, 2160), ("font", 10, 60)):
        if type(value.get(key)) is not int or not lo <= value[key] <= hi:
            return None
    if any(not isinstance(value.get(k), bool) for k in ("time", "badges", "emotes")):
        return None
    return {k: value[k] for k in ("bg", "width", "height", "font", "time", "badges", "emotes")}


def flag(value):
    return value if isinstance(value, bool) else None


def ranged(lo, hi):
    return lambda v: v if type(v) is int and lo <= v <= hi else None


# Kullanici tercihleri: ad -> (varsayilan, dogrulayici). Dogrulayici gecersizde None doner,
# o zaman eski deger kalir. Arayuz bunlari get_settings / set_settings ile okur ve yazar.
PREFS = {
    "hoverPreview": (True, flag),            # kartin uzerine gelince onizleme oynasin
    "previewMuted": (False, flag),           # incelemedeki oynatici sessiz baslasin (karttaki onizleme hep sessiz)
    "volume": (50, ranged(0, 100)),          # oynatici ses seviyesi
    "nameTemplate": (NAME_DEFAULT, valid_name),
    "notifyDone": (True, flag),              # kuyruk bitince Windows bildirimi
    "notifyLive": (True, flag),              # favori yayinci canliya gecince Windows bildirimi
    "sectionLength": ("auto", lambda v: v if v == "auto" or (type(v) is int and 5 <= v <= 600) else None),
    "liveRemux": (True, flag),               # canli kayit bitince .ts -> .mp4
    "speedLimit": (0, ranged(0, 1000)),      # toplam indirme hizi siniri, MB/s (0 = sinirsiz)
    "clipboardWatch": (True, flag),          # pencereye donunce panodaki Kick linkini oner
    "updateCheck": (True, flag),             # acilista yeni surum var mi bak
    "chatAuto": (False, flag),               # video / kesit / klip / canli kayit inince sohbeti de indir
    "chatFormats": (["ass", "json"], chat_formats),   # sohbetin yazilacagi bicimler
    "chatPanel": (True, flag),               # izleme penceresinde sohbet paneli acik
    "chatImage": ({"bg": "dark", "time": True, "badges": True, "emotes": True, "width": 480}, chat_image),
    "chatVideo": ({"bg": "green", "width": 400, "height": 720, "font": 18, "time": False, "badges": True, "emotes": True}, chat_video),
    "lang": (detect_lang(), lambda v: v if v in LANGS else None),   # arayuz dili; ilk acilista Windows'tan
}
