"""Uygulama ici guncelleyici: surumdeki manifest.json'a gore degisen dosyalari indirir ve yerine koyar.

manifest.json (schema 1), tools/make_manifest.py uretir:
  {"schema": 1, "version": "1.0.1",
   "files": [{"path": "KickIndirici.exe", "size": 123, "sha256": "...", "urls": ["https://...", ...]}, ...],
   "remove": ["eski.dll"],                       istege bagli: artik kullanilmayan dosyalar
   "installer": "https://.../Setup.exe"}         istege bagli: dosya guncellemesi yapilamazsa kurucu calisir

- Yollar uygulama klasorune goredir; yalnizca hash'i farkli ya da eksik dosyalar iner (ffmpeg degismediyse inmez).
- Her dosyanin birden fazla adresi olabilir; sirayla denenir. Boyut ve SHA-256 tutmazsa dosya kabul edilmez.
- Inenler once .update/ klasorune konur. Uygulama: calisan exe silinemez ama yeniden adlandirilabilir;
  eski dosya <ad>.old olur, yenisi yerine gecer. Biri bile basarisiz olursa hepsi geri alinir.
  .old dosyalari ve yarim kalmis .update/ klasoru sonraki acilista temizlenir.
- Manifest bu surumun okuyamadigi bir schema ile gelirse (ya da dosyalari yoksa) kurucuya donulur;
  boylece guncelleyicinin kendisi degisse bile eski surumler takilip kalmaz.
"""

import hashlib
import os
import shutil
import urllib.request
import winreg

SCHEMA = 1
STAGE = ".update"
CHUNK = 256 * 1024


class UpdateError(Exception):
    """Kullaniciya gosterilecek metinle."""


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(1024 * 1024):
            h.update(chunk)
    return h.hexdigest()


def safe_path(root, rel):
    """Manifestteki yolu uygulama klasoru icinde mutlak yola cevirir; disari cikan yollar reddedilir."""
    if not isinstance(rel, str) or not rel or os.path.isabs(rel) or ":" in rel:
        raise UpdateError("Güncelleme bilgisi bozuk.")
    path = os.path.normpath(os.path.join(root, rel))
    if os.path.commonpath([path, os.path.normpath(root)]) != os.path.normpath(root):
        raise UpdateError("Güncelleme bilgisi bozuk.")
    return path


def usable(manifest):
    """Bu surum manifestteki dosya guncellemesini yapabilir mi?"""
    return isinstance(manifest, dict) and manifest.get("schema") == SCHEMA and isinstance(manifest.get("files"), list)


def plan(manifest, root):
    """Inmesi gereken dosyalar: eksik olan ya da hash'i farkli olan."""
    need = []
    for f in manifest["files"]:
        target = safe_path(root, f.get("path"))
        urls = [u for u in (f.get("urls") or []) if isinstance(u, str) and u.startswith("https://")]
        if not urls or not isinstance(f.get("size"), int) or not isinstance(f.get("sha256"), str):
            raise UpdateError("Güncelleme bilgisi bozuk.")
        if os.path.isfile(target) and os.path.getsize(target) == f["size"] and sha256_file(target) == f["sha256"].lower():
            continue
        need.append({"path": f["path"], "target": target, "size": f["size"], "sha256": f["sha256"].lower(), "urls": urls})
    return need


def download(need, root, user_agent, progress=None):
    """Dosyalari .update/ altina indirir ve dogrular. progress(indirilen, toplam) bayt olarak cagrilir."""
    stage = os.path.join(root, STAGE)
    shutil.rmtree(stage, ignore_errors=True)
    total, done = sum(f["size"] for f in need), 0
    for f in need:
        f["staged"] = safe_path(stage, f["path"])
        os.makedirs(os.path.dirname(f["staged"]), exist_ok=True)
        last = None
        for url in f["urls"]:
            got, h = 0, hashlib.sha256()
            try:
                req = urllib.request.Request(url, headers={"User-Agent": user_agent})
                with urllib.request.urlopen(req, timeout=30) as r, open(f["staged"], "wb") as out:
                    while chunk := r.read(CHUNK):
                        out.write(chunk)
                        h.update(chunk)
                        got += len(chunk)
                        if progress:
                            progress(done + got, total)
                if got == f["size"] and h.hexdigest() == f["sha256"]:
                    break
                last = "mismatch"
            except OSError as e:
                last = f"{f['path']}: {e}"
        else:
            if last == "mismatch":
                raise UpdateError("İndirilen dosya doğrulanamadı. Daha sonra tekrar dene.")
            raise UpdateError("Güncelleme indirilemedi. İnterneti kontrol et.") from Exception(last)
        done += f["size"]
    return need


def apply(need, remove, root):
    """Indirilmis dosyalari yerine koyar. Calisan exe dahil eskiler <ad>.old olur; hata olursa geri alinir."""
    swapped = []    # (hedef, eski kopya ya da None)
    try:
        for f in need:
            old = None
            if os.path.exists(f["target"]):
                old = f["target"] + ".old"
                if os.path.exists(old):
                    os.remove(old)
                os.replace(f["target"], old)
            swapped.append((f["target"], old))
            os.makedirs(os.path.dirname(f["target"]), exist_ok=True)
            os.replace(f["staged"], f["target"])
        for rel in remove or []:
            path = safe_path(root, rel)
            if os.path.exists(path):
                os.replace(path, path + ".old")
    except OSError as e:
        for target, old in reversed(swapped):
            try:
                if os.path.exists(target) and old:
                    os.remove(target)
                if old:
                    os.replace(old, target)
            except OSError:
                pass
        raise UpdateError("Dosyalar yerine konamadı; güncelleme geri alındı.") from e
    shutil.rmtree(os.path.join(root, STAGE), ignore_errors=True)


def cleanup(root):
    """Acilista: onceki guncellemeden kalan .old dosyalarini ve yarim .update/ klasorunu siler."""
    shutil.rmtree(os.path.join(root, STAGE), ignore_errors=True)
    for folder, _dirs, files in os.walk(root):
        for name in files:
            if name.endswith(".old"):
                try:
                    os.remove(os.path.join(folder, name))
                except OSError:
                    pass    # eski surec hala kapaniyor olabilir; bir sonraki acilista silinir


def writable(root):
    try:
        probe = os.path.join(root, ".write-test")
        with open(probe, "w"):
            pass
        os.remove(probe)
        return True
    except OSError:
        return False


def set_installed_version(version):
    """Kurucunun 'Uygulamalar' listesindeki surum numarasini gunceller (kurucuyla kurulduysa)."""
    key = r"Software\Microsoft\Windows\CurrentVersion\Uninstall\{6B1E2A54-8C3F-4D7A-9E21-5F0A7C3D4B18}_is1"
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key, 0, winreg.KEY_SET_VALUE) as k:
            winreg.SetValueEx(k, "DisplayVersion", 0, winreg.REG_SZ, version)
    except OSError:
        pass
