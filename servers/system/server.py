"""Onyx system server: install software and control Windows itself.

Installs go through winget, Windows' own package manager (Microsoft's, open
source), so "install valorant" or "set up python" means one command: find the
package, install it silently, check it worked. Apps that need admin rights show
Windows' usual UAC prompt unless Onyx was started with admin rights
(npm run elevate).
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from mcp.server.fastmcp import FastMCP  # noqa: E402

from common import check_stop, log, reply  # noqa: E402

mcp = FastMCP(
    "onyx_system",
    log_level="WARNING",
    instructions="Install, update and remove apps with winget; system info, processes, power, volume, brightness, Wi-Fi and Windows settings.",
)

NO_WINDOW = 0x08000000


def _run(args: list[str], timeout: float = 120) -> tuple[int, str]:
    p = subprocess.run(args, capture_output=True, timeout=timeout, creationflags=NO_WINDOW)
    out = (p.stdout + p.stderr).decode("utf-8", errors="replace")
    # winget draws progress bars with carriage returns and spinner characters.
    out = "\n".join(line.split("\r")[-1] for line in out.splitlines())
    out = re.sub(r"^.*[▀-▟▒░]{3,}.*$", "", out, flags=re.M)
    return p.returncode, out.strip()


def _ps(script: str, timeout: float = 60) -> str:
    code, out = _run(["powershell", "-NoProfile", "-NonInteractive", "-Command", script], timeout)
    return out


WINGET_FLAGS = ["--accept-source-agreements", "--disable-interactivity"]


def _table(text: str) -> list[dict]:
    """Parse winget's fixed-width tables using the header's column positions."""
    lines = text.splitlines()
    for i, line in enumerate(lines):
        if re.match(r"^\s*Name\s+Id\s+", line) and i + 1 < len(lines) and set(lines[i + 1].strip()) <= {"-"}:
            header = line
            cols = [(m.group(0), m.start()) for m in re.finditer(r"\S+", header)]
            names = [c[0] for c in cols]
            starts = [c[1] for c in cols] + [10_000]
            rows = []
            for row in lines[i + 2 :]:
                if not row.strip() or set(row.strip()) <= {"-"}:
                    continue
                if re.match(r"^\d+ (upgrades|package)", row):
                    continue
                vals = {names[k]: row[starts[k] : starts[k + 1]].strip() for k in range(len(names))}
                if vals.get("Id"):
                    rows.append(vals)
            return rows
    return []


@mcp.tool()
def search_apps(query: str) -> str:
    """Search for installable apps (winget). Returns name, id, version, source."""
    code, out = _run(["winget", "search", query, *WINGET_FLAGS], 90)
    rows = _table(out)
    if not rows:
        return reply({"query": query, "results": [], "note": out[-300:] or "No packages found."})
    return reply({"query": query, "results": [{"name": r.get("Name"), "id": r.get("Id"), "version": r.get("Version"), "source": r.get("Source", "")} for r in rows[:15]]})


# What people call things, mapped to the package they mean.
ALIASES = {
    "python": "Python.Python.3.13", "python3": "Python.Python.3.13", "vscode": "Microsoft.VisualStudioCode",
    "vs code": "Microsoft.VisualStudioCode", "code": "Microsoft.VisualStudioCode", "node": "OpenJS.NodeJS.LTS",
    "nodejs": "OpenJS.NodeJS.LTS", "node.js": "OpenJS.NodeJS.LTS", "java": "EclipseAdoptium.Temurin.21.JDK",
    "jdk": "EclipseAdoptium.Temurin.21.JDK", "git": "Git.Git", "github desktop": "GitHub.GitHubDesktop",
    "chrome": "Google.Chrome", "google chrome": "Google.Chrome", "firefox": "Mozilla.Firefox", "brave": "Brave.Brave",
    "vlc": "VideoLAN.VLC", "zoom": "Zoom.Zoom", "telegram": "Telegram.TelegramDesktop", "spotify": "Spotify.Spotify",
    "discord": "Discord.Discord", "steam": "Valve.Steam", "epic games": "EpicGames.EpicGamesLauncher",
    "epic": "EpicGames.EpicGamesLauncher", "minecraft": "Mojang.MinecraftLauncher", "notepad++": "Notepad++.Notepad++",
    "7zip": "7zip.7zip", "7-zip": "7zip.7zip", "winrar": "RARLab.WinRAR", "docker": "Docker.DockerDesktop",
    "android studio": "Google.AndroidStudio", "visual studio": "Microsoft.VisualStudio.2022.Community",
    "pycharm": "JetBrains.PyCharm.Community", "intellij": "JetBrains.IntelliJIDEA.Community", "postman": "Postman.Postman",
    "obs": "OBSProject.OBSStudio", "whatsapp": "9NKSQGP7F2NH", "powertoys": "Microsoft.PowerToys",
    "windows terminal": "Microsoft.WindowsTerminal", "anaconda": "Anaconda.Anaconda3", "miniconda": "Anaconda.Miniconda3",
    "go": "GoLang.Go", "golang": "GoLang.Go", "rust": "Rustlang.Rustup", "mysql": "Oracle.MySQL", "postgres": "PostgreSQL.PostgreSQL.17",
    "postgresql": "PostgreSQL.PostgreSQL.17", "mongodb": "MongoDB.Server", "figma": "Figma.Figma", "notion": "Notion.Notion",
    "slack": "SlackTechnologies.Slack", "teams": "Microsoft.Teams", "obsidian": "Obsidian.Obsidian", "blender": "BlenderFoundation.Blender",
    "gimp": "GIMP.GIMP.3", "audacity": "Audacity.Audacity", "qbittorrent": "qBittorrent.qBittorrent", "ollama": "Ollama.Ollama",
}


def _resolve(name_or_id: str) -> tuple[str | None, list[dict]]:
    """An exact winget id, or the best match for a name."""
    q = name_or_id.strip()
    alias = ALIASES.get(q.lower().removeprefix("the ").strip())
    if alias:
        return alias, []
    code, out = _run(["winget", "search", q, *WINGET_FLAGS], 90)
    rows = _table(out)
    if not rows:
        return None, []
    low = q.lower()
    for r in rows:
        if r["Id"].lower() == low:
            return r["Id"], rows
    norm = lambda s: re.sub(r"[^a-z0-9]", "", s.lower())  # noqa: E731
    nq = norm(q)

    def score(r):
        name, pid = r.get("Name", ""), r["Id"]
        segs = [norm(x) for x in pid.split(".")]
        s = 0
        # winget's own packages install silently; Store copies often do not.
        if r.get("Source", "winget") == "winget":
            s += 10
        if name.lower() == low:
            s += 8
        elif norm(name) == nq:
            s += 7
        elif norm(name).endswith(nq) or norm(name).startswith(nq):
            s += 4  # "Microsoft Visual Studio Code" for "visual studio code"
        elif nq in norm(name):
            s += 1
        if nq in segs:
            s += 5 + (3 if segs.count(nq) > 1 or (len(segs) > 1 and segs[0] == segs[-1]) else 0)  # 7zip.7zip
        if re.search(r"\b(dark|theme|portable|beta|preview|nightly|insiders|canary)\b", name.lower()) and not re.search(r"dark|theme|portable|beta|preview|nightly|insiders|canary", low):
            s -= 4
        return s

    ranked = sorted(rows, key=score, reverse=True)
    if len(ranked) == 1 or score(ranked[0]) - score(ranked[1]) >= 3:
        return ranked[0]["Id"], ranked
    # Several equally good matches (VALORANT has one per region): let the caller pick.
    return None, ranked


@mcp.tool()
def install_app(name_or_id: str, version: str = "") -> str:
    """Install an app silently, e.g. "Python 3.12", "VS Code", "Discord", "RiotGames.Valorant.AP".
    If several packages match, returns the choices: call again with the exact id.
    Can take many minutes for big apps. Windows may show an admin (UAC) prompt."""
    check_stop()
    pkg, rows = _resolve(name_or_id)
    if not pkg:
        if not rows:
            return reply({"installed": False, "error": f'No package found for "{name_or_id}". Try search_apps with other words.'})
        return reply({
            "installed": False,
            "choose_one": [{"name": r.get("Name"), "id": r.get("Id"), "source": r.get("Source", "")} for r in rows[:12]],
            "note": "Several packages match: call install_app again with the exact id. (For VALORANT in India, use RiotGames.Valorant.AP.)",
        })
    args = ["winget", "install", "--id", pkg, "--exact", "--silent", "--accept-package-agreements", *WINGET_FLAGS]
    if version:
        args += ["--version", version]
    started = time.time()
    code, out = _run(args, timeout=3600)
    tail = out[-1500:]
    ok = code == 0 or re.search(r"Successfully installed|already installed|No newer package versions", out, re.I)
    result = {"installed": bool(ok), "id": pkg, "minutes": round((time.time() - started) / 60, 1), "output": tail}
    if re.search(r"already installed", out, re.I):
        result["note"] = "It was already installed."
    if not ok and re.search(r"0x8a150056|admin|elevat|cancelled by the user|1223", out, re.I):
        result["note"] = "The installer needs admin rights and the prompt was declined or timed out. Accept the Windows prompt, or start Onyx with admin rights (npm run elevate)."
    if ok:
        result["next"] = "New programs are on PATH for new shells; verify with the shell tool (e.g. `python --version`)."
    return reply(result)


@mcp.tool()
def uninstall_app(name_or_id: str) -> str:
    """Uninstall an app (winget). Use list_installed to find the exact id."""
    check_stop()
    code, out = _run(["winget", "uninstall", "--id", name_or_id, "--exact", "--silent", *WINGET_FLAGS], 1800)
    if code != 0 and re.search(r"No installed package found", out, re.I):
        code, out = _run(["winget", "uninstall", "--name", name_or_id, "--silent", *WINGET_FLAGS], 1800)
    return reply({"uninstalled": code == 0, "output": out[-1200:]})


@mcp.tool()
def update_apps(name_or_id: str = "") -> str:
    """Update one app, or everything with an update available when no name is given."""
    check_stop()
    if name_or_id:
        args = ["winget", "upgrade", "--id", name_or_id, "--exact", "--silent", "--accept-package-agreements", *WINGET_FLAGS]
    else:
        args = ["winget", "upgrade", "--all", "--silent", "--accept-package-agreements", "--include-unknown", *WINGET_FLAGS]
    code, out = _run(args, 3600)
    return reply({"ok": code == 0, "output": out[-2000:]})


@mcp.tool()
def list_installed(query: str = "", updates_only: bool = False) -> str:
    """Installed apps (winget), filtered by name. updates_only=True lists apps with updates."""
    args = ["winget", "upgrade" if updates_only else "list", *WINGET_FLAGS]
    if query and not updates_only:
        args[2:2] = [query]
    code, out = _run(args, 120)
    rows = _table(out)
    return reply([{k: v for k, v in r.items() if v} for r in rows[:80]])


@mcp.tool()
def system_info() -> str:
    """Windows version, CPU, RAM, GPU, disks, battery and uptime."""
    script = r"""
$os = Get-CimInstance Win32_OperatingSystem
$cs = Get-CimInstance Win32_ComputerSystem
$cpu = (Get-CimInstance Win32_Processor | Select-Object -First 1).Name
$gpu = (Get-CimInstance Win32_VideoController | ForEach-Object Name) -join ', '
$disks = Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | ForEach-Object { @{ drive=$_.DeviceID; free_gb=[math]::Round($_.FreeSpace/1GB,1); size_gb=[math]::Round($_.Size/1GB,1) } }
$bat = Get-CimInstance Win32_Battery | Select-Object -First 1
[pscustomobject]@{
  windows = "$($os.Caption) $($os.Version)"; cpu = $cpu; gpu = $gpu
  ram_gb = [math]::Round($cs.TotalPhysicalMemory/1GB,1); ram_free_gb = [math]::Round($os.FreePhysicalMemory/1MB,1)
  disks = $disks; battery = if ($bat) { "$($bat.EstimatedChargeRemaining)%" } else { $null }
  uptime_hours = [math]::Round(((Get-Date) - $os.LastBootUpTime).TotalHours,1)
} | ConvertTo-Json -Depth 4 -Compress
"""
    return _ps(script)


@mcp.tool()
def processes(query: str = "", top: int = 15) -> str:
    """Running programs using the most memory (filter by name)."""
    q = query.replace("'", "")
    script = (
        f"Get-Process | Where-Object {{ $_.ProcessName -like '*{q}*' }} | Sort-Object WorkingSet64 -Descending | "
        f"Select-Object -First {max(1, min(int(top), 60))} Id, ProcessName, @{{n='MB';e={{[math]::Round($_.WorkingSet64/1MB)}}}}, MainWindowTitle | ConvertTo-Json -Compress"
    )
    return _ps(script)


PROTECTED = {"csrss", "wininit", "winlogon", "lsass", "services", "smss", "system", "svchost", "explorer", "dwm", "node", "electron", "ollama"}


@mcp.tool()
def kill_process(name_or_pid: str) -> str:
    """Close a program that is stuck or unwanted, by name ("chrome") or process id."""
    check_stop()
    target = name_or_pid.strip().replace(".exe", "")
    if target.lower() in PROTECTED:
        raise PermissionError(f"{target} is part of Windows or of Onyx itself; not stopping it.")
    if target.isdigit():
        out = _ps(f"Stop-Process -Id {int(target)} -Force -PassThru | Select-Object Id, ProcessName | ConvertTo-Json -Compress")
    else:
        out = _ps(f"Stop-Process -Name '{target}' -Force -PassThru | Select-Object Id, ProcessName | ConvertTo-Json -Compress")
    return reply({"stopped": out or f"nothing called {target} was running"})


@mcp.tool()
def power(action: str, delay_seconds: int = 0) -> str:
    """lock, sleep, hibernate, sign_out, restart, shutdown, or cancel (a pending restart/shutdown)."""
    check_stop()
    a = action.lower().replace(" ", "_")
    d = max(0, min(int(delay_seconds), 86_400))
    if a == "lock":
        _run(["rundll32.exe", "user32.dll,LockWorkStation"])
    elif a in ("sleep", "hibernate"):
        _ps(f"Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Application]::SetSuspendState('{'Hibernate' if a == 'hibernate' else 'Suspend'}', $false, $false)")
    elif a in ("sign_out", "logoff", "log_out"):
        _run(["shutdown", "/l"])
    elif a == "restart":
        _run(["shutdown", "/r", "/t", str(max(d, 10))])
    elif a == "shutdown":
        _run(["shutdown", "/s", "/t", str(max(d, 10))])
    elif a == "cancel":
        _run(["shutdown", "/a"])
    else:
        raise ValueError("action must be lock, sleep, hibernate, sign_out, restart, shutdown or cancel")
    return reply({"done": a, "delay_seconds": d})


_VOLUME_CS = r"""
using System; using System.Runtime.InteropServices;
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume { int f(); int g(); int h(); int i();
  int SetMasterVolumeLevelScalar(float level, Guid ctx); int j(); int GetMasterVolumeLevelScalar(out float level);
  int k(); int l(); int m(); int n(); int SetMute(bool mute, Guid ctx); int GetMute(out bool mute); }
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice { int Activate(ref Guid id, int ctx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object o); }
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator { int f(); int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice d); }
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumerator {}
public static class OnyxAudio {
  static IAudioEndpointVolume Vol() { var e = (IMMDeviceEnumerator)(new MMDeviceEnumerator()); IMMDevice d; e.GetDefaultAudioEndpoint(0, 1, out d);
    var id = typeof(IAudioEndpointVolume).GUID; object o; d.Activate(ref id, 23, IntPtr.Zero, out o); return (IAudioEndpointVolume)o; }
  public static float Get() { float v; Vol().GetMasterVolumeLevelScalar(out v); return v; }
  public static void Set(float v) { Vol().SetMasterVolumeLevelScalar(v, Guid.Empty); }
  public static void Mute(bool m) { Vol().SetMute(m, Guid.Empty); }
}
"""


@mcp.tool()
def volume(level: int = -1, mute: str = "") -> str:
    """Set the speaker volume to `level` (0-100), and/or mute="on"/"off". With nothing, reports the volume."""
    cs = _VOLUME_CS.replace('"', '""')
    parts = [f'Add-Type -TypeDefinition @"\n{_VOLUME_CS}\n"@']
    if 0 <= int(level) <= 100:
        parts.append(f"[OnyxAudio]::Set({int(level) / 100.0})")
    if mute in ("on", "off"):
        parts.append(f"[OnyxAudio]::Mute(${'true' if mute == 'on' else 'false'})")
    parts.append("[math]::Round([OnyxAudio]::Get()*100)")
    out = _ps("\n".join(parts))
    return reply({"volume": out.splitlines()[-1] if out else None})


@mcp.tool()
def brightness(level: int) -> str:
    """Set the built-in screen's brightness (0-100). Laptops only."""
    lvl = max(0, min(int(level), 100))
    out = _ps(f"(Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods | Invoke-CimMethod -MethodName WmiSetBrightness -Arguments @{{Timeout=1; Brightness={lvl}}}) | Out-Null; (Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness).CurrentBrightness")
    if not out.strip().isdigit():
        return reply({"ok": False, "note": "This screen does not let Windows set its brightness (external monitors usually don't)."})
    return reply({"brightness": int(out.strip())})


SETTINGS_PAGES = {
    "wifi": "ms-settings:network-wifi", "network": "ms-settings:network", "bluetooth": "ms-settings:bluetooth",
    "display": "ms-settings:display", "sound": "ms-settings:sound", "apps": "ms-settings:appsfeatures",
    "default apps": "ms-settings:defaultapps", "startup apps": "ms-settings:startupapps", "update": "ms-settings:windowsupdate",
    "battery": "ms-settings:batterysaver", "power": "ms-settings:powersleep", "notifications": "ms-settings:notifications",
    "storage": "ms-settings:storagesense", "privacy": "ms-settings:privacy", "personalization": "ms-settings:personalization",
    "themes": "ms-settings:themes", "background": "ms-settings:personalization-background", "mouse": "ms-settings:mousetouchpad",
    "keyboard": "ms-settings:typing", "language": "ms-settings:regionlanguage", "time": "ms-settings:dateandtime",
    "accounts": "ms-settings:yourinfo", "vpn": "ms-settings:network-vpn", "hotspot": "ms-settings:network-mobilehotspot",
    "gaming": "ms-settings:gaming-gamebar", "graphics": "ms-settings:display-advancedgraphics", "about": "ms-settings:about",
    "printers": "ms-settings:printers", "focus": "ms-settings:quiethours", "night light": "ms-settings:nightlight",
}


@mcp.tool()
def open_settings(page: str) -> str:
    """Open a Windows Settings page: wifi, bluetooth, display, sound, apps, default apps, startup apps,
    update, battery, power, notifications, storage, privacy, themes, background, mouse, keyboard,
    language, time, vpn, hotspot, gaming, graphics, about, printers, focus, night light."""
    uri = SETTINGS_PAGES.get(page.lower().strip()) or (page if page.startswith("ms-settings:") else None)
    if not uri:
        raise ValueError(f"Unknown settings page. Known: {', '.join(SETTINGS_PAGES)}")
    os.startfile(uri)
    return reply({"opened": uri})


@mcp.tool()
def wifi(action: str = "status", name: str = "") -> str:
    """Wi-Fi: status (current network), list (networks in range), connect (to a saved network by name), disconnect."""
    a = action.lower()
    if a == "status":
        return reply({"status": _run(["netsh", "wlan", "show", "interfaces"])[1][-1200:]})
    if a == "list":
        out = _run(["netsh", "wlan", "show", "networks"])[1]
        return reply({"networks": re.findall(r"SSID \d+ : (.+)", out)})
    if a == "connect":
        if not name:
            raise ValueError("give the network name")
        code, out = _run(["netsh", "wlan", "connect", f"name={name}"])
        return reply({"ok": code == 0, "output": out, "note": "" if code == 0 else "Only networks this PC has joined before can be connected this way."})
    if a == "disconnect":
        return reply({"output": _run(["netsh", "wlan", "disconnect"])[1]})
    raise ValueError("action must be status, list, connect or disconnect")


@mcp.tool()
def dark_mode(on: bool) -> str:
    """Switch Windows and apps to dark (on=True) or light mode."""
    v = 0 if on else 1
    key = r"HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize"
    _ps(f"Set-ItemProperty -Path '{key}' -Name AppsUseLightTheme -Value {v}; Set-ItemProperty -Path '{key}' -Name SystemUsesLightTheme -Value {v}")
    return reply({"dark_mode": on})


@mcp.tool()
def empty_recycle_bin() -> str:
    """Permanently delete everything in the Recycle Bin."""
    check_stop()
    _ps("Clear-RecycleBin -Force -ErrorAction SilentlyContinue")
    return reply({"emptied": True})


if __name__ == "__main__":
    log("[system] Onyx system server ready")
    mcp.run()
