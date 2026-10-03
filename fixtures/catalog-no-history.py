"""Qualification-only installed catalog launcher: any transcript/event body read fails."""
from pathlib import Path
original_open = Path.open

def metadata_only(path, *args, **kwargs):
    if path.name in {"transcript.jsonl", "events.jsonl"}:
        raise AssertionError("Catalog attempted native history body I/O")
    return original_open(path, *args, **kwargs)

Path.open = metadata_only
from amplifier_session_catalog.__main__ import main
main()
