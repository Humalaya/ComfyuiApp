// `npm run deploy`: type-check, build into dist-next/, then swap it in for
// dist/ with renames — the app server (server/webapp.js) never sees a
// half-written dist/. A failed check or build leaves the live app untouched.
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const run = (cmd) => execSync(cmd, { cwd: root, stdio: 'inherit' })

run('npx tsc --noEmit -p tsconfig.app.json')
run('npx vite build --outDir dist-next --emptyOutDir')

const dist = path.join(root, 'dist')
const old = path.join(root, 'dist-old')
fs.rmSync(old, { recursive: true, force: true })
if (fs.existsSync(dist)) fs.renameSync(dist, old)
fs.renameSync(path.join(root, 'dist-next'), dist)
fs.rmSync(old, { recursive: true, force: true })
console.log('[deploy] dist/ updated — the phone picks it up on its next load (it offers "Güncelleme hazır").')
