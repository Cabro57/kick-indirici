"""Dil dosyalarini denetler: kodda kullanilan her anahtar en.json'da var mi, tr.json'da eksik ya da
fazla anahtar, {ad} yerleri iki dilde ayni mi. Kullanim: python tools/check_i18n.py"""

import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load(lang):
    with open(os.path.join(ROOT, "web", "i18n", f"{lang}.json"), encoding="utf-8") as f:
        return json.load(f)


def used_keys():
    keys = set()
    for path in ["web/index.html", "web/app.js"]:
        text = open(os.path.join(ROOT, path), encoding="utf-8").read()
        keys |= set(re.findall(r'data-i18n(?:-[a-z]+)?="([^"]+)"', text))
        keys |= set(re.findall(r'\bt\("([^"]+)"', text))
    for base, _, files in os.walk(os.path.join(ROOT, "src")):
        for name in files:
            if name.endswith(".py"):
                text = open(os.path.join(base, name), encoding="utf-8").read()
                keys |= set(re.findall(r'\bt\("([^"]+)"', text))
    return keys


def slots(value):
    values = value.values() if isinstance(value, dict) else [value]
    return {s for v in values for s in re.findall(r"\{(\w+)\}", v)}


def main():
    en, tr = load("en"), load("tr")
    problems = []
    for key in sorted(used_keys() - set(en)):
        problems.append(f"en.json'da yok: {key}")
    for key in sorted(set(en) - set(tr)):
        if not key.startswith("lang."):
            problems.append(f"tr.json'da eksik: {key}")
    for key in sorted(set(tr) - set(en)):
        problems.append(f"tr.json'da fazla: {key}")
    for key in sorted(set(en) & set(tr)):
        if slots(en[key]) != slots(tr[key]):
            problems.append(f"yer tutucular farkli: {key}")
    print("\n".join(problems) or f"tamam: {len(en)} anahtar")
    # sablon anahtarlari (t(`status.${s}`)) bu taramada gorunmez; kullanilmayan anahtar listesi bu yuzden yok
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
