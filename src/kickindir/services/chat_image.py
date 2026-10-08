"""Sohbet mesajlarinin resmi (PNG): renkli adlar, rozetler, emote resimleri, emoji. Pillow ile cizilir;
ileride sohbet videosunun kareleri de ayni cizimle uretilecek."""

import io
import os
import re
import time
import unicodedata
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
        if ch not in "‍️" and unicodedata.category(ch) in ("Cf", "Co", "Cn", "Cc"):
            continue                    # gorunmez isaretler (or. ayni mesaji tekrar yollamak icin eklenen U+E0000): kutu cizilmesin
        f, e = (emoji, True) if EMOJI.match(ch) else (cjk, False) if CJK.match(ch) else (regular, False)
        if out and out[-1][1] is f:
            out[-1][0] += ch
        else:
            out.append([ch, f, e])
    return out


class Painter:
    """Tek tek mesaj resimleri (saydam zeminli, `width` genisliginde). Resim de video da bunlari dizer.
    size: yazi boyutu (px, olcek dahil); outline: zemin koyu degilse yazilar okunsun diye siyah kontur."""

    def __init__(self, opts, width, size, outline, s=1):
        self.opts, self.width, self.s, self.outline = opts, width, s, outline
        self.show_time, self.show_badges, self.show_emotes = opts.get("time", True), opts.get("badges", True), opts.get("emotes", True)
        self.emote_h, self.badge_h = round(size * 28 / 15), round(size * 18 / 15)
        self.regular, self.bold = font("segoeui.ttf", size), font("segoeuib.ttf", size)
        self.emoji, self.cjk = font("seguiemj.ttf", size), font("msyh.ttc", size)
        self.line_h = int(size * 1.45)
        self.space = draw_len(" ", self.regular)

    def prefetch(self, messages):
        """Rozet ve emote resimlerini paralel indirir (her biri bir kez)."""
        urls = set()
        for m in messages:
            if self.show_badges:
                urls.update(m.get("badges") or [])
            if self.show_emotes:
                urls.update(EMOTE_URL.format(i) for i in re.findall(r"\[emote:(\d+):", m.get("content") or ""))
        with ThreadPoolExecutor(max_workers=16) as pool:
            list(pool.map(fetch_image, urls - _images.keys()))

    def items(self, m):
        """Mesajin ogeleri: ("text", metin, yazi tipi, renk, emoji) | ("img", resim, yukseklik) | ("sp",) | ("gap",)"""
        items = []
        if self.show_time:
            t = m.get("stamp", m.get("t")) or 0                 # stamp: kisa videoda asil saat
            stamp = time.strftime("%H:%M:%S", time.localtime(t)) if self.opts.get("clock") else hms(t)
            items += [("text", stamp, self.regular, (140, 140, 150), False), ("sp",)]
        for u in m.get("badges") or [] if self.show_badges else []:
            img = _images.get(u)
            if img:
                items += [("img", img, self.badge_h), ("gap",)]
        items += [("text", m.get("user") or "?", self.bold, color(m.get("color")), False),
                  ("text", ":", self.regular, (235, 235, 240), False), ("sp",)]
        content = m.get("content") or m.get("text") or ""
        for part in re.split(r"(\[emote:\d+:[^\]]*\])", content):
            em = re.fullmatch(r"\[emote:(\d+):([^\]]*)\]", part)
            img = em and self.show_emotes and _images.get(EMOTE_URL.format(em.group(1)))
            if img:
                items += [("sp",), ("img", img, self.emote_h)]
                continue
            for i, word in enumerate((em.group(2) if em else part).split(" ")):
                if i or em:
                    items.append(("sp",))
                for text, f, e in runs(word, self.regular, self.emoji, self.cjk):
                    items.append(("text", text, f, (235, 235, 240), e))
        return items

    def lines(self, m):
        """Satirlara yerlestirme: kelime sigmazsa alt satira; tek basina sigmayan uzun kelime harf harf
        bolunur. [(satir yuksekligi, [(x, oge)])]"""
        lines, x, prev = [[]], 0, None
        for it in self.items(m):
            if it[0] == "sp":
                x += self.space if x and prev != "sp" else 0
                prev = "sp"
                continue
            prev = it[0]
            if it[0] == "gap":
                x += 3 * self.s
                continue
            w = item_width(it)
            if x + w > self.width and x > 0:
                lines.append([])
                x = 0
            if w > self.width and it[0] == "text":
                for ch in it[1]:
                    cw = draw_len(ch, it[2])
                    if x + cw > self.width:
                        lines.append([])
                        x = 0
                    lines[-1].append((x, ("text", ch, it[2], it[3], it[4])))
                    x += cw
                continue
            lines[-1].append((x, it))
            x += w
        return [(max([self.line_h] + [it[2] + 2 * self.s for _, it in ln if it[0] == "img"]), ln) for ln in lines]

    def tile(self, m):
        laid = self.lines(m)
        im = Image.new("RGBA", (self.width, sum(h for h, _ in laid)), (0, 0, 0, 0))
        d = ImageDraw.Draw(im)
        y = 0
        for h, ln in laid:
            mid = y + h // 2
            for x, it in ln:
                if it[0] == "img":
                    img = scaled(it[1], it[2])
                    im.alpha_composite(img, (x, mid - img.height // 2))
                else:
                    _, text, f, rgb, is_emoji = it
                    kw = {"embedded_color": True} if is_emoji else {"fill": rgb}
                    if self.outline and not is_emoji:
                        kw.update(stroke_width=self.s, stroke_fill=(0, 0, 0))
                    d.text((x, mid), text, font=f, anchor="lm", **kw)
            y += h
        return im


def render_chat(messages, opts):
    """messages: chat_entry kayitlari. opts: bg "dark" | "transparent", time / badges / emotes (bool),
    width (px), clock (canli: t epoch, saat yerel saat olarak yazilir). Resim 2 kat cozunurlukte
    cizilir: paylasildiginda keskin kalsin."""
    s = 2
    width = max(240, min(1200, int(opts.get("width") or 420))) * s
    dark = opts.get("bg") != "transparent"
    pad, gap = 14 * s, 6 * s
    painter = Painter(opts, width - 2 * pad, 15 * s, not dark, s)
    painter.prefetch(messages)
    tiles = [painter.tile(m) for m in messages]
    height = sum(t.height for t in tiles) + gap * max(0, len(tiles) - 1) + 2 * pad
    im = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    if dark:
        ImageDraw.Draw(im).rounded_rectangle((0, 0, width - 1, height - 1), radius=10 * s, fill=(24, 24, 27, 255))
    y = pad
    for tile in tiles:
        im.alpha_composite(tile, (pad, y))
        y += tile.height + gap
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
