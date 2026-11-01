import fs from 'node:fs'
import path from 'node:path'
import { isValidSessionId } from '../paths.js'
import { sanitize } from '../protocol.js'
import { focusOrigin } from '../launcher.js'
import { readText, planned, tilde, exists, isDir, isObj } from './util.js'
import { defaultAutonomy, originFrom } from './event.js'

// pi (@earendil-works/pi-coding-agent). It has no hooks and no MCP: it has TypeScript extensions,
// auto-loaded from $PI_CODING_AGENT_DIR/extensions (~/.pi/agent/extensions). autochat writes one
// small file there, autochat.ts, a file of its own. It loads src/harness/pi-extension.js from
// this install, which does both of autochat's jobs:
//
// - `lounge`: pi's lifecycle events go through `autochat hook --harness pi <event>` (setup
//   --harness pi; doctor and uninstall treat it as pi's hooks);
// - `room`: the agent-room tools, autochat_catch_up and so on (setup --agents; the "MCP"
//   registration in doctor and uninstall).
//
// Verified against pi 0.74.0 (test/fixtures/pi/, recorded from the real binary):
// - Extensions see ctx.hasUI, false in print mode (`pi -p`, piped stdin) and json mode
//   (`--mode json`), true in the TUI and in rpc mode (`--mode rpc`).
// - A print run is session_start (startup) → agent_start → tool_call… → agent_end per prompt →
//   session_shutdown (quit). Session ids are UUIDs; /new, /resume and /fork shut the session
//   down and start another, /reload shuts down and starts the same one.
// - pi has no permission prompts and no ask-the-user tool, so it never reports a request.
// - A tool_result handler that returns {content} replaces what the model reads of that tool's
//   result: the extension's doorbell appends a text block.

const MODES = ['interactive', 'rpc', 'print', 'json']
const HEADLESS = new Set(['print', 'json'])
export const EXTENSION = 'autochat.ts'

// --- the extension file ------------------------------------------------------------------------

/** $PI_CODING_AGENT_DIR, else ~/.pi/agent: where pi keeps settings, sessions and extensions. */
export function agentDir (ctx) {
  const dir = ctx.env.PI_CODING_AGENT_DIR
  if (!dir) return path.join(ctx.home, '.pi', 'agent')
  if (dir === '~') return ctx.home
  return dir.startsWith('~/') ? path.join(ctx.home, dir.slice(2)) : dir
}
export const extensionFile = (ctx) => path.join(agentDir(ctx), 'extensions', EXTENSION)
const moduleFor = (ctx) => path.resolve(path.dirname(ctx.bin), '..', 'src', 'harness', 'pi-extension.js')

const HEADER = `// autochat for pi: it puts you in the autochat lounge while pi works on its own (\`autochat setup
// --harness pi\`) and connects pi to the local agent room (\`autochat setup --agents\`).
// \`autochat uninstall\` removes this file. autochat rewrites it, so don't edit it.`
const CONFIG = /^const AUTOCHAT = (\{.*\})$/m

/** The stub pi loads: settings, plus loading the extension from this autochat install. */
export function extensionSource (cfg) {
  return `${HEADER}
const AUTOCHAT = ${JSON.stringify({ node: cfg.node, bin: cfg.bin, module: cfg.module, lounge: !!cfg.lounge, room: !!cfg.room })}

export default async function autochat (pi: any) {
  try {
    const { register } = await import(AUTOCHAT.module)
    await register(pi, AUTOCHAT)
  } catch (err) {
    // autochat moved or is gone: \`autochat doctor\` says so, \`autochat setup\` fixes it.
    if (process.env.AUTOCHAT_DEBUG) console.error('autochat:', err)
  }
}
`
}

/** The settings in our stub; null when there's no file, undefined when it isn't ours. */
export function readExtension (text) {
  if (text === null) return null
  const m = CONFIG.exec(text)
  if (!m || !text.startsWith('// autochat for pi')) return undefined
  try {
    const cfg = JSON.parse(m[1])
    return isObj(cfg) && typeof cfg.bin === 'string' ? cfg : undefined
  } catch {
    return undefined
  }
}

// Our own file, so no backup; written atomically (pi may be loading extensions right now),
// through a symlink to its target.
function writeOwn (file, text) {
  let target = file
  try { target = fs.realpathSync(file) } catch {}
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const tmp = `${target}.autochat-${process.pid}.tmp`
  fs.writeFileSync(tmp, text, { mode: 0o644 })
  fs.renameSync(tmp, target)
}

const PARTS = {
  lounge: 'lifecycle events → autochat hook --harness pi',
  room: 'agent-room tools: autochat_catch_up, autochat_status, autochat_post, autochat_read, autochat_wait, autochat_thread'
}

/** Turns one part of the extension on or off (`part`: lounge | room). Both off: no file. */
function computeExtension (ctx, part, on) {
  const file = extensionFile(ctx)
  const text = readText(file)
  const have = readExtension(text)
  const entry = `${EXTENSION}: ${PARTS[part]}`
  const next = extensionSource({ node: ctx.node, bin: ctx.bin, module: moduleFor(ctx), lounge: !!have?.lounge, room: !!have?.room, [part]: true })
  if (have === undefined) {
    if (!on) return { id: 'pi', action: 'none', file }
    return { id: 'pi', action: 'manual', file, reason: `${tilde(file, ctx)} isn't autochat's, so autochat won't overwrite it (move it aside and rerun)`, snippet: next }
  }
  if (!on) {
    if (!have?.[part]) return { id: 'pi', action: 'none', file }
    const rest = { ...have, [part]: false }
    const write = !rest.lounge && !rest.room ? () => fs.rmSync(file, { force: true }) : () => writeOwn(file, extensionSource(rest))
    return { id: 'pi', action: 'remove', file, entries: [entry], entry, write }
  }
  if (next === text) return { id: 'pi', action: 'none', file }
  return { id: 'pi', action: have?.[part] ? 'update' : 'add', file, entries: [entry], entry, write: () => writeOwn(file, next) }
}

/** What the stub on disk says, for doctor: which parts are on, and whether its paths exist. */
export function extensionStatus (ctx) {
  const file = extensionFile(ctx)
  const cfg = readExtension(readText(file))
  return {
    file,
    foreign: cfg === undefined,
    lounge: !!cfg?.lounge,
    room: !!cfg?.room,
    valid: cfg ? [cfg.node, cfg.bin, cfg.module].every(p => typeof p === 'string' && exists(p)) : undefined,
    module: cfg?.module ?? null
  }
}

// --- events -----------------------------------------------------------------------------------

/** print and json runs have nobody at pi's prompt; null when the payload doesn't say. */
export function headless (p) {
  if (MODES.includes(p.mode)) return HEADLESS.has(p.mode)
  return typeof p.has_ui === 'boolean' ? !p.has_ui : null
}

const str = (v) => typeof v === 'string' ? v : ''

/** A payload from the autochat extension (hookPayload() in pi-extension.js) as a SessionEvent. */
export function normalize (event, p, env) {
  if (!isObj(p) || !isValidSessionId(p.session_id)) return null
  const name = str(p.hook_event_name) || event
  const mode = MODES.includes(p.mode) ? p.mode : null
  const ev = {
    harness: 'pi',
    sid: p.session_id,
    kind: 'notice',
    mode,
    headless: headless(p),
    cwd: typeof p.cwd === 'string' ? sanitize(p.cwd, 300) : undefined,
    origin: originFrom(env)
  }
  switch (name) {
    case 'session_start':
      ev.kind = 'start'
      break
    case 'agent_start':
      ev.kind = 'activity'
      break
    case 'tool_call': {
      ev.kind = 'activity'
      const files = Array.isArray(p.files) ? p.files.filter(f => typeof f === 'string' && f).slice(0, 20).map(f => sanitize(f, 300)) : []
      if (files.length) ev.files = files
      break
    }
    case 'agent_end':
      // In the TUI, pi now waits at its prompt; print, json and rpc runs may get another prompt.
      ev.kind = mode === 'interactive' ? 'waiting' : 'idle'
      if (str(p.last_assistant_message)) ev.summary = sanitize(p.last_assistant_message, 2000)
      break
    case 'session_shutdown':
      // /reload starts the same session again.
      if (p.reason === 'reload') break
      ev.kind = 'end'
      ev.reason = sanitize(String(p.reason || 'end'), 32)
      break
  }
  return ev
}

// --- the adapter ------------------------------------------------------------------------------

const mcp = {
  where (ctx) { return tilde(extensionFile(ctx), ctx) },
  status (ctx) {
    const s = extensionStatus(ctx)
    if (!s.room) return { registered: false }
    return { registered: true, valid: s.valid, command: `pi extension ${tilde(s.file, ctx)} → ${s.module}` }
  },
  plan (ctx) { return planned((c) => computeExtension(c, 'room', true), ctx) },
  unplan (ctx) { return planned((c) => computeExtension(c, 'room', false), ctx) }
}

export default {
  id: 'pi',
  name: 'pi',
  modes: [...MODES, 'headless'],
  trigger: ['headless'],
  detect (ctx) {
    const binary = ctx.which('pi')
    return { installed: !!binary || isDir(agentDir(ctx)), binary, paths: { extension: extensionFile(ctx) } }
  },
  hooksNote: 'New pi sessions load the extension; running ones pick it up on /reload.',
  planHooks: (ctx) => planned((c) => computeExtension(c, 'lounge', true), ctx),
  unplanHooks: (ctx) => planned((c) => computeExtension(c, 'lounge', false), ctx),
  hookStatus (ctx) {
    const s = extensionStatus(ctx)
    return { installed: s.lounge, file: s.file, ...(s.lounge && { valid: s.valid }) }
  },
  normalize,
  autonomy: defaultAutonomy,
  focus: focusOrigin,
  mcp
}
