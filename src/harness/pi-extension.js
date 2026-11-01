import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { envVar } from '../env.js'
import { TOOLS, instructions, agentHello, gitInfo, DaemonLink, Tools, syncLivePaths } from '../agent-client.js'
import { titleLine } from '../agent-client/binding.js'

// The autochat extension for pi (#35). pi has no hooks and no MCP, so the stub that autochat
// writes to ~/.pi/agent/extensions/autochat.ts loads this module, and it does both jobs:
//
// - The lounge (`lounge: true`): pi's lifecycle events go to `autochat hook --harness pi <event>`
//   with a JSON payload on stdin, as other harnesses' hooks do, so src/harness/pi.js and the
//   trigger rule decide what they mean.
// - The agent room (`room: true`): the six agent-room tools, registered as pi tools named
//   autochat_catch_up, autochat_status, …, over the daemon's agent protocol
//   (src/agent-client.js, as `autochat mcp` does). pi namespaces nothing, and `read` is one of
//   its built-in tools, hence the prefix.
//
// It runs inside pi, so it never throws into pi, and it prints nothing (but AUTOCHAT_DEBUG logs on
// stderr): pi's TUI owns the terminal.

export const EVENTS = ['session_start', 'agent_start', 'tool_call', 'agent_end', 'session_shutdown']
export const TOOL_PREFIX = 'autochat_'
// The agent joins the room at its first autochat tool call, or this long after its session
// starts, so quick runs don't flash in and out of the room.
export const JOIN_DELAY_MS = 3000
// How long pi's shutdown waits for the last events to reach autochat.
const FLUSH_MS = 3000
const HOOK_TIMEOUT_MS = 10000
// pi's tools that write files, and their path argument.
const EDIT_TOOLS = new Set(['edit', 'write'])
// Consecutive activity is one event: the newest one stands for those still queued.
const ACTIVITY = new Set(['agent_start', 'tool_call'])
// pi asks tools to keep their output under 50 KB.
const MAX_TOOL_TEXT = 50 * 1024

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * pi's run mode: `interactive`, `rpc`, `print` (`pi -p`, or piped stdin) or `json`
 * (`--mode json`). Extensions only see ctx.hasUI (false in print and json mode), so the flag
 * itself tells print from json and rpc from interactive.
 */
export function runMode (hasUI, argv = process.argv) {
  const i = argv.indexOf('--mode')
  const flag = i >= 0 ? argv[i + 1] : null
  if (hasUI === false) return flag === 'json' ? 'json' : 'print'
  if (hasUI === true) return flag === 'rpc' ? 'rpc' : 'interactive'
  return null
}

function lastAssistantText (messages) {
  if (!Array.isArray(messages)) return ''
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.role !== 'assistant') continue
    const blocks = Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content }]
    return blocks.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n').trim()
  }
  return ''
}

/** The hook payload for one pi event: what src/harness/pi.js normalize() reads. */
export function hookPayload (event, e, ctx, argv = process.argv) {
  const p = {
    hook_event_name: event,
    session_id: ctx.sessionManager?.getSessionId?.() ?? null,
    cwd: ctx.cwd ?? null,
    mode: runMode(ctx.hasUI, argv),
    has_ui: typeof ctx.hasUI === 'boolean' ? ctx.hasUI : null
  }
  if (event === 'session_start' || event === 'session_shutdown') p.reason = typeof e?.reason === 'string' ? e.reason : null
  if (event === 'tool_call') {
    p.tool_name = typeof e?.toolName === 'string' ? e.toolName : null
    const file = e?.input?.path
    if (EDIT_TOOLS.has(p.tool_name) && typeof file === 'string' && file) p.files = [file]
  }
  if (event === 'agent_end') {
    const text = lastAssistantText(e?.messages)
    if (text) p.last_assistant_message = text.slice(0, 2000)
  }
  return p
}

/**
 * Runs `<node> <bin> hook --harness pi <event>` for each event, one at a time and in order, with
 * the payload on stdin. pi never waits for it (except at shutdown, through flush()), and a hook
 * that can't run is skipped.
 */
export function hookRunner ({ node, bin, env = process.env, spawnHook = spawn, timeoutMs = HOOK_TIMEOUT_MS }) {
  const queue = []
  let running = false
  const idle = []
  const settle = () => { if (!running && !queue.length) { for (const r of idle.splice(0)) r() } }
  const runOne = ({ event, payload }) => new Promise((resolve) => {
    let child
    try {
      child = spawnHook(node, [bin, 'hook', '--harness', 'pi', event], { env, stdio: ['pipe', 'ignore', 'ignore'], detached: true, windowsHide: true })
    } catch {
      return resolve()
    }
    let done = false
    const finish = () => { if (!done) { done = true; clearTimeout(timer); resolve() } }
    const timer = setTimeout(finish, timeoutMs)
    timer.unref?.()
    child.on('error', finish)
    child.on('exit', finish)
    child.stdin?.on('error', () => {})
    child.stdin?.end(JSON.stringify(payload))
    child.unref?.()
  })
  const pump = async () => {
    if (running) return
    running = true
    while (queue.length) await runOne(queue.shift())
    running = false
    settle()
  }
  return {
    send (event, payload) {
      const last = queue[queue.length - 1]
      if (last && ACTIVITY.has(last.event) && ACTIVITY.has(event)) queue[queue.length - 1] = { event, payload }
      else queue.push({ event, payload })
      pump()
    },
    /**
     * Resolves once every queued event has been handed to autochat, or after ms. Its timer keeps
     * the process alive meanwhile: pi exits after its last session_shutdown handler returns.
     */
    flush (ms = FLUSH_MS) {
      if (!running && !queue.length) return Promise.resolve()
      return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms)
        idle.push(() => { clearTimeout(timer); resolve() })
      })
    },
    get pending () { return queue.length + (running ? 1 : 0) }
  }
}

// --- the lounge ------------------------------------------------------------------------------

function forwardLifecycle (pi, { node, bin, env, spawnHook, argv }) {
  const hooks = hookRunner({ node, bin, env, spawnHook })
  for (const event of EVENTS) {
    pi.on(event, async (e, ctx) => {
      try {
        hooks.send(event, hookPayload(event, e, ctx, argv))
        // pi exits (print mode) or swaps the session right after this: let the events land.
        if (event === 'session_shutdown') await hooks.flush()
      } catch {}
    })
  }
  return hooks
}

// --- the agent room ----------------------------------------------------------------------------

const toolName = (name) => TOOL_PREFIX + name
export const ETIQUETTE = `## autochat agent room\n${instructions(toolName)}`

function capText (text) {
  if (Buffer.byteLength(text) <= MAX_TOOL_TEXT) return text
  const cut = Buffer.from(text).subarray(0, MAX_TOOL_TEXT).toString('utf8').replace(/\uFFFD$/, '')
  return `${cut}\n[truncated: ${Buffer.byteLength(text)} bytes; ask for less, e.g. ${toolName('read')} with a smaller limit]`
}

const aborted = (signal) => new Promise((resolve) => {
  if (!signal) return
  if (signal.aborted) return resolve(null)
  signal.addEventListener('abort', () => resolve(null), { once: true })
})

// pi loads a fresh copy of each extension for every session, /reload included. Resume tokens
// outlive the copy, so a reloaded session comes back as the same agent rather than a new one.
const RESUME = Symbol.for('autochat.pi.resume')
const resumeTokens = () => (globalThis[RESUME] ??= new Map())

// The pi session's name (/name), if it has one.
const sessionName = (ctx) => {
  try { return titleLine(ctx?.sessionManager?.getSessionName?.()) } catch { return null }
}

function agentRoom (pi, { env, log, joinDelayMs = JOIN_DELAY_MS }) {
  let link = null
  let tools = null
  let live = null
  let joinTimer = null
  let lastCtx = null
  // One agent per pi session: who it is, from the first session event or tool call.
  const bind = (ctx) => {
    if (link) return
    // As git reports it, so the paths in status() come out repo-relative.
    let cwd = ctx.cwd || process.cwd()
    try { cwd = fs.realpathSync(cwd) } catch {}
    const git = gitInfo(cwd)
    const sessionId = ctx.sessionManager?.getSessionId?.() ?? null
    const hello = agentHello({ harness: 'pi', pid: process.pid, harnessPid: process.pid, sessionId, cwd, git, env, title: sessionName(ctx) })
    link = new DaemonLink({ hello, env, log })
    if (sessionId) {
      link.token = resumeTokens().get(sessionId) ?? null
      link.on('connected', () => resumeTokens().set(sessionId, link.token))
    }
    // As in `autochat mcp`: the files changed in git go to the card as live paths (#56).
    live = syncLivePaths({ link, top: git.top, env, log })
    tools = new Tools({ link, session: { harness: 'pi', cwd, top: git.top, readTitle: () => sessionName(lastCtx) }, onCall: live.poke })
  }
  pi.on('session_start', (e, ctx) => {
    try {
      bind(ctx)
      joinTimer = setTimeout(() => link.start(), joinDelayMs)
      joinTimer.unref?.()
    } catch {}
  })
  // Ending the session ends the agent's presence at once (`bye`): a new session, /resume, /fork, or
  // quitting. /reload loads a new copy of the extension for the same session, which resumes the
  // same agent, so it only closes the connection.
  pi.on('session_shutdown', async (e) => {
    clearTimeout(joinTimer)
    live?.stop()
    if (e?.reason === 'reload') link?.close()
    else await link?.bye()
  })
  // The room's etiquette goes into the system prompt while the tools are on.
  pi.on('before_agent_start', (e) => {
    try {
      const active = (pi.getActiveTools?.() || []).map(t => typeof t === 'string' ? t : t?.name)
      if (!active.some(n => typeof n === 'string' && n.startsWith(TOOL_PREFIX))) return
      return { systemPrompt: `${e.systemPrompt}\n\n${ETIQUETTE}` }
    } catch {}
  })
  for (const t of TOOLS) {
    pi.registerTool({
      name: toolName(t.name),
      label: t.title,
      description: t.description,
      parameters: t.inputSchema,
      async execute (toolCallId, params, signal, onUpdate, ctx) {
        bind(ctx)
        lastCtx = ctx
        clearTimeout(joinTimer)
        if (!link.connected) link.start()
        const result = await Promise.race([tools.call(t.name, isObj(params) ? params : {}, () => !!signal?.aborted), aborted(signal)])
        if (!result) throw new Error('cancelled')
        const text = result.content?.[0]?.text ?? ''
        if (result.isError) throw new Error(text)
        // pi keeps `details` in its session file: only the doorbell, the text has the rest.
        return { content: [{ type: 'text', text: capText(text) }], details: { inbox: result.structuredContent?.inbox ?? null } }
      }
    })
  }
  return { get link () { return link } }
}

/**
 * The extension: `pi` is pi's ExtensionAPI, `opts` the stub's settings: {node, bin, lounge,
 * room}. Tests pass `env`, `argv`, `spawnHook` and `joinDelayMs`.
 */
export async function register (pi, opts = {}) {
  const env = opts.env || process.env
  const debug = !!envVar('DEBUG', env)
  const log = (s) => { if (debug) process.stderr.write(`autochat (pi): ${s}\n`) }
  const out = {}
  try {
    if (opts.lounge && opts.node && opts.bin) out.hooks = forwardLifecycle(pi, { node: opts.node, bin: opts.bin, env, spawnHook: opts.spawnHook, argv: opts.argv })
    if (opts.room) out.room = agentRoom(pi, { env, log, joinDelayMs: opts.joinDelayMs })
  } catch (err) {
    log(err?.stack || String(err))
  }
  return out
}
