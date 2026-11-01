import net from 'node:net'
import fs from 'node:fs'
import { sockPath, runDir, ensureDir } from './paths.js'

export const MAX = 256 * 1024
export const PROTOCOL = 1
export const MAX_SUBSCRIBERS = 8
export const NO_AGENT_ROOM = 'agent rooms need the autochat daemon'
const MAX_BACKLOG = 1024 * 1024
// Agents (our own MCP server) read promptly; catch-up replies can be large.
const MAX_AGENT_BACKLOG = 8 * 1024 * 1024
const MIN_INTERVAL_MS = { lounge: 50, agents: 100 }

// One state line, kept under the line cap by dropping the oldest messages first.
export function encodeState (state) {
  let line = JSON.stringify(state)
  if (Buffer.byteLength(line) <= MAX || !Array.isArray(state.messages)) return line
  const s = { ...state, messages: [...state.messages] }
  while (Buffer.byteLength(line) > MAX && s.messages.length) {
    s.messages.splice(0, Math.max(1, Math.ceil(s.messages.length / 8)))
    line = JSON.stringify(s)
  }
  return line
}

// An `agents` snapshot line: like encodeState, and if the cards alone are still too big,
// their focus.paths and focus.live lists are shortened.
export function encodeAgents (snap) {
  let line = encodeState(snap)
  if (Buffer.byteLength(line) <= MAX || !Array.isArray(snap.agents)) return line
  let s = JSON.parse(line)
  for (let keep = 64; Buffer.byteLength(line) > MAX && keep >= 0; keep = keep ? Math.floor(keep / 2) : -1) {
    s = { ...s, agents: s.agents.map(c => c.focus ? { ...c, focus: { ...c.focus, paths: c.focus.paths.slice(0, keep), live: c.focus.live?.slice(0, keep) } } : c) }
    line = JSON.stringify(s)
  }
  return line
}

/**
 * Local-only channel to the (single) autochat process: the terminal UI or `autochat daemon`.
 * Hooks send one-shot messages (one line in, one reply line out, then close).
 * Clients whose first line is {"type":"subscribe"} keep the connection: they get a
 * state snapshot now and after every publish() (≤ 20/s), and may send {"type":"cmd"}
 * lines. With `stream: "agents"` they get the agent room instead (≤ 10/s).
 * Connections whose first line is {"type":"agent-hello"} are agents (the MCP server).
 * `agents` ({connect, state, command}) is the agent room; only the daemon has one.
 * See docs/protocol.md.
 */
export function serve (onMessage, { state, command, agents = null, maxSubscribers = MAX_SUBSCRIBERS } = {}) {
  const streams = {
    lounge: { subs: new Set(), state, command, encode: encodeState, results: false },
    agents: { subs: new Set(), state: agents?.state, command: agents?.command, encode: encodeAgents, results: true }
  }
  const agentSocks = new Set()
  const write = (sock, line, max = MAX_BACKLOG) => {
    if (sock.destroyed) return
    sock.write(line + '\n')
    // A client that stopped reading must not grow our memory without bound.
    if (sock.writableLength > max) sock.destroy()
  }
  const refuse = (sock, error) => { sock.end(JSON.stringify({ type: 'error', v: PROTOCOL, error }) + '\n'); return false }

  const subscribe = (sock, msg) => {
    const name = msg.stream ?? 'lounge'
    if (typeof name !== 'string' || !Object.hasOwn(streams, name)) return refuse(sock, 'unknown stream')
    const stream = streams[name]
    if (name === 'agents' && !agents) return refuse(sock, NO_AGENT_ROOM)
    if (!stream.state) return refuse(sock, 'subscriptions not supported')
    if (msg.v !== undefined && msg.v !== PROTOCOL) return refuse(sock, 'unsupported protocol version')
    if (stream.subs.size >= maxSubscribers) return refuse(sock, 'too many subscribers')
    stream.subs.add(sock)
    sock.on('close', () => stream.subs.delete(sock))
    write(sock, stream.encode(stream.state()))
    return stream
  }

  const runCommand = (sock, stream, msg) => {
    const id = msg?.id ?? null
    const reply = (r) => write(sock, JSON.stringify({ type: 'reply', id, ...r }))
    if (!msg || msg.type !== 'cmd') return reply({ ok: false, error: msg ? 'unknown message type' : 'invalid json' })
    Promise.resolve()
      .then(() => stream.command(msg))
      .then(
        (result) => reply(stream.results && result !== undefined ? { ok: true, result } : { ok: true }),
        (err) => reply({ ok: false, error: err?.message || String(err) })
      )
  }

  // The first line was agent-hello: hand the connection to the agent room.
  const agentConnection = (sock, hello) => {
    if (!agents) return refuse(sock, NO_AGENT_ROOM)
    const peer = {
      send: (obj) => write(sock, JSON.stringify(obj), MAX_AGENT_BACKLOG),
      end: (obj) => { if (!sock.destroyed) sock.end(obj ? JSON.stringify(obj) + '\n' : undefined) }
    }
    const handler = agents.connect(hello, peer)
    if (!handler) return false
    agentSocks.add(sock)
    sock.on('close', () => { agentSocks.delete(sock); handler.close() })
    return handler
  }

  const server = net.createServer((sock) => {
    let buf = ''
    let subscribed = null
    let agent = null
    sock.setEncoding('utf8')
    sock.on('error', () => {})
    sock.on('data', (d) => {
      buf += d
      if (buf.length > MAX) { sock.destroy(); return }
      let i
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        let msg = null
        try { msg = JSON.parse(line) } catch {}
        // Lines come from any local process: a surprise here costs that connection, never the core.
        try {
          if (agent) { agent.message(msg); continue }
          if (subscribed) { runCommand(sock, subscribed, msg); continue }
          if (msg?.type === 'agent-hello') {
            agent = agentConnection(sock, msg)
            if (!agent) return
            continue
          }
          if (msg?.type === 'subscribe') {
            subscribed = subscribe(sock, msg)
            if (!subscribed) return
            continue
          }
        } catch {
          sock.destroy()
          return
        }
        let reply = { ok: !!msg }
        if (msg) {
          try { reply = { ok: true, ...(onMessage(msg) || {}) } } catch (err) { reply = { ok: false, error: err.message } }
        }
        sock.end(JSON.stringify(reply) + '\n')
      }
    })
  })

  // Snapshots are full state, so a burst of changes coalesces into one.
  for (const [name, stream] of Object.entries(streams)) {
    stream.timer = null
    stream.last = 0
    stream.flush = () => {
      stream.timer = null
      stream.last = Date.now()
      if (!stream.subs.size) return
      const line = stream.encode(stream.state())
      for (const sock of stream.subs) write(sock, line)
    }
    stream.interval = MIN_INTERVAL_MS[name]
  }
  server.publish = (name = 'lounge') => {
    const stream = streams[name]
    if (!stream || stream.timer || !stream.subs.size || !stream.state) return
    stream.timer = setTimeout(stream.flush, Math.max(0, stream.last + stream.interval - Date.now()))
  }
  server.subscribers = streams.lounge.subs
  server.agentSubscribers = streams.agents.subs
  server.agentConnections = agentSocks
  const close = server.close.bind(server)
  server.close = (cb) => {
    for (const stream of Object.values(streams)) {
      clearTimeout(stream.timer)
      for (const sock of stream.subs) sock.end()
    }
    for (const sock of agentSocks) sock.end()
    return close(cb)
  }

  return new Promise((resolve, reject) => {
    const p = sockPath()
    if (process.platform !== 'win32') ensureDir(runDir())
    const listen = (retried) => {
      server.once('error', async (err) => {
        if (err.code !== 'EADDRINUSE' || retried || process.platform === 'win32') return reject(err)
        // Socket file exists: is another autochat alive, or is it stale?
        const alive = await send({ type: 'ping' }, 400)
        if (alive) return reject(Object.assign(new Error('autochat already running'), { code: 'ALREADY_RUNNING', info: alive }))
        try { fs.unlinkSync(p) } catch {}
        listen(true)
      })
      server.listen(p, () => {
        if (process.platform !== 'win32') { try { fs.chmodSync(p, 0o600) } catch {} }
        resolve(server)
      })
    }
    listen(false)
  })
}

// Resolves to the UI's reply object, or null if no UI is listening.
export function send (msg, timeoutMs = 500) {
  return new Promise((resolve) => {
    let done = false
    const finish = (v) => { if (!done) { done = true; clearTimeout(timer); sock.destroy(); resolve(v) } }
    const sock = net.connect(sockPath())
    const timer = setTimeout(() => finish(null), timeoutMs)
    let buf = ''
    sock.setEncoding('utf8')
    sock.on('connect', () => sock.write(JSON.stringify(msg) + '\n'))
    sock.on('data', (d) => {
      buf += d
      const i = buf.indexOf('\n')
      if (i !== -1) {
        try { finish(JSON.parse(buf.slice(0, i))) } catch { finish(null) }
      }
    })
    sock.on('error', () => finish(null))
    sock.on('close', () => finish(null))
  })
}
