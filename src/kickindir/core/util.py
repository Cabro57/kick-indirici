"""Kucuk yardimcilar: bicimleme, dosya adi, bos alan, pano, geri donusum kutusu."""

import ctypes
import os
import re
import shutil

from kickindir.config import norm_name
from kickindir.core.i18n import lang, t


class UserError(RuntimeError):
    """Metni kullaniciya hazir (secili dilde, ne yapilacagini soyler); arayuz oldugu gibi gosterir."""


def fmt_hms(sec, sep="."):
    sec = int(sec)
    return f"{sec // 3600:02d}{sep}{sec % 3600 // 60:02d}{sep}{sec % 60:02d}"


def trim_playlist(text, start, end):
    """HLS medya listesinden yalnizca [start, end] araligina degen parcalari birakir.

    Dondurur: (yeni liste, ilk parcanin basindan kesit basina kadar saniye).
    """
    header, segments, tags, pos = [], [], [], 0.0
    for line in text.splitlines():
        line = line.strip()
        if not line or line == "#EXT-X-ENDLIST":
            continue
        if not line.startswith("#"):
            dur = next((float(x[8:].split(",")[0]) for x in tags if x.startswith("#EXTINF:")), 0.0)
            segments.append((pos, pos + dur, tags + [line]))
            pos += dur
            tags = []
        elif segments or tags or line.startswith(("#EXTINF", "#EXT-X-PROGRAM-DATE-TIME", "#EXT-X-DISCONTINUITY")):
            tags.append(line)
        else:
            header.append(line)
    keep = [seg for seg in segments if seg[1] > start and seg[0] < end]
    if not keep:
        raise UserError(t("err.rangeOutside"))
    header = [h for h in header if not h.startswith("#EXT-X-PLAYLIST-TYPE")]
    body = [line for seg in keep for line in seg[2]]
    return "\n".join(header + ["#EXT-X-PLAYLIST-TYPE:VOD"] + body + ["#EXT-X-ENDLIST"]) + "\n", start - keep[0][0]


def fmt_size(n):
    text = f"{n / 1024 ** 3:.1f} GB" if n >= 1024 ** 3 else f"{n / 1024 ** 2:.0f} MB"
    return text.replace(".", ",") if lang() == "tr" else text


def fmt_speed(mb):
    """MB/s, bir ondalikla; ondalik ayirici dile gore."""
    text = f"{mb:.1f} MB/s"
    return text.replace(".", ",") if lang() == "tr" else text


def fill_name(template, channel, title, date, vid):
    """Dosya adi sablonunu yt-dlp olmadan doldurur (canli kayit, sohbet)."""
    name = norm_name(template)
    for key, value in (("channel", channel), ("title", title[:70]), ("date", date), ("id", vid)):
        name = name.replace("{" + key + "}", value)
    return re.sub(r'[\\/:*?"<>|\r\n]+', "_", name).strip()


def free_space(folder):
    """Klasorun bulundugu diskteki bos alan (bayt). Klasor henuz yoksa var olan ilk ust klasore bakar."""
    path = os.path.abspath(folder)
    while not os.path.exists(path) and os.path.dirname(path) != path:
        path = os.path.dirname(path)
    try:
        return shutil.disk_usage(path).free
    except OSError:
        return None


def clipboard_text():
    """Panodaki metin (Win32, ek kutuphane yok); metin yoksa ya da pano mesgulse ""."""
    user32, kernel32 = ctypes.windll.user32, ctypes.windll.kernel32
    user32.GetClipboardData.restype = ctypes.c_void_p
    kernel32.GlobalLock.argtypes = [ctypes.c_void_p]
    kernel32.GlobalLock.restype = ctypes.c_void_p
    kernel32.GlobalUnlock.argtypes = [ctypes.c_void_p]
    if not user32.OpenClipboard(None):
        return ""
    try:
        handle = user32.GetClipboardData(13)      # CF_UNICODETEXT
        if not handle:
            return ""
        ptr = kernel32.GlobalLock(handle)
        if not ptr:
            return ""
        try:
            return ctypes.wstring_at(ptr)[:2000]
        finally:
            kernel32.GlobalUnlock(handle)
    finally:
        user32.CloseClipboard()


def recycle(path):
    """Dosyayi Geri Donusum Kutusu'na tasir (kalici silmez). Basarili mi."""
    class SHFILEOPSTRUCTW(ctypes.Structure):
        _fields_ = [("hwnd", ctypes.c_void_p), ("wFunc", ctypes.c_uint), ("pFrom", ctypes.c_wchar_p),
                    ("pTo", ctypes.c_wchar_p), ("fFlags", ctypes.c_ushort), ("fAnyOperationsAborted", ctypes.c_int),
                    ("hNameMappings", ctypes.c_void_p), ("lpszProgressTitle", ctypes.c_wchar_p)]
    FO_DELETE, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_SILENT, FOF_NOERRORUI = 3, 0x40, 0x10, 0x4, 0x400
    op = SHFILEOPSTRUCTW(None, FO_DELETE, os.path.abspath(path) + "\0", None,
                         FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI, 0, None, None)
    return ctypes.windll.shell32.SHFileOperationW(ctypes.byref(op)) == 0 and not os.path.exists(path)
