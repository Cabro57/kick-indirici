"""Surum icin manifest.json uretir; uygulama-ici guncelleyici bunu okur (bkz. src/kickindir/services/updater.py).

    python tools/make_manifest.py --version 1.0.1 --base-url https://github.com/.../releases/download/v1.0.1 \
        --installer KickIndirici-Setup-1.0.1.exe --out dist/manifest.json \
        KickIndirici.exe=dist/KickIndirici.exe ffmpeg.exe=dist/ffmpeg.exe LICENSE-ffmpeg.txt=installer/LICENSE-ffmpeg.txt

Her dosya "uygulamadaki-yol=diskteki-kaynak" olarak verilir; release'e uygulamadaki adin son parcasiyla yuklenir.
Yeni bir dosya eklemek ya da birini kaldirmak icin yalnizca bu komut satiri degisir (--remove eski.dll).
"""

import argparse
import hashlib
import json
import os
import posixpath


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(1024 * 1024):
            h.update(chunk)
    return h.hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--version", required=True)
    ap.add_argument("--base-url", required=True, help="release dosyalarinin indirildigi adres")
    ap.add_argument("--installer", help="dosya guncellemesi yapilamazsa calisacak kurucunun release'teki adi")
    ap.add_argument("--remove", action="append", default=[], help="artik kullanilmayan dosya (uygulamadaki yol)")
    ap.add_argument("--out", required=True)
    ap.add_argument("files", nargs="+", help="uygulamadaki-yol=diskteki-kaynak")
    a = ap.parse_args()
    base = a.base_url.rstrip("/")
    files = []
    for spec in a.files:
        rel, src = spec.split("=", 1)
        files.append({"path": rel, "size": os.path.getsize(src), "sha256": sha256(src),
                      "urls": [f"{base}/{posixpath.basename(rel)}"]})
    manifest = {"schema": 1, "version": a.version, "files": files, "remove": a.remove}
    if a.installer:
        manifest["installer"] = f"{base}/{a.installer}"
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False)
    print(json.dumps(manifest, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
