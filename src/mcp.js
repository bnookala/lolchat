import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { envVar } from './env.js'
import { INSTRUCTIONS, TOOLS, bindSession, DaemonLink, Tools, syncLivePaths } from './agent-client.js'

// `autochat mcp`: a stdio MCP server, one per agent session, started by the harness. It's a
// thin client of the daemon's agent protocol (docs/protocol.md, "Agent room (local)") over
// the local unix socket, through src/agent-client.js: it never opens a network connection and
// never holds keys.
//
// Transport: newline-delimited JSON-RPC 2.0, hand-rolled (no MCP SDK). It speaks both eras:
// legacy clients open with `initialize` (2024-11-05 … 2025-11-25); modern clients
// (2026-07-28) send per-request `_meta` and may call `server/discover`.

// The session binding, the daemon connection and the tools live in src/agent-client.js.
export { HARNESSES, NOT_RUNNING, INSTRUCTIONS, TOOLS, matchHarness, psTable, parseRemote, gitInfo, bindSession, changedPaths, DaemonLink, wakeApp, Tools } from './agent-client.js'

export const MODERN_VERSIONS = ['2026-07-28']
export const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
export const SUPPORTED_VERSIONS = [...MODERN_VERSIONS, ...LEGACY_VERSIONS]

const VERSION_KEY = 'io.modelcontextprotocol/protocolVersion'
const CAPS_KEY = 'io.modelcontextprotocol/clientCapabilities'
const SERVER_INFO_KEY = 'io.modelcontextprotocol/serverInfo'
const PKG = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'))
export const SERVER_INFO = { name: 'autochat', version: PKG.version }

// The agent joins the room at its first tool call, or this long after the client's first
// message: harness health checks (`claude mcp get`, …) start and stop servers within a second
// or two, and shouldn't flash in and out of the room.
export const PRESENCE_DELAY_MS = 3000

const TOOL_NAMES = new Set(TOOLS.map(t => t.name))

// --- JSON-RPC / MCP ------------------------------------------------------------------------------

const rpcError = (id, code, message, data) => ({ jsonrpc: '2.0', id: id ?? null, error: data === undefined ? { code, message } : { code, message, data } })
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

export class McpServer {
  constructor ({ tools, write, log = () => {} }) {
    this.tools = tools
    this.write = write
    this.log = log
    this.inflight = new Map()
    this.legacyVersion = null
  }

  // One line from stdin.
  async line (text) {
    if (!text.trim()) return
    let msg
    try {
      msg = JSON.parse(text)
    } catch {
      this.write(rpcError(null, -32700, 'Parse error'))
      return
    }
    if (Array.isArray(msg)) {
      if (!msg.length) return this.write(rpcError(null, -32600, 'Invalid Request: empty batch'))
      const out = (await Promise.all(msg.map(m => this.message(m)))).filter(Boolean)
      if (out.length) this.write(out)
      return
    }
    const out = await this.message(msg)
    if (out) this.write(out)
  }

  // One JSON-RPC message: resolves to the response, or null (notifications, cancelled requests).
  async message (msg) {
    if (!isObj(msg) || msg.jsonrpc !== '2.0') return rpcError(isObj(msg) ? msg.id : null, -32600, 'Invalid Request')
    if (msg.method === undefined) return null // a response to us; we never send requests
    if (typeof msg.method !== 'string') return rpcError(msg.id, -32600, 'Invalid Request')
    if (msg.id === undefined) { this._notification(msg); return null }
    const entry = { cancelled: false }
    this.inflight.set(msg.id, entry)
    try {
      const res = await this._request(msg, () => entry.cancelled)
      return entry.cancelled ? null : res
    } catch (err) {
      this.log('request failed: ' + (err?.stack || err))
      return entry.cancelled ? null : rpcError(msg.id, -32603, 'Internal error')
    } finally {
      this.inflight.delete(msg.id)
    }
  }

  _notification (msg) {
    if (msg.method === 'notifications/cancelled') {
      const entry = this.inflight.get(msg.params?.requestId)
      if (entry) entry.cancelled = true
    }
  }

  async _request ({ id, method, params }, cancelled) {
    if (params !== undefined && !isObj(params)) return rpcError(id, -32602, 'Invalid params')
    params = params || {}
    const meta = isObj(params._meta) ? params._meta : {}
    const requested = meta[VERSION_KEY]
    const modern = requested !== undefined && method !== 'initialize'
    if (modern) {
      if (!MODERN_VERSIONS.includes(requested)) {
        return rpcError(id, -32022, 'Unsupported protocol version', { supported: SUPPORTED_VERSIONS, requested })
      }
      if (!isObj(meta[CAPS_KEY])) return rpcError(id, -32602, `Invalid params: _meta needs ${CAPS_KEY}`)
    }
    const ok = (result, cacheable = false) => ({
      jsonrpc: '2.0',
      id,
      result: modern
        ? { resultType: 'complete', ...result, ...(cacheable ? { ttlMs: 3600000, cacheScope: 'public' } : {}), _meta: { [SERVER_INFO_KEY]: SERVER_INFO } }
        : result
    })
    switch (method) {
      case 'initialize': {
        if (typeof params.protocolVersion !== 'string') return rpcError(id, -32602, 'Invalid params: protocolVersion is required')
        const version = LEGACY_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : LEGACY_VERSIONS[0]
        this.legacyVersion = version
        this.log(`initialize ${params.protocolVersion} → ${version} (${params.clientInfo?.name || 'client'})`)
        return ok({ protocolVersion: version, capabilities: { tools: {} }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS })
      }
      case 'ping':
        return ok({})
      case 'server/discover':
        if (!modern) return rpcError(id, -32602, `Invalid params: _meta needs ${VERSION_KEY}`)
        return ok({ supportedVersions: SUPPORTED_VERSIONS, capabilities: { tools: {} }, instructions: INSTRUCTIONS }, true)
      case 'tools/list':
        return ok({ tools: TOOLS }, true)
      case 'tools/call': {
        const { name } = params
        if (typeof name !== 'string') return rpcError(id, -32602, 'Invalid params: tools/call needs a tool name')
        if (!TOOL_NAMES.has(name)) return rpcError(id, -32602, `Unknown tool: ${name}`)
        const args = params.arguments ?? {}
        if (!isObj(args)) return rpcError(id, -32602, 'Invalid params: arguments must be an object')
        const result = await this.tools.call(name, args, cancelled)
        return result === null ? null : ok(result)
      }
      default:
        return rpcError(id, -32601, `Method not found: ${method}`)
    }
  }
}

/** `autochat mcp [--harness <id>]`: serve MCP on stdin/stdout until stdin closes. */
export async function runMcp ({ harness = null, stdin = process.stdin, stdout = process.stdout, env = process.env, presenceDelayMs = PRESENCE_DELAY_MS } = {}) {
  const debug = !!envVar('DEBUG', env)
  const log = (s) => { if (debug) process.stderr.write(`autochat mcp: ${s}\n`) }
  const session = bindSession({ harness, env })
  log(`${session.harness}${session.harnessPid ? ' pid ' + session.harnessPid : ''} in ${session.cwd} (${session.hello.repo || 'no repo'})`)
  const link = new DaemonLink({ hello: session.hello, env, log })
  // While connected, the files changed in git go to the card as live paths (#56).
  const live = syncLivePaths({ link, top: session.top, env, log })
  const tools = new Tools({ link, session, onCall: live.poke })
  const server = new McpServer({ tools, log, write: (obj) => stdout.write(JSON.stringify(obj) + '\n') })
  let joinTimer = null
  const joinSoon = () => {
    if (joinTimer) return
    joinTimer = setTimeout(() => link.start(), presenceDelayMs)
    joinTimer.unref?.()
  }

  let finished = false
  let resolveDone
  const done = new Promise(resolve => { resolveDone = resolve })
  const finish = () => {
    if (finished) return
    finished = true
    clearTimeout(joinTimer)
    // Leave the room now (`bye`) rather than show as away for the resume window; let queued
    // responses flush first. Both are bounded, so the harness's shutdown never waits on us.
    Promise.all([link.bye(), new Promise(resolve => stdout.write('', resolve))]).then(() => resolveDone())
    setTimeout(resolveDone, 500).unref()
  }
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, finish)
  stdout.on('error', finish)

  let buf = ''
  stdin.setEncoding('utf8')
  stdin.on('data', (d) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      joinSoon()
      server.line(line).catch((err) => log('line failed: ' + (err?.stack || err)))
    }
  })
  stdin.on('end', () => {
    if (buf.trim()) server.line(buf).catch(() => {})
    // Give in-flight calls a moment to answer before the presence ends.
    setTimeout(finish, 50)
  })
  stdin.on('error', finish)
  return { session, link, tools, server, done }
}
