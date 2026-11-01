import path from 'node:path'
import { isValidSessionId } from '../paths.js'
import { sanitize } from '../protocol.js'
import { focusOrigin } from '../launcher.js'
import { readJson, writeJson, planned, tilde, exists, isObj, shq, envPid } from './util.js'
import { SERVER, argsFor } from './mcp-config.js'
import { byTrigger, modesOf, originFrom } from './event.js'

// Claude Code. Hooks: command hooks in its user settings, $CLAUDE_CONFIG_DIR/settings.json
// (~/.claude/settings.json), next to the user's own. MCP registration goes through its CLI.
//
// Verified live against Claude Code 2.1.273 on a claude.ai subscription (test/fixtures/claude/):
// - Every payload has session_id, transcript_path, cwd and hook_event_name. permission_mode comes
//   with UserPromptSubmit, PreToolUse, PostToolUse, PermissionRequest, PermissionDenied and Stop,
//   not with SessionStart, Notification, StopFailure or SessionEnd. Manual mode arrives as
//   "default", whether it was asked for as `--permission-mode manual` or `default`.
// - PermissionRequest fires whenever a dialog would ask, AskUserQuestion included. In `claude -p`
//   nobody answers it: the call is denied right away. Notification permission_prompt follows about
//   6 s later with only "Claude needs your permission"; idle_prompt comes a minute after Stop.
// - PermissionDenied fires only when auto mode's classifier refuses a tool call. StopFailure fires
//   when an API error ends the turn (error: rate_limit, overloaded, model_not_found, …).
// - Stop carries last_assistant_message. SessionEnd's reason is prompt_input_exit (/exit, Ctrl+C
//   twice), clear (/clear: a SessionStart with a new session_id follows), other (the end of -p,
//   SIGTERM, SIGHUP), resume or logout.
// - `claude -p` can exit without a SessionEnd when an API error stops it, and kills the StopFailure
//   hook on its way out; a killed process sends nothing. Hooks get CLAUDE_PID: the session ends
//   once that process is gone.
// - Hooks inherit CLAUDE_CODE_SESSION_ATTENDED: 0 for `claude -p` and `claude --bg` sessions
//   (even once you attach to one), 1 in a terminal. CLAUDE_CODE_ENTRYPOINT is sdk-cli for -p,
//   cli otherwise (--bg included).
// - Running sessions pick up changes to settings.json, hooks included.

export const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'PermissionDenied', 'Notification', 'Stop', 'StopFailure', 'SessionEnd']
const MATCHERS = { Notification: 'permission_prompt|idle_prompt|elicitation_dialog' }
// What the hooks call a mode, as Claude Code names it today (`--permission-mode manual`).
const MODE_NAMES = { default: 'manual' }
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

// --- hooks ------------------------------------------------------------------------------------------

export const settingsFile = (ctx) => path.join(ctx.claudeHome, 'settings.json')
const command = (ctx, event) => `${shq(ctx.node)} ${shq(ctx.bin)} hook --harness claude ${event} || true`
const group = (ctx, event) => ({ ...(MATCHERS[event] && { matcher: MATCHERS[event] }), hooks: [{ type: 'command', command: command(ctx, event), timeout: 10 }] })
// Ours, wherever it is and whichever install it runs.
const OURS = /autochat\.js'?\s+hook\s+--harness\s+claude(\s|$)/
const ours = (h) => isObj(h) && typeof h.command === 'string' && OURS.test(h.command)
const hasOurs = (g) => isObj(g) && Array.isArray(g.hooks) && g.hooks.some(ours)

function computeHooks (ctx) {
  const file = settingsFile(ctx)
  const { text, root } = readJson(file)
  const manual = (reason) => ({
    id: 'claude',
    action: 'manual',
    file,
    reason,
    snippet: JSON.stringify({ hooks: Object.fromEntries(HOOK_EVENTS.map(e => [e, [group(ctx, e)]])) }, null, 2)
  })
  if (root === undefined) return manual(`${tilde(file, ctx)} isn't plain JSON (comments?), so autochat won't rewrite it`)
  const next = root ? structuredClone(root) : {}
  if (next.hooks !== undefined && !isObj(next.hooks)) return manual(`"hooks" in ${tilde(file, ctx)} isn't an object`)
  const hooks = next.hooks || {}
  const changed = []
  let had = false
  for (const event of HOOK_EVENTS) {
    const list = hooks[event] ?? []
    if (!Array.isArray(list)) return manual(`"hooks.${event}" in ${tilde(file, ctx)} isn't a list`)
    const want = group(ctx, event)
    const kept = []
    let placed = false
    for (const g of list) {
      if (!hasOurs(g)) { kept.push(g); continue }
      had = true
      const others = g.hooks.filter(h => !ours(h))
      if (!others.length) {
        // Our own group: replaced where it is (a moved install, a new matcher), duplicates dropped.
        if (!placed) kept.push(want)
        placed = true
        continue
      }
      // Our handler, moved into one of the user's groups: updated there.
      const handlers = []
      for (const h of g.hooks) {
        if (!ours(h)) handlers.push(h)
        else if (!placed) { handlers.push(want.hooks[0]); placed = true }
      }
      kept.push({ ...g, hooks: handlers })
    }
    if (!placed) kept.push(want)
    if (JSON.stringify(kept) === JSON.stringify(list)) continue
    hooks[event] = kept
    changed.push(event)
  }
  if (!changed.length) return { id: 'claude', action: 'none', file }
  next.hooks = hooks
  return {
    id: 'claude',
    action: had ? 'update' : 'add',
    file,
    entries: changed.map(e => `${e}${MATCHERS[e] ? ` (${MATCHERS[e]})` : ''}: ${command(ctx, e)}`),
    write: () => writeJson(file, text, next)
  }
}

// Removes our handlers only, then whatever that leaves empty: our groups, then event lists and a
// `hooks` object that held nothing else. Everything else stays byte-for-byte.
function uncomputeHooks (ctx) {
  const file = settingsFile(ctx)
  const { text, root } = readJson(file)
  if (!root || !isObj(root.hooks)) return { id: 'claude', action: 'none', file }
  const next = structuredClone(root)
  const removed = []
  for (const [event, list] of Object.entries(next.hooks)) {
    if (!Array.isArray(list) || !list.some(hasOurs)) continue
    const kept = []
    for (const g of list) {
      if (!hasOurs(g)) { kept.push(g); continue }
      const others = g.hooks.filter(h => !ours(h))
      if (others.length) kept.push({ ...g, hooks: others })
    }
    if (kept.length) next.hooks[event] = kept
    else delete next.hooks[event]
    removed.push(event)
  }
  if (!removed.length) return { id: 'claude', action: 'none', file }
  if (!Object.keys(next.hooks).length) delete next.hooks
  return { id: 'claude', action: 'remove', file, entries: removed.map(e => `${e}: autochat hook --harness claude ${e}`), write: () => writeJson(file, text, next) }
}

const commandPaths = (cmd) => (/^'((?:[^']|'\\'')*)' '((?:[^']|'\\'')*)'/.exec(cmd) || []).slice(1).map(p => p.replace(/'\\''/g, "'"))

function hookStatus (ctx) {
  const file = settingsFile(ctx)
  const { root } = readJson(file)
  const all = root && isObj(root.hooks) ? root.hooks : {}
  const found = HOOK_EVENTS.map(e => (Array.isArray(all[e]) ? all[e] : []).flatMap(g => isObj(g) && Array.isArray(g.hooks) ? g.hooks : []).find(ours)).filter(Boolean)
  return {
    installed: found.length === HOOK_EVENTS.length,
    partial: found.length > 0 && found.length < HOOK_EVENTS.length,
    // The node and autochat.js our hooks run still exist.
    valid: found.every(h => { const p = commandPaths(h.command); return p.length === 2 && p.every(exists) }),
    disabled: root?.disableAllHooks === true,
    file
  }
}

// --- events -----------------------------------------------------------------------------------------

// Nobody attends `claude -p` and `--bg` sessions. null: this Claude Code doesn't say.
export function headless (env) {
  if (env.CLAUDE_CODE_SESSION_ATTENDED === '0') return true
  if (env.CLAUDE_CODE_SESSION_ATTENDED === '1') return false
  if (env.CLAUDE_CODE_ENTRYPOINT === 'sdk-cli') return true
  return env.CLAUDE_CODE_ENTRYPOINT ? false : null
}

const str = (v) => typeof v === 'string' ? v : ''

function describeTool (tool, input) {
  const i = isObj(input) ? input : {}
  const detail = [i.command, i.file_path, i.notebook_path, i.path, i.url, i.pattern, i.query, i.description].find(v => typeof v === 'string' && v)
  return sanitize(detail ? `${tool}: ${detail}` : tool, 600)
}

function describeQuestions (input) {
  const qs = isObj(input) && Array.isArray(input.questions) ? input.questions.filter(isObj) : []
  return sanitize(qs.map((q) => {
    const choices = Array.isArray(q.options) ? q.options.map(o => isObj(o) ? str(o.label) : str(o)).filter(Boolean) : []
    return str(q.question) + (choices.length ? ` [${choices.join(' / ')}]` : '')
  }).filter(Boolean).join(' · '), 600)
}

function editedFiles (tool, input) {
  if (!EDIT_TOOLS.has(tool) || !isObj(input)) return undefined
  const p = [input.file_path, input.notebook_path].find(v => typeof v === 'string' && v)
  return p ? [sanitize(p, 300)] : undefined
}

/** A Claude Code hook payload as a SessionEvent (autonomy is decided by autonomy()). */
export function normalize (event, p, env) {
  if (!isObj(p) || !isValidSessionId(p.session_id)) return null
  const name = str(p.hook_event_name) || event
  const tool = str(p.tool_name)
  const mode = str(p.permission_mode) || null
  const pid = Number(env.CLAUDE_PID)
  const ev = {
    harness: 'claude',
    sid: p.session_id,
    kind: 'notice',
    mode: mode && (MODE_NAMES[mode] ?? mode),
    headless: headless(env),
    cwd: typeof p.cwd === 'string' ? sanitize(p.cwd, 300) : undefined,
    origin: originFrom(env),
    // The Claude Code process. It can go without a SessionEnd (`claude -p` on an API error, a kill).
    pid: Number.isInteger(pid) && pid > 0 ? pid : undefined
  }
  switch (name) {
    case 'SessionStart':
      ev.kind = 'start'
      break
    case 'UserPromptSubmit':
      ev.kind = 'activity'
      break
    case 'PreToolUse':
    case 'PostToolUse':
      if (name === 'PreToolUse' && tool === 'AskUserQuestion') {
        ev.kind = 'request'
        ev.request = { title: 'Claude has a question for you', message: describeQuestions(p.tool_input) }
      } else {
        ev.kind = 'activity'
      }
      ev.files = editedFiles(tool, p.tool_input)
      break
    case 'PermissionRequest':
      ev.kind = 'request'
      ev.request = tool === 'AskUserQuestion'
        ? { title: 'Claude has a question for you', message: describeQuestions(p.tool_input) }
        : { title: 'Permission needed', message: describeTool(tool || 'a tool', p.tool_input) }
      break
    case 'Notification':
      // permission_prompt repeats the PermissionRequest that came before it, with no detail.
      if (p.notification_type === 'permission_prompt') {
        ev.kind = 'request'
        ev.request = { title: 'Permission needed', message: '' }
      } else if (p.notification_type === 'elicitation_dialog') {
        ev.kind = 'request'
        ev.request = { title: 'Claude needs input', message: sanitize(str(p.message), 600) }
      } else if (p.notification_type === 'idle_prompt') {
        ev.kind = 'waiting'
      }
      break
    case 'PermissionDenied':
      // Auto mode's classifier refused a tool call. The agent carries on without it.
      ev.kind = 'failed'
      ev.reason = 'permission_denied'
      ev.summary = sanitize(`Auto mode refused ${describeTool(tool || 'a tool', p.tool_input)}${str(p.reason) ? ` (${p.reason})` : ''}`, 2000)
      break
    case 'Stop':
      ev.kind = 'idle'
      if (str(p.last_assistant_message)) ev.summary = sanitize(p.last_assistant_message, 2000)
      break
    case 'StopFailure':
      // An API error ended its turn: error is rate_limit, overloaded, model_not_found, …
      ev.kind = 'failed'
      ev.stopped = true
      ev.reason = sanitize(str(p.error) || 'unknown', 32)
      ev.summary = sanitize(str(p.last_assistant_message) || str(p.error_details) || ev.reason, 2000)
      break
    case 'SessionEnd':
      ev.kind = 'end'
      ev.reason = sanitize(String(p.reason || 'end'), 32)
      break
  }
  if (!ev.files) delete ev.files
  if (!ev.pid) delete ev.pid
  return ev
}

// `auto`, or nobody attending (headless). When this Claude Code doesn't say whether anyone is
// attending, a mode that doesn't count by itself leaves it unknown.
function autonomy (payload, session) {
  const a = byTrigger(modesOf(session), session.trigger)
  const headlessCounts = Array.isArray(session.trigger) && session.trigger.includes('headless')
  return a === 'interactive' && session.headless === null && headlessCounts ? 'unknown' : a
}

// --- the doorbell -----------------------------------------------------------------------------------

// Verified against Claude Code 2.1.273: hookSpecificOutput.additionalContext from a PostToolUse
// hook reaches the model right after that tool's result ("PostToolUse:<tool> hook additional
// context: …"). Our PostToolUse hook already runs for every tool. Hooks get CLAUDE_PID, the Claude
// Code process, which is also the harness pid in `autochat mcp`'s hello.
const ROOM_TOOL = new RegExp(`^mcp__${SERVER}__`)
const doorbell = {
  event: 'PostToolUse',
  skip: (p) => typeof p.tool_name === 'string' && ROOM_TOOL.test(p.tool_name),
  pid: (env) => envPid(env.CLAUDE_PID),
  output: (text) => JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text } })
}

// --- MCP registration: through its CLI (user scope) ---------------------------------------------------

const mcp = {
  where () { return 'claude mcp (user scope)' },
  // `claude mcp get` prints Command:/Args: lines, and exits 1 when there's no such server.
  status (ctx) {
    const binary = ctx.which('claude')
    if (!binary) return { registered: false }
    const r = ctx.run(binary, ['mcp', 'get', SERVER])
    if (r.status !== 0) return { registered: false }
    const field = (k) => (new RegExp(`^\\s*${k}:[ \\t]*(.*)$`, 'm').exec(r.stdout || '') || [])[1]?.trim() ?? ''
    const command = field('Command')
    const args = field('Args')
    const binPath = (/(\S.*?autochat\.js)(?: |$)/.exec(args) || [])[1]
    return {
      registered: true,
      valid: !!command && exists(command) && !!binPath && exists(binPath) && /(^| )mcp( |$)/.test(args),
      command: `${command} ${args}`.trim(),
      args
    }
  },
  plan (ctx) {
    const binary = ctx.which('claude')
    const want = argsFor('claude', ctx)
    const st = this.status(ctx)
    const current = st.registered && st.command === [ctx.node, ...want].join(' ')
    if (current) return { id: 'claude', action: 'none' }
    const add = ['mcp', 'add', '--scope', 'user', SERVER, '--', ctx.node, ...want]
    return {
      id: 'claude',
      action: st.registered ? 'update' : 'add',
      command: ['claude', ...add],
      apply: () => {
        if (st.registered) ctx.run(binary, ['mcp', 'remove', '--scope', 'user', SERVER])
        const r = ctx.run(binary, add)
        if (r.status !== 0) throw new Error(`claude mcp add failed: ${(r.stderr || r.stdout || '').trim().split('\n')[0]}`)
      }
    }
  },
  unplan (ctx) {
    const binary = ctx.which('claude')
    if (!binary || !this.status(ctx).registered) return { id: 'claude', action: 'none' }
    return {
      id: 'claude',
      action: 'remove',
      command: ['claude', 'mcp', 'remove', '--scope', 'user', SERVER],
      apply: () => {
        const r = ctx.run(binary, ['mcp', 'remove', '--scope', 'user', SERVER])
        if (r.status !== 0) throw new Error(`claude mcp remove failed: ${(r.stderr || r.stdout || '').trim().split('\n')[0]}`)
      }
    }
  }
}

export default {
  id: 'claude',
  name: 'Claude Code',
  modes: ['manual', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions', 'headless'],
  trigger: ['auto', 'headless'],
  detect (ctx) {
    const binary = ctx.which('claude')
    return { installed: !!binary, binary, paths: { settings: settingsFile(ctx) } }
  },
  hooksNote: 'Claude Code picks them up right away, sessions already running included.',
  planHooks: (ctx) => planned(computeHooks, ctx),
  unplanHooks: (ctx) => planned(uncomputeHooks, ctx),
  hookStatus,
  normalize,
  autonomy,
  doorbell,
  focus: focusOrigin,
  mcp
}
