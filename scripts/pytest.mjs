/** Runs the Python unit tests with the project venv. */

import { spawnSync } from 'node:child_process'
import { PYTHON, ROOT } from '../core/config.mjs'

const r = spawnSync(PYTHON, ['-X', 'utf8', '-m', 'unittest', 'discover', 'tests'], { cwd: ROOT, stdio: 'inherit' })
process.exit(r.status ?? 1)
