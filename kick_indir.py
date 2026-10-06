"""Kick Indirici: Kick VOD, klip ve canli yayin indirici (pywebview arayuzu + yt-dlp motoru).

Motor src/kickindir/ paketinde, arayuz web/ klasorunde. Bu dosya yalnizca giris noktasidir.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "src"))

from kickindir.app import main  # noqa: E402

if __name__ == "__main__":
    main()
