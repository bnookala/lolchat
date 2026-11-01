import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { copilotHome, sessionEventsPath, sessionDir, cacheDir, ensureDir, isValidSessionId } from '../paths.js'
import { sanitize } from '../protocol.js'
import { focusOrigin } from '../launcher.js'
import { harnessContext, readText, planned, scanEvents, pidAlive, shq, psq } from './util.js'
import { jsonServer, detectBy, child, argsFor, SERVER } from './mcp-config.js'
import { byTrigger, defaultAutonomy, originFrom } from './event.js'

// Copilot CLI. Hooks: $COPILOT_HOME/hooks/autochat.json, a file of our own. Its mode (autopilot,
// interactive, plan) comes from the session log, $COPILOT_HOME/session-state/<id>/events.jsonl,
// which also reports completions and aborts that no hook sees. Sessions whose process started
// before the hooks were installed never call them: observe() finds those in session-state.

export const HOOK_EVENTS = ['sessionStart', 'userPromptSubmitted', 'preToolUse', 'postToolUse', 'agentStop', 'notification', 'sessionEnd']
const REQUEST_NOTIFICATIONS = new Set(['permission_prompt', 'elicitation_dialog'])

// --- hooks ------------------------------------------------------------------------------------------

export const hooksFile = (ctx = harnessContext()) => path.join(ctx.copilotHome, 'hooks', 'autochat.json')
// Written by versions from before the lolchat → autochat rename; it runs the old CLI.
export const legacyHooksFile = (ctx = harnessContext()) => path.join(ctx.copilotHome, 'hooks', 'lolchat.json')

// `autochat hook <event>` without --harness means Copilot: that's what these have always run.
function entry (ctx, event, extra = {}) {
  // `|| true` matters: preToolUse command hooks are fail-closed.
  return {
    type: 'command',
    bash: `${shq(ctx.node)} ${shq(ctx.bin)} hook ${event} || true`,
    powershell: `& ${psq(ctx.node)} ${psq(ctx.bin)} hook ${event}; exit 0`,
    timeoutSec: 10,
    ...extra
  }
}

export function buildHooksConfig (ctx = harnessContext()) {
  return {
    version: 1,
    hooks: {
      userPromptSubmitted: [entry(ctx, 'userPromptSubmitted')],
      // preToolUse fires before every tool (so the room opens right away, even when the
      // first tool runs for minutes); postToolUse is only needed to catch task_complete.
      preToolUse: [entry(ctx, 'preToolUse')],
      postToolUse: [entry(ctx, 'postToolUse', { matcher: 'task_complete' })],
      notification: [entry(ctx, 'notification', { matcher: 'permission_prompt|elicitation_dialog' })],
      agentStop: [entry(ctx, 'agentStop')],
      sessionEnd: [entry(ctx, 'sessionEnd')]
    }
  }
}

function computeHooks (ctx) {
  const file = hooksFile(ctx)
  const next = JSON.stringify(buildHooksConfig(ctx), null, 2) + '\n'
  const prev = readText(file)
  // Keep the mtime when nothing changed: doctor compares it with Copilot process start times.
  if (prev === next) return { id: 'copilot', action: 'none', file }
  return {
    id: 'copilot',
    action: prev === null ? 'add' : 'update',
    file,
    write: () => {
      ensureDir(path.dirname(file))
      fs.writeFileSync(file, next)
    }
  }
}

export function installHooks (ctx = harnessContext()) {
  planned(computeHooks, ctx).apply?.()
  return hooksFile(ctx)
}

export function hooksInstalledAt (ctx = harnessContext()) {
  try { return fs.statSync(hooksFile(ctx)).mtimeMs } catch { return null }
}

const unlink = (file) => { try { fs.unlinkSync(file); return true } catch { return false } }

export const removeLegacyHooks = (ctx = harnessContext()) => unlink(legacyHooksFile(ctx))
export const legacyHooksInstalled = (ctx = harnessContext()) => fs.existsSync(legacyHooksFile(ctx))

export function uninstallHooks (ctx = harnessContext()) {
  const removed = unlink(hooksFile(ctx))
  return removeLegacyHooks(ctx) || removed
}

export function hooksInstalled (ctx = harnessContext()) {
  try {
    const cfg = JSON.parse(fs.readFileSync(hooksFile(ctx), 'utf8'))
    return JSON.stringify(cfg).includes(ctx.bin.replace(/\\/g, '\\\\'))
  } catch { return false }
}

// --- events -----------------------------------------------------------------------------------------

function describeQuestion (args) {
  if (!args || typeof args !== 'object') return ''
  let text = args.question || args.message || ''
  if (Array.isArray(args.choices) && args.choices.length) text += ' [' + args.choices.join(' / ') + ']'
  const props = args.requestedSchema?.properties
  if (props && typeof props === 'object') {
    const fields = Object.values(props).filter(p => p && p.title).map(p => Array.isArray(p.enum) ? `${p.title}: ${p.enum.join(' / ')}` : p.title)
    if (fields.length) text += ' (' + fields.join(', ') + ')'
  }
  return text
}

function parseArgs (a) {
  if (typeof a === 'string') { try { return JSON.parse(a) } catch { return { question: a } } }
  return a
}

// Real CLI payloads differ from the docs: preToolUse batches `toolCalls: [{name, args}]`
// and notifications use `notificationType`. Accept every shape we've seen.
function toolCalls (p) {
  if (Array.isArray(p.toolCalls)) return p.toolCalls.filter(c => c && typeof c === 'object').map(c => ({ name: c.name || c.toolName, args: parseArgs(c.args ?? c.arguments ?? c.toolArgs) }))
  const name = p.toolName || p.tool_name
  return name ? [{ name, args: parseArgs(p.toolArgs ?? p.tool_input) }] : []
}

/** A Copilot hook payload as a SessionEvent (autonomy is decided by autonomy()). */
export function normalize (event, p, env) {
  const sid = p.sessionId || p.session_id || env.COPILOT_AGENT_SESSION_ID
  if (!isValidSessionId(sid)) return null
  const calls = toolCalls(p)
  const find = (n) => calls.find(c => c.name === n)
  const ev = {
    harness: 'copilot',
    sid,
    kind: 'notice',
    mode: quickMode(sid),
    cwd: typeof p.cwd === 'string' ? sanitize(p.cwd, 300) : undefined,
    origin: originFrom(env)
  }
  switch (event) {
    case 'userPromptSubmitted':
    case 'UserPromptSubmit':
      ev.kind = 'activity'
      break
    case 'postToolUse':
    case 'PostToolUse':
    case 'preToolUse':
    case 'PreToolUse': {
      const done = find('task_complete')
      const ask = find('ask_user')
      if (done && /^post/i.test(event)) {
        ev.kind = 'complete'
        ev.summary = sanitize(done.args?.summary || '', 2000)
      } else if (ask && /^pre/i.test(event)) {
        ev.kind = 'request'
        ev.request = { title: 'Copilot has a question for you', message: sanitize(describeQuestion(ask.args), 600) }
      } else {
        ev.kind = 'activity'
      }
      break
    }
    case 'notification':
    case 'Notification': {
      const t = p.notification_type || p.notificationType
      if (REQUEST_NOTIFICATIONS.has(t)) {
        ev.kind = 'request'
        ev.request = {
          title: sanitize(p.title || (t === 'permission_prompt' ? 'Permission needed' : 'Copilot needs input'), 80),
          message: sanitize(p.message || '', 600)
        }
      }
      break
    }
    case 'agentStop':
    case 'Stop':
      ev.kind = 'idle'
      break
    case 'sessionEnd':
    case 'SessionEnd':
      ev.kind = 'end'
      ev.reason = sanitize(String(p.reason || 'end'), 32)
      break
  }
  return ev
}

// --- the doorbell -----------------------------------------------------------------------------------

// Verified against Copilot CLI 1.0.102: a command hook that prints {"additionalContext": "…"} for
// preToolUse gets it to the model as a user message right after that tool's result ("Additional
// context from preToolUse hook: …"). postToolUse appends it to the result itself, but our
// postToolUse only runs for task_complete: preToolUse already runs for every tool, so ringing there
// costs one socket round trip and no extra process. task_complete ends an autopilot run, so a line
// after it would never be read.
const ROOM_TOOL = new RegExp(`^${SERVER}-`)
const doorbell = {
  event: 'preToolUse',
  skip: (p) => toolCalls(p).some(c => typeof c.name === 'string' && (ROOM_TOOL.test(c.name) || c.name === 'task_complete')),
  output: (text) => JSON.stringify({ additionalContext: text })
}

// --- the session log --------------------------------------------------------------------------------

/**
 * Current agent mode of a Copilot CLI session ("interactive" | "plan" | "autopilot" | null),
 * cached per session so hooks firing on every tool call only read appended bytes.
 */
export function quickMode (sessionId) {
  if (!isValidSessionId(sessionId)) return null
  const file = sessionEventsPath(sessionId)
  const cacheFile = path.join(cacheDir(), sessionId + '.json')
  let cache = { offset: 0, mode: null }
  try { cache = { ...cache, ...JSON.parse(fs.readFileSync(cacheFile, 'utf8')) } } catch {}
  let mode = cache.mode
  const res = scanEvents(file, cache.offset, (t) => t === 'session.mode_changed', (e) => {
    if (typeof e.data?.newMode === 'string') mode = e.data.newMode
  })
  if (res.missing) return null
  if (res.reset) {
    // File shrank (rewritten); rescan from scratch.
    mode = null
    scanEvents(file, 0, (t) => t === 'session.mode_changed', (e) => { mode = e.data?.newMode ?? mode })
  }
  try {
    ensureDir(cacheDir())
    fs.writeFileSync(cacheFile, JSON.stringify({ offset: res.offset, mode }))
  } catch {}
  return mode
}

export function objectiveStatus (sessionId) {
  if (!isValidSessionId(sessionId)) return null
  try {
    const o = JSON.parse(fs.readFileSync(path.join(sessionDir(sessionId), 'autopilot-objective.json'), 'utf8'))
    return o?.current?.status ?? null
  } catch { return null }
}

const WATCHED = new Set([
  'session.mode_changed', 'session.task_complete', 'abort', 'session.shutdown',
  'assistant.turn_start', 'user.message', 'session.autopilot_objective_changed'
])

/**
 * Tails a session's events.jsonl. The initial scan only establishes current mode;
 * lifecycle events are emitted for lines appended after start().
 * Events: mode(newMode), task-complete({summary}), abort(reason), shutdown, activity(type)
 */
export class SessionLog extends EventEmitter {
  constructor (sessionId, { pollMs = 1000 } = {}) {
    super()
    this.sessionId = sessionId
    this.file = sessionEventsPath(sessionId)
    this.pollMs = pollMs
    this.offset = 0
    this.mode = null
    this.timer = null
  }

  /** `since` (ms): also replay lifecycle events logged at or after this time. */
  start ({ since = Infinity } = {}) {
    const replay = []
    const res = scanEvents(this.file, 0, (t) => t === 'session.mode_changed' || (since !== Infinity && WATCHED.has(t)), (e) => {
      if (e.type === 'session.mode_changed' && typeof e.data?.newMode === 'string') this.mode = e.data.newMode
      if (since !== Infinity && Date.parse(e.timestamp) >= since) replay.push(e)
    })
    this.offset = res.offset
    const startMode = this.mode
    this.mode = null
    for (const e of replay) this._event(e)
    this.mode = startMode
    this.timer = setInterval(() => this.poll(), this.pollMs)
    this.timer.unref?.()
    return this
  }

  poll () {
    const res = scanEvents(this.file, this.offset, (t) => WATCHED.has(t), (e) => this._event(e))
    if (!res.missing) this.offset = res.offset
  }

  _event (e) {
    const d = e.data || {}
    switch (e.type) {
      case 'session.mode_changed':
        if (typeof d.newMode === 'string' && d.newMode !== this.mode) {
          this.mode = d.newMode
          this.emit('mode', d.newMode)
        }
        break
      case 'session.task_complete':
        this.emit('task-complete', { summary: typeof d.summary === 'string' ? sanitize(d.summary, 2000) : '' })
        break
      case 'abort':
        this.emit('abort', d.reason || 'abort')
        break
      case 'session.shutdown':
        this.emit('shutdown')
        break
      case 'session.autopilot_objective_changed':
        this.emit('objective', d.status)
        break
      default:
        this.emit('activity', e.type)
    }
  }

  stop () {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}

// --- the session-state scan -------------------------------------------------------------------------

// Hooks are loaded once when a Copilot CLI process starts, so sessions that were already
// running when `autochat setup` ran never call us. This finds them from session-state instead.

const TAIL = 512 * 1024
const START = new Set(['user.message', 'assistant.turn_start'])
const STOP = new Set(['session.task_complete', 'abort', 'session.shutdown'])
const END = 'assistant.turn_end'

function lockPid (dir) {
  let names = []
  try { names = fs.readdirSync(dir) } catch { return null }
  for (const n of names) {
    const m = /^inuse\.(\d+)\.lock$/.exec(n)
    if (m) return Number(m[1])
  }
  return null
}

function workspaceCwd (dir) {
  try {
    const m = /^cwd: (.+)$/m.exec(fs.readFileSync(path.join(dir, 'workspace.yaml'), 'utf8'))
    return m ? sanitize(m[1].replace(/^["']|["']$/g, ''), 300) : undefined
  } catch { return undefined }
}

/** Latest start / stop / turn-end timestamps from the tail of a session log. */
export function lifecycle (file) {
  let size
  try { size = fs.statSync(file).size } catch { return null }
  const lc = { lastStart: 0, lastStop: 0, lastEnd: 0 }
  scanEvents(file, Math.max(0, size - TAIL), (t) => START.has(t) || STOP.has(t) || t === END, (e) => {
    const ts = Date.parse(e.timestamp) || 0
    if (START.has(e.type)) lc.lastStart = Math.max(lc.lastStart, ts)
    else if (STOP.has(e.type)) lc.lastStop = Math.max(lc.lastStop, ts)
    else lc.lastEnd = Math.max(lc.lastEnd, ts)
  })
  return lc
}

/**
 * Copilot sessions whose process is alive and whose log changed within `windowMs`.
 * `running` = in a mode that counts (`trigger`, by default autopilot), working on something since
 * the last completion/abort, and not sitting idle after its final turn for longer than `idleMs`.
 */
export function liveSessions ({ idleMs = 45000, windowMs = 30 * 60 * 1000, now = Date.now(), trigger = adapter.trigger } = {}) {
  const root = path.join(copilotHome(), 'session-state')
  let dirs = []
  try { dirs = fs.readdirSync(root) } catch { return [] }
  const out = []
  for (const sid of dirs) {
    if (!isValidSessionId(sid)) continue
    const dir = path.join(root, sid)
    const file = path.join(dir, 'events.jsonl')
    let mtime
    try { mtime = fs.statSync(file).mtimeMs } catch { continue }
    if (now - mtime > windowMs) continue
    const pid = lockPid(dir)
    if (!pid || !pidAlive(pid)) continue
    const mode = quickMode(sid)
    const lc = lifecycle(file) || { lastStart: 0, lastStop: 0, lastEnd: 0 }
    const working = lc.lastStart > lc.lastStop
    const idle = lc.lastEnd > lc.lastStart && now - mtime > idleMs
    const autonomous = byTrigger(mode ? [mode] : [], trigger) === 'autonomous'
    out.push({ sid, pid, mode, cwd: workspaceCwd(dir), mtime, ...lc, running: autonomous && working && !idle, scannedAt: now })
  }
  return out
}

// --- the adapter ------------------------------------------------------------------------------------

const server = jsonServer({
  id: 'copilot',
  file: (ctx) => path.join(ctx.copilotHome, 'mcp-config.json'),
  servers: (root, create) => child(root, 'mcpServers', create),
  entry: (ctx) => ({ type: 'local', command: ctx.node, args: argsFor('copilot', ctx), tools: ['*'] })
})

// Copilot CLI puts a server's instructions in the system prompt only for the servers on its
// allowlist, or with --allow-all-mcp-server-instructions. In 1.0.102 the allowlist is built in
// (github-mcp-server, bluebird, computer-use), and nothing persistent adds to it: no config key,
// environment variable or `mcp add` option. So setup can't, and doctor says how instead.
const ETIQUETTE_STATUS = {
  shown: null,
  note: "autochat's instructions reach the model only when Copilot CLI runs with --allow-all-mcp-server-instructions (its allowlist is built in, and no setting adds to it); without it, Copilot agents get the tool descriptions alone. To always pass it: alias copilot='copilot --allow-all-mcp-server-instructions'"
}

const mcp = {
  ...server,
  status (ctx) {
    const st = server.status(ctx)
    return st.registered ? { ...st, etiquette: ETIQUETTE_STATUS } : st
  }
}

const adapter = {
  id: 'copilot',
  name: 'Copilot CLI',
  modes: ['interactive', 'plan', 'autopilot'],
  trigger: ['autopilot'],
  detect (ctx) {
    return { ...detectBy('copilot', mcp.file)(ctx), paths: { hooks: hooksFile(ctx), mcp: mcp.file(ctx), sessions: path.join(ctx.copilotHome, 'session-state') } }
  },
  hooksNote: 'New Copilot CLI sessions pick up the hooks; ones already running keep what they started with (autochat doctor lists them).',
  planHooks: (ctx) => planned(computeHooks, ctx),
  unplanHooks (ctx) {
    const files = [hooksFile(ctx), legacyHooksFile(ctx)].filter(f => fs.existsSync(f))
    if (!files.length) return { id: 'copilot', action: 'none', file: hooksFile(ctx) }
    return { id: 'copilot', action: 'remove', file: hooksFile(ctx), apply: () => { for (const f of files) unlink(f) } }
  },
  hookStatus: (ctx) => ({ installed: hooksInstalled(ctx), file: hooksFile(ctx), legacy: legacyHooksInstalled(ctx) ? legacyHooksFile(ctx) : null }),
  normalize,
  autonomy: defaultAutonomy,
  doorbell,
  // An active autopilot objective keeps a stopped session in the room.
  continues: (session) => objectiveStatus(session.sid) === 'active',
  follow: (sid) => new SessionLog(sid),
  observe (ctx, emit) {
    const scan = () => { try { emit(liveSessions({ idleMs: ctx.idleMs, trigger: ctx.trigger ? ctx.trigger('copilot') : adapter.trigger })) } catch {} }
    scan()
    const timer = setInterval(scan, ctx.intervalMs ?? 3000)
    timer.unref?.()
    return () => clearInterval(timer)
  },
  focus: focusOrigin,
  mcp
}

export default adapter
