"""Diskte tutulan veri: ayarlar, kuyruk, gecmis, kayitli kesitler."""

import json
import os

from .config import DATA_DIR, HISTORY_PATH, QUEUE_PATH, SETTINGS_PATH, log


def load_settings():
    try:
        with open(SETTINGS_PATH, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_settings(data):
    try:
        os.makedirs(os.path.dirname(SETTINGS_PATH), exist_ok=True)
        with open(SETTINGS_PATH, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
    except OSError:
        pass


def clean_cut_set(url, raw):
    """Diskten ya da dosyadan gelen bir kesit kumesini dogrular; kullanilamazsa None."""
    if not isinstance(url, str) or not url.startswith("http") or not isinstance(raw, dict):
        return None
    clips = []
    for c in raw.get("clips") or []:
        try:
            a, b = int(c["a"]), int(c["b"])
        except (KeyError, TypeError, ValueError):
            continue
        if 0 <= a < b:
            clips.append({"a": a, "b": b, "name": str(c.get("name") or "")[:80], "note": str(c.get("note") or "")[:300]})
    if not clips:
        return None
    clips.sort(key=lambda c: (c["a"], c["b"]))
    text = lambda k: str(raw.get(k) or "")[:300]   # noqa: E731
    return {"uuid": text("uuid"), "title": text("title"), "thumb": text("thumb"), "start": text("start"),
            "channel": text("channel"), "duration": max(0, int(raw["duration"])) if isinstance(raw.get("duration"), (int, float)) else 0,
            "updated": raw["updated"] if isinstance(raw.get("updated"), (int, float)) else 0, "clips": clips}


def load_queue():
    try:
        with open(QUEUE_PATH, encoding="utf-8") as f:
            data = json.load(f)
        return [e for e in data if isinstance(e, dict) and e.get("url")]
    except (OSError, ValueError):
        return []


def save_queue(items):
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        tmp = QUEUE_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(items, f, ensure_ascii=False)
        os.replace(tmp, QUEUE_PATH)
    except OSError as e:
        log.info("kuyruk yazilamadi: %s", e)


def load_history():
    try:
        with open(HISTORY_PATH, encoding="utf-8") as f:
            data = json.load(f)
        return [e for e in data if isinstance(e, dict) and e.get("file")]
    except (OSError, ValueError):
        return []


def save_history(items):
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        tmp = HISTORY_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(items, f, ensure_ascii=False)
        os.replace(tmp, HISTORY_PATH)
    except OSError as e:
        log.info("gecmis yazilamadi: %s", e)
