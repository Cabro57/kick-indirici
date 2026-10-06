"""Ayar tanimlari ve dogrulayicilari."""

import re

from .config import NAME_DEFAULT, NAME_TOKENS


def int_or_auto(value, lo, hi):
    return value if type(value) is int and lo <= value <= hi else "auto"


def valid_name(value):
    """Dosya adi sablonu gecerliyse kendisi, degilse None. {baslik} ya da {id} sart: yoksa
    her indirme ayni adi alir ve birbirinin ustune yazar."""
    if not isinstance(value, str) or not value.strip() or len(value) > 120:
        return None
    value = value.strip()
    if re.search(r'[\\/:*?"<>|{}]', re.sub(r"\{[a-z]+\}", "", value)):
        return None
    if any(t not in NAME_TOKENS for t in re.findall(r"\{([a-z]+)\}", value)):
        return None
    return value if "{baslik}" in value or "{id}" in value else None


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
}
