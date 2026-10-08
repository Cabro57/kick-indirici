"""Anonim kullanim verisi (kullanici izin verdiyse): kac kisi hangi surumu kullaniyor, indirmeler ne hizda,
hangi hatalar oluyor, hangi ozellikler kullaniliyor, hangi donanimda. Olaylar sirada biriktirilir ve
arka planda toplu gonderilir (PostHog, AB sunuculari). IP saklanmaz; adres, baslik, dosya yolu gonderilmez.
Gonderilemeyenler kapanista diske yazilir, sonraki acilista yeniden denenir."""

import ctypes
import json
import os
import platform
import re
import subprocess
import sys
import threading
import traceback
import uuid
import winreg
from datetime import datetime, timezone

from curl_cffi import requests as cffi_requests

from kickindir.config import DATA_DIR, POSTHOG_HOST, POSTHOG_KEY, VERSION, log

ID_PATH = os.path.join(DATA_DIR, "install-id")
PENDING_PATH = os.path.join(DATA_DIR, "telemetry-pending.json")
CONSENT_PATH = os.path.join(DATA_DIR, "telemetry-consent")   # kurulum sihirbazinin yazdigi secim: "1" / "0"
FLUSH_EVERY = 30          # sn
MAX_QUEUE = 500


def install_id():
    """Bu kurulumun rastgele kimligi (kisiyle iliskisi yok); ilk cagrida uretilir."""
    try:
        with open(ID_PATH, encoding="utf-8") as fh:
            value = fh.read().strip()
            if re.fullmatch(r"[0-9a-f-]{36}", value):
                return value
    except OSError:
        pass
    value = str(uuid.uuid4())
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        with open(ID_PATH, "w", encoding="utf-8") as fh:
            fh.write(value)
    except OSError:
        pass
    return value


def installer_consent():
    """Kurulum sihirbazinda verilen cevap: True / False, sorulmadiysa None."""
    try:
        with open(CONSENT_PATH, encoding="utf-8") as fh:
            return fh.read().strip() == "1"
    except OSError:
        return None


def scrub(text):
    """Hata metninden kisisel olabilecekleri temizler: kullanici klasoru, dosya yollari, adresler."""
    text = str(text or "")
    text = re.sub(r"[A-Za-z]:\\[^\s'\"<>|]*\\([^\\\s'\"<>|]+)", r"<path>\\\1", text)   # yalnizca dosya adi kalir
    text = re.sub(r"https?://\S+", "<url>", text)
    user = os.environ.get("USERNAME")
    if user and len(user) > 2:
        text = text.replace(user, "<user>")
    return text[:1000]


class Telemetry:
    def __init__(self, enabled):
        self.enabled = enabled            # None: henuz sorulmadi (olaylar bekler), True / False
        self.id = install_id()
        self.queue = []
        self.lock = threading.Lock()
        self.wake = threading.Event()
        self.session = str(uuid.uuid4())
        self.base = {"app_version": VERSION, "frozen": bool(getattr(sys, "frozen", False)),
                     "$session_id": self.session, "$process_person_profile": False}
        try:
            with open(PENDING_PATH, encoding="utf-8") as fh:
                self.queue = [e for e in json.load(fh) if isinstance(e, dict)][-MAX_QUEUE:]
            os.remove(PENDING_PATH)
        except (OSError, ValueError):
            pass
        threading.Thread(target=self._loop, daemon=True).start()

    def set_enabled(self, on):
        self.enabled = on
        if not on:
            with self.lock:
                self.queue.clear()
        self.wake.set()

    def track(self, event, props=None):
        if self.enabled is False or not POSTHOG_KEY:
            return
        e = {"event": event, "distinct_id": self.id, "timestamp": datetime.now(timezone.utc).isoformat(),
             "properties": {**self.base, **(props or {})}}
        with self.lock:
            self.queue.append(e)
            del self.queue[:-MAX_QUEUE]

    def exception(self, exc_type, exc, tb, where="python", handled=True):
        """PostHog hata takibi bicimi ($exception_list); yollar ve kullanici adi temizlenir."""
        frames = []
        for f in traceback.extract_tb(tb) if tb else []:
            name = os.path.basename(f.filename)
            frames.append({"filename": name, "function": f.name, "lineno": f.lineno, "platform": "python",
                           "in_app": "kickindir" in f.filename.replace("\\", "/"), "context_line": scrub(f.line or "")})
        self.track("$exception", {"$exception_list": [{
            "type": exc_type.__name__ if exc_type else "Error", "value": scrub(exc),
            "mechanism": {"handled": handled, "synthetic": False},
            "stacktrace": {"type": "raw", "frames": frames}}], "where": where})

    def js_error(self, message, source="", line=0, stack=""):
        frames = [{"filename": os.path.basename(source or "app.js"), "function": "?", "lineno": line or 0,
                   "platform": "web:javascript", "in_app": True}]
        self.track("$exception", {"$exception_list": [{
            "type": "JSError", "value": scrub(message), "mechanism": {"handled": False, "synthetic": False},
            "stacktrace": {"type": "raw", "frames": frames}}], "where": "ui", "stack": scrub(stack)})

    def _loop(self):
        while True:
            self.wake.wait(FLUSH_EVERY)
            self.wake.clear()
            self.flush()

    def flush(self, timeout=10):
        if not self.enabled or not POSTHOG_KEY:
            return
        with self.lock:
            batch, self.queue = self.queue[:100], self.queue[100:]
        if not batch:
            return
        try:
            r = cffi_requests.post(f"{POSTHOG_HOST}/batch/", json={"api_key": POSTHOG_KEY, "batch": batch}, timeout=timeout)
            r.raise_for_status()
        except Exception as e:  # noqa: BLE001 - ag yoksa sonra yeniden
            log.info("kullanim verisi gonderilemedi: %s", e)
            with self.lock:
                self.queue[:0] = batch
                del self.queue[:-MAX_QUEUE]

    def close(self):
        """Kapanis: kalanlari kisa sureyle gondermeyi dener, olmazsa diske yazar."""
        if self.enabled:
            self.flush(timeout=3)
        with self.lock:
            left = self.queue if self.enabled is not False else []
        if left:
            try:
                with open(PENDING_PATH, "w", encoding="utf-8") as fh:
                    json.dump(left, fh)
            except OSError:
                pass


# ---------- donanim (yalnizca Windows'un kendi bilgileri; ek program yok) ----------

def hardware(folder):
    """Islemci, cekirdek, bellek, ekran karti, ekran, indirme klasorunun diski."""
    out = {"os": platform.platform(terse=True), "os_build": sys.getwindowsversion().build,
           "cpu_cores": os.cpu_count() or 0, "arch": platform.machine()}
    try:
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"HARDWARE\DESCRIPTION\System\CentralProcessor\0") as k:
            out["cpu"] = winreg.QueryValueEx(k, "ProcessorNameString")[0].strip()
    except OSError:
        pass

    class MEM(ctypes.Structure):
        _fields_ = [("len", ctypes.c_ulong), ("load", ctypes.c_ulong), ("total", ctypes.c_ulonglong),
                    ("avail", ctypes.c_ulonglong), ("tp", ctypes.c_ulonglong), ("ap", ctypes.c_ulonglong),
                    ("tv", ctypes.c_ulonglong), ("av", ctypes.c_ulonglong), ("ave", ctypes.c_ulonglong)]
    m = MEM()
    m.len = ctypes.sizeof(MEM)
    if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m)):
        out["ram_gb"] = round(m.total / 1024 ** 3)
    gpus = []
    cls = r"SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}"
    try:
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, cls) as k:
            for i in range(32):
                try:
                    sub = winreg.EnumKey(k, i)
                except OSError:
                    break
                try:
                    with winreg.OpenKey(k, sub) as s:
                        name = winreg.QueryValueEx(s, "DriverDesc")[0]
                        if name and name not in gpus and "Basic Display" not in name and "Remote" not in name:
                            gpus.append(name)
                except OSError:
                    continue
    except OSError:
        pass
    out["gpu"] = ", ".join(gpus[:3])
    u = ctypes.windll.user32
    out["screen"] = f"{u.GetSystemMetrics(0)}x{u.GetSystemMetrics(1)}"
    out["monitors"] = u.GetSystemMetrics(80)
    out.update(disk_kind(folder))
    return out


def disk_kind(folder):
    """Indirme klasorunun bulundugu disk: SSD / HDD ve baglanti (NVMe, SATA, USB). PowerShell ~1 sn."""
    drive = os.path.splitdrive(os.path.abspath(folder))[0].rstrip(":")
    if not re.fullmatch(r"[A-Za-z]", drive):
        return {"disk": "network"}
    script = (f"$n=(Get-Partition -DriveLetter {drive} -ErrorAction Stop | Get-Disk).Number;"
              "$d=Get-PhysicalDisk | Where-Object DeviceId -eq $n; \"$($d.MediaType)|$($d.BusType)\"")
    try:
        r = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", script], capture_output=True,
                           text=True, timeout=15, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        media, _, bus = r.stdout.strip().partition("|")
        return {"disk": media or "unknown", "disk_bus": bus or "unknown"}
    except Exception:  # noqa: BLE001
        return {"disk": "unknown"}
