"""Actual installed catalog with one deliberately stalled discovery RPC."""
import os
import time
from pathlib import Path
from amplifier_session_catalog.discovery import Discovery

original = Discovery.hint

def delayed(self, sessionDirectory, **kwargs):
    Path(os.environ['HINT_ENTERED']).write_text('entered')
    time.sleep(30)
    Path(os.environ['HINT_LATE']).write_text('late writer')
    return original(self, sessionDirectory, **kwargs)

Discovery.hint = delayed
from amplifier_session_catalog.__main__ import main
main()
