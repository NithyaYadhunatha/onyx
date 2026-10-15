/**
 * One-time setup:  npm run setup
 *
 * Checks Node, builds the Python environment, checks your Claude Code login,
 * and offers (asking each time) the optional free downloads:
 *   - Android platform-tools (adb), from Google, for phone control  (~13 MB)
 *   - voice models: wake word (openWakeWord, GitHub), speech recognition
 *     (Whisper base.en, Hugging Face) and a natural voice (Piper, Hugging Face)  (~220 MB)
 * Then writes your settings and can add Onyx to the Start menu and startup.
 *
 *   npm run setup -- --yes            accept every question
 *   npm run setup -- --no-downloads   skip all downloads
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import readline from 'node:readline/promises'
import { DATA_DIR, PYTHON, ROOT, accessToken, loadConfig, saveConfig } from '../core/config.mjs'

const argv = new Set(process.argv.slice(2))
const YES = argv.has('--yes')
const NO_DL = argv.has('--no-downloads')
const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

const ok = (s) => console.log(`  \x1b[32m✓\x1b[0m ${s}`)
const warn = (s) => console.log(`  \x1b[33m!\x1b[0m ${s}`)
const step = (s) => console.log(`\n\x1b[1m${s}\x1b[0m`)

async function ask(question, def = true) {
  if (YES) return true
  const hint = def ? 'Y/n' : 'y/N'
  const a = (await rl.question(`  ${question} [${hint}] `)).trim().toLowerCase()
  return a ? a.startsWith('y') : def
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: ROOT, ...opts })
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed`)
}

function findPython() {
  for (const [cmd, args] of [['py', ['-3.12']], ['py', ['-3.11']], ['python', []], ['py', ['-3']]]) {
    try {
      const v = execFileSync(cmd, [...args, '-c', 'import sys;print(sys.version_info[:2])'], { encoding: 'utf8' })
      const [maj, min] = v.match(/\d+/g).map(Number)
      if (maj === 3 && min >= 10) return [cmd, args]
    } catch {}
  }
  return null
}

async function main() {
  console.log('\n\x1b[1mOnyx setup\x1b[0m')

  step('1. Node.js')
  const major = Number(process.versions.node.split('.')[0])
  if (major < 20) throw new Error(`Node ${process.versions.node} is too old: install Node 20 or newer from nodejs.org`)
  ok(`Node ${process.versions.node}`)
  if (!existsSync(join(ROOT, 'node_modules', '@anthropic-ai', 'claude-agent-sdk'))) run('npm', ['install'], { shell: true })
  ok('npm packages')

  step('2. Python environment')
  if (!existsSync(PYTHON)) {
    const py = findPython()
    if (!py) throw new Error('Python 3.10+ not found: install it from python.org (tick "Add to PATH")')
    run(py[0], [...py[1], '-m', 'venv', '.venv'])
  }
  run(PYTHON, ['-m', 'pip', 'install', '-q', '--upgrade', 'pip'])
  run(PYTHON, ['-m', 'pip', 'install', '-q', '-r', 'requirements.txt'])
  // Generate the UI Automation COM wrappers now, so the first real use is fast.
  run(PYTHON, ['-c', 'import uiautomation'], { stdio: 'ignore' })
  ok('desktop, office and phone tool servers')

  step('3. The brain')
  const cfg = loadConfig()
  const creds = join(homedir(), '.claude', '.credentials.json')
  if (existsSync(creds) || process.env.ANTHROPIC_API_KEY) {
    ok('Claude Code login found: Onyx will use it (no API key needed)')
  } else {
    warn('No Claude Code login found. Log in once with:')
    console.log(`     "${join(ROOT, 'node_modules', '@anthropic-ai', 'claude-agent-sdk-win32-x64', 'claude.exe')}"`)
    console.log('     then type /login. Or use a free local model instead (see README: "Local brain").')
  }

  step('4. Phone control (optional)')
  const adbHome = join(ROOT, 'tools', 'platform-tools', 'adb.exe')
  const adbLocal = join(process.env.LOCALAPPDATA ?? '', 'Android', 'Sdk', 'platform-tools', 'adb.exe')
  if (existsSync(adbHome) || existsSync(adbLocal) || spawnSync('where', ['adb'], { stdio: 'ignore' }).status === 0) {
    ok('adb is installed')
  } else if (!NO_DL && (await ask('Download Android platform-tools (adb) from Google, about 13 MB?'))) {
    const zip = join(ROOT, 'tools', 'platform-tools.zip')
    mkdirSync(join(ROOT, 'tools'), { recursive: true })
    run('powershell', [
      '-NoProfile',
      '-Command',
      `$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -Uri https://dl.google.com/android/repository/platform-tools-latest-windows.zip -OutFile '${zip}'; Expand-Archive -Force '${zip}' '${join(ROOT, 'tools')}'; Remove-Item '${zip}'`,
    ])
    ok(existsSync(adbHome) ? 'adb installed in tools/platform-tools' : 'download finished, but adb.exe was not found')
  } else {
    warn('Skipped. Phone tools will tell you how to install adb when you need them.')
  }

  step('5. Voice (optional)')
  let voice = cfg.voice.enabled
  if (!NO_DL && (await ask('Set up voice ("hey jarvis" wake word, local speech recognition, natural voice)? Downloads about 220 MB.', false))) {
    run(PYTHON, ['-m', 'pip', 'install', '-q', '-r', 'requirements-voice.txt'])
    const models = join(ROOT, 'models')
    mkdirSync(join(models, 'piper'), { recursive: true })
    run(PYTHON, [
      '-c',
      `import openwakeword.utils as u; u.download_models(['${cfg.voice.wakeWord}'], target_directory=r'${join(models, 'openwakeword')}')`,
    ])
    ok('wake word model')
    run(PYTHON, ['-m', 'piper.download_voices', cfg.voice.piperVoice, '--data-dir', join(models, 'piper')])
    ok(`Piper voice ${cfg.voice.piperVoice}`)
    run(PYTHON, [
      '-c',
      `from faster_whisper import WhisperModel; WhisperModel('${cfg.voice.whisperModel}', device='cpu', compute_type='int8', download_root=r'${join(models, 'whisper-cache')}')`,
    ])
    ok(`Whisper ${cfg.voice.whisperModel}`)
    voice = true
  }

  step('6. Settings')
  const approvals = YES
    ? cfg.approvals
    : (await ask('Ask before every action (recommended while you get to know Onyx)? Say no to only ask for risky ones.', true))
      ? 'ask'
      : 'auto'
  const lan = !YES && (await ask('Let your phone use Onyx over your home Wi-Fi (web app + SMS forwarding)?', false))
  saveConfig({ approvals, voice: { enabled: voice }, lan: { enabled: lan } })
  accessToken()
  ok(`settings saved to ${join(DATA_DIR, 'config.json')}`)

  step('7. Shortcuts')
  if (await ask('Add Onyx to the Start menu?', true)) {
    run('node', [join(ROOT, 'scripts', 'autostart.mjs'), '--start-menu'])
  }
  if (await ask('Start Onyx automatically when you sign in to Windows?', false)) {
    run('node', [join(ROOT, 'scripts', 'autostart.mjs')])
  }

  console.log('\n\x1b[1mDone.\x1b[0m Start Onyx with \x1b[36mnpm start\x1b[0m, then press \x1b[36mAlt+Space\x1b[0m anywhere.\n')
}

main()
  .catch((err) => {
    console.error(`\n\x1b[31mSetup stopped: ${err.message}\x1b[0m`)
    process.exitCode = 1
  })
  .finally(() => rl.close())
