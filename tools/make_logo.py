"""Kick Indirici logosu: Kick'in resmi "K" harfi + sag altta indirme rozeti.

Tek geometri kaynagi; buradan uretilir:
  assets/logo.svg        kaynak (web/logo.svg kopyasi uygulamanin sol ustundeki isaret)
  assets/logo-1024.png   buyuk PNG
  assets/app.ico         exe / pencere / gorev cubugu ikonu (16-256 px)
Calistir: python tools/make_logo.py
"""

import os

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "assets")

GREEN = "#53FC18"
INK = "#0B0E0F"
U = 64                      # tasarim izgarasi (64 x 64)
TILE_R = 14                 # karo kose yaricapi

# K: kick.com/img/kick-logo.svg icindeki resmi "K" harfi (KICK yazisinin ilk harfi), birebir.
# Kisisel kullanim icin; program dagitilacaksa Kick markasi nedeniyle degistirilmeli.
KICK_K = ("M0 .028h7.7v5.32h2.561v-2.66h2.562V.028h7.7v7.996H17.96v2.66h-2.562v2.66h2.562v2.66h2.562V24"
          "h-7.699v-2.66h-2.562v-2.66H7.7V24H0V.028Z")


def k_polygon(scale, dx, dy):
    """Yalnizca M/h/v/H/V iceren yolu kose noktalarina cevirir."""
    import re
    pts, x, y = [], 0.0, 0.0
    for cmd, num in re.findall(r"([MhvHVZ])([-\d.]*)", KICK_K):
        n = float(num) if num else 0.0
        if cmd == "M":
            x, y = 0.0, n          # yol "M0 .028" ile basliyor
        elif cmd == "h":
            x += n
        elif cmd == "v":
            y += n
        elif cmd == "H":
            x = n
        elif cmd == "V":
            y = n
        else:
            continue
        pts.append((dx + x * scale, dy + y * scale))
    return pts


K_SCALE = 1.72
K_POLY = k_polygon(K_SCALE, 10.5, 11.4)     # ~35 x 41 birim, rozete yer birakacak sekilde sola yasli
# indirme rozeti: koyu bosluk halkasi + yesil daire + koyu asagi ok
BADGE_C, BADGE_R, GAP = (50, 50), 10.5, 3
ARROW = [(48.2, 43.2), (51.8, 43.2), (51.8, 49.2), (55.2, 49.2), (50, 55.6), (44.8, 49.2), (48.2, 49.2)]


def svg(tile=True):
    parts = []
    if tile:
        parts.append(f'<rect width="{U}" height="{U}" rx="{TILE_R}" fill="{INK}"/>')
    pts = " ".join(f"{x:.2f},{y:.2f}" for x, y in K_POLY)
    parts.append(f'<polygon points="{pts}" fill="{GREEN}"/>')
    cx, cy = BADGE_C
    ring = INK if tile else "none"
    if tile:
        parts.append(f'<circle cx="{cx}" cy="{cy}" r="{BADGE_R + GAP}" fill="{ring}"/>')
    parts.append(f'<circle cx="{cx}" cy="{cy}" r="{BADGE_R}" fill="{GREEN}"/>')
    pts = " ".join(f"{x},{y}" for x, y in ARROW)
    parts.append(f'<polygon points="{pts}" fill="{INK}"/>')
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {U} {U}">{"".join(parts)}</svg>'


def raster(size):
    """Ust ornekleme ile kenar yumusatmali cizim."""
    ss = 4
    s = size * ss / U
    im = Image.new("RGBA", (size * ss, size * ss), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([0, 0, size * ss - 1, size * ss - 1], radius=TILE_R * s, fill=INK)
    d.polygon([(x * s, y * s) for x, y in K_POLY], fill=GREEN)
    cx, cy = BADGE_C
    r = BADGE_R + GAP
    d.ellipse([(cx - r) * s, (cy - r) * s, (cx + r) * s, (cy + r) * s], fill=INK)
    r = BADGE_R
    d.ellipse([(cx - r) * s, (cy - r) * s, (cx + r) * s, (cy + r) * s], fill=GREEN)
    d.polygon([(x * s, y * s) for x, y in ARROW], fill=INK)
    return im.resize((size, size), Image.LANCZOS)


def main():
    os.makedirs(OUT, exist_ok=True)
    for path in (os.path.join(OUT, "logo.svg"), os.path.join(ROOT, "web", "logo.svg")):
        with open(path, "w", encoding="utf-8") as f:
            f.write(svg())
    raster(1024).save(os.path.join(OUT, "logo-1024.png"))
    sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
    big = raster(256)
    big.save(os.path.join(OUT, "app.ico"), sizes=[(n, n) for n in sizes],
             append_images=[raster(n) for n in sizes if n != 256])
    print("assets/logo.svg, logo-1024.png, app.ico")


if __name__ == "__main__":
    main()
