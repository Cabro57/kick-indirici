"""Sohbet mesajlarinin resmi (PNG): renkli adlar, rozetler, emote resimleri, emoji. Pillow ile cizilir;
ileride sohbet videosunun kareleri de ayni cizimle uretilecek."""

import io
import os
import re
import time
from concurrent.futures import ThreadPoolExecutor

from PIL import Image, ImageDraw, ImageFont
from curl_cffi import requests as cffi_requests

from kickindir.services.chat import EMOTE_URL, hms

FONTS = os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts")
_fonts, _images = {}, {}
EMOJI = re.compile(r"[\u2190-\u2bff\u3030\u303d\u3297\u3299\ufe0f\u200d\U0001f000-\U0001faff]")
CJK = re.compile(r"[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]")


def font(name, size):
    """Windows yazi tipi; yoksa Pillow'un kendi yazi tipi."""
    key = (name, size)
    if key not in _fonts:
        try:
            _fonts[key] = ImageFont.truetype(os.path.join(FONTS, name), size)
        except OSError:
            _fonts[key] = ImageFont.load_default(size)
    return _fonts[key]


def fetch_image(url):
    """Rozet / emote resmi (animasyonluysa ilk kare); alinamazsa None. Bellekte saklanir."""
    if url not in _images:
        try:
            r = cffi_requests.get(url, impersonate="chrome", timeout=10)
            r.raise_for_status()
            _images[url] = Image.open(io.BytesIO(r.content)).convert("RGBA")
        except Exception:  # noqa: BLE001 - resim gelmezse yerine ad yazilir
            _images[url] = None
    return _images[url]


def runs(text, regular, emoji, cjk):
    """Metni yazi tipi degisen parcalara boler: [(metin, yazi tipi, emoji mi)]."""
    out = []
    for ch in text:
        f, e = (emoji, True) if EMOJI.match(ch) else (cjk, False) if CJK.match(ch) else (regular, False)
        if out and out[-1][1] is f:
            out[-1][0] += ch
        else:
            out.append([ch, f, e])
    return out


def render_chat(messages, opts):
    """messages: chat_entry kayitlari. opts: bg "dark" | "transparent", time / badges / emotes (bool),
    width (px), clock (canli: t epoch, saat yerel saat olarak yazilir). Resim 2 kat cozunurlukte cizilir: paylasildiginda keskin kalsin."""
    s = 2
    width = max(240, min(1200, int(opts.get("width") or 420))) * s
    show_time, show_badges, show_emotes = opts.get("time", True), opts.get("badges", True), opts.get("emotes", True)
    dark = opts.get("bg") != "transparent"
    size, emote_h, badge_h, pad, gap = 15 * s, 28 * s, 18 * s, 14 * s, 6 * s
    regular, bold = font("segoeui.ttf", size), font("segoeuib.ttf", size)
    emoji, cjk = font("seguiemj.ttf", size), font("msyh.ttc", size)
    line_h = int(size * 1.45)
    space = draw_len(" ", regular)

    urls = set()
    for m in messages:
        if show_badges:
            urls.update(m.get("badges") or [])
        if show_emotes:
            urls.update(EMOTE_URL.format(i) for i in re.findall(r"\[emote:(\d+):", m.get("content") or ""))
    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(fetch_image, urls - _images.keys()))

    # her mesaj: ogeler ("text", metin, yazi tipi, renk, emoji) | ("img", resim, yukseklik) | ("sp",)
    blocks = []
    for m in messages:
        items = []
        if show_time:
            stamp = time.strftime("%H:%M:%S", time.localtime(m.get("t") or 0)) if opts.get("clock") else hms(m.get("t") or 0)
            items += [("text", stamp, regular, (140, 140, 150), False), ("sp",)]
        for u in m.get("badges") or [] if show_badges else []:
            img = _images.get(u)
            if img:
                items += [("img", img, badge_h), ("gap",)]
        items += [("text", m.get("user") or "?", bold, color(m.get("color")), False), ("text", ":", regular, (235, 235, 240), False), ("sp",)]
        content = m.get("content") or m.get("text") or ""
        for part in re.split(r"(\[emote:\d+:[^\]]*\])", content):
            em = re.fullmatch(r"\[emote:(\d+):([^\]]*)\]", part)
            img = em and show_emotes and _images.get(EMOTE_URL.format(em.group(1)))
            if img:
                items += [("sp",), ("img", img, emote_h)]
                continue
            for i, word in enumerate((em.group(2) if em else part).split(" ")):
                if i or em:
                    items.append(("sp",))
                for text, f, e in runs(word, regular, emoji, cjk):
                    items.append(("text", text, f, (235, 235, 240), e))
        blocks.append(items)

    # satirlara yerlestirme: kelime sigmazsa alt satira; tek basina sigmayan uzun kelime harf harf bolunur
    inner = width - 2 * pad
    laid = []                       # [(satir yuksekligi, [(x, oge)])]
    for items in blocks:
        lines, x, prev = [[]], 0, None
        for it in items:
            if it[0] == "sp":
                x += space if x and prev != "sp" else 0
                prev = "sp"
                continue
            prev = it[0]
            if it[0] == "gap":
                x += 3 * s
                continue
            w = item_width(it)
            if x + w > inner and x > 0:
                lines.append([])
                x = 0
            if w > inner and it[0] == "text":
                for ch in it[1]:
                    cw = draw_len(ch, it[2])
                    if x + cw > inner:
                        lines.append([])
                        x = 0
                    lines[-1].append((x, ("text", ch, it[2], it[3], it[4])))
                    x += cw
                continue
            lines[-1].append((x, it))
            x += w
        for ln in lines:
            h = max([line_h] + [it[2] + 2 * s for _, it in ln if it[0] == "img"])
            laid.append((h, ln))
        laid.append((gap, []))
    if laid:
        laid.pop()

    height = sum(h for h, _ in laid) + 2 * pad
    im = Image.new("RGBA", (width, max(height, 2 * pad)), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    if dark:
        d.rounded_rectangle((0, 0, width - 1, im.height - 1), radius=10 * s, fill=(24, 24, 27, 255))
    y = pad
    for h, ln in laid:
        mid = y + h // 2
        for x, it in ln:
            if it[0] == "img":
                img = scaled(it[1], it[2])
                im.alpha_composite(img, (pad + x, mid - img.height // 2))
            else:
                _, text, f, rgb, is_emoji = it
                kw = {"embedded_color": True} if is_emoji else {"fill": rgb}
                if not dark and not is_emoji:
                    kw.update(stroke_width=s, stroke_fill=(0, 0, 0))
                d.text((pad + x, mid), text, font=f, anchor="lm", **kw)
        y += h
    out = io.BytesIO()
    im.save(out, "PNG", optimize=True)
    return out.getvalue()


def draw_len(text, f):
    return int(f.getlength(text))


def item_width(it):
    if it[0] == "img":
        return scaled(it[1], it[2]).width
    return draw_len(it[1], it[2])


_scaled = {}


def scaled(img, h):
    key = (id(img), h)
    if key not in _scaled:
        _scaled[key] = img.resize((max(1, round(img.width * h / img.height)), h), Image.LANCZOS)
    return _scaled[key]


def color(hexcode):
    h = (hexcode or "").lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4)) if re.fullmatch(r"[0-9A-Fa-f]{6}", h) else (255, 255, 255)
