/** npm run voice: voice in this terminal, so you can watch what it hears. */

import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { PYTHON, ROOT, loadConfig } from '../core/config.mjs'
import { ensureCore } from '../core/launch.mjs'

await ensureCore(loadConfig())
const child = spawn(PYTHON, ['-X', 'utf8', join(ROOT, 'voice', 'voice.py')], { cwd: ROOT, stdio: 'inherit' })
child.on('exit', (code) => process.exit(code ?? 0))
