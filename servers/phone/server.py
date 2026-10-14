"""Onyx phone server: control an Android phone over adb.

adb is Google's open-source Android Debug Bridge. Connect the phone once by USB
(USB debugging) or over Wi-Fi (Wireless debugging, Android 11+), and Onyx can
read the screen's UI tree, tap, type, swipe, open apps and read SMS and
notifications, the same see-act-verify loop as on the desktop.

Nothing here sends a message or places a call by itself: dial and send_sms
only open the dialer or the SMS composer, filled in, for the user to confirm.
"""

from __future__ import annotations

import difflib
import io
import os
import re
import shutil
import subprocess
import sys
import time
import uuid
import xml.etree.ElementTree as ET

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from PIL import Image as PILImage  # noqa: E402
from mcp.server.fastmcp import FastMCP, Image  # noqa: E402

from common import check_stop, log, reply  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

mcp = FastMCP(
    "onyx_phone",
    log_level="WARNING",
    instructions=(
        "Control the user's Android phone over adb. Call devices first. Read ui_tree for numbered "
        "elements, tap/type by number, verify after each action."
    ),
)

ELEMENTS: dict[int, dict] = {}
SHOTS: dict[str, dict] = {}
_serial: str | None = None

NO_WINDOW = 0x08000000 if os.name == "nt" else 0


def _adb_path() -> str | None:
    candidates = [
        os.environ.get("ONYX_ADB") or "",
        shutil.which("adb") or "",
        os.path.join(ROOT, "tools", "platform-tools", "adb.exe"),
        os.path.join(ROOT, "tools", "platform-tools", "adb"),
        os.path.join(os.environ.get("LOCALAPPDATA", ""), "Android", "Sdk", "platform-tools", "adb.exe"),
        os.path.join(os.path.expanduser("~"), "AppData", "Local", "Android", "Sdk", "platform-tools", "adb.exe"),
    ]
    return next((c for c in candidates if c and os.path.isfile(c)), None)


NO_ADB = (
    "adb is not installed. Run `npm run setup` in the Onyx folder and choose to install Android platform-tools "
    "(Google's free adb), or install it yourself and put it on PATH."
)


def _run(args: list[str], timeout: float = 30, binary: bool = False, device: bool = True):
    adb = _adb_path()
    if not adb:
        raise RuntimeError(NO_ADB)
    cmd = [adb]
    if device:
        cmd += ["-s", _pick()]
    cmd += args
    p = subprocess.run(cmd, capture_output=True, timeout=timeout, creationflags=NO_WINDOW)
    if binary:
        if p.returncode != 0:
            raise RuntimeError(p.stderr.decode(errors="replace").strip() or "adb failed")
        return p.stdout
    out = (p.stdout.decode("utf-8", errors="replace") + p.stderr.decode("utf-8", errors="replace")).strip()
    if p.returncode != 0 and "error" in out.lower():
        raise RuntimeError(out[:500])
    return out


def _shell(cmd: str, timeout: float = 30) -> str:
    return _run(["shell", cmd], timeout=timeout)


def _list_devices() -> list[dict]:
    out = _run(["devices", "-l"], device=False, timeout=15)
    devs = []
    for line in out.splitlines()[1:]:
        parts = line.split()
        if len(parts) >= 2 and not line.startswith("*"):
            info = {"serial": parts[0], "state": parts[1]}
            m = re.search(r"model:(\S+)", line)
            if m:
                info["model"] = m.group(1).replace("_", " ")
            devs.append(info)
    return devs


def _pick() -> str:
    global _serial
    devs = [d for d in _list_devices() if d["state"] == "device"]
    if _serial and any(d["serial"] == _serial for d in devs):
        return _serial
    if not devs:
        unauth = [d for d in _list_devices() if d["state"] == "unauthorized"]
        if unauth:
            raise RuntimeError("The phone is connected but not authorised: unlock it and tap Allow on the USB debugging prompt.")
        raise RuntimeError(
            "No phone connected. On the phone: Settings > Developer options > Wireless debugging (or USB debugging). "
            "Then plug in USB, or use connect with the IP:port shown on the phone."
        )
    _serial = devs[0]["serial"]
    return _serial


def _screen_size() -> tuple[int, int]:
    out = _shell("wm size")
    m = re.findall(r"(\d+)x(\d+)", out)
    w, h = m[-1] if m else ("1080", "2400")
    return int(w), int(h)


def _focus_app() -> str:
    out = _shell("dumpsys window | grep -E 'mCurrentFocus|mFocusedApp' | head -2")
    m = re.search(r"([a-zA-Z0-9_.]+)/([a-zA-Z0-9_.$]+)", out)
    return m.group(1) if m else ""


# ------------------------------------------------------------------ tools


@mcp.tool()
def devices() -> str:
    """Connected Android devices and their state (device = ready). Call this first."""
    adb = _adb_path()
    if not adb:
        return reply({"devices": [], "adb": None, "help": NO_ADB})
    try:
        return reply({"devices": _list_devices(), "adb": adb})
    except Exception as err:
        return reply({"devices": [], "adb": adb, "error": str(err)})


@mcp.tool()
def connect(address: str, pair_address: str = "", pairing_code: str = "") -> str:
    """Connect over Wi-Fi. On the phone: Developer options > Wireless debugging. `address` is the
    IP:port shown there. The first time, also tap "Pair device with pairing code" and give its
    pair_address (IP:port) and the 6-digit pairing_code."""
    global _serial
    out = []
    if pair_address and pairing_code:
        out.append(_run(["pair", pair_address, pairing_code], device=False, timeout=30))
    res = _run(["connect", address], device=False, timeout=30)
    out.append(res)
    if "connected" in res.lower() and "cannot" not in res.lower():
        _serial = address
    return reply({"result": " | ".join(out), "devices": _list_devices()})


@mcp.tool()
def screenshot(max_width: int = 720):
    """The phone screen as an image. To tap a point you see, use tap(x, y, screenshot_id)."""
    png = _run(["exec-out", "screencap", "-p"], binary=True, timeout=30)
    img = PILImage.open(io.BytesIO(png)).convert("RGB")
    scale = 1.0
    max_width = max(300, min(int(max_width), 1440))
    if img.width > max_width:
        scale = max_width / img.width
        img = img.resize((max_width, int(img.height * scale)), PILImage.LANCZOS)
    sid = uuid.uuid4().hex[:6]
    SHOTS[sid] = {"scale": scale}
    if len(SHOTS) > 30:
        SHOTS.pop(next(iter(SHOTS)))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=70)
    return [f"screenshot_id={sid} size={img.width}x{img.height} scale={scale:.3f}", Image(data=buf.getvalue(), format="jpeg")]


def _bounds(s: str):
    m = re.findall(r"\[(-?\d+),(-?\d+)\]", s or "")
    if len(m) != 2:
        return None
    (x1, y1), (x2, y2) = m
    x1, y1, x2, y2 = int(x1), int(y1), int(x2), int(y2)
    if x2 <= x1 or y2 <= y1:
        return None
    return (x1, y1, x2, y2)


@mcp.tool()
def ui_tree(max_elements: int = 200) -> str:
    """The current phone screen as numbered elements: `[4] Button "Pay" @(540,1820)`. Tap or type by number.
    Numbers stay valid until the next ui_tree."""
    _shell("rm -f /sdcard/onyx_ui.xml")
    dump = _shell("uiautomator dump /sdcard/onyx_ui.xml", timeout=40)
    xml = _shell("cat /sdcard/onyx_ui.xml", timeout=20)
    if "<hierarchy" not in xml:
        raise RuntimeError(f"Could not read the screen ({dump.strip()[:200]}). The screen may be off or showing a secure view: try key('wakeup') or a screenshot.")
    xml = xml[xml.index("<?xml") if "<?xml" in xml else xml.index("<hierarchy"):]
    root = ET.fromstring(xml)
    ELEMENTS.clear()
    lines = []
    n = 0
    for node in root.iter("node"):
        if n >= max_elements:
            break
        a = node.attrib
        b = _bounds(a.get("bounds"))
        if not b:
            continue
        text = (a.get("text") or "").strip()
        desc = (a.get("content-desc") or "").strip()
        clickable = a.get("clickable") == "true" or a.get("long-clickable") == "true"
        editable = a.get("class", "").endswith("EditText")
        scrollable = a.get("scrollable") == "true"
        checkable = a.get("checkable") == "true"
        if not (text or desc or clickable or editable or scrollable):
            continue
        n += 1
        kind = a.get("class", "View").split(".")[-1]
        rid = (a.get("resource-id") or "").split("/")[-1]
        cx, cy = (b[0] + b[2]) // 2, (b[1] + b[3]) // 2
        ELEMENTS[n] = {"center": (cx, cy), "password": a.get("password") == "true", "editable": editable, "kind": kind}
        bits = [f"[{n}] {kind}"]
        label = text or desc
        if label:
            bits.append(repr(label[:90]).replace("'", '"') if '"' not in label[:90] else repr(label[:90]))
        if desc and text and desc != text:
            bits.append(f"desc={desc[:60]!r}")
        if rid:
            bits.append(f"id={rid}")
        if checkable:
            bits.append("checked" if a.get("checked") == "true" else "unchecked")
        if a.get("enabled") == "false":
            bits.append("disabled")
        if scrollable:
            bits.append("scrollable")
        if not clickable and not editable and not scrollable:
            bits.append("(text)")
        if a.get("password") == "true":
            bits.append("PASSWORD-FIELD")
        bits.append(f"@({cx},{cy})")
        lines.append(" ".join(bits))
    head = f"App: {_focus_app() or 'unknown'}"
    if not lines:
        lines.append("(No elements: the screen may be off, locked or a game/video. Use screenshot.)")
    return head + "\n" + "\n".join(lines)


def _point(element, x, y, screenshot_id):
    if element is not None:
        e = ELEMENTS.get(int(element))
        if not e:
            raise ValueError(f"No element [{element}]: read ui_tree again.")
        return e["center"]
    if x is None or y is None:
        raise ValueError("Give an element number, or x and y.")
    if screenshot_id:
        s = SHOTS.get(screenshot_id)
        if not s:
            raise ValueError("Unknown screenshot_id: take a new screenshot.")
        return int(float(x) / s["scale"]), int(float(y) / s["scale"])
    return int(x), int(y)


@mcp.tool()
def tap(element: int | None = None, x: float | None = None, y: float | None = None, screenshot_id: str = "", long_press: bool = False) -> str:
    """Tap an element by number (preferred) or a point (screen pixels, or a screenshot's pixels with screenshot_id)."""
    check_stop()
    px, py = _point(element, x, y, screenshot_id)
    if long_press:
        _shell(f"input swipe {px} {py} {px} {py} 700")
    else:
        _shell(f"input tap {px} {py}")
    time.sleep(0.6)
    return reply({"tapped": [px, py], "app": _focus_app()})


def _focused_is_password() -> bool:
    """Read the focused field's inputType from the input method service."""
    out = _shell("dumpsys input_method | grep -m 3 inputType")
    for hexval in re.findall(r"inputType=0x([0-9a-fA-F]+)", out):
        v = int(hexval, 16)
        cls, var = v & 0xF, v & 0xFF0
        # TEXT + PASSWORD / VISIBLE_PASSWORD / WEB_PASSWORD, or NUMBER + PASSWORD (PINs)
        if (cls == 1 and var in (0x80, 0x90, 0xE0)) or (cls == 2 and var == 0x10):
            return True
    return False


def _shell_quote(s: str) -> str:
    return "'" + s.replace("'", "'\\''") + "'"


@mcp.tool()
def type_text(text: str, element: int | None = None, clear: bool = False, enter: bool = False) -> str:
    """Type text on the phone. With `element`, taps it first. clear=True deletes what is there first.
    Refuses password fields. adb typing supports plain ASCII; for other scripts, use set the text via the app."""
    check_stop()
    if element is not None:
        e = ELEMENTS.get(int(element))
        if not e:
            raise ValueError(f"No element [{element}]: read ui_tree again.")
        if e["password"]:
            raise PermissionError("That is a password field. Onyx never types passwords: ask the user to type it.")
        _shell(f"input tap {e['center'][0]} {e['center'][1]}")
        time.sleep(0.4)
    if _focused_is_password():
        raise PermissionError("The focused field is a password field. Onyx never types passwords: ask the user to type it.")
    if clear:
        _shell("input keyevent KEYCODE_MOVE_END")
        for _ in range(4):
            _shell("input keyevent " + " ".join(["KEYCODE_DEL"] * 40))
    if any(ord(c) > 126 for c in text):
        raise ValueError("adb can only type plain English characters. Remove emoji/other scripts, or paste the text another way.")
    # `input text` takes %s for a space; send in chunks so long text does not time out.
    for i in range(0, len(text), 80):
        check_stop()
        chunk = text[i : i + 80].replace("%", "\\%").replace(" ", "%s")
        _shell(f"input text {_shell_quote(chunk)}")
    if enter:
        _shell("input keyevent KEYCODE_ENTER")
    time.sleep(0.3)
    return reply({"typed": len(text)})


KEYS = {
    "home": "KEYCODE_HOME", "back": "KEYCODE_BACK", "enter": "KEYCODE_ENTER", "delete": "KEYCODE_DEL",
    "backspace": "KEYCODE_DEL", "tab": "KEYCODE_TAB", "recents": "KEYCODE_APP_SWITCH", "app_switch": "KEYCODE_APP_SWITCH",
    "volume_up": "KEYCODE_VOLUME_UP", "volume_down": "KEYCODE_VOLUME_DOWN", "mute": "KEYCODE_VOLUME_MUTE",
    "power": "KEYCODE_POWER", "wakeup": "KEYCODE_WAKEUP", "sleep": "KEYCODE_SLEEP", "play_pause": "KEYCODE_MEDIA_PLAY_PAUSE",
    "next": "KEYCODE_MEDIA_NEXT", "previous": "KEYCODE_MEDIA_PREVIOUS", "search": "KEYCODE_SEARCH", "escape": "KEYCODE_ESCAPE",
    "camera": "KEYCODE_CAMERA", "menu": "KEYCODE_MENU",
}


@mcp.tool()
def key(name: str) -> str:
    """Press a phone key: home, back, enter, delete, tab, recents, volume_up, volume_down, mute, power,
    wakeup, sleep, play_pause, next, previous, search. Also "notifications" and "quick_settings" open those panels."""
    check_stop()
    n = name.lower().strip()
    if n == "notifications":
        _shell("cmd statusbar expand-notifications")
    elif n == "quick_settings":
        _shell("cmd statusbar expand-settings")
    elif n in KEYS:
        _shell(f"input keyevent {KEYS[n]}")
    else:
        raise ValueError(f"Unknown key {name}. Known: {', '.join(KEYS)}, notifications, quick_settings")
    time.sleep(0.5)
    return reply({"pressed": n, "app": _focus_app()})


@mcp.tool()
def swipe(direction: str = "up", x1: int | None = None, y1: int | None = None, x2: int | None = None, y2: int | None = None, duration_ms: int = 350) -> str:
    """Swipe: direction up/down/left/right (up scrolls the content down), or exact x1,y1 -> x2,y2."""
    check_stop()
    if None in (x1, y1, x2, y2):
        w, h = _screen_size()
        cx, cy = w // 2, h // 2
        d = direction.lower()
        dx, dy = int(w * 0.3), int(h * 0.3)
        x1, y1, x2, y2 = {
            "up": (cx, cy + dy, cx, cy - dy), "down": (cx, cy - dy, cx, cy + dy),
            "left": (cx + dx, cy, cx - dx, cy), "right": (cx - dx, cy, cx + dx, cy),
        }.get(d, (cx, cy + dy, cx, cy - dy))
    _shell(f"input swipe {x1} {y1} {x2} {y2} {max(50, min(int(duration_ms), 3000))}")
    time.sleep(0.6)
    return reply({"swiped": [x1, y1, x2, y2]})


APPS = {
    "whatsapp": "com.whatsapp", "phonepe": "com.phonepe.app", "google pay": "com.google.android.apps.nbu.paisa.user",
    "gpay": "com.google.android.apps.nbu.paisa.user", "paytm": "net.one97.paytm", "youtube": "com.google.android.youtube",
    "chrome": "com.android.chrome", "gmail": "com.google.android.gm", "maps": "com.google.android.apps.maps",
    "google maps": "com.google.android.apps.maps", "instagram": "com.instagram.android", "spotify": "com.spotify.music",
    "settings": "com.android.settings", "swiggy": "in.swiggy.android", "zomato": "com.application.zomato",
    "uber": "com.ubercab", "ola": "com.olacabs.customer", "rapido": "com.rapido.passenger", "amazon": "in.amazon.mShop.android.shopping",
    "flipkart": "com.flipkart.android", "telegram": "org.telegram.messenger", "messages": "com.google.android.apps.messaging",
    "phone": "com.google.android.dialer", "dialer": "com.google.android.dialer", "calendar": "com.google.android.calendar",
    "clock": "com.google.android.deskclock", "photos": "com.google.android.apps.photos", "play store": "com.android.vending",
    "netflix": "com.netflix.mediaclient", "camera": "android.media.action.STILL_IMAGE_CAMERA", "contacts": "com.google.android.contacts",
    "drive": "com.google.android.apps.docs", "keep": "com.google.android.keep", "calculator": "com.google.android.calculator",
    "files": "com.google.android.apps.nbu.files", "x": "com.twitter.android", "twitter": "com.twitter.android",
    "linkedin": "com.linkedin.android", "snapchat": "com.snapchat.android", "blinkit": "com.grofers.customerapp",
    "zepto": "com.zeptoconsumerapp", "bigbasket": "com.bigbasket.mobileapp", "myntra": "com.myntra.android",
}


def _packages(third_party: bool = False) -> list[str]:
    out = _shell("pm list packages" + (" -3" if third_party else ""))
    return sorted(l.split(":", 1)[1].strip() for l in out.splitlines() if l.startswith("package:"))


@mcp.tool()
def list_apps(query: str = "") -> str:
    """Installed app packages (third-party), filtered by `query`."""
    pk = _packages(third_party=not query) if not query else [p for p in _packages() if query.lower() in p.lower()]
    return reply(pk[:300])


@mcp.tool()
def open_app(name: str) -> str:
    """Open an app on the phone by name ("WhatsApp", "PhonePe", "Maps") or package name."""
    check_stop()
    n = name.lower().strip()
    target = APPS.get(n) or (name if "." in name else None)
    if target and target.startswith("android.media.action"):
        _shell(f"am start -a {target}")
        time.sleep(1.5)
        return reply({"opened": "camera", "app": _focus_app()})
    pk = _packages()
    if not target or target not in pk:
        squashed = n.replace(" ", "")
        hits = [p for p in pk if squashed in p.lower().replace(".", "").replace("_", "")]
        if not hits:
            close = difflib.get_close_matches(squashed, [p.split(".")[-1] for p in pk], n=1, cutoff=0.6)
            hits = [p for p in pk if close and p.endswith("." + close[0])]
        if not hits:
            raise ValueError(f'No app matching "{name}" is installed. Use list_apps.')
        target = sorted(hits, key=len)[0]
    out = _shell(f"monkey -p {target} -c android.intent.category.LAUNCHER 1")
    if "No activities found" in out:
        raise RuntimeError(f"{target} has no launchable screen.")
    time.sleep(2.0)
    return reply({"opened": target, "app": _focus_app()})


@mcp.tool()
def open_url(url: str) -> str:
    """Open a link on the phone (web page, maps link, upi:// link, etc.) in its app."""
    check_stop()
    if not re.match(r"^[a-z][a-z0-9+.-]*:", url, re.I):
        url = "https://" + url
    _shell(f"am start -a android.intent.action.VIEW -d {_shell_quote(url)}")
    time.sleep(1.5)
    return reply({"opened": url, "app": _focus_app()})


def _parse_content_rows(out: str) -> list[dict]:
    rows = []
    # Each row: "Row: N _id=.., address=.., date=.., body=<may contain anything>"
    parts = re.split(r"(?:^|\n)Row: \d+ ", out)
    for part in parts:
        m = re.match(r"_id=(\d+), address=(.*?), date=(\d+), body=(.*)$", part, re.S)
        if m:
            rows.append({"id": int(m.group(1)), "address": m.group(2), "date_ms": int(m.group(3)), "body": m.group(4).strip()})
    return rows


@mcp.tool()
def read_sms(since_ms: int = 0, limit: int = 50, query: str = "") -> str:
    """Read received SMS (newest last). since_ms: only messages after this epoch-ms time.
    query: only messages containing this text."""
    where = f"date>{int(since_ms)}" if since_ms else "date>0"
    cmd = (
        "content query --uri content://sms/inbox --projection _id:address:date:body "
        f"--where {_shell_quote(where)} --sort {_shell_quote('date DESC')}"
    )
    out = _shell(cmd, timeout=60)
    if "Permission Denial" in out or "SecurityException" in out:
        return reply({
            "error": "This phone does not let adb read SMS.",
            "help": "Use the phone forwarder instead (phone/README.md): it posts new SMS to Onyx over Wi-Fi.",
        })
    rows = _parse_content_rows(out)
    if query:
        rows = [r for r in rows if query.lower() in (r["body"] + r["address"]).lower()]
    rows = sorted(rows[: max(1, min(int(limit), 1000))], key=lambda r: r["date_ms"])
    return reply({"count": len(rows), "messages": rows})


@mcp.tool()
def notifications(limit: int = 30) -> str:
    """Current notifications on the phone: app, title, text."""
    out = _shell("dumpsys notification --noredact", timeout=40)
    items = []
    for block in re.split(r"\n\s*NotificationRecord\(", out)[1:]:
        pkg = re.search(r"pkg=(\S+)", block)
        title = re.search(r"android\.title=\w+ \((.*?)\)\n", block)
        text = re.search(r"android\.text=\w+ \((.*?)\)\n", block)
        big = re.search(r"android\.bigText=\w+ \((.*?)\)\n", block)
        if not (title or text):
            continue
        items.append({
            "app": pkg.group(1) if pkg else "",
            "title": title.group(1) if title else "",
            "text": (big or text).group(1)[:300] if (big or text) else "",
        })
        if len(items) >= limit:
            break
    return reply({"count": len(items), "notifications": items})


@mcp.tool()
def battery() -> str:
    """Phone battery level and charging state."""
    out = _shell("dumpsys battery")
    level = re.search(r"level: (\d+)", out)
    status = re.search(r"status: (\d+)", out)
    return reply({
        "level": int(level.group(1)) if level else None,
        "charging": status.group(1) in ("2", "5") if status else None,
    })


@mcp.tool()
def dial(number: str) -> str:
    """Open the phone's dialer with a number filled in. The user presses call."""
    check_stop()
    clean = re.sub(r"[^\d+*#]", "", number)
    _shell(f"am start -a android.intent.action.DIAL -d tel:{_shell_quote(clean)[1:-1]}")
    return reply({"dialer_opened": clean, "note": "The user must press the call button."})


@mcp.tool()
def send_sms(number: str, message: str) -> str:
    """Open the SMS app with a message to `number` filled in. The user presses send."""
    check_stop()
    clean = re.sub(r"[^\d+]", "", number)
    _shell(
        f"am start -a android.intent.action.SENDTO -d sms:{clean} --es sms_body {_shell_quote(message)} --ez exit_on_sent true"
    )
    return reply({"composer_opened": clean, "note": "The user must press send."})


if __name__ == "__main__":
    log(f"[phone] Onyx phone server ready (adb: {_adb_path() or 'not installed'})")
    mcp.run()
