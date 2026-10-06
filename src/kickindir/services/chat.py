"""VOD sohbeti: Kick'ten cekme ve .ass altyaziya cevirme."""

import collections
import re
import time

from kickindir.services.kick import kick_get, kick_time


def chat_window(channel_id, start, tries=3):
    """Sohbetin [start, start + CHAT_WINDOW) araligindaki mesajlari (Kick'in tekrar oynatma API'si)."""
    stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(start))
    for i in range(tries):
        try:
            data = kick_get(f"https://kick.com/api/v2/channels/{channel_id}/messages?start_time={stamp}")
            return (data.get("data") or {}).get("messages") or []
        except Exception:  # noqa: BLE001 - gecici ag hatasi: biraz bekleyip tekrar
            if i == tries - 1:
                raise
            time.sleep(1 + i)
    return []


def chat_entry(m, vod_start):
    """API mesajindan sade kayit: t (yayin basindan sn), kullanici, renk, metin."""
    sender = m.get("sender") or {}
    text = re.sub(r"\[emote:\d+:([^\]]*)\]", r"\1", m.get("content") or "")
    return {"t": round(kick_time(m.get("created_at")) - vod_start, 1), "user": sender.get("username") or "?",
            "color": (sender.get("identity") or {}).get("color") or "#FFFFFF",
            "text": re.sub(r"\s+", " ", text).strip(), "id": m.get("id")}


def ass_time(sec):
    sec = max(0.0, sec)
    return f"{int(sec // 3600)}:{int(sec % 3600 // 60):02d}:{sec % 60:05.2f}"


def chat_ass(messages, lines=10, hold=10):
    """Sohbet altyazisi: her mesajda sol ustteki kutu son `lines` mesaji gosterir; sonraki mesaja
    (en fazla `hold` sn) kadar ekranda kalir. Oynatici videoyla ayni adli .ass dosyasini kendisi acar."""
    def esc(s):
        return s.replace("\\", "∖").replace("{", "(").replace("}", ")")

    def color(hexcode):
        h = hexcode.lstrip("#")
        return f"&H{h[4:6]}{h[2:4]}{h[0:2]}&" if re.fullmatch(r"[0-9A-Fa-f]{6}", h) else "&HFFFFFF&"

    out = ["[Script Info]", "ScriptType: v4.00+", "PlayResX: 1920", "PlayResY: 1080", "WrapStyle: 0", "",
           "[V4+ Styles]",
           "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, "
           "Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, "
           "MarginR, MarginV, Encoding",
           "Style: Chat,Segoe UI,30,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,0,7,24,1380,24,1",
           "", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text"]
    shown = collections.deque(maxlen=lines)
    for i, m in enumerate(messages):
        shown.append(f"{{\\c{color(m['color'])}\\b1}}{esc(m['user'])}{{\\c&HFFFFFF&\\b0}}: {esc(m['text'][:200])}")
        end = min(messages[i + 1]["t"], m["t"] + hold) if i + 1 < len(messages) else m["t"] + hold
        if end > m["t"]:
            text = "\\N".join(shown)
            out.append(f"Dialogue: 0,{ass_time(m['t'])},{ass_time(end)},Chat,,0,0,0,,{text}")
    return "\n".join(out) + "\n"
