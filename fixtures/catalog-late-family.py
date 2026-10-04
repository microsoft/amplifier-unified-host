"""Owned installed catalog with one stalled selected-family writer."""
import os
import time
from pathlib import Path
from amplifier_session_catalog.discovery import Discovery
original = Discovery.reconcile_family

def delayed(self, **kwargs):
    Path(os.environ['HINT_ENTERED']).write_text('entered')
    time.sleep(30)
    Path(os.environ['HINT_LATE']).write_text('late writer')
    return original(self, **kwargs)

Discovery.reconcile_family = delayed
from amplifier_session_catalog.__main__ import main
main()
