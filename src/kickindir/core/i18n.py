"""Arayuz dili: web/i18n/<dil>.json sozlukleri. Ingilizce asil kaynak; diger dilde eksik anahtar
Ingilizceye, o da yoksa anahtarin kendisine duser. Arayuz ayni sozlugu init() ile alir."""

import ctypes
import json
import os
import re

from kickindir.config import log, resource_dir

LANGS = ("en", "tr")
DEFAULT_LANG = "en"

_strings = {}
_lang = DEFAULT_LANG


def detect_lang():
    """Windows arayuz dili listede varsa o, yoksa Ingilizce (ilk acilista bir kez)."""
    try:
        primary = ctypes.windll.kernel32.GetUserDefaultUILanguage() & 0x3FF
    except (AttributeError, OSError):
        return DEFAULT_LANG
    return {0x1F: "tr"}.get(primary, DEFAULT_LANG)


def _load(lang):
    try:
        with open(os.path.join(resource_dir(), "web", "i18n", f"{lang}.json"), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError) as e:
        log.info("dil dosyasi okunamadi (%s): %s", lang, e)
        return {}


def set_lang(lang):
    """Etkin dili secer; Ingilizce temel, ustune secilen dil yazilir."""
    global _lang, _strings
    _lang = lang if lang in LANGS else DEFAULT_LANG
    _strings = _load(DEFAULT_LANG)
    if _lang != DEFAULT_LANG:
        _strings.update(_load(_lang))


def lang():
    return _lang


def strings():
    return _strings


def t(key, **kw):
    """Sozlukteki metin, {ad} yerlerine kw. Cogul icin deger {"one", "other"} olabilir; n ile secilir."""
    if not _strings:
        set_lang(_lang)
    s = _strings.get(key, key)
    if isinstance(s, dict):
        s = s.get("one" if kw.get("n") == 1 and _lang == "en" else "other") or s.get("other") or key
    # bilinmeyen {ad} oldugu gibi kalir: metinde {title} gibi sablon adlari da gecebilir
    return re.sub(r"\{(\w+)\}", lambda m: str(kw[m.group(1)]) if m.group(1) in kw else m.group(0), s)
