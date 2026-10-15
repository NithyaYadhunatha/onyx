# Onyx

**An open-source AI agent that controls your Windows PC and your Android phone.**
Press a hotkey (or say "hey jarvis"), tell it what you want, and it does it:
files, apps, Excel, the web, your phone. It asks before anything risky.

```
"Add this month's PhonePe statement to my expense sheet"
"Open Excel and make a monthly budget template"
"Organise my Downloads folder by file type"
"Every Sunday at 8pm, tell me what I spent this week"
"Open WhatsApp on my phone and read me the last message from Amma"
```

## What it can do

- **Your PC.** Onyx sees every app through Windows UI Automation (the accessibility layer),
  so it clicks real buttons by name instead of guessing pixels, and falls back to screenshots
  for anything else. It runs shell commands and reads and writes files.
- **Excel and expenses.** It reads bank and UPI statements (PhonePe, Google Pay, Paytm, HDFC,
  SBI, ICICI, Axis… as PDF, CSV or XLSX) and bank SMS, sorts spending into categories, skips
  duplicates, and keeps `Documents\Onyx\Expenses.xlsx` with a live monthly summary and chart.
- **Your phone.** Over adb (USB or Wi-Fi), Onyx sees the screen, taps, types, opens apps, and
  reads SMS and notifications. Bank SMS land in the expense sheet automatically.
- **Proactive.** Tasks run on a schedule ("9am on the 1st"), once at a set time, or when
  something happens (a new SMS, a new file in a folder, your phone connecting).
- **Memory.** It remembers facts about you and your setup between conversations.
- **Three ways to talk to it:** the hotkey window (Alt+Space), voice (wake word, local speech
  recognition, a natural local voice), or your phone's browser on home Wi-Fi.

## Install

You need **Windows 10/11**, **Node.js 20+** and **Python 3.10+**, plus one of:
- a **Claude Code** login (Pro/Max subscription, no API key needed), or
- a **free local model** through [Ollama](https://ollama.com) (see "Local brain" below).

```bash
npm install
npm run setup
npm start
```

`npm run setup` builds the Python environment and asks before each optional download:
adb for phone control (~13 MB, from Google) and the voice models (~220 MB). After that,
press **Alt+Space** anywhere.

If you have never logged in to Claude Code, setup shows you the one command to run.

## Safety

Onyx can drive your whole computer, so the rules are strict and the code enforces them,
not just the prompt:

- **Approvals.** Every tool is classed as *read* (runs freely), *act* (asks first) or
  *danger* (always asks, in every mode: sending messages, deleting, payments, risky shell
  commands). Approve once, for the whole task, or "always" for that tool. Answer in the
  window, on your phone, or by voice.
- **Stop key.** `Ctrl+Alt+Esc`, or flinging the mouse into a screen corner, freezes every
  action at once.
- **No secrets.** It refuses to type into password fields, on the PC and on the phone, and is
  told never to enter OTPs, PINs or card numbers, and never to complete a payment.
- **Nothing is sent for you.** Phone SMS and calls only open the composer or dialer, filled
  in. You press send.
- **Audit log.** Every tool call, decision and result is in `%USERPROFILE%\.onyx\logs\`
  (`npm run cli -- log`).
- **Local only.** The core listens on 127.0.0.1 with a private access token. Wi-Fi access for
  your phone is off until you turn it on.

## Using it

| | |
|---|---|
| `Alt+Space` | open or hide the Onyx window (from anywhere) |
| `Ctrl+Alt+Esc` | stop everything |
| `Ctrl+Alt+Space` | push-to-talk (when voice is on) |
| "hey jarvis" | wake word (when voice is on) |
| `npm run cli` | Onyx in a terminal (`npm run cli -- "do something"` for one request) |
| `npm run cli -- tasks` | list scheduled tasks |
| `npm run cli -- log` | today's actions |
| `npm run voice` | voice in a terminal, to see what it hears |
| `npm run autostart` | start Onyx when you sign in (`-- --remove` to undo) |

Settings live in `%USERPROFILE%\.onyx\config.json`:

```jsonc
{
  "brain": "claude",                 // or "local"
  "claude": { "model": "claude-sonnet-5-5", "effort": "medium" },
  "approvals": "ask",                // "auto": only risky actions ask
  "alwaysAllow": [],                 // e.g. ["onyx_office.*"]
  "hotkey": "Alt+Space",
  "phone": { "smsSync": true, "smsSyncMinutes": 15 },
  "expenses": { "workbook": "C:\\Users\\you\\Documents\\Onyx\\Expenses.xlsx" },
  "lan": { "enabled": false, "port": 8766 },
  "voice": { "enabled": false, "wakeWord": "hey_jarvis", "whisperModel": "base.en" }
}
```

Restart Onyx after changing them (tray icon → Quit Onyx, then `npm start`).

**Phone setup** (adb, the phone web app, SMS forwarding): see [phone/README.md](phone/README.md).

## Local brain (free, offline)

1. Install [Ollama](https://ollama.com) and pull a model with tool calling:
   `ollama pull qwen2.5:7b-instruct` (or `qwen2.5:3b-instruct` on a 4 GB GPU).
2. Set `"brain": "local"` in the settings. `local.baseUrl` and `local.model` point at any
   OpenAI-compatible server (Ollama, LM Studio, llama.cpp).

Small local models handle files, Excel, memory and phone tasks well, but they are much weaker
than Claude at long multi-step GUI tasks, and they cannot see screenshots.

## How it works

```
 faces                         core (Node)                          hands (MCP servers)
 ─────                         ───────────                          ───────────────────
 hotkey window (Electron) ─┐   brain: Claude Agent SDK               onyx_desktop  UI Automation,
 voice (Python)           ─┼─► or a local OpenAI-compatible model ─► screenshots, mouse, keyboard
 phone web app            ─┤   approval gate (every tool call)       onyx_office   Excel, statements,
 terminal                 ─┘   memory · scheduler · action log        SMS, expenses
                               phone SMS sync                         onyx_phone    adb
                                                                      + any MCP server you add
```

- **core/**: the hub everyone connects to (WebSocket + HTTP on 127.0.0.1:8765, token auth),
  the approval policy, memory, scheduler, action log, and the two brains.
- **servers/**: the Python tool servers, speaking the Model Context Protocol (MCP).
- **app/**: the hotkey window. The same page is the phone web app.
- **voice/**: openWakeWord, faster-whisper and Piper, all running locally.

Add any other MCP server in `%USERPROFILE%\.onyx\servers.json` (same shape as Claude Code's
`mcpServers`), or set `"includeClaudeCodeServers": true` to reuse the ones in your Claude Code config.

## Development

```bash
npm test            # unit tests: policy, scheduler, memory, SMS/statement parsing, workbook
npm run test:e2e    # end-to-end with the real brain (reads your window list, writes a temp file)
```

## Built with

Open source: Model Context Protocol · Electron · uiautomation · PyAutoGUI · mss · openpyxl ·
pdfplumber · Android platform-tools (adb) · openWakeWord · faster-whisper · Piper · croner · ws · zod.

The Claude brain uses the **Claude Agent SDK**, which is not open source: it is Anthropic's
proprietary SDK, used under your Claude Code subscription terms. Onyx's own code is MIT. For a
setup that is open source end to end, use the local brain with an open model.

## License

MIT
