import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { isValidSessionId } from '../paths.js'
import { sanitize } from '../protocol.js'
import { focusOrigin } from '../launcher.js'
import { readText, readJson, writeJson, writeFileSafely, planned, tilde, exists, isDir, isObj, same, shq } from './util.js'
import { argsFor, commandValid, SERVER } from './mcp-config.js'
import { byTrigger, modesOf, originFrom } from './event.js'

// Codex CLI. Hooks: $CODEX_HOME/hooks.json (~/.codex), one matcher group of ours per event, next
// to the user's own. MCP servers: [mcp_servers.autochat] in $CODEX_HOME/config.toml, a TOML table
// edited as text so comments and formatting survive.
//
// Verified against Codex 0.166.0 (docs/harnesses.md#codex; the payloads are in
// test/fixtures/codex/):
// - hooks.json is {"description"?, "hooks": {<Event>: [{matcher?, hooks: [{type: "command",
//   command, timeout?, async?, statusMessage?}]}]}}. Another top-level key and Codex drops the
//   whole file. Commands run as `<your account's shell> -c <command>` (not a login shell, and not
//   $SHELL), in the session's cwd, with the JSON on stdin. Exit 0 with nothing on stdout is a
//   success.
// - Codex runs a hook only once you've trusted its exact definition (/hooks in Codex), and records
//   that in config.toml, by file, event and position: see trustHash(). codex exec skips untrusted
//   hooks without a word.
// - Every payload has session_id, transcript_path (null with --ephemeral), cwd and
//   hook_event_name; all but SessionEnd have permission_mode, from the approval policy alone:
//   bypassPermissions for `never` (which codex exec forces), default for every policy that asks.
// - Nothing in a payload says `codex exec`. The session's rollout (transcript_path) does: its
//   first line is the session_meta, with source "exec" (originator "codex_exec"). The TUI's is
//   "vscode" (through its app-server daemon, the default) or "cli" (--no-daemon). Each turn's
//   turn_context line there has its collaboration mode and approvals reviewer.
// - Subagents' hooks carry the parent's session_id, plus agent_id, and their own rollout.

const TOML_HEADER = /^\s*\[\s*mcp_servers\s*\.\s*(?:autochat|"autochat"|'autochat')\s*(\.[^\]]*)?\]\s*(?:#.*)?$/
const ANY_HEADER = /^\s*\[/
const tomlString = (s) => JSON.stringify(String(s))

function tomlBlocks (text) {
  // [start, end) line ranges of [mcp_servers.autochat] and its sub-tables.
  const lines = text.split('\n')
  const ranges = []
  for (let i = 0; i < lines.length; i++) {
    const m = TOML_HEADER.exec(lines[i])
    if (!m) continue
    let j = i + 1
    while (j < lines.length && !ANY_HEADER.test(lines[j])) j++
    ranges.push({ start: i, end: j, sub: !!m[1] })
    i = j - 1
  }
  return { lines, ranges }
}

function tomlValue (lines, key) {
  const re = new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*(?:#.*)?$`)
  for (const l of lines) {
    const m = re.exec(l)
    if (!m) continue
    try { return JSON.parse(m[1].replace(/'([^']*)'/g, (_, s) => JSON.stringify(s))) } catch { return m[1] }
  }
  return undefined
}

const mcp = {
  file: (ctx) => path.join(ctx.codexHome, 'config.toml'),
  where (ctx) { return tilde(this.file(ctx), ctx) },
  read (ctx) {
    const text = readText(this.file(ctx)) ?? ''
    const { lines, ranges } = tomlBlocks(text)
    const main = ranges.find(r => !r.sub)
    const body = main ? lines.slice(main.start + 1, main.end) : null
    const inline = /^\s*autochat\s*=\s*\{/m.test(text) && /^\s*\[\s*mcp_servers\s*\]/m.test(text)
    return { text, lines, ranges, main, body, inline }
  },
  status (ctx) {
    const { body } = this.read(ctx)
    if (!body) return { registered: false }
    const command = tomlValue(body, 'command')
    const args = tomlValue(body, 'args')
    return { registered: true, valid: commandValid(command, args), command: [command, ...(Array.isArray(args) ? args : [])].join(' ') }
  },
  plan (ctx) { return planned((c) => this.compute(c), ctx) },
  compute (ctx) {
    const f = this.file(ctx)
    const { text, lines, main, body, inline } = this.read(ctx)
    const want = { command: ctx.node, args: argsFor('codex', ctx) }
    const block = [`command = ${tomlString(want.command)}`, `args = [${want.args.map(tomlString).join(', ')}]`]
    if (inline) return { id: 'codex', action: 'manual', file: f, reason: `${tilde(f, ctx)} defines autochat inline under [mcp_servers]`, snippet: `[mcp_servers.autochat]\n${block.join('\n')}` }
    if (body && same(tomlValue(body, 'command'), want.command) && same(tomlValue(body, 'args'), want.args)) return { id: 'codex', action: 'none', file: f }
    let next
    if (main) {
      // Rewrite command and args in place (args may span lines); keep the table's other settings.
      const kept = []
      let inArgs = false
      for (const l of body) {
        if (inArgs) { if (l.includes(']')) inArgs = false; continue }
        if (/^\s*command\s*=/.test(l)) continue
        if (/^\s*args\s*=/.test(l)) { inArgs = !l.includes(']'); continue }
        kept.push(l)
      }
      next = [...lines.slice(0, main.start + 1), ...block, ...kept, ...lines.slice(main.end)].join('\n')
    } else {
      const base = text.replace(/\n*$/, '')
      next = (base ? base + '\n\n' : '') + `[mcp_servers.autochat]\n${block.join('\n')}\n`
    }
    return { id: 'codex', action: main ? 'update' : 'add', file: f, entry: `[mcp_servers.autochat]\n${block.join('\n')}`, write: () => writeFileSafely(f, next) }
  },
  unplan (ctx) { return planned((c) => this.uncompute(c), ctx) },
  uncompute (ctx) {
    const f = this.file(ctx)
    const { lines, ranges } = this.read(ctx)
    if (!ranges.length) return { id: 'codex', action: 'none', file: f }
    const drop = new Set()
    for (const r of ranges) for (let i = r.start; i < r.end; i++) drop.add(i)
    const next = lines.filter((_, i) => !drop.has(i)).join('\n').replace(/\n{3,}/g, '\n\n').replace(/\n+$/, '\n')
    return { id: 'codex', action: 'remove', file: f, write: () => writeFileSafely(f, next) }
  }
}

// --- hooks ------------------------------------------------------------------------------------------

export const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'Stop', 'Interrupt', 'SessionEnd']
// SessionEnd and Interrupt hooks get 1 s unless they ask for more, and 3 s at most (more is cut
// to 3 s, with a warning); the others get 10 minutes.
const SHORT = ['SessionEnd', 'Interrupt']
const TIMEOUTS = { SessionEnd: 3, Interrupt: 3 }
export const hooksFile = (ctx) => path.join(ctx.codexHome, 'hooks.json')
const command = (ctx, event) => `${shq(ctx.node)} ${shq(ctx.bin)} hook --harness codex ${event} || true`
const group = (ctx, event) => ({ hooks: [{ type: 'command', command: command(ctx, event), timeout: TIMEOUTS[event] ?? 10 }] })
// Ours, wherever it is and whichever install it runs.
const OURS = /autochat\.js'?\s+hook\s+--harness\s+codex(\s|$)/
const ours = (h) => isObj(h) && typeof h.command === 'string' && OURS.test(h.command)
const hasOurs = (g) => isObj(g) && Array.isArray(g.hooks) && g.hooks.some(ours)

function computeHooks (ctx) {
  const file = hooksFile(ctx)
  const { text, root } = readJson(file)
  const manual = (reason) => ({
    id: 'codex',
    action: 'manual',
    file,
    reason,
    snippet: JSON.stringify({ hooks: Object.fromEntries(HOOK_EVENTS.map(e => [e, [group(ctx, e)]])) }, null, 2)
  })
  if (root === undefined) return manual(`${tilde(file, ctx)} isn't plain JSON, so autochat won't rewrite it`)
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
        // Our own group: replaced where it is (Codex keys trust by position), duplicates dropped.
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
  if (!changed.length) return { id: 'codex', action: 'none', file }
  next.hooks = hooks
  return {
    id: 'codex',
    action: had ? 'update' : 'add',
    file,
    entries: changed.map(e => `${e}: ${command(ctx, e)}`),
    write: () => writeJson(file, text, next)
  }
}

// Is `stripped` (the file without our handlers, with the lists that emptied still there) what
// `before` (readJson of the one-time backup) held? Lists and a `hooks` object we created don't
// count; ones the user had, empty or not, do.
function asBefore (before, stripped, events) {
  if (before.text === null || before.root === undefined) return false
  const orig = before.root ?? {}
  const c = structuredClone(stripped)
  for (const e of events) if (!c.hooks[e].length && !(isObj(orig.hooks) && Object.hasOwn(orig.hooks, e))) delete c.hooks[e]
  if (!Object.keys(c.hooks).length && !Object.hasOwn(orig, 'hooks')) delete c.hooks
  return same(c, orig)
}

// Removes our handlers only, then whatever that leaves empty: our groups, event lists and a
// `hooks` object that held nothing else, and the file itself when nothing at all is left (an
// empty hooks.json does nothing). writeJson() re-serializes the file, so when what's left is
// what it held before autochat first wrote to it, uninstall puts back the backup's exact bytes,
// whatever their layout, line endings or empty lists.
function uncomputeHooks (ctx) {
  const file = hooksFile(ctx)
  const { text, root } = readJson(file)
  if (!root || !isObj(root.hooks)) return { id: 'codex', action: 'none', file }
  const stripped = structuredClone(root)
  const removed = []
  for (const [event, list] of Object.entries(stripped.hooks)) {
    if (!Array.isArray(list) || !list.some(hasOurs)) continue
    const kept = []
    for (const g of list) {
      if (!hasOurs(g)) { kept.push(g); continue }
      const others = g.hooks.filter(h => !ours(h))
      if (others.length) kept.push({ ...g, hooks: others })
    }
    stripped.hooks[event] = kept
    removed.push(event)
  }
  if (!removed.length) return { id: 'codex', action: 'none', file }
  const next = structuredClone(stripped)
  for (const event of removed) if (!next.hooks[event].length) delete next.hooks[event]
  if (!Object.keys(next.hooks).length) delete next.hooks
  const before = readJson(file + '.autochat.bak')
  const write = asBefore(before, stripped, removed)
    ? () => writeFileSafely(file, before.text)
    : Object.keys(next).length ? () => writeJson(file, text, next) : () => fs.rmSync(file, { force: true })
  return { id: 'codex', action: 'remove', file, entries: removed.map(e => `${e}: autochat hook --harness codex ${e}`), write }
}

const commandPaths = (cmd) => (/^'((?:[^']|'\\'')*)' '((?:[^']|'\\'')*)'/.exec(cmd) || []).slice(1).map(p => p.replace(/'\\''/g, "'"))

// `key = true|false` lines directly under [features] in config.toml (not a profile's):
// [{key, raw, value}].
function featureFlags (text) {
  const out = []
  let table = ''
  for (const line of String(text ?? '').split('\n')) {
    const header = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/.exec(line)
    if (header) { table = header[1].replace(/[\s"']/g, ''); continue }
    const m = /^\s*([\w.\-"' ]+?)\s*=\s*(true|false)\s*(?:#.*)?$/.exec(line)
    if (!m) continue
    const key = [table, m[1].replace(/[\s"']/g, '')].filter(Boolean).join('.')
    if (key.startsWith('features.')) out.push({ key: key.slice('features.'.length), raw: m[1].trim(), value: m[2] === 'true' })
  }
  return out
}

// `hooks = false` under [features] in config.toml (or its old name, codex_hooks) turns every hook
// off. Returns where it's said, or null.
function hooksOff (ctx) {
  const file = mcp.file(ctx)
  const f = featureFlags(readText(file)).find(f => (f.key === 'hooks' || f.key === 'codex_hooks') && !f.value)
  return f ? `${f.raw} = false under [features] in ${tilde(file, ctx)}` : null
}

// --- trust ------------------------------------------------------------------------------------------

// Codex records the hooks you trust in config.toml, one table per hook, keyed by file, event and
// position: [hooks.state."<hooks.json>:<event>:<group>:<handler>"], with trusted_hash (and
// enabled = false when you turn one off in /hooks).
const MATCHER_EVENTS = ['PreToolUse', 'PermissionRequest', 'PostToolUse', 'PreCompact', 'PostCompact', 'SessionStart', 'SessionEnd', 'SubagentStart', 'SubagentStop']
const snake = (event) => event.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
const sortedKeys = (v) => Array.isArray(v) ? v.map(sortedKeys) : isObj(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sortedKeys(v[k])])) : v

/**
 * The trusted_hash Codex records for a command hook: the sha256 of the hook as Codex normalizes
 * it (the event, the group's matcher where the event has one, the handler with its timeout and
 * async filled in), as JSON with sorted keys. `group` is the matcher group the handler is in.
 */
export function trustHash (event, group, handler) {
  const t = Number.isInteger(handler.timeout) ? handler.timeout : SHORT.includes(event) ? 1 : 600
  const identity = {
    event_name: snake(event),
    ...(MATCHER_EVENTS.includes(event) && typeof group?.matcher === 'string' && { matcher: group.matcher }),
    hooks: [{
      type: 'command',
      command: handler.command,
      timeout: SHORT.includes(event) ? Math.min(Math.max(t, 1), 3) : Math.max(t, 1),
      async: handler.async === true,
      ...(typeof handler.statusMessage === 'string' && { statusMessage: handler.statusMessage })
    }]
  }
  return 'sha256:' + crypto.createHash('sha256').update(JSON.stringify(sortedKeys(identity))).digest('hex')
}

const unquote = (s) => s.replace(/\\(["\\])/g, '$1')
function stateFields (s) {
  const hash = /\btrusted_hash\s*=\s*"([^"]*)"/.exec(s)
  const enabled = /\benabled\s*=\s*(true|false)\b/.exec(s)
  return { ...(hash && { trusted_hash: hash[1] }), ...(enabled && { enabled: enabled[1] === 'true' }) }
}

// Codex's per-hook state from config.toml: {key: {trusted_hash, enabled}}, from
// [hooks.state."<key>"] tables (how Codex writes them) and `"<key>" = {…}` under [hooks.state].
function hookStates (text) {
  const out = {}
  let table = null
  for (const line of String(text ?? '').split('\n')) {
    const header = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/.exec(line)
    if (header) {
      const m = /^hooks\s*\.\s*state(?:\s*\.\s*"((?:[^"\\]|\\.)*)")?$/.exec(header[1])
      table = m ? (m[1] === undefined ? '' : unquote(m[1])) : null
      continue
    }
    if (table === null) continue
    if (table) { Object.assign(out[table] ??= {}, stateFields(line)); continue }
    const inline = /^\s*"((?:[^"\\]|\\.)*)"\s*=\s*\{(.*)\}\s*(?:#.*)?$/.exec(line)
    if (inline) out[unquote(inline[1])] = stateFields(inline[2])
  }
  return out
}

// How many of our hooks Codex skips: {untrusted, off}.
function trustOf (ctx, hooks) {
  const file = hooksFile(ctx)
  let real = file
  try { real = fs.realpathSync(file) } catch {}
  const states = hookStates(readText(mcp.file(ctx)))
  const counts = { untrusted: 0, off: 0 }
  for (const event of HOOK_EVENTS) {
    (Array.isArray(hooks[event]) ? hooks[event] : []).forEach((g, gi) => {
      if (!isObj(g) || !Array.isArray(g.hooks)) return
      g.hooks.forEach((h, hi) => {
        if (!ours(h)) return
        const key = `:${snake(event)}:${gi}:${hi}`
        const state = states[file + key] ?? states[real + key]
        if (state?.enabled === false) counts.off++
        else if (state?.trusted_hash !== trustHash(event, g, h)) counts.untrusted++
      })
    })
  }
  return counts
}

function hookStatus (ctx) {
  const file = hooksFile(ctx)
  const { root } = readJson(file)
  const all = root && isObj(root.hooks) ? root.hooks : {}
  const found = HOOK_EVENTS.map(e => (Array.isArray(all[e]) ? all[e] : []).flatMap(g => isObj(g) && Array.isArray(g.hooks) ? g.hooks : []).find(ours)).filter(Boolean)
  const off = hooksOff(ctx)
  const trust = found.length ? trustOf(ctx, all) : null
  const which = (n) => n >= found.length ? "autochat's hooks" : `${n} of autochat's hooks`
  const notes = trust
    ? [trust.untrusted && `Codex skips ${which(trust.untrusted)} until you trust them (new, or changed since you did): open /hooks in Codex and trust them`,
        trust.off && `${which(trust.off)} ${trust.off === 1 ? 'is' : 'are'} turned off in /hooks in Codex`].filter(Boolean)
    : []
  return {
    installed: found.length === HOOK_EVENTS.length,
    partial: found.length > 0 && found.length < HOOK_EVENTS.length,
    // The node and autochat.js our hooks run still exist.
    valid: found.every(h => { const p = commandPaths(h.command); return p.length === 2 && p.every(exists) }),
    disabled: !!off,
    ...(off && { disabledBy: off }),
    file,
    // Codex has trusted every one of ours, and none is turned off.
    ...(trust && { trusted: !trust.untrusted && !trust.off }),
    ...(notes.length && { note: notes.join('; ') })
  }
}

// --- events -----------------------------------------------------------------------------------------

const MODES = ['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions']
const HEAD = 64 * 1024

/**
 * How the session was started, from the first line of its rollout file (the session_meta):
 * {source, originator}, or null when there's no such file or line. Only the head of the file is
 * read; when the session_meta line is longer, its first fields are enough.
 */
export function sessionSource (file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return null
  let head
  try {
    const fd = fs.openSync(file, 'r')
    try {
      const buf = Buffer.alloc(HEAD)
      head = buf.subarray(0, fs.readSync(fd, buf, 0, HEAD, 0)).toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return null
  }
  const line = head.split('\n')[0]
  try {
    const o = JSON.parse(line)
    if (o?.type !== 'session_meta' || !isObj(o.payload)) return null
    return { source: o.payload.source ?? null, originator: typeof o.payload.originator === 'string' ? o.payload.originator : null }
  } catch {}
  if (!/^\{[^{]{0,200}"type":"session_meta"/.test(line)) return null
  // source is a string ("exec", "cli", …) or an object ({"subagent": …}).
  const m = /"source":(?:"([\w-]+)"|(\{))/.exec(line)
  const originator = /"originator":"([\w.-]+)"/.exec(line)?.[1] ?? null
  return { source: m ? m[1] ?? {} : null, originator }
}

/** Nobody at Codex's prompt: `codex exec`. null when the rollout doesn't say (or has none). */
export function headless (transcriptPath) {
  const s = sessionSource(transcriptPath)
  if (!s) return null
  // A subagent, a custom client, an internal thread: the session that matters is another one.
  if (s.source !== null && typeof s.source !== 'string') return null
  if (s.source === 'exec') return true
  // The TUI is "vscode" through its app-server daemon (the default for app-server clients), "cli"
  // with --no-daemon.
  if (['cli', 'vscode', 'mcp'].includes(s.source)) return false
  if (s.source === null && s.originator === 'codex_exec') return true
  if (s.source === null && s.originator === 'codex_cli_rs') return false
  return null
}

const TAIL = 8 * 1024 * 1024

/**
 * One turn's settings, from the turn_context line Codex writes into the rollout as the turn
 * starts: {mode (the collaboration mode: "default", "plan"), reviewer (who answers approvals:
 * "user", "auto_review")}, or null when the rollout doesn't say (no file, or the turn started
 * more than the last 8 MB ago).
 */
export function turnContext (file, turnId) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || typeof turnId !== 'string' || !/^[\w-]{1,128}$/.test(turnId)) return null
  let text
  try {
    const fd = fs.openSync(file, 'r')
    try {
      const size = fs.fstatSync(fd).size
      const len = Math.min(size, TAIL)
      const buf = Buffer.alloc(len)
      text = buf.subarray(0, fs.readSync(fd, buf, 0, len, size - len)).toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return null
  }
  // Every line of the turn names it; the turn_context line is the first of them.
  const needle = `"turn_id":"${turnId}"`
  for (let i = text.lastIndexOf(needle); i !== -1;) {
    const start = text.lastIndexOf('\n', i) + 1
    const end = text.indexOf('\n', i)
    const line = text.slice(start, end === -1 ? undefined : end)
    if (line.includes('"type":"turn_context"')) {
      try {
        const o = JSON.parse(line)
        if (o?.type === 'turn_context' && o.payload?.turn_id === turnId) {
          const mode = o.payload.collaboration_mode?.mode
          const reviewer = o.payload.approvals_reviewer
          return { mode: typeof mode === 'string' ? mode : null, reviewer: typeof reviewer === 'string' ? reviewer : null }
        }
      } catch {}
    }
    i = start > 0 ? text.lastIndexOf(needle, start - 1) : -1
  }
  return null
}

const codexHomeOf = (env) => env?.CODEX_HOME || path.join(env?.HOME || os.homedir(), '.codex')
const featureOn = (env, name) => {
  try { return featureFlags(readText(path.join(codexHomeOf(env), 'config.toml'))).some(f => f.key === name && f.value) } catch { return false }
}

/**
 * Does Codex put this approval (or question) to you? codex exec never does: it turns both down
 * itself, or leaves approvals to its automatic reviewer, as the TUI does with that reviewer on.
 * And Codex turns request_user_input down outside Plan mode, unless
 * default_mode_request_user_input is on.
 */
function putToYou (ev, p, env, question) {
  if (ev.headless === true) return false
  const turn = turnContext(p.transcript_path, p.turn_id)
  if (!turn) return true
  if (!question) return turn.reviewer === null || turn.reviewer === 'user'
  return turn.mode !== 'default' || featureOn(env, 'default_mode_request_user_input')
}

const str = (v) => typeof v === 'string' ? v : ''

// apply_patch's input is the patch: `*** Add File: <path>` and so on.
function patchFiles (patch) {
  const out = []
  for (const m of str(patch).matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)) {
    const f = m[1].trim()
    if (f && !out.includes(f)) out.push(f)
  }
  return out.slice(0, 20)
}

function editedFiles (tool, input) {
  if (tool !== 'apply_patch' || !isObj(input)) return undefined
  const files = patchFiles(input.command).map(f => sanitize(f, 300))
  return files.length ? files : undefined
}

function describeTool (tool, input) {
  const i = isObj(input) ? input : {}
  const what = tool === 'apply_patch' ? patchFiles(i.command).join(', ') : str(i.command)
  const why = str(i.description)
  const text = [tool || 'a tool', what && `: ${what}`, why && ` (${why})`].filter(Boolean).join('')
  return sanitize(text, 600)
}

// request_user_input: questions, each with options.
function describeQuestions (input) {
  const qs = isObj(input) && Array.isArray(input.questions) ? input.questions.filter(isObj) : []
  return sanitize(qs.map((q) => {
    const choices = Array.isArray(q.options) ? q.options.map(o => isObj(o) ? str(o.label) : str(o)).filter(Boolean) : []
    return str(q.question) + (choices.length ? ` [${choices.join(' / ')}]` : '')
  }).filter(Boolean).join(' · '), 600)
}

/** A Codex hook payload as a SessionEvent (autonomy is decided by autonomy()). */
export function normalize (event, p, env) {
  if (!isObj(p) || !isValidSessionId(p.session_id)) return null
  const name = str(p.hook_event_name) || event
  const tool = str(p.tool_name)
  const ev = {
    harness: 'codex',
    sid: p.session_id,
    kind: 'notice',
    mode: MODES.includes(p.permission_mode) ? p.permission_mode : null,
    // A subagent's payload points at its own rollout, which only says it's a subagent: unknown,
    // so its events keep the parent's session as it is and never start or end one.
    headless: p.agent_id ? null : headless(p.transcript_path),
    cwd: typeof p.cwd === 'string' ? sanitize(p.cwd, 300) : undefined,
    origin: originFrom(env)
  }
  switch (name) {
    case 'SessionStart':
      ev.kind = 'start'
      break
    case 'UserPromptSubmit':
    case 'SubagentStart':
    case 'SubagentStop':
      ev.kind = 'activity'
      break
    case 'PreToolUse':
    case 'PostToolUse':
      if (name === 'PreToolUse' && tool === 'request_user_input' && putToYou(ev, p, env, true)) {
        ev.kind = 'request'
        ev.request = { title: 'Codex has a question for you', message: describeQuestions(p.tool_input) }
      } else {
        ev.kind = 'activity'
      }
      ev.files = editedFiles(tool, p.tool_input)
      break
    case 'PermissionRequest':
      if (putToYou(ev, p, env, false)) {
        ev.kind = 'request'
        ev.request = { title: 'Permission needed', message: describeTool(tool, p.tool_input) }
      } else {
        ev.kind = 'activity'
      }
      break
    case 'Stop':
      ev.kind = 'idle'
      if (str(p.last_assistant_message)) ev.summary = sanitize(p.last_assistant_message, 2000)
      break
    case 'Interrupt':
      // You stopped the turn (Esc, or turned an approval down): you're at its prompt now. Stopped
      // with Ctrl+C, codex exec exits.
      if (ev.headless === true) {
        ev.kind = 'end'
        ev.reason = 'interrupt'
      } else {
        ev.kind = 'waiting'
      }
      break
    case 'SessionEnd':
      ev.kind = 'end'
      ev.reason = sanitize(String(p.reason || 'end'), 32)
      break
  }
  if (!ev.files) delete ev.files
  return ev
}

// `codex exec`, by default. When the rollout can't say whether anyone is there, a mode that
// doesn't count by itself leaves the session unknown, rather than ending it.
function autonomy (payload, session) {
  const a = byTrigger(modesOf(session), session.trigger)
  const headlessCounts = Array.isArray(session.trigger) && session.trigger.includes('headless')
  return a === 'interactive' && session.headless === null && headlessCounts ? 'unknown' : a
}

// --- the doorbell -----------------------------------------------------------------------------------

// From Codex's hooks documentation (not run live): hookSpecificOutput.additionalContext from a
// PostToolUse hook is added to the model's context as developer context. Our PostToolUse hook
// already runs for every tool. Codex runs hooks through a login shell, whose parent is Codex.
const ROOM_TOOL = new RegExp(`^mcp__${SERVER}__`)
const doorbell = {
  event: 'PostToolUse',
  skip: (p) => typeof p.tool_name === 'string' && ROOM_TOOL.test(p.tool_name),
  output: (text) => JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text } })
}

export default {
  id: 'codex',
  name: 'Codex',
  modes: [...MODES, 'headless'],
  trigger: ['headless'],
  detect (ctx) {
    const binary = ctx.which('codex')
    return { installed: !!binary || isDir(ctx.codexHome), binary, paths: { config: mcp.file(ctx), hooks: hooksFile(ctx) } }
  },
  hooksNote: 'Codex skips new or changed hooks until you trust them (codex exec without a word): open /hooks in Codex and trust autochat\'s.',
  planHooks: (ctx) => planned(computeHooks, ctx),
  unplanHooks: (ctx) => planned(uncomputeHooks, ctx),
  hookStatus,
  normalize,
  autonomy,
  doorbell,
  focus: focusOrigin,
  mcp
}
