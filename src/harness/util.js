import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync, execFile } from 'node:child_process'
import { BIN } from '../launcher.js'
import { envVar } from '../env.js'

// Shared by the harness adapters: where each harness keeps its files, careful edits of the
// user's config files, and incremental JSONL reads.

export function harnessContext ({ env = process.env, node = process.execPath, bin = BIN, run = null } = {}) {
  const home = env.HOME || os.homedir()
  const searchPath = envVar('HARNESS_PATH', env) ?? env.PATH ?? ''
  return {
    env,
    node,
    bin,
    home,
    copilotHome: env.COPILOT_HOME || path.join(home, '.copilot'),
    claudeHome: env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'),
    configHome: env.XDG_CONFIG_HOME || path.join(home, '.config'),
    codexHome: env.CODEX_HOME || path.join(home, '.codex'),
    which: (name) => which(name, searchPath),
    run: run || ((cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', env, timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] }))
  }
}

// AUTOCHAT_HARNESS_PATH (path-delimited) replaces PATH when looking for harness binaries.
export function which (name, searchPath) {
  for (const dir of String(searchPath).split(path.delimiter).filter(Boolean)) {
    const p = path.join(dir, name)
    try {
      if (fs.statSync(p).isFile()) { fs.accessSync(p, fs.constants.X_OK); return p }
    } catch {}
  }
  return null
}

/** `<binary> --version`, reduced to its first version number. Spawns, so doctor only. */
export function versionOf (ctx, binary) {
  if (!binary) return null
  const r = ctx.run(binary, ['--version'])
  return (/\d+\.\d+(?:\.\d+)?/.exec(`${r.stdout || ''} ${r.stderr || ''}`) || [])[0] || null
}

export const tilde = (p, ctx) => p && ctx.home && p.startsWith(ctx.home + path.sep) ? '~' + p.slice(ctx.home.length) : p
export const exists = (p) => { try { return fs.statSync(p).isFile() } catch { return false } }
export const isDir = (p) => { try { return fs.statSync(p).isDirectory() } catch { return false } }
export const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
export const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
// POSIX shell and PowerShell single quotes, for hook commands.
export const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'"
export const psq = (s) => "'" + String(s).replace(/'/g, "''") + "'"

// --- careful file edits ---------------------------------------------------------------------------

export function readText (file) {
  try { return fs.readFileSync(file, 'utf8') } catch (err) { if (err.code === 'ENOENT') return null; throw err }
}

// Atomic (temp file + rename), with a one-time backup (unless `backup` is false). A symlinked
// config (stow, chezmoi, home-manager) is written through to its target, so the link stays a link.
export function writeFileSafely (file, text, { backup = true } = {}) {
  let target = file
  try { target = fs.realpathSync(file) } catch {}
  fs.mkdirSync(path.dirname(target), { recursive: true })
  let mode = 0o600
  if (exists(target)) {
    mode = fs.statSync(target).mode & 0o777
    const bak = file + '.autochat.bak'
    if (backup && !fs.existsSync(bak)) fs.copyFileSync(target, bak)
  }
  const tmp = `${target}.autochat-${process.pid}.tmp`
  fs.writeFileSync(tmp, text, { mode })
  fs.renameSync(tmp, target)
}

/**
 * A JSON config file. `root` is null when the file is missing or empty, undefined when it isn't
 * a plain JSON object (comments, say), else the parsed object.
 */
export function readJson (file) {
  const text = readText(file)
  if (text === null || !text.trim()) return { text, root: null }
  try {
    const root = JSON.parse(text)
    return { text, root: isObj(root) ? root : undefined }
  } catch {
    return { text, root: undefined }
  }
}

function jsonIndent (text) {
  const m = /^([ \t]+)["}\]]/m.exec(text || '')
  return m ? m[1] : 2
}

/** Writes `root` in the file's own indentation, with a final newline only if it had one. */
export function writeJson (file, text, root) {
  writeFileSafely(file, JSON.stringify(root, null, jsonIndent(text)) + (text && !text.endsWith('\n') ? '' : '\n'))
}

// Plans are shown first and applied later (maybe after a prompt), so apply() works from the file
// as it is then, not as it was when planned: nothing written in between gets lost.
const freshly = (compute, ctx) => () => {
  const now = compute(ctx)
  if (now.action === 'manual') throw new Error(now.reason)
  now.write?.()
}
const shown = ({ write, ...rest }) => rest

/**
 * A plan to show: {id, action, file, …}. If it changes anything, apply() recomputes it from the
 * file as it is then and writes that. `compute(ctx)` returns the plan plus a write() closure.
 */
export function planned (compute, ctx) {
  const p = compute(ctx)
  return p.write ? { ...shown(p), apply: freshly(compute, ctx) } : shown(p)
}

// --- JSONL logs -------------------------------------------------------------------------------------

const HEAD = 200
const CHUNK = 1024 * 1024
const TYPE_RE = /^\{"type":"([^"]+)"/

/**
 * Incrementally scan a JSONL file from `offset`, parsing only lines whose
 * leading "type" passes `want`. Huge uninteresting lines are skipped without
 * being buffered. Returns the offset just past the last complete line.
 */
export function scanEvents (file, offset, want, onEvent) {
  let fd
  try { fd = fs.openSync(file, 'r') } catch { return { offset, missing: true } }
  try {
    const size = fs.fstatSync(fd).size
    let reset = false
    if (size < offset) { offset = 0; reset = true }
    const buf = Buffer.alloc(CHUNK)
    let pos = offset
    let lastComplete = offset
    let parts = []
    let partsLen = 0
    let skipping = false
    let decided = false
    const decide = () => {
      const head = Buffer.concat(parts).subarray(0, HEAD).toString('utf8')
      const m = TYPE_RE.exec(head)
      if (!m || !want(m[1])) { skipping = true; parts = []; partsLen = 0 }
      decided = true
    }
    while (pos < size) {
      const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, size - pos), pos)
      if (n <= 0) break
      let i = 0
      while (i < n) {
        let nl = buf.indexOf(10, i)
        if (nl >= n) nl = -1
        const end = nl === -1 ? n : nl
        if (!skipping) {
          parts.push(Buffer.from(buf.subarray(i, end)))
          partsLen += end - i
          if (!decided && partsLen >= HEAD) decide()
        }
        if (nl === -1) { i = n; break }
        if (!skipping) {
          if (!decided) decide()
          if (!skipping) {
            try { onEvent(JSON.parse(Buffer.concat(parts).toString('utf8'))) } catch {}
          }
        }
        parts = []; partsLen = 0; skipping = false; decided = false
        lastComplete = pos + nl + 1
        i = nl + 1
      }
      pos += n
    }
    return { offset: lastComplete, reset }
  } finally {
    fs.closeSync(fd)
  }
}

// --- processes --------------------------------------------------------------------------------------

/** A pid from an environment variable (a positive integer), or null. */
export function envPid (value) {
  const n = Number(value)
  return typeof value === 'string' && /^\d+$/.test(value) && Number.isSafeInteger(n) && n > 0 ? n : null
}

export function pidAlive (pid) {
  try { process.kill(pid, 0); return true } catch (err) { return err.code === 'EPERM' }
}

/**
 * A process's parent pid, or null when it's gone or unknown: /proc on Linux, `ps` (about 15 ms)
 * elsewhere. Never rejects.
 */
export function parentPid (pid) {
  return new Promise((resolve) => {
    if (!Number.isSafeInteger(pid) || pid <= 1 || process.platform === 'win32') return resolve(null)
    const ppid = (v) => { const n = Number(v); return Number.isSafeInteger(n) && n > 1 ? n : null }
    if (process.platform === 'linux') {
      // /proc/<pid>/stat: "pid (comm) state ppid …", and comm may hold spaces or parentheses.
      return fs.readFile(`/proc/${pid}/stat`, 'utf8', (err, text) => resolve(err ? null : ppid(text.slice(text.lastIndexOf(')') + 2).split(' ')[1])))
    }
    execFile('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 }, (err, stdout) => resolve(err ? null : ppid(String(stdout).trim())))
  })
}

/** Process start time in ms (via `ps -o etime`), or null if unknown. */
export function processStartMs (pid, now = Date.now()) {
  if (process.platform === 'win32') return null
  const r = spawnSync('ps', ['-o', 'etime=', '-p', String(pid)], { encoding: 'utf8' })
  const m = /^\s*(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)\s*$/.exec(r.stdout || '')
  if (!m) return null
  const [, d = 0, h = 0, min, s] = m
  return now - ((Number(d) * 24 + Number(h)) * 3600 + Number(min) * 60 + Number(s)) * 1000
}
