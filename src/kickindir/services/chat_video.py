"""Sohbet videosu: mesajlar alttan girip yukari kayar (yesil perde .mp4 ya da saydam .webm). Kareleri Pillow
cizer (chat_image.Painter), ffmpeg kodlar. Ekran yalnizca yeni mesaj gelince degisir: her degisen kare bir
kez PNG olarak yazilir ve ffmpeg'e sureleriyle (concat listesi) verilir; arada ayni kare tekrar cizilmez."""

import os
import re
import shutil
import subprocess
import tempfile
import threading

from PIL import Image

from kickindir.services.chat_image import Painter

FPS = 30
SLIDE = 5            # yeni mesajin kayarak girisi (kare): ~0,17 sn
GREEN = (0, 177, 64)


def render_video(messages, duration, opts, out, ffmpeg, progress=lambda frac: None, cancelled=lambda: False):
    """messages: chat_entry kayitlari, t videonun basindan sn (sirali). duration: videonun uzunlugu (sn).
    opts: bg "green" | "transparent", width, height, font, time / badges / emotes. out: .mp4 ya da .webm.
    Kare cizimi isin ilk %40'i, kodlama kalani."""
    w, h, size = opts.get("width", 400), opts.get("height", 720), opts.get("font", 18)
    pad, gap = round(size * 0.6), round(size * 0.35)
    green = opts.get("bg") != "transparent"
    painter = Painter(opts, w - 2 * pad, size, True)
    painter.prefetch(messages)
    total = max(1, round(duration * FPS))
    work = tempfile.mkdtemp(prefix="chatvid-")
    try:
        frames = []                                   # [(kare no, dosya)]
        shown = []                                    # ekrandaki mesaj resimleri, en yenisi sonda
        blank = Image.new("RGBA", (w, h), GREEN + (255,) if green else (0, 0, 0, 0))

        def frame(no, offset):
            im = blank.copy()
            y = h - pad + offset
            for tile in reversed(shown):
                y -= tile.height
                if y + tile.height < 0:
                    break
                im.alpha_composite(tile, (pad, y))
                y -= gap
            path = os.path.join(work, f"{len(frames):07d}.png")
            (im.convert("RGB") if green else im).save(path, compress_level=1)
            frames.append((no, path))

        frame(0, 0)
        groups = {}
        for m in messages:
            no = round(m["t"] * FPS)
            if 0 <= no < total:
                groups.setdefault(no, []).append(m)
        starts = sorted(groups)
        for i, no in enumerate(starts):
            if cancelled():
                raise InterruptedError()
            tiles = [painter.tile(m) for m in groups[no]]
            shown.extend(tiles)
            used, keep = 0, 0
            for tile in reversed(shown):                  # ekrandan tasanlari birak
                used += tile.height + gap
                keep += 1
                if used > h + h // 2:
                    break
            del shown[:-keep]
            rise = sum(t.height + gap for t in tiles)
            end = starts[i + 1] if i + 1 < len(starts) else total
            for k in range(SLIDE):
                if no + k >= end:
                    break
                p = (k + 1) / SLIDE
                frame(no + k, round(rise * (1 - p) ** 3))        # yavaslayarak yerine oturur
            if i % 50 == 0:
                progress(0.4 * i / len(starts))
        lst = os.path.join(work, "list.ffconcat")
        with open(lst, "w", encoding="utf-8") as fh:
            fh.write("ffconcat version 1.0\n")
            for j, (no, path) in enumerate(frames):
                nxt = frames[j + 1][0] if j + 1 < len(frames) else total
                fh.write(f"file '{os.path.basename(path)}'\nduration {(nxt - no) / FPS:.6f}\n")
            fh.write(f"file '{os.path.basename(frames[-1][1])}'\n")
        if green:
            codec = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-tune", "animation", "-pix_fmt", "yuv420p", "-movflags", "+faststart"]
        else:
            codec = ["-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-crf", "40", "-b:v", "0", "-deadline", "realtime",
                     "-cpu-used", "8", "-row-mt", "1"]
        cmd = [ffmpeg, "-hide_banner", "-y", "-f", "concat", "-safe", "0", "-i", lst, "-vf", f"fps={FPS}",
               *codec, "-progress", "pipe:1", "-nostats", out]
        proc = subprocess.Popen(cmd, cwd=work, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        err = []
        threading.Thread(target=lambda: err.extend(proc.stderr), daemon=True).start()
        for line in proc.stdout:
            if cancelled():
                proc.kill()
                proc.wait()
                raise InterruptedError()
            m = re.match(r"out_time_us=(\d+)", line)
            if m:
                progress(0.4 + 0.6 * min(1.0, int(m.group(1)) / 1e6 / max(duration, 1)))
        if proc.wait() != 0:
            raise RuntimeError("ffmpeg: " + "".join(err[-5:]).strip()[-300:])
        progress(1.0)
        return out
    finally:
        shutil.rmtree(work, ignore_errors=True)
