"""Kayitli kesit setleri: liste, kaydet, sil, disa/ice aktar."""

import copy
import json
import time
import webview

from kickindir.core.storage import clean_cut_set


class CutsMixin:
    """Kayitli kesit setleri: liste, kaydet, sil, disa/ice aktar."""

    def _cuts_snapshot(self):
        with self._cuts_lock:
            return copy.deepcopy(self._cuts)

    def cuts_list(self):
        """Kayitli kesit kumeleri, en son degisen once."""
        sets = [{"url": u, **e} for u, e in self._cuts_snapshot().items()]
        return sorted(sets, key=lambda e: e["updated"], reverse=True)

    def cuts_save(self, url, meta, clips):
        """Bir VOD'un kesit listesini saklar; liste bossa kaydi siler."""
        entry = clean_cut_set(url, {**(meta or {}), "clips": clips, "updated": time.time()})
        with self._cuts_lock:
            if entry:
                self._cuts[url] = entry
            else:
                self._cuts.pop(url, None)
        self._save()
        return self.cuts_list()

    def cuts_delete(self, url):
        with self._cuts_lock:
            self._cuts.pop(url, None)
        self._save()
        return self.cuts_list()

    def cuts_export(self):
        """Tum kayitli kesitleri kullanicinin sectigi JSON dosyasina yazar."""
        if not self._cuts_snapshot():
            return {"ok": False, "error": "Dışa aktarılacak kayıtlı kesit yok."}
        res = self._window.create_file_dialog(webview.FileDialog.SAVE, directory=self._folder,
                                              save_filename="kick-kesitler.json",
                                              file_types=("Kesit dosyası (*.json)",))
        if not res:
            return {"ok": False}
        path = res if isinstance(res, str) else res[0]
        try:
            with open(path, "w", encoding="utf-8") as f:
                json.dump({"kickKesitler": 1, "cuts": self._cuts_snapshot()}, f, ensure_ascii=False, indent=1)
        except OSError as e:
            return {"ok": False, "error": f"Dosya yazılamadı: {e.strerror or e}"}
        return {"ok": True, "count": len(self._cuts_snapshot())}

    def cuts_import(self):
        """Dosyadaki kesitleri mevcutlara ekler: ayni VOD'da ayni aralik ikinci kez eklenmez."""
        res = self._window.create_file_dialog(webview.FileDialog.OPEN, directory=self._folder,
                                              file_types=("Kesit dosyası (*.json)",))
        if not res:
            return {"ok": False}
        path = res if isinstance(res, str) else res[0]
        try:
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
            incoming = data["cuts"]
            if data.get("kickKesitler") != 1 or not isinstance(incoming, dict):
                raise ValueError
        except (OSError, ValueError, KeyError, TypeError, AttributeError):
            return {"ok": False, "error": "Bu dosya bir Kick İndirici kesit dosyası değil."}
        added = 0
        with self._cuts_lock:
            for url, raw in incoming.items():
                entry = clean_cut_set(url, raw)
                if not entry:
                    continue
                have = self._cuts.setdefault(url, {**entry, "clips": []})
                known = {(c["a"], c["b"]) for c in have["clips"]}
                new = [c for c in entry["clips"] if (c["a"], c["b"]) not in known]
                have["clips"] = sorted(have["clips"] + new, key=lambda c: (c["a"], c["b"]))
                have["updated"] = time.time()
                added += len(new)
        self._save()
        return {"ok": True, "added": added, "cuts": self.cuts_list()}
