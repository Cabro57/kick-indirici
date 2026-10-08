"""Sohbet videosu: mesajlar alttan girip yukari kayar (yesil perde .mp4 ya da saydam .webm), hareketli
emote'lar oynar. Kareleri Pillow cizer (chat_image.Painter), ffmpeg'e ham goruntu olarak akar. Bir kare
yalnizca ekranda bir sey degisince (yeni mesaj, kayma, emote'un sonraki karesi) yeniden cizilir; degismeyen
kare cizilmeden tekrar gonderilir."""

import subprocess
import threading

from PIL import Image

from kickindir.services.chat_image import Painter, anim_frame, scaled

FPS = 30
SLIDE = 5            # yeni mesajin kayarak girisi (kare): ~0,17 sn
GREEN = (0, 177, 64)


def render_video(messages, duration, opts, out, ffmpeg, progress=lambda frac: None, cancelled=lambda: False):
    """messages: chat_entry kayitlari, t videonun basindan sn (sirali). duration: videonun uzunlugu (sn).
    opts: bg "green" | "transparent", width, height, font, time / badges / emotes. out: .mp4 ya da .webm."""
    w, h, size = opts.get("width", 400), opts.get("height", 720), opts.get("font", 18)
    pad, gap = round(size * 0.6), round(size * 0.35)
    green = opts.get("bg") != "transparent"
    painter = Painter(opts, w - 2 * pad, size, True)
    painter.prefetch(messages)
    total = max(1, round(duration * FPS))
    if green:
        codec = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-tune", "animation", "-pix_fmt", "yuv420p",
                 "-movflags", "+faststart"]
    else:
        codec = ["-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-crf", "40", "-b:v", "0", "-deadline", "realtime",
                 "-cpu-used", "8", "-row-mt", "1"]
    cmd = [ffmpeg, "-hide_banner", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24" if green else "rgba", "-s", f"{w}x{h}",
           "-r", str(FPS), "-i", "pipe:0", *codec, out]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    err = []
    threading.Thread(target=lambda: err.extend(proc.stderr), daemon=True).start()

    groups = {}
    for m in messages:
        no = round(m["t"] * FPS)
        if 0 <= no < total:
            groups.setdefault(no, []).append(m)
    blank = Image.new("RGBA", (w, h), GREEN + (255,) if green else (0, 0, 0, 0))
    shown = []                    # ekrandaki mesajlar, en yenisi sonda: (resim, hareketli resim yerleri)
    arrived, rise = -SLIDE, 0     # son mesajin geldigi kare ve kayma payi
    last_key, buf = None, None
    try:
        for f in range(total):
            if f in groups:
                new = []
                for m in groups[f]:
                    spots = []
                    new.append((painter.tile(m, spots), spots))
                shown.extend(new)
                arrived, rise = f, sum(t.height + gap for t, _ in new)
                used, keep = 0, 0
                for tile, _ in reversed(shown):           # ekrandan tasanlari birak
                    used += tile.height + gap
                    keep += 1
                    if used > h + h // 2:
                        break
                del shown[:-keep]
            k = f - arrived
            offset = round(rise * (1 - (k + 1) / SLIDE) ** 3) if k < SLIDE else 0   # yavaslayarak yerine oturur
            # gorunen mesajlar ve hareketli resimlerinin o anki kareleri: degismediyse ayni kare tekrar gider
            t = f / FPS
            y, visible = h - pad + offset, []
            for tile, spots in reversed(shown):
                y -= tile.height
                if y + tile.height < 0:
                    break
                visible.append((tile, spots, y))
                y -= gap
            frames = [anim_frame(url, t) for _, spots, _ in visible for *_, url in spots]
            key = (offset, len(shown), id(shown[-1][0]) if shown else 0, tuple(id(x) for x in frames))
            if key != last_key:
                im = blank.copy()
                it = iter(frames)
                for tile, spots, ty in visible:
                    im.alpha_composite(tile, (pad, ty))
                    for x, sy, sh, _ in spots:
                        fr = scaled(next(it), sh)
                        if 0 <= ty + sy and ty + sy + fr.height <= h:
                            im.alpha_composite(fr, (pad + x, ty + sy))
                        else:
                            part = Image.new("RGBA", (w, h), (0, 0, 0, 0))
                            part.paste(fr, (pad + x, ty + sy))
                            im.alpha_composite(part)
                buf = (im.convert("RGB") if green else im).tobytes()
                last_key = key
            proc.stdin.write(buf)
            if f % 300 == 0:
                if cancelled():
                    raise InterruptedError()
                progress(f / total)
        proc.stdin.close()
        if proc.wait() != 0:
            raise RuntimeError("ffmpeg: " + b"".join(err[-5:]).decode(errors="replace").strip()[-300:])
    except BaseException:
        proc.kill()
        proc.wait()
        raise
    progress(1.0)
    return out
