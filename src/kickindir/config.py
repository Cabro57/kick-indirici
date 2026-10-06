"""Sabitler, dosya yollari ve uygulama klasorleri."""

import logging
import os
import shutil
import sys


VERSION = "1.0.5"


UPDATE_REPO = "Cabro57/kick-indirici"         # surumler bu GitHub deposunun release'lerinden okunur


QUALITIES = ["En iyi", "1080p60", "720p60", "480p", "360p", "160p"]


# Dosya adi sablonu: kullanici {kanal} {baslik} {tarih} {id} yazar, yt-dlp sablonuna cevrilir.
NAME_DEFAULT = "{kanal} - {baslik} [{id}]"


NAME_TOKENS = {"kanal": "%(channel,uploader|kick)s", "baslik": "%(title).90B",
               "tarih": "%(upload_date>%Y-%m-%d|)s", "id": "%(id).12s"}


CPU = os.cpu_count() or 4


FRAG_THREADS = max(8, min(32, CPU * 2))      # her video icin parca thread sayisi


MAX_PARALLEL = max(2, min(6, CPU // 2))      # otomatik ayarin cikabilecegi ust sinir


ACTIVE_NET = ("preparing", "downloading")


ACTIVE_ALL = ACTIVE_NET + ("merging", "recording")


FRAG_THREADS_MAX = 64


DATA_DIR = os.path.join(os.environ.get("APPDATA", os.path.expanduser("~")), "KickIndirici")


SETTINGS_PATH = os.path.join(DATA_DIR, "settings.json")


LOG_PATH = os.path.join(DATA_DIR, "log.txt")


HISTORY_PATH = os.path.join(DATA_DIR, "history.json")


HISTORY_MAX = 1000


QUEUE_PATH = os.path.join(DATA_DIR, "queue.json")   # bitmemis indirmeler: sonraki acilista geri gelir


DISK_RESERVE = 512 * 1024 * 1024             # indirme sonrasi diskte kalmasi gereken en az bos alan


CHAT_WINDOW = 5                              # sohbet API'si her istekte bu kadar saniyelik mesaj verir


WEBVIEW2_URL = "https://go.microsoft.com/fwlink/p/?LinkId=2124703"


# bozuk kurulumda bootstrapper "zaten kurulu" sanabiliyor; bagimsiz kurucunun oldugu sayfa
WEBVIEW2_PAGE = "https://developer.microsoft.com/microsoft-edge/webview2/#download"


log = logging.getLogger("kick")

PROJECT_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))   # kaynaktan calisirken web/ ve assets/ burada


def app_dir():
    return os.path.dirname(sys.executable) if getattr(sys, "frozen", False) else PROJECT_DIR


def resource_dir():
    return getattr(sys, "_MEIPASS", PROJECT_DIR)


def find_ffmpeg():
    local = os.path.join(app_dir(), "ffmpeg.exe")
    if os.path.exists(local):
        return local
    return shutil.which("ffmpeg")


AFTER_DONE = ("none", "sleep", "shutdown")   # kuyruk bitince: hicbir sey / uyku / bilgisayari kapat


LIVE_POLL = 120                              # favorilerin canli durumunu kontrol araligi (sn)


TOAST_APP_ID = "Cabro57.KickIndirici"


INSTANCE_PID = os.path.join(DATA_DIR, "instance.pid")
