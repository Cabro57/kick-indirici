"""Sohbet: Kick'ten cekme ve dosyalara yazma (.ass altyazi, .txt, .json, .html)."""

import collections
import html
import json
import re
import time
from concurrent.futures import ThreadPoolExecutor

from kickindir.services.kick import kick_get, kick_time

CHUNK = 300          # aralik bu kadar saniyelik parcalara bolunur; her parca ayri cekilir (paralel)
WORKERS = 8
EMOTE_URL = "https://files.kick.com/emotes/{}/fullsize"


def chat_page(channel_id, cursor, tries=3):
    """Kick'in sohbet gecmisi: cursor anindan (mikro saniye) GERIYE 25 mesaj ve sonraki sayfanin cursor'u.
    Bu API canli yayinda da calisir (yaklasik 20 sn geriden)."""
    for i in range(tries):
        try:
            data = kick_get(f"https://kick.com/api/v2/channels/{channel_id}/messages?cursor={cursor}").get("data") or {}
            return data.get("messages") or [], data.get("cursor")
        except Exception:  # noqa: BLE001 - gecici ag hatasi: biraz bekleyip tekrar
            if i == tries - 1:
                raise
            time.sleep(1 + i)
    return [], None


def fetch_range(channel_id, start, end, cancelled=lambda: False, progress=lambda done, total: None):
    """[start, end) araligindaki (epoch sn) tum mesajlar, zamana gore sirali. Aralik CHUNK'lik parcalara
    bolunur; her parca kendi sonundan geriye sayfa sayfa paralel cekilir. Cursor zamandan uretildigi icin
    parcalar birbirini beklemez. (Eski 5 sn'lik start_time pencereleri kalabalik sohbette mesaj kaciriyordu.)"""
    parts = [(max(a, start), min(a + CHUNK, end)) for a in range(int(start), int(end) + 1, CHUNK) if max(a, start) < min(a + CHUNK, end)]

    def walk(part):
        a, b = part
        got, cursor = [], int(b * 1_000_000)
        while cursor:
            if cancelled():
                raise InterruptedError()
            msgs, cursor = chat_page(channel_id, cursor)
            if not msgs:
                break
            times = []
            for m in msgs:
                try:
                    ts = kick_time(m.get("created_at"))
                except ValueError:
                    continue
                times.append(ts)
                if a <= ts < b:
                    got.append(m)
            if not times or min(times) < a:
                break
        return got

    if not parts:
        return []
    seen, out = set(), []
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        for i, got in enumerate(pool.map(walk, parts), 1):
            for m in got:
                if m.get("id") not in seen and m.get("content"):
                    seen.add(m.get("id"))
                    out.append(m)
            progress(i, len(parts))
    out.sort(key=lambda m: m.get("created_at") or "")
    return out


def chat_entry(m, zero):
    """API mesajindan sade kayit. t: `zero` anindan (epoch sn) itibaren saniye. content emote isaretlerini
    ([emote:id:ad]) korur; text duz metindir."""
    sender = m.get("sender") or {}
    identity = sender.get("identity") or {}
    content = re.sub(r"\s+", " ", m.get("content") or "").strip()
    return {"t": round(kick_time(m.get("created_at")) - zero, 1), "user": sender.get("username") or "?",
            "color": identity.get("color") or "#FFFFFF",
            "text": re.sub(r"\[emote:\d+:([^\]]*)\]", r"\1", content),
            "content": content,
            "badges": [b.get("image_url") for b in identity.get("badges_v2") or [] if b.get("image_url")],
            "id": m.get("id")}


def ass_time(sec):
    sec = max(0.0, sec)
    return f"{int(sec // 3600)}:{int(sec % 3600 // 60):02d}:{sec % 60:05.2f}"


def hms(sec):
    sec = max(0, int(sec))
    return f"{sec // 3600}:{sec % 3600 // 60:02d}:{sec % 60:02d}"


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


def chat_txt(messages):
    """Okunabilir metin: [s:dd:ss] kullanici: mesaj"""
    return "".join(f"[{hms(m['t'])}] {m['user']}: {m['text']}\n" for m in messages)


def chat_html(messages, title):
    """Tarayicida acilan tek dosya: renkli adlar, rozetler ve emote resimleri (Kick'in sunucusundan)."""
    def body(content):
        parts = re.split(r"(\[emote:\d+:[^\]]*\])", content)
        out = []
        for p in parts:
            m = re.fullmatch(r"\[emote:(\d+):([^\]]*)\]", p)
            out.append(f'<img class="e" src="{EMOTE_URL.format(m.group(1))}" alt="{html.escape(m.group(2))}" '
                       f'title="{html.escape(m.group(2))}">' if m else html.escape(p))
        return "".join(out)

    def badges(urls):
        return "".join('<img class="b" src="' + html.escape(u, quote=True) + '" alt="">' for u in urls or [])

    rows = "\n".join(
        f'<p><time>{hms(m["t"])}</time>{badges(m.get("badges"))}'
        f'<b style="color:{html.escape(m["color"], quote=True)}">{html.escape(m["user"])}</b>: {body(m.get("content") or m["text"])}</p>'
        for m in messages)
    return f"""<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{html.escape(title)}</title>
<style>
body {{ margin: 0; padding: 16px; background: #101010; color: #e8e8e8; font: 14px/1.5 "Segoe UI", system-ui, sans-serif; }}
h1 {{ font-size: 16px; margin: 0 0 12px; }}
p {{ margin: 0; padding: 3px 6px; border-radius: 4px; word-wrap: break-word; }}
p:hover {{ background: #1c1c1c; }}
time {{ color: #777; font-variant-numeric: tabular-nums; margin-right: 8px; }}
.b {{ height: 16px; vertical-align: -3px; margin-right: 3px; }}
.e {{ height: 26px; vertical-align: middle; }}
</style></head><body>
<h1>{html.escape(title)}</h1>
{rows}
</body></html>
"""


def write_chat(base, messages, meta, formats):
    """Secilen bicimlerde base + uzanti dosyalari yazar; yazilan dosyalarin listesini dondurur
    (ilki Indirilenler'de gosterilecek dosya)."""
    order = [f for f in ("ass", "html", "txt", "json") if f in formats] or ["ass"]
    files = []
    for f in order:
        path = base + (".chat.json" if f == "json" else ".chat.html" if f == "html" else ".chat.txt" if f == "txt" else ".ass")
        if f == "json":
            text = json.dumps({**meta, "messages": messages}, ensure_ascii=False)
        elif f == "html":
            text = chat_html(messages, meta.get("title") or "")
        elif f == "txt":
            text = chat_txt(messages)
        else:
            text = chat_ass(messages)
        with open(path, "w", encoding="utf-8-sig" if f in ("ass", "txt") else "utf-8") as fh:
            fh.write(text)
        files.append(path)
    return files
