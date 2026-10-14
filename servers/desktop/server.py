"""Onyx desktop server: see and control Windows.

The approach, in order of reliability:
  1. UI Automation, the accessibility layer every Windows app exposes. It gives
     real controls with names ("Button Save") and exact positions, so Onyx
     clicks the thing, not a guess at pixels.
  2. Screenshots for whatever the tree cannot describe (games, canvases, some
     web content), with clicks mapped back from image coordinates.
  3. Real mouse and keyboard input (SendInput), so it works in every app.

Safety: ctrl+alt+esc, or slamming the mouse into a screen corner, stops every
action at once. Typing into password fields is refused.
"""

from __future__ import annotations

import ctypes
import ctypes.wintypes as wt
import difflib
import functools
import io
import json
import os
import subprocess
import sys
import threading
import time
import uuid

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

# Physical pixels everywhere. Without this, at 125%/150% display scaling the
# accessibility tree, the screenshots and the mouse each disagree about where
# things are. It must happen before anything else touches the screen.
try:
    ctypes.windll.shcore.SetProcessDpiAwareness(2)
except Exception:
    try:
        ctypes.windll.user32.SetProcessDPIAware()
    except Exception:
        pass

import mss  # noqa: E402
import pyautogui  # noqa: E402
import pyperclip  # noqa: E402

# On first use comtypes generates COM wrappers and announces it on stdout,
# which here is the MCP protocol channel. Keep that chatter on stderr.
_stdout, sys.stdout = sys.stdout, sys.stderr
try:
    import uiautomation as auto  # noqa: E402
finally:
    sys.stdout = _stdout
from PIL import Image as PILImage, ImageDraw  # noqa: E402
from mcp.server.fastmcp import FastMCP, Image  # noqa: E402

from common import Stopped, check_stop, install_stop_hotkey, log, reply, trigger_stop  # noqa: E402

pyautogui.FAILSAFE = True  # mouse into a corner = stop
pyautogui.PAUSE = 0.05
auto.SetGlobalSearchTimeout(2)

mcp = FastMCP(
    "onyx_desktop",
    log_level="WARNING",
    instructions=(
        "Control the Windows desktop. Read get_ui_tree to see numbered elements, act on them by "
        "number with click/type_text, and verify after every action. Use screenshot when the tree "
        "is not enough."
    ),
)

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32

# The numbered elements from the most recent tree, and the screenshots taken,
# so the model can refer to "element 12" or "this point in screenshot ab12".
ELEMENTS: dict[int, dict] = {}
SHOTS: dict[str, dict] = {}
_lock = threading.RLock()

INTERACTIVE = {
    "ButtonControl", "EditControl", "CheckBoxControl", "RadioButtonControl", "ComboBoxControl",
    "ListItemControl", "MenuItemControl", "TabItemControl", "HyperlinkControl", "TreeItemControl",
    "SliderControl", "SplitButtonControl", "DataItemControl", "SpinnerControl", "DocumentControl",
    "MenuBarControl", "ScrollBarControl", "HeaderItemControl", "ListControl", "TableControl",
    "TreeControl",
}
LABELS = {"TextControl", "ImageControl", "HeaderControl", "TitleBarControl", "StatusBarControl", "ToolBarControl", "GroupControl"}


# ---------------------------------------------------------------- helpers


def _guard(fn):
    """Run a tool with COM initialised on this thread, the stop switch
    honoured, and pyautogui's corner failsafe turned into a real stop."""

    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        with _lock:
            with auto.UIAutomationInitializerInThread(debug=False):
                try:
                    return fn(*args, **kwargs)
                except pyautogui.FailSafeException:
                    trigger_stop("mouse moved to a screen corner")
                    raise Stopped("The user moved the mouse to a corner to stop Onyx. Stop now and report.")

    return wrapper


def _process_name(pid: int) -> str:
    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    h = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not h:
        return ""
    try:
        buf = ctypes.create_unicode_buffer(1024)
        size = wt.DWORD(1024)
        if kernel32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
            return os.path.basename(buf.value)
        return ""
    finally:
        kernel32.CloseHandle(h)


def _rect(ctrl) -> tuple[int, int, int, int] | None:
    try:
        r = ctrl.BoundingRectangle
        if r.width() <= 0 or r.height() <= 0:
            return None
        return (r.left, r.top, r.right, r.bottom)
    except Exception:
        return None


def _windows(include_untitled: bool = False) -> list[dict]:
    out = []
    fg = user32.GetForegroundWindow()
    for w in auto.GetRootControl().GetChildren():
        try:
            handle = w.NativeWindowHandle
            title = w.Name or ""
            if not handle or not user32.IsWindowVisible(handle):
                continue
            if not title and not include_untitled:
                continue
            if w.ClassName in ("Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd"):
                continue
            r = _rect(w)
            out.append(
                {
                    "handle": handle,
                    "title": title,
                    "app": _process_name(w.ProcessId),
                    "minimized": bool(user32.IsIconic(handle)),
                    "active": handle == fg,
                    "rect": r,
                }
            )
        except Exception:
            continue
    return out


def _find_window(window: str | int | None):
    """A window by handle, by title or app name (fuzzy), or the active one."""
    if window in (None, "", "active", "foreground"):
        h = user32.GetForegroundWindow()
        return auto.ControlFromHandle(h) if h else None
    if isinstance(window, int) or (isinstance(window, str) and window.strip().lstrip("-").isdigit()):
        ctrl = auto.ControlFromHandle(int(window))
        if ctrl:
            return ctrl
    q = str(window).lower().strip()
    wins = _windows()
    for pick in (
        lambda w: w["title"].lower() == q,
        lambda w: q in w["title"].lower(),
        lambda w: q in w["app"].lower().replace(".exe", ""),
    ):
        hit = next((w for w in wins if pick(w)), None)
        if hit:
            return auto.ControlFromHandle(hit["handle"])
    names = [w["title"] for w in wins]
    close = difflib.get_close_matches(str(window), names, n=1, cutoff=0.5)
    if close:
        hit = next(w for w in wins if w["title"] == close[0])
        return auto.ControlFromHandle(hit["handle"])
    return None


def _activate(win) -> bool:
    if win is None:
        return False
    handle = win.NativeWindowHandle
    if user32.GetForegroundWindow() == handle:
        return True
    if user32.IsIconic(handle):
        user32.ShowWindow(handle, 9)  # SW_RESTORE
    # Windows refuses SetForegroundWindow to background processes unless a key
    # event just happened; a lone Alt press is the well-known way through.
    user32.keybd_event(0x12, 0, 0, 0)
    user32.keybd_event(0x12, 0, 2, 0)
    user32.SetForegroundWindow(handle)
    for _ in range(10):
        if user32.GetForegroundWindow() == handle:
            return True
        time.sleep(0.05)
    try:
        win.SetActive()
        win.SetFocus()
    except Exception:
        pass
    return user32.GetForegroundWindow() == handle


def _top_window(ctrl):
    try:
        return auto.ControlFromHandle(ctrl.GetTopLevelControl().NativeWindowHandle)
    except Exception:
        return None


def _value(ctrl) -> str | None:
    try:
        if ctrl.ControlTypeName in ("EditControl", "ComboBoxControl", "DocumentControl"):
            p = ctrl.GetPattern(auto.PatternId.ValuePattern)
            if p:
                v = p.Value
                if v and len(v) > 120:
                    v = v[:120] + "…"
                return v
    except Exception:
        pass
    return None


def _toggle(ctrl) -> str | None:
    try:
        if ctrl.ControlTypeName in ("CheckBoxControl", "RadioButtonControl"):
            p = ctrl.GetPattern(auto.PatternId.TogglePattern)
            if p:
                return {0: "off", 1: "on", 2: "mixed"}.get(p.ToggleState)
            p = ctrl.GetPattern(auto.PatternId.SelectionItemPattern)
            if p:
                return "selected" if p.IsSelected else None
    except Exception:
        pass
    return None


def _walk(root, *, max_elements: int, max_depth: int, predicate=None, deadline: float):
    """Depth-first over the UI tree, keeping the elements worth showing."""
    found = []

    def visit(ctrl, depth, shown_depth):
        if len(found) >= max_elements or time.time() > deadline or depth > max_depth:
            return
        try:
            children = ctrl.GetChildren()
        except Exception:
            return
        for child in children:
            if len(found) >= max_elements or time.time() > deadline:
                return
            try:
                if child.IsOffscreen and child.ControlTypeName not in ("WindowControl", "PaneControl"):
                    continue
                kind = child.ControlTypeName
                name = (child.Name or "").strip()
                rect = _rect(child)
                keep = False
                if rect:
                    if predicate is not None:
                        keep = predicate(child, name)
                    else:
                        keep = kind in INTERACTIVE or (kind in LABELS and name)
                next_shown = shown_depth
                if keep:
                    info = {
                        "ctrl": child,
                        "kind": kind.replace("Control", ""),
                        "name": name[:100],
                        "rect": rect,
                        "depth": shown_depth,
                    }
                    aid = child.AutomationId
                    if aid and not aid.isdigit() and len(aid) < 60:
                        info["aid"] = aid
                    v = _value(child)
                    if v:
                        info["value"] = v
                    t = _toggle(child)
                    if t:
                        info["state"] = t
                    if not child.IsEnabled:
                        info["disabled"] = True
                    if kind == "EditControl" and child.IsPassword:
                        info["password"] = True
                    found.append(info)
                    next_shown = shown_depth + 1
                visit(child, depth + 1, next_shown)
            except Exception:
                continue

    visit(root, 0, 0)
    return found


def _render(elements: list[dict], start_id: int) -> list[str]:
    lines = []
    with _lock:
        for i, e in enumerate(elements):
            eid = start_id + i
            ELEMENTS[eid] = e
            l, t, r, b = e["rect"]
            bits = [f"{'  ' * min(e['depth'], 8)}[{eid}] {e['kind']}"]
            if e["name"]:
                bits.append(json.dumps(e["name"], ensure_ascii=False))
            if e.get("value") is not None:
                bits.append(f"value={json.dumps(e['value'], ensure_ascii=False)}")
            if e.get("state"):
                bits.append(e["state"])
            if e.get("aid") and e["aid"] != e["name"]:
                bits.append(f"id={e['aid']}")
            if e.get("disabled"):
                bits.append("disabled")
            if e.get("password"):
                bits.append("PASSWORD-FIELD")
            bits.append(f"@({(l + r) // 2},{(t + b) // 2})")
            lines.append(" ".join(bits))
    return lines


def _center(eid: int) -> tuple[int, int, dict]:
    e = ELEMENTS.get(int(eid))
    if not e:
        raise ValueError(f"No element [{eid}]. Element numbers come from the latest get_ui_tree or find_elements; read the tree again.")
    rect = _rect(e["ctrl"]) or e["rect"]
    if not rect:
        raise ValueError(f"Element [{eid}] is no longer on screen. Read the tree again.")
    l, t, r, b = rect
    return (l + r) // 2, (t + b) // 2, e


# Unicode typing through SendInput: works in every app and every language,
# unlike keyboard layouts or the clipboard.
INPUT_KEYBOARD = 1
KEYEVENTF_KEYUP = 0x2
KEYEVENTF_UNICODE = 0x4


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [("wVk", wt.WORD), ("wScan", wt.WORD), ("dwFlags", wt.DWORD), ("time", wt.DWORD), ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong))]


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [("dx", wt.LONG), ("dy", wt.LONG), ("mouseData", wt.DWORD), ("dwFlags", wt.DWORD), ("time", wt.DWORD), ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong))]


class _INPUTunion(ctypes.Union):
    _fields_ = [("ki", KEYBDINPUT), ("mi", MOUSEINPUT)]


class INPUT(ctypes.Structure):
    _fields_ = [("type", wt.DWORD), ("u", _INPUTunion)]


def _send_unicode(text: str, delay: float = 0.004) -> None:
    for ch in text:
        check_stop()
        if ch == "\n":
            pyautogui.press("enter")
            continue
        if ch == "\t":
            pyautogui.press("tab")
            continue
        units = ch.encode("utf-16-le")
        for k in range(0, len(units), 2):
            code = int.from_bytes(units[k : k + 2], "little")
            down = INPUT(type=INPUT_KEYBOARD, u=_INPUTunion(ki=KEYBDINPUT(0, code, KEYEVENTF_UNICODE, 0, None)))
            up = INPUT(type=INPUT_KEYBOARD, u=_INPUTunion(ki=KEYBDINPUT(0, code, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP, 0, None)))
            arr = (INPUT * 2)(down, up)
            user32.SendInput(2, arr, ctypes.sizeof(INPUT))
        time.sleep(delay)


def _focused_is_password() -> bool:
    try:
        f = auto.GetFocusedControl()
        return bool(f and f.ControlTypeName == "EditControl" and f.IsPassword)
    except Exception:
        return False


def _fg_title() -> str:
    h = user32.GetForegroundWindow()
    n = user32.GetWindowTextLengthW(h)
    buf = ctypes.create_unicode_buffer(n + 1)
    user32.GetWindowTextW(h, buf, n + 1)
    return buf.value


_START_APPS: list[dict] | None = None
_START_APPS_AT = 0.0


def _start_apps() -> list[dict]:
    global _START_APPS, _START_APPS_AT
    if _START_APPS is None or time.time() - _START_APPS_AT > 600:
        try:
            out = subprocess.run(
                ["powershell", "-NoProfile", "-Command", "Get-StartApps | ConvertTo-Json -Compress"],
                capture_output=True, text=True, timeout=30, creationflags=0x08000000,
            ).stdout
            data = json.loads(out or "[]")
            _START_APPS = [data] if isinstance(data, dict) else data
        except Exception as err:
            log(f"[desktop] Get-StartApps failed: {err}")
            _START_APPS = []
        _START_APPS_AT = time.time()
    return _START_APPS


def _match_apps(name: str, n: int = 8) -> list[dict]:
    q = name.lower().strip()
    apps = _start_apps()
    exact = [a for a in apps if a["Name"].lower() == q]
    starts = [a for a in apps if a["Name"].lower().startswith(q) and a not in exact]
    contains = [a for a in apps if q in a["Name"].lower() and a not in exact and a not in starts]
    fuzzy_names = difflib.get_close_matches(name, [a["Name"] for a in apps], n=n, cutoff=0.6)
    fuzzy = [a for a in apps if a["Name"] in fuzzy_names and a not in exact + starts + contains]
    return (exact + starts + contains + fuzzy)[:n]


# ---------------------------------------------------------------- tools


@mcp.tool()
@_guard
def list_windows() -> str:
    """List open windows: handle, title, app, whether it is active or minimized."""
    return reply(_windows())


@mcp.tool()
@_guard
def screen_info() -> str:
    """Screen size(s), the active window, and the mouse position."""
    with mss.mss() as s:
        monitors = [{"index": i, "left": m["left"], "top": m["top"], "width": m["width"], "height": m["height"]} for i, m in enumerate(s.monitors) if i > 0]
    x, y = pyautogui.position()
    return reply({"monitors": monitors, "active_window": _fg_title(), "mouse": [x, y]})


@mcp.tool()
@_guard
def focus_window(window: str) -> str:
    """Bring a window to the front. `window` is a handle, a title or part of one, or an app name like "excel"."""
    win = _find_window(window)
    if not win:
        raise ValueError(f'No window matches "{window}". Use list_windows to see what is open.')
    ok = _activate(win)
    return reply({"focused": ok, "title": win.Name, "handle": win.NativeWindowHandle})


@mcp.tool()
@_guard
def window_action(window: str, action: str) -> str:
    """minimize, maximize, restore or close a window (by handle, title or app name)."""
    win = _find_window(window)
    if not win:
        raise ValueError(f'No window matches "{window}".')
    h = win.NativeWindowHandle
    action = action.lower()
    if action == "minimize":
        user32.ShowWindow(h, 6)
    elif action == "maximize":
        user32.ShowWindow(h, 3)
    elif action == "restore":
        user32.ShowWindow(h, 9)
    elif action == "close":
        user32.PostMessageW(h, 0x0010, 0, 0)  # WM_CLOSE: the app can still ask to save
    else:
        raise ValueError("action must be minimize, maximize, restore or close")
    time.sleep(0.4)
    return reply({"done": action, "title": win.Name, "now_active": _fg_title()})


@mcp.tool()
@_guard
def list_apps(query: str = "") -> str:
    """Installed apps from the Start menu. Filter with `query`."""
    apps = _match_apps(query, 25) if query else _start_apps()[:200]
    return reply([a["Name"] for a in apps])


@mcp.tool()
@_guard
def open_app(name: str) -> str:
    """Open an app by name ("Excel", "Calculator", "Spotify", "Settings"), a file path, or a URL.
    Waits for its window and returns it."""
    check_stop()
    before = {w["handle"] for w in _windows()}
    target = name.strip().strip('"')
    launched = None
    if os.path.exists(target) or "://" in target or target.startswith("ms-settings:"):
        os.startfile(target)
        launched = target
    else:
        matches = _match_apps(target, 3)
        if matches:
            app = matches[0]
            subprocess.Popen(["explorer.exe", f"shell:AppsFolder\\{app['AppID']}"], creationflags=0x08000000)
            launched = app["Name"]
        else:
            try:
                os.startfile(target)  # App Paths: "excel", "winword", "notepad"
                launched = target
            except OSError:
                raise ValueError(f'No app called "{name}". Try list_apps to see what is installed.')
    deadline = time.time() + 12
    new = []
    while time.time() < deadline:
        time.sleep(0.5)
        new = [w for w in _windows() if w["handle"] not in before]
        if new:
            break
    if new:
        win = auto.ControlFromHandle(new[0]["handle"])
        _activate(win)
        time.sleep(0.4)
        return reply({"opened": launched, "window": new[0]})
    # Already-running apps often just come to the front instead of opening a window.
    return reply({"opened": launched, "window": None, "active_window": _fg_title(), "note": "No new window appeared; the app may already be open (check list_windows)."})


@mcp.tool()
@_guard
def get_ui_tree(window: str = "", max_elements: int = 250) -> str:
    """The controls in a window as numbered elements, with positions: e.g.
    `[12] Button "Save" @(830,412)`. Defaults to the active window. Act on them with
    click(element=12) or type_text(element=…). Numbers stay valid until the next tree."""
    win = _find_window(window or None)
    if not win:
        raise ValueError(f'No window matches "{window}".')
    max_elements = max(20, min(int(max_elements), 600))
    elements = _walk(win, max_elements=max_elements, max_depth=40, deadline=time.time() + 10)
    with _lock:
        ELEMENTS.clear()
    lines = _render(elements, 1)
    r = _rect(win)
    head = f'Window "{win.Name}" (handle {win.NativeWindowHandle}, {_process_name(win.ProcessId)}) rect={r}'
    tail = ""
    if len(elements) >= max_elements:
        tail = f"\n(Showing the first {max_elements} elements. Use find_elements to search for a specific one.)"
    if not elements:
        tail = "\n(No accessible elements: use screenshot and click by screenshot coordinates.)"
    return head + "\n" + "\n".join(lines) + tail


@mcp.tool()
@_guard
def find_elements(text: str, window: str = "", kind: str = "") -> str:
    """Search the window (default: active) for elements whose name, value or id contains `text`.
    Optional `kind` like Button, Edit, ListItem. Returns numbered elements usable with click/type_text."""
    win = _find_window(window or None)
    if not win:
        raise ValueError(f'No window matches "{window}".')
    q = text.lower()
    k = kind.lower().replace("control", "")

    def pred(ctrl, name):
        if k and ctrl.ControlTypeName.lower().replace("control", "") != k:
            return False
        hay = f"{name} {ctrl.AutomationId or ''} {_value(ctrl) or ''}".lower()
        return q in hay

    found = _walk(win, max_elements=40, max_depth=60, predicate=pred, deadline=time.time() + 10)
    start = (max(ELEMENTS) + 1) if ELEMENTS else 1
    for e in found:
        e["depth"] = 0
    lines = _render(found, start)
    return "\n".join(lines) if lines else f'Nothing matching "{text}" in "{win.Name}".'


@mcp.tool()
@_guard
def screenshot(window: str = "", monitor: int = 1, marks: bool = False, max_width: int = 1366):
    """A screenshot of the active window (or `window`, or a whole monitor when window="screen").
    marks=True draws the numbers from the latest get_ui_tree on it. To click a point you see,
    call click(x, y, screenshot_id) with coordinates in this image."""
    with mss.mss() as s:
        if window == "screen":
            mon = s.monitors[max(1, min(int(monitor), len(s.monitors) - 1))]
            box = (mon["left"], mon["top"], mon["left"] + mon["width"], mon["top"] + mon["height"])
        else:
            win = _find_window(window or None)
            r = _rect(win) if win else None
            if not r:
                mon = s.monitors[1]
                box = (mon["left"], mon["top"], mon["left"] + mon["width"], mon["top"] + mon["height"])
            else:
                # Clamp to the virtual screen: maximized windows hang a few pixels off it.
                v = s.monitors[0]
                box = (max(r[0], v["left"]), max(r[1], v["top"]), min(r[2], v["left"] + v["width"]), min(r[3], v["top"] + v["height"]))
        shot = s.grab({"left": box[0], "top": box[1], "width": box[2] - box[0], "height": box[3] - box[1]})
    img = PILImage.frombytes("RGB", shot.size, shot.rgb)
    if marks and ELEMENTS:
        draw = ImageDraw.Draw(img)
        for eid, e in list(ELEMENTS.items()):
            l, t, r_, b = e["rect"]
            if r_ < box[0] or l > box[2] or b < box[1] or t > box[3]:
                continue
            rect = (l - box[0], t - box[1], r_ - box[0], b - box[1])
            draw.rectangle(rect, outline=(255, 0, 80), width=2)
            draw.rectangle((rect[0], rect[1], rect[0] + 8 + 7 * len(str(eid)), rect[1] + 14), fill=(255, 0, 80))
            draw.text((rect[0] + 3, rect[1]), str(eid), fill=(255, 255, 255))
    scale = 1.0
    max_width = max(400, min(int(max_width), 2560))
    if img.width > max_width:
        scale = max_width / img.width
        img = img.resize((max_width, int(img.height * scale)), PILImage.LANCZOS)
    sid = uuid.uuid4().hex[:6]
    SHOTS[sid] = {"left": box[0], "top": box[1], "scale": scale}
    if len(SHOTS) > 30:
        SHOTS.pop(next(iter(SHOTS)))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=72)
    info = f"screenshot_id={sid} size={img.width}x{img.height} (screen origin {box[0]},{box[1]}, scale {scale:.3f})"
    return [info, Image(data=buf.getvalue(), format="jpeg")]


def _point(element, x, y, screenshot_id):
    if element is not None:
        cx, cy, e = _center(element)
        win = _top_window(e["ctrl"])
        if win:
            _activate(win)
        return cx, cy
    if x is None or y is None:
        raise ValueError("Give an element number, or x and y.")
    if screenshot_id:
        s = SHOTS.get(screenshot_id)
        if not s:
            raise ValueError(f"Unknown screenshot_id {screenshot_id}; take a new screenshot.")
        return int(s["left"] + float(x) / s["scale"]), int(s["top"] + float(y) / s["scale"])
    return int(x), int(y)


@mcp.tool()
@_guard
def click(element: int | None = None, x: float | None = None, y: float | None = None, screenshot_id: str = "",
          button: str = "left", double: bool = False, label: str = "") -> str:
    """Click an element by number (preferred), or a point: x,y in screen pixels, or in a
    screenshot's pixels when screenshot_id is given. button: left/right/middle. `label` is a
    short note of what you are clicking, shown to the user."""
    check_stop()
    px, py = _point(element, x, y, screenshot_id)
    pyautogui.moveTo(px, py, duration=0.12)
    check_stop()
    pyautogui.click(px, py, clicks=2 if double else 1, interval=0.08, button=button)
    time.sleep(0.35)
    return reply({"clicked": [px, py], "active_window": _fg_title()})


@mcp.tool()
@_guard
def type_text(text: str, element: int | None = None, clear: bool = False, enter: bool = False) -> str:
    """Type text (any language, emoji ok). With `element`, clicks it first. clear=True replaces what is
    there; enter=True presses Enter after. Refuses password fields."""
    check_stop()
    if element is not None:
        cx, cy, e = _center(element)
        if e.get("password"):
            raise PermissionError("That is a password field. Onyx never types passwords: ask the user to type it.")
        win = _top_window(e["ctrl"])
        if win:
            _activate(win)
        pyautogui.click(cx, cy)
        time.sleep(0.15)
    if _focused_is_password():
        raise PermissionError("The focused field is a password field. Onyx never types passwords: ask the user to type it.")
    if clear:
        pyautogui.hotkey("ctrl", "a")
        pyautogui.press("delete")
    _send_unicode(text)
    if enter:
        pyautogui.press("enter")
    time.sleep(0.2)
    return reply({"typed": len(text), "active_window": _fg_title()})


KEY_ALIASES = {
    "control": "ctrl", "cmd": "win", "windows": "win", "super": "win", "meta": "win", "escape": "esc",
    "return": "enter", "del": "delete", "ins": "insert", "pgup": "pageup", "pgdn": "pagedown",
    "page_up": "pageup", "page_down": "pagedown", "arrowup": "up", "arrowdown": "down",
    "arrowleft": "left", "arrowright": "right", "spacebar": "space", "bksp": "backspace", "option": "alt",
}


@mcp.tool()
@_guard
def press_keys(keys: str, repeat: int = 1) -> str:
    """Press keys or shortcuts. Combos with +, several in order separated by spaces:
    "ctrl+s", "enter", "alt+tab", "ctrl+shift+esc", "win+d", "ctrl+a delete", "down down enter"."""
    combos = keys.lower().split()
    for _ in range(max(1, min(int(repeat), 50))):
        for combo in combos:
            check_stop()
            parts = [KEY_ALIASES.get(p, p) for p in combo.split("+") if p]
            bad = [p for p in parts if p not in pyautogui.KEYBOARD_KEYS]
            if bad:
                raise ValueError(f"Unknown key(s): {', '.join(bad)}")
            if len(parts) == 1:
                pyautogui.press(parts[0])
            else:
                pyautogui.hotkey(*parts, interval=0.04)
            time.sleep(0.08)
    time.sleep(0.25)
    return reply({"pressed": keys, "active_window": _fg_title()})


@mcp.tool()
@_guard
def scroll(direction: str = "down", amount: int = 5, element: int | None = None, x: float | None = None,
           y: float | None = None, screenshot_id: str = "") -> str:
    """Scroll up/down/left/right by `amount` notches, over an element or point (default: where the mouse is)."""
    check_stop()
    if element is not None or (x is not None and y is not None):
        px, py = _point(element, x, y, screenshot_id)
        pyautogui.moveTo(px, py, duration=0.1)
    n = max(1, min(int(amount), 50))
    d = direction.lower()
    if d in ("up", "down"):
        pyautogui.scroll(120 * n * (1 if d == "up" else -1))
    elif d in ("left", "right"):
        pyautogui.hscroll(120 * n * (1 if d == "right" else -1))
    else:
        raise ValueError("direction must be up, down, left or right")
    time.sleep(0.3)
    return reply({"scrolled": d, "notches": n})


@mcp.tool()
@_guard
def drag(from_element: int | None = None, to_element: int | None = None, from_x: float | None = None,
         from_y: float | None = None, to_x: float | None = None, to_y: float | None = None, screenshot_id: str = "") -> str:
    """Drag with the left mouse button, between elements or points."""
    check_stop()
    a = _point(from_element, from_x, from_y, screenshot_id)
    b = _point(to_element, to_x, to_y, screenshot_id)
    pyautogui.moveTo(*a, duration=0.15)
    pyautogui.mouseDown()
    pyautogui.moveTo(*b, duration=0.6)
    pyautogui.mouseUp()
    time.sleep(0.3)
    return reply({"dragged": [a, b]})


@mcp.tool()
def wait(seconds: float = 1.0) -> str:
    """Wait for something to load (max 30 seconds)."""
    s = max(0.1, min(float(seconds), 30))
    end = time.time() + s
    while time.time() < end:
        check_stop()
        time.sleep(0.2)
    return reply({"waited": s})


@mcp.tool()
@_guard
def wait_for(text: str, window: str = "", timeout: float = 15) -> str:
    """Wait until a window title or an element containing `text` appears (max 60s)."""
    q = text.lower()
    end = time.time() + max(1, min(float(timeout), 60))
    while time.time() < end:
        check_stop()
        for w in _windows():
            if q in w["title"].lower():
                return reply({"found": "window", "title": w["title"], "handle": w["handle"]})
        win = _find_window(window or None)
        if win:
            hits = _walk(win, max_elements=1, max_depth=60, predicate=lambda c, n: q in n.lower(), deadline=time.time() + 3)
            if hits:
                return reply({"found": "element", "name": hits[0]["name"], "kind": hits[0]["kind"]})
        time.sleep(0.7)
    return reply({"found": None, "note": f'"{text}" did not appear within the timeout.'})


@mcp.tool()
def get_clipboard() -> str:
    """Read the clipboard text."""
    return reply({"text": pyperclip.paste()[:20000]})


@mcp.tool()
def set_clipboard(text: str) -> str:
    """Put text on the clipboard (then ctrl+v pastes it)."""
    pyperclip.copy(text)
    return reply({"copied": len(text)})


@mcp.tool()
@_guard
def system_volume(action: str, steps: int = 5) -> str:
    """Volume: action up, down or mute (toggles). `steps` of 2% each."""
    check_stop()
    key = {"up": "volumeup", "down": "volumedown", "mute": "volumemute"}.get(action.lower())
    if not key:
        raise ValueError("action must be up, down or mute")
    pyautogui.press(key, presses=1 if key == "volumemute" else max(1, min(int(steps), 50)))
    return reply({"volume": action})


if __name__ == "__main__":
    install_stop_hotkey()
    log("[desktop] Onyx desktop server ready")
    mcp.run()
