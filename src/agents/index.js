import { EventEmitter } from 'node:events'
import { LIMITS, AgentError, fail, hex } from './limits.js'
import * as guardrails from './guardrails.js'
import * as names from './names.js'
import * as hello from './hello.js'
import * as status from './status.js'
import * as presence from './presence.js'
import * as overlap from './overlap.js'
import * as board from './board.js'
import * as posts from './posts.js'
import * as threads from './threads.js'
import * as inbox from './inbox.js'
import * as human from './human.js'

// The local agent room: agents of the same OS user on this machine, hosted by
// `autochat daemon` over the unix socket. Memory only, and no network: this module (and
// everything it imports) must never load Hyperswarm, the DHT or any socket API.
// See docs/agent-room/README.md.
//
// This file is the composition root: the room's shared state, the dispatch of commands, the
// message log, and the registries. Each concern is a module in this directory that mixes its
// methods into AgentRoom and registers its commands, contributors and hooks.

export { AGENT_PROTOCOL, TIER, STATES, POST_KINDS, LIMITS, AgentError } from './limits.js'
export { normalizeName, defaultName, dedupeName } from './names.js'
export { normalizePath, overlapOn } from './overlap.js'

// The modules, in order. Contributors and hooks run in this order, then in registration order
// within a module: that order is what keeps the keys of every result, card and message in their
// documented order.
const MODULES = [guardrails, names, hello, status, presence, overlap, board, posts, threads, inbox, human]

// Contributors add fields to a result. fn.call(room, ctx, result) returns an object whose fields
// are merged into `result`, or null for none. A new key goes at the end; an existing key keeps
// its place.
//   card     ctx {agent}                       an agent's card
//   catchUp  ctx {agent, msg}                  the catchUp result
//   status   ctx {agent, msg}                  the status result
//   post     ctx {agent, msg, entry, thread}   the post result
//   read     ctx {agent, msg}                  the read result
//   message  ctx {entry}                       a message as agents and humans see it
export const CONTRIBUTIONS = ['card', 'catchUp', 'status', 'post', 'read', 'message']

// Hooks: fn.call(room, ...args).
//   init     ()                           a new room: set up the module's state on `this`
//   join     (agent, {resumed})           after the welcome, for a new or a resumed agent
//   leave    (agent)                      the agent has left (its resume window is over)
//   post     (entry, {thread, mentions})  a message was added to the log: posts, sys, overlap, human
//   status   (agent, msg)                 a status command was applied; its result comes next
//   deliver  (agent, entries)             catchUp, read or wait returns these, now marked read
export const HOOKS = ['init', 'join', 'leave', 'post', 'status', 'deliver']

export const registry = {
  commands: new Map(), // agent command name → fn.call(room, agent, msg)
  humanCommands: new Map(), // agents-stream command name → fn.call(room, msg)
  contributors: Object.fromEntries(CONTRIBUTIONS.map(k => [k, []])),
  hooks: Object.fromEntries(HOOKS.map(k => [k, []]))
}

/**
 * Events: `change` (anything visible changed), `presence` (event, card) with event
 * joined | away | back | left.
 */
export class AgentRoom extends EventEmitter {
  constructor ({ human, ack = false, onAck = () => {}, now = Date.now, limits = {}, harnesses = null } = {}) {
    super()
    this.human = human || 'me'
    this.ack = !!ack
    this.onAck = onAck
    this.harnesses = harnesses // human.js: the daemon's {planAgents, setupAgents}, for Connect agents
    this.now = now
    this.limits = { ...LIMITS, ...limits }
    this.agents = new Map()
    this.log = []
    this.bySeq = new Map()
    this.seq = 0
    this.everConnected = false
    this.closed = false
    // Module state: tokens (hello.js), formerNames (names.js), pairs (overlap.js), threads (threads.js).
    this._hook('init')
    this.pruneTimer = setInterval(() => this._prune(), 60000)
    this.pruneTimer.unref?.()
  }

  // --- registries ------------------------------------------------------------------

  _hook (name, ...args) {
    for (const fn of registry.hooks[name]) fn.apply(this, args)
  }

  _contribute (target, ctx, result = {}) {
    for (const fn of registry.contributors[target]) {
      const fields = fn.call(this, ctx, result)
      if (fields) Object.assign(result, fields)
    }
    return result
  }

  // --- the agent protocol -------------------------------------------------------------

  _onLine (agent, peer, msg) {
    if (agent.peer !== peer) return
    const id = msg?.id ?? null
    const reply = (r) => {
      if (agent.peer !== peer) return
      peer.send({ type: 'reply', id, ...r, inbox: this._inbox(agent) })
    }
    const failed = (err) => reply({ ok: false, error: err?.message || String(err), ...(err?.retryAfterMs !== undefined ? { retryAfterMs: err.retryAfterMs } : {}) })
    if (!msg || typeof msg !== 'object') return failed(new Error('invalid json'))
    if (msg.type !== 'cmd') return failed(new Error('unknown message type'))
    let result
    try {
      result = this._command(agent, msg)
    } catch (err) {
      if (!(err instanceof AgentError)) this.emit('error-log', err)
      return failed(err)
    }
    if (result && typeof result.then === 'function') {
      result.then((r) => reply({ ok: true, result: r }), failed)
    } else {
      reply({ ok: true, result })
    }
  }

  _command (agent, msg) {
    const run = registry.commands.get(msg.cmd)
    if (!run) fail('unknown command')
    return run.call(this, agent, msg)
  }

  // --- messages ------------------------------------------------------------------

  _sys (text) {
    this._append({ kind: 'sys', from: null, text })
  }

  _append (m, opts = {}) {
    const now = this.now()
    const msg = {
      seq: ++this.seq,
      id: hex(8),
      ts: now,
      kind: m.kind,
      from: m.from ?? null,
      thread: m.thread ?? null,
      to: m.to ?? [],
      replyTo: m.replyTo ?? null,
      text: m.text,
      intervention: m.kind === 'human'
    }
    const thread = msg.thread ? this.threads.get(msg.thread) : null
    const { audience, mentions } = this._route(msg, thread, opts)
    const entry = { msg, author: opts.author ?? null, audience }
    this.log.push(entry)
    this.bySeq.set(msg.seq, entry)
    // threads.js counts it; inbox.js puts it in its audience's inboxes and wakes their waits.
    this._hook('post', entry, { thread, mentions })
    if (this.log.length > this.limits.historyMax) this._prune()
    this._changed()
    return entry
  }

  _msgView (entry) {
    const m = entry.msg
    return this._contribute('message', { entry }, { ...m, from: m.from && { ...m.from }, to: [...m.to] })
  }

  _prune () {
    const now = this.now()
    const L = this.limits
    let drop = 0
    while (drop < this.log.length && (this.log.length - drop > L.historyMax || now - this.log[drop].msg.ts > L.historyMs)) drop++
    if (drop) {
      for (const e of this.log.splice(0, drop)) {
        this.bySeq.delete(e.msg.seq)
        for (const id of e.audience) this.agents.get(id)?.unread.delete(e.msg.seq)
      }
    }
    for (const [id, t] of this.threads) {
      const since = t.status === 'resolved' ? t.resolvedAt : t.lastAt
      if (now - since > L.threadMs) this.threads.delete(id)
    }
    if (drop) this._changed()
  }

  // --- humans (the `agents` stream) ---------------------------------------------------

  // Commands on an agents-stream subscription. Throws to reply {ok:false, error}.
  command (msg) {
    const run = registry.humanCommands.get(msg.cmd)
    if (!run) fail('unknown command')
    return run.call(this, msg)
  }

  _changed () {
    if (!this.closed) this.emit('change')
  }

  close () {
    this.closed = true
    clearInterval(this.pruneTimer)
    for (const a of this.agents.values()) {
      clearTimeout(a.awayTimer)
      clearTimeout(a.removeTimer)
      this._cancelWait(a, 'shutting down')
      const peer = a.peer
      a.peer = null
      peer?.end()
    }
  }
}

// --- composition -----------------------------------------------------------------------------

const define = (map, kind) => (name, fn) => {
  if (map.has(name)) throw new Error(`${kind} ${name} is registered twice`)
  map.set(name, fn)
}
const listed = (lists, kind) => (name, fn) => {
  if (!Object.hasOwn(lists, name)) throw new Error(`unknown ${kind}: ${name}`)
  lists[name].push(fn)
}

// What each module's register(r) gets.
const r = {
  command: define(registry.commands, 'command'),
  humanCommand: define(registry.humanCommands, 'agents-stream command'),
  contribute: listed(registry.contributors, 'contribution'),
  on: listed(registry.hooks, 'hook')
}

for (const m of MODULES) {
  for (const [key, desc] of Object.entries(Object.getOwnPropertyDescriptors(m.methods || {}))) {
    if (Object.hasOwn(AgentRoom.prototype, key)) throw new Error(`AgentRoom.${key} is defined twice`)
    Object.defineProperty(AgentRoom.prototype, key, { ...desc, enumerable: false })
  }
  m.register?.(r)
}
