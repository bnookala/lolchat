import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync, execFile } from 'node:child_process'
import { isValidSessionId } from '../paths.js'
import { envVar } from '../env.js'
import { sanitize } from '../text.js'
import { findSecret } from '../secrets.js'

// The session binding: which harness runs us (its process, its session id), the git facts for
// the agent's hello and card, and the paths it touches (auto paths for `status`).

export const HARNESSES = ['copilot', 'claude', 'codex', 'opencode', 'gemini', 'pi']

const PACKAGE_HINTS = [
  ['copilot', /@github\/copilot\b/],
  ['claude', /@anthropic-ai\/claude-code\b|\/claude\/versions\//],
  ['codex', /@openai\/codex\b/],
  ['opencode', /\bopencode-ai\b/],
  ['gemini', /@google\/gemini-cli\b/],
  ['pi', /\bpi-coding-agent\b/]
]
const ENV_HINTS = [['claude', 'CLAUDECODE'], ['gemini', 'GEMINI_CLI'], ['opencode', 'OPENCODE'], ['codex', 'CODEX_SANDBOX'], ['codex', 'CODEX_MANAGED_BY_NPM']]
const SESSION_ENV = {
  copilot: ['COPILOT_AGENT_SESSION_ID'],
  claude: ['CLAUDE_CODE_SESSION_ID', 'CLAUDE_SESSION_ID'],
  codex: ['CODEX_SESSION_ID'],
  opencode: ['OPENCODE_SESSION_ID'],
  gemini: ['GEMINI_SESSION_ID'],
  pi: ['PI_SESSION_ID']
}

/** Which harness a process command line belongs to, or null. */
export function matchHarness (command) {
  if (typeof command !== 'string') return null
  for (const token of command.trim().split(/\s+/).slice(0, 3)) {
    const base = path.basename(token).replace(/\.(?:c?js|mjs|exe)$/i, '').toLowerCase()
    if (HARNESSES.includes(base)) return base
  }
  for (const [harness, re] of PACKAGE_HINTS) if (re.test(command)) return harness
  return null
}

// pid → {ppid, command} for every process, from one `ps` call.
export function psTable () {
  if (process.platform === 'win32') return new Map()
  const r = spawnSync('ps', ['-A', '-ww', '-o', 'pid=,ppid=,command='], { encoding: 'utf8', timeout: 3000, maxBuffer: 32 * 1024 * 1024 })
  const table = new Map()
  for (const line of (r.stdout || '').split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (m) table.set(Number(m[1]), { ppid: Number(m[2]), command: m[3] })
  }
  return table
}

function ancestors (table, pid) {
  const out = []
  let p = table.get(pid)?.ppid
  while (p && p > 1 && out.length < 16 && !out.some(a => a.pid === p)) {
    const row = table.get(p)
    if (!row) break
    out.push({ pid: p, command: row.command })
    p = row.ppid
  }
  return out
}

function processCwd (pid) {
  try {
    if (process.platform === 'linux') return fs.readlinkSync(`/proc/${pid}/cwd`)
    if (process.platform === 'darwin') {
      const r = spawnSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8', timeout: 3000 })
      const line = (r.stdout || '').split('\n').find(l => l.startsWith('n'))
      return line ? line.slice(1) : null
    }
  } catch {}
  return null
}

function git (cwd, args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] })
  return r.status === 0 ? r.stdout.replace(/\n$/, '') : null
}

function gitAsync (cwd, args, env = process.env) {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024 * 1024, env }, (err, stdout) => resolve(err ? null : stdout))
  })
}

/** "owner/repo" from a git remote URL (https, ssh, scp-like), or null. */
export function parseRemote (url) {
  if (typeof url !== 'string' || !url.trim()) return null
  const parts = url.trim().replace(/\/+$/, '').replace(/\.git$/, '').split(/[/:]/).filter(Boolean)
  if (parts.length < 2) return null
  const repo = parts.slice(-2).join('/')
  return /^[\w.-]+\/[\w.-]+$/.test(repo) ? repo : null
}

/**
 * Git facts for the agent's card. repo is `origin` as owner/repo (then any other remote, then
 * `local/<repository directory>` for repos without remotes, so worktrees of one local repo
 * still overlap). All null outside git.
 */
export function gitInfo (cwd) {
  const top = git(cwd, ['rev-parse', '--show-toplevel'])
  if (!top) return { top: null, repo: null, branch: null, worktree: null }
  let repo = parseRemote(git(top, ['remote', 'get-url', 'origin']))
  if (!repo) {
    const first = (git(top, ['remote']) || '').split('\n').find(Boolean)
    if (first) repo = parseRemote(git(top, ['remote', 'get-url', first]))
  }
  if (!repo) {
    const common = git(top, ['rev-parse', '--git-common-dir'])
    if (common) {
      const dir = path.resolve(top, common)
      const main = path.basename(dir) === '.git' ? path.dirname(dir) : dir
      const name = path.basename(main).replace(/\.git$/, '').replace(/[^\w.-]+/g, '-')
      if (name) repo = 'local/' + name
    }
  }
  const branch = git(top, ['rev-parse', '--abbrev-ref', 'HEAD'])
  return { top, repo, branch: branch && branch !== 'HEAD' ? branch : null, worktree: path.basename(top) }
}

// A double-quoted YAML scalar's escapes.
const YAML_ESCAPES = { 0: '\0', a: '\x07', b: '\b', t: '\t', n: '\n', v: '\v', f: '\f', r: '\r', e: '\x1b', N: '\x85', _: '\xa0', L: '\u2028', P: '\u2029' }

/** A top-level one-line YAML string (plain, 'single' or "double" quoted), or null. */
export function yamlField (text, key) {
  const m = new RegExp(`^${key}:[ \\t]+(.*?)\\r?$`, 'm').exec(typeof text === 'string' ? text : '')
  const v = m ? m[1].trim() : ''
  if (v.startsWith('"')) {
    const q = /^"((?:[^"\\]|\\.)*)"/.exec(v)
    return q ? q[1].replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (_, e) => e.length > 1 ? String.fromCodePoint(parseInt(e.slice(1), 16)) : (YAML_ESCAPES[e] ?? e)) : null
  }
  if (v.startsWith("'")) {
    const q = /^'((?:[^']|'')*)'/.exec(v)
    return q ? q[1].replace(/''/g, "'") : null
  }
  const plain = v.replace(/\s#.*$/, '').trim()
  return !plain || /^[|>~]|^null$/i.test(plain) ? null : plain
}

/** A session title for the hello: one line, at most 80 characters; null if it looks like a secret. */
export function titleLine (title) {
  const clean = sanitize(typeof title === 'string' ? title : '', 80)
  return clean && !findSecret(clean) ? clean : null
}

/**
 * The harness's title for this session, where one is cheap and reliable to read: Copilot's session
 * name, `name:` in its session's workspace.yaml. pi's comes from its extension. What the other
 * harnesses expose is in docs/agents.md ("Who it is").
 */
export function sessionTitle ({ harness, sessionId = null, env = process.env }) {
  if (harness !== 'copilot' || !isValidSessionId(sessionId)) return null
  const home = env.COPILOT_HOME || path.join(os.homedir(), '.copilot')
  try {
    return titleLine(yamlField(fs.readFileSync(path.join(home, 'session-state', sessionId, 'workspace.yaml'), 'utf8'), 'name'))
  } catch {
    return null
  }
}

/** The agent-hello line (docs/agent-room/hello.md): who the agent is and where it works. */
export function agentHello ({ harness, pid, harnessPid = null, sessionId = null, cwd, git: g = gitInfo(cwd), env = process.env, title = null }) {
  return {
    type: 'agent-hello',
    v: 1,
    harness,
    name: envVar('AGENT_NAME', env) || null,
    pid,
    harnessPid,
    sessionId,
    cwd,
    repo: g.repo,
    branch: g.branch,
    worktree: g.worktree,
    title,
    resume: null
  }
}

/**
 * Who we are: harness (--harness, else the nearest harness among our ancestor processes, else
 * env hints, else "agent"), the harness pid, its session id when the env exposes one, its title
 * when we can read it, and the git facts. Builds the agent-hello line.
 */
export function bindSession ({ harness: flag = null, env = process.env, cwd = process.cwd(), ps = psTable, pid = process.pid } = {}) {
  let harness = flag ? String(flag).toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 20) : null
  let harnessPid = null
  let chain = []
  try { chain = ancestors(ps(), pid) } catch {}
  for (const a of chain) {
    const h = matchHarness(a.command)
    if (h && (!harness || h === harness)) {
      harness = harness || h
      harnessPid = a.pid
      break
    }
  }
  if (!harness) harness = ENV_HINTS.find(([, k]) => env[k])?.[0] || 'agent'
  const sessionId = (SESSION_ENV[harness] || []).map(k => env[k]).find(isValidSessionId) || null
  // Some harnesses start MCP servers in $HOME or /: use the harness's own directory then.
  if (harnessPid && (cwd === os.homedir() || cwd === '/')) cwd = processCwd(harnessPid) || cwd
  const g = gitInfo(cwd)
  // Sessions often get their title after the harness starts us: the status tool reads it again.
  const readTitle = () => sessionTitle({ harness, sessionId, env })
  return {
    harness,
    harnessPid,
    sessionId,
    cwd,
    top: g.top,
    readTitle,
    hello: agentHello({ harness, pid, harnessPid, sessionId, cwd, git: g, env, title: readTitle() })
  }
}

async function defaultBranchBase (top, git = gitAsync) {
  const head = await git(top, ['rev-parse', '--abbrev-ref', 'HEAD'])
  let base = (await git(top, ['rev-parse', '--abbrev-ref', 'origin/HEAD']))?.trim()
  if (!base) {
    for (const b of ['main', 'master', 'trunk']) {
      if (await git(top, ['rev-parse', '--verify', '--quiet', 'refs/heads/' + b]) !== null) { base = b; break }
    }
  }
  const branch = head?.trim()
  if (!base || !branch || branch === 'HEAD' || base === branch || base === 'origin/' + branch) return null
  return (await git(top, ['merge-base', 'HEAD', base]))?.trim() || null
}

/**
 * Repo-relative paths this worktree touches: `git status --porcelain` (including untracked
 * files and both sides of renames), plus what the branch changed since it forked from the
 * default branch (both sides of renames too), so committing doesn't make an overlap disappear.
 */
export async function changedPaths (top) {
  const out = []
  const status = await gitAsync(top, ['status', '--porcelain=v1', '-z', '--untracked-files=normal'])
  const parts = (status || '').split('\0')
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]
    if (entry.length < 4) continue
    out.push(entry.slice(3))
    if (/^[RC]/.test(entry)) out.push(parts[++i])
  }
  const base = await defaultBranchBase(top)
  if (base) {
    const diff = await gitAsync(top, ['diff', '--no-renames', '--name-only', '-z', base])
    out.push(...(diff || '').split('\0'))
  }
  return out.filter(Boolean)
}

export function repoRelative (p, cwd, top) {
  if (typeof p !== 'string' || !p.trim()) return null
  if (!top) return p
  const rel = path.relative(top, path.resolve(cwd, p))
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null
  return rel.split(path.sep).join('/')
}

// --- live paths (#56) -------------------------------------------------------------------------

/**
 * `git status --porcelain=v2 -z --branch`: the HEAD commit (null before the first commit), and the
 * paths it lists, repo-relative: changed, staged, unmerged and untracked files, and both sides of
 * renames and copies.
 */
export function parseStatusV2 (out) {
  let oid = null
  const paths = []
  const parts = (out || '').split('\0')
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]
    if (entry.startsWith('# branch.oid ')) {
      const v = entry.slice(13)
      oid = /^[0-9a-f]{7,64}$/.test(v) ? v : null
      continue
    }
    // How many space-separated fields come before the path.
    const fields = { 1: 8, 2: 9, u: 10, '?': 1 }[entry[0]]
    if (!fields || entry[1] !== ' ') continue
    paths.push(entry.split(' ').slice(fields).join(' '))
    if (entry[0] === '2') paths.push(parts[++i])
  }
  return { oid, paths: paths.filter(Boolean) }
}

/**
 * The live paths of a worktree, for the `paths` command: the same files as status()'s auto paths
 * (changedPaths), but cheaper to ask for every few seconds. Each call runs one `git status`; the
 * branch's changes against the default branch are cached per HEAD commit (and for at most
 * maxAgeMs). It never takes git's index lock (GIT_OPTIONAL_LOCKS=0), so it can't get in the way of
 * the agent's own git commands. Resolves to null when git fails.
 */
export function livePaths (top, { git = gitAsync, now = Date.now, maxAgeMs = 5 * 60 * 1000 } = {}) {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
  const run = (cwd, args) => git(cwd, args, env)
  let committed = null
  return async () => {
    const status = await run(top, ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=normal'])
    if (status === null) return null
    const { oid, paths } = parseStatusV2(status)
    if (!committed || committed.oid !== oid || now() - committed.at > maxAgeMs) {
      const base = oid ? await defaultBranchBase(top, run) : null
      const diff = base ? await run(top, ['diff', '--no-renames', '--name-only', '-z', base, oid]) : ''
      if (diff === null) return null
      committed = { oid, at: now(), paths: diff.split('\0').filter(Boolean) }
    }
    return [...new Set([...paths, ...committed.paths])]
  }
}

export const AGENT_PATHS_MS = 15000

/**
 * Keeps the agent's live paths (its card's focus.live) current while the link is connected, so
 * overlaps show up without a new status (#56). It checks every intervalMs (AUTOCHAT_AGENT_PATHS_MS,
 * default 15 s; 0 turns it off), and after a tool call (poke) when the last check is at least that
 * old. A check reads the live paths and sends `paths` only when they changed since the last send,
 * or after a (re)connect. A check never starts while the previous one still runs.
 */
export function syncLivePaths ({ link, top, env = process.env, intervalMs = null, read = null, now = Date.now, log = () => {} }) {
  const fromEnv = envVar('AGENT_PATHS_MS', env)
  const every = intervalMs ?? (fromEnv !== undefined && fromEnv !== '' && Number(fromEnv) >= 0 ? Number(fromEnv) : AGENT_PATHS_MS)
  read = read || (top ? livePaths(top) : null)
  let timer = null
  let running = false
  let lastCheck = -Infinity
  let sent = null
  let unsupported = false
  let stopped = !read || !(every > 0)
  const halt = () => { clearInterval(timer); timer = null }
  const stop = () => { stopped = true; halt() }
  const check = async () => {
    if (link.closed) stop()
    if (stopped || unsupported || running || !link.connected) return
    running = true
    lastCheck = now()
    try {
      const paths = await read()
      if (!paths) return
      const list = [...new Set(paths)].filter(p => p.length <= 300).slice(0, 200)
      const key = JSON.stringify(list)
      // Never wait for (or wake) the daemon from here: only a live connection gets a `paths`.
      if (key === sent || stopped || !link.connected) return
      const reply = await link.request('paths', { paths: list })
      if (reply.ok) {
        sent = key
        log(`live paths: ${list.length} sent, ${reply.result?.overlaps?.length ?? 0} overlaps`)
      } else if (reply.error === 'unknown command') {
        // An older daemon: try again after the next connect.
        unsupported = true
        halt()
      }
    } catch (err) {
      log(`live paths: ${err.message}`)
    } finally {
      running = false
    }
  }
  if (!stopped) {
    link.on('connected', () => {
      sent = null
      unsupported = false
      if (!timer && !stopped) {
        timer = setInterval(check, every)
        timer.unref?.()
      }
      check()
    })
    link.on('disconnected', halt)
  }
  return {
    check,
    poke: () => { if (now() - lastCheck >= every) check() },
    stop
  }
}
