"""CapCut masaustu taslagi: indirilen videoyu zaman cizelgesine koyan hazir bir proje klasoru yazar.

CapCut'in resmi bir disari aktarma yolu yok; taslak klasorundeki JSON dosyalari belgesiz bir bicim.
Burada CapCut'in kendi taslaklarindan cikarilmis en kucuk alan kumesi yazilir, eksik alanlari CapCut
acarken kendisi doldurur. Bicim degisirse open_in_capcut UserError verir, arayuz klasoru gosterir.
"""

import json
import os
import re
import subprocess
import time
import uuid

from kickindir.core.i18n import t
from kickindir.core.util import UserError

CAPCUT_DIR = os.path.join(os.environ.get("LOCALAPPDATA", ""), "CapCut")
DRAFT_VERSION = 360000          # CapCut 9.x taslaklarindaki "version"
NEW_VERSION = "110.0.0"         # eski bir bicim surumu: yeni CapCut eski taslagi kendisi yukseltir


def _uid():
    return str(uuid.uuid4()).upper()


def capcut_exe():
    """Kurulu CapCut.exe; yoksa None."""
    exe = os.path.join(CAPCUT_DIR, "Apps", "CapCut.exe")
    return exe if os.path.isfile(exe) else None


def draft_root():
    """CapCut'in taslak klasoru: ayarlarda degistirildiyse oradaki, yoksa varsayilan."""
    try:
        with open(os.path.join(CAPCUT_DIR, "User Data", "Config", "globalSetting"), encoding="utf-8") as f:
            for line in f:
                if line.startswith("currentCustomDraftPath="):
                    path = line.split("=", 1)[1].strip().replace("\\\\", "\\")
                    if os.path.isdir(path):
                        return path
    except OSError:
        pass
    return os.path.join(CAPCUT_DIR, "User Data", "Projects", "com.lveditor.draft")


def probe(ffmpeg, path):
    """(sure mikrosaniye, genislik, yukseklik, ses var mi): ffprobe paketlenmedigi icin ffmpeg -i ciktisindan."""
    out = subprocess.run([ffmpeg, "-nostdin", "-hide_banner", "-i", path], stdin=subprocess.DEVNULL,
                         capture_output=True, timeout=30, creationflags=subprocess.CREATE_NO_WINDOW)
    text = out.stderr.decode("utf-8", "replace")
    dur = re.search(r"Duration: (\d+):(\d\d):(\d\d(?:\.\d+)?)", text)
    size = re.search(r"Stream #.*?Video:.*?, (\d{2,5})x(\d{2,5})[ ,\[]", text)
    if not dur or not size:
        raise UserError(t("err.capcutProbe"))
    h, m, s = dur.groups()
    return (round((int(h) * 3600 + int(m) * 60 + float(s)) * 1_000_000), int(size.group(1)), int(size.group(2)),
            bool(re.search(r"Stream #.*?Audio:", text)))


def _unique_folder(root, name):
    name = re.sub(r'[\\/:*?"<>|\r\n]+', "_", name).strip(" .")[:80] or "Kick"
    folder, n = os.path.join(root, name), 1
    while os.path.exists(folder):
        n += 1
        folder = os.path.join(root, f"{name} ({n})")
    return folder


def _video_material(mid, path, dur, w, h, has_audio):
    return {
        "id": mid, "type": "video", "path": path.replace("\\", "/"), "material_name": os.path.basename(path),
        "duration": dur, "width": w, "height": h, "has_audio": has_audio, "category_name": "local",
        "crop": {"upper_left_x": 0.0, "upper_left_y": 0.0, "upper_right_x": 1.0, "upper_right_y": 0.0,
                 "lower_left_x": 0.0, "lower_left_y": 1.0, "lower_right_x": 1.0, "lower_right_y": 1.0},
        "crop_ratio": "free", "crop_scale": 1.0, "source_platform": 0,
    }


def _segment(mid, refs, start, dur, render_index, scale=1.0, x=0.0, y=0.0, volume=1.0):
    return {
        "id": _uid(), "material_id": mid, "extra_material_refs": refs,
        "source_timerange": {"start": 0, "duration": dur}, "target_timerange": {"start": start, "duration": dur},
        "speed": 1.0, "volume": volume, "last_nonzero_volume": 1.0, "visible": True, "reverse": False,
        "clip": {"scale": {"x": scale, "y": scale}, "rotation": 0.0, "transform": {"x": x, "y": y},
                 "flip": {"vertical": False, "horizontal": False}, "alpha": 1.0},
        "uniform_scale": {"on": True, "value": 1.0}, "render_index": render_index,
        "track_render_index": render_index, "enable_adjust": True, "enable_lut": True, "keyframe_refs": [],
        "common_keyframes": [], "hdr_settings": {"mode": 1, "intensity": 1.0, "nits": 1000},
    }


def write_draft(ffmpeg, clips, name):
    """Taslak klasorunu yazar, yolunu dondurur. clips: [(video, sohbet videosu ya da None)]. Videolar ana
    izde arka arkaya, tuval ilk videonun kendi boyutunda; sohbetler ust izde kendi videosunun hizasinda,
    sag ust kosede."""
    root = draft_root()
    if not os.path.isdir(root):
        raise UserError(t("err.capcutMissing"))
    probed = [(probe(ffmpeg, v), c if c and os.path.isfile(c) else None) for v, c in clips]
    _, W, H, _ = probed[0][0]
    materials, speeds = [], []
    main = {"id": _uid(), "type": "video", "attribute": 0, "flag": 0, "name": "", "is_default_name": True, "segments": []}
    over = {**main, "id": _uid(), "segments": []}

    # CapCut malzemeyi once tuvale sigdirir, sonra scale ile buyutur. Konum (x, y) tuvalin yari
    # boyutu cinsinden, merkezden; y yukari dogru artar.
    def add(track, path, start, d, mw, mh, audio, **place):
        mid, sid = _uid(), _uid()
        materials.append(_video_material(mid, path, d, mw, mh, audio))
        speeds.append({"id": sid, "type": "speed", "mode": 0, "speed": 1.0, "curve_speed": None})
        track["segments"].append(_segment(mid, [sid], start, d, 0 if track is main else 1, **place))

    start = 0
    for ((dur, vw, vh, has_audio), chat), (video, _) in zip(probed, clips):
        add(main, video, start, dur, vw, vh, has_audio)
        if chat:                                # sag ust kose, tuvalin %45'i
            cdur, cw, ch, _ = probe(ffmpeg, chat)
            fit = min(W / cw, H / ch)
            scale = min(H * 0.45 / (ch * fit), W * 0.95 / (cw * fit))
            sw, sh = cw * fit * scale, ch * fit * scale
            add(over, chat, start, min(cdur, dur), cw, ch, False, scale=scale,
                x=(W - sw) / W, y=(H - sh) / H, volume=0.0)
        start += dur
    dur = start
    tracks = [main] + ([over] if over["segments"] else [])

    folder = _unique_folder(root, name)
    draft_id, now_us = _uid(), int(time.time() * 1_000_000)
    content = {
        "id": draft_id, "version": DRAFT_VERSION, "new_version": NEW_VERSION, "name": "", "duration": dur,
        "create_time": 0, "update_time": 0, "fps": 30.0, "color_space": 0,
        "canvas_config": {"ratio": "original", "width": W, "height": H, "background": None},
        "config": {"maintrack_adsorb": True, "video_mute": False},
        "platform": {"os": "windows", "app_source": "cc", "app_id": 359289},
        "tracks": tracks,
        "materials": {"videos": materials, "speeds": speeds, "audios": [], "texts": [], "canvases": [],
                      "sound_channel_mappings": [], "material_animations": [], "placeholder_infos": [],
                      "vocal_separations": [], "effects": [], "stickers": [], "transitions": []},
        "keyframes": {"videos": [], "audios": [], "texts": [], "stickers": [], "filters": [], "adjusts": [],
                      "handwrites": [], "effects": []},
        "relationships": [], "mutable_config": None, "last_modified_platform": {"os": "windows", "app_source": "cc"},
    }
    meta = {
        "draft_id": _uid(), "draft_name": os.path.basename(folder), "draft_fold_path": folder.replace("\\", "/"),
        "draft_root_path": root, "draft_cover": "", "draft_removable_storage_device": "",
        "draft_materials": [{"type": k, "value": []} for k in (0, 1, 2, 3, 6, 7, 8)],
        "draft_timeline_materials_size_": 0, "draft_is_invisible": False, "draft_type": "",
        "tm_draft_create": now_us, "tm_draft_modified": now_us, "tm_draft_removed": 0, "tm_duration": dur,
    }
    os.makedirs(folder)
    for fname, data in (("draft_content.json", content), ("draft_meta_info.json", meta)):
        with open(os.path.join(folder, fname), "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
    return folder


def launch():
    """CapCut'i baslatir (aciksa yeni pencere acmaz, one getirir). Kurulu degilse False."""
    exe = capcut_exe()
    if not exe:
        return False
    subprocess.Popen([exe], cwd=os.path.dirname(exe), creationflags=subprocess.DETACHED_PROCESS)
    return True
