"""Shared bits for Onyx's Python tool servers: replies, the stop switch, and
a line back to the core."""

from __future__ import annotations

import json
import os
import sys
import threading
import time
import urllib.request

CORE_URL = os.environ.get("ONYX_CORE_URL", "http://127.0.0.1:8765")
TOKEN = os.environ.get("ONYX_TOKEN", "")
ONYX_HOME = os.environ.get("ONYX_HOME") or os.path.join(os.path.expanduser("~"), ".onyx")

# How long after a stop every action keeps refusing. Long enough for the
# agent's current step to notice and wrap up; short enough that the next task
# you give is not affected.
STOP_WINDOW_SEC = 12

_stopped_at = 0.0


def log(*parts) -> None:
    """stdout belongs to the MCP protocol: anything human goes to stderr."""
    print(*parts, file=sys.stderr, flush=True)


def reply(value) -> str:
    return json.dumps(value, ensure_ascii=False, default=str)


def core_post(path: str, body: dict | None = None, timeout: float = 5.0):
    req = urllib.request.Request(
        CORE_URL + path,
        data=json.dumps(body or {}).encode(),
        headers={"content-type": "application/json", "authorization": f"Bearer {TOKEN}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read() or b"{}")
    except Exception as err:  # the core may not be running in a test
        log(f"[onyx] could not reach the core at {path}: {err}")
        return None


def trigger_stop(reason: str) -> None:
    global _stopped_at
    _stopped_at = time.time()
    log(f"[onyx] STOP: {reason}")
    threading.Thread(target=core_post, args=("/stop", {"reason": reason}), daemon=True).start()


class Stopped(Exception):
    pass


def check_stop() -> None:
    if time.time() - _stopped_at < STOP_WINDOW_SEC:
        raise Stopped("The user pressed the Onyx stop key. Stop now: do not take any more actions; report what you got done.")


def install_stop_hotkey(combo: str = "ctrl+alt+esc") -> bool:
    """A global hotkey that freezes every action, from anywhere in Windows."""
    try:
        import keyboard

        keyboard.add_hotkey(combo, lambda: trigger_stop(f"{combo} pressed"), suppress=False)
        log(f"[onyx] stop hotkey ready: {combo}")
        return True
    except Exception as err:
        log(f"[onyx] stop hotkey unavailable ({err}); the stop button in the Onyx window still works")
        return False
