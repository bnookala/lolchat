import { AgentError, fail, int, isStr, label, opt } from './limits.js'

// The inbox: who gets a message (its audience), the doorbell, delivering (marking read), the
// cursor, and the `read` and `wait` commands. See docs/agent-room/inbox.md.

export const methods = {
  // A new message's audience (whose inbox it lands in) and which of them it mentions.
  _route (msg, thread, { author = null, audience = null, mentions = null, toIds = [], replyTo = null }) {
    let aud
    let men
    if (audience) {
      aud = new Set(audience)
      men = new Set(mentions || [])
    } else {
      men = new Set([...toIds, ...(msg.kind === 'sys' ? [] : this._mentionIds(msg.text))])
      aud = new Set(men)
      if (msg.kind === 'decision' || msg.kind === 'human') for (const a of this._live()) aud.add(a.id)
      if (replyTo !== null) { const parent = this.bySeq.get(replyTo); if (parent?.author) aud.add(parent.author) }
      if (thread) for (const id of thread.participants) aud.add(id)
    }
    if (author) { aud.delete(author); men.delete(author) }
    for (const id of aud) {
      const a = this.agents.get(id)
      if (!a || a.left) { aud.delete(id); men.delete(id) }
    }
    return { audience: aud, mentions: men }
  },

  // The doorbell on every reply: unread inbox messages, and how many mention you.
  _inbox (agent) {
    let mentions = 0
    for (const m of agent.unread.values()) if (m) mentions++
    return { unread: agent.unread.size, mentions }
  },

  // Marks entries read and returns their views.
  _deliver (agent, entries) {
    for (const e of entries) agent.unread.delete(e.msg.seq)
    this._hook('deliver', agent, entries)
    return entries.map(e => this._msgView(e))
  },

  _read (agent, msg) {
    const L = this.limits
    const limit = opt(msg.limit) ? L.readDefault : msg.limit
    if (!int(limit) || limit < 1 || limit > L.readMax) fail(`limit must be 1-${L.readMax}`)
    if (!opt(msg.since) && !(int(msg.since) && msg.since >= 0)) fail('since must be a message seq (0 or more)')
    const scope = opt(msg.scope) ? 'inbox' : msg.scope
    if (!['inbox', 'all'].includes(scope)) fail('scope must be inbox or all')
    if (!opt(msg.thread)) {
      if (!isStr(msg.thread) || !this.threads.has(msg.thread)) fail(`unknown thread: ${label(msg.thread)}`)
      const since = Math.min(msg.since ?? 0, this.seq)
      const all = this.log.filter(e => e.msg.thread === msg.thread && e.msg.seq > since)
      const page = all.slice(0, limit)
      return this._contribute('read', { agent, msg }, { messages: this._deliver(agent, page), cursor: page.length ? page.at(-1).msg.seq : since, hasMore: all.length > page.length })
    }
    // A `since` from before a daemon restart can be ahead of this daemon's seq.
    const since = Math.min(msg.since ?? agent.cursor, this.seq)
    const match = scope === 'all' ? () => true : (e) => e.audience.has(agent.id)
    const all = this.log.filter(e => e.msg.seq > since && match(e))
    const page = all.slice(0, limit)
    const hasMore = all.length > page.length
    const cursor = hasMore ? page.at(-1).msg.seq : Math.max(since, this.seq)
    agent.cursor = Math.max(agent.cursor, cursor)
    return this._contribute('read', { agent, msg }, { messages: this._deliver(agent, page), cursor, hasMore })
  },

  _wait (agent, msg) {
    const L = this.limits
    let timeoutMs = opt(msg.timeoutMs) ? L.waitDefaultMs : msg.timeoutMs
    if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs)) fail('timeoutMs must be a number')
    timeoutMs = Math.min(L.waitMaxMs, Math.max(0, Math.round(timeoutMs)))
    let thread = null
    if (!opt(msg.thread)) {
      if (!isStr(msg.thread) || !this.threads.has(msg.thread)) fail(`unknown thread: ${label(msg.thread)}`)
      thread = msg.thread
    }
    if (agent.wait) this._cancelWait(agent, 'superseded')
    const since = thread
      ? Math.min(this.seq, ...this.log.filter(e => e.msg.thread === thread && agent.unread.has(e.msg.seq)).map(e => e.msg.seq - 1))
      : null
    return new Promise((resolve, reject) => {
      const w = { thread, since, resolve, reject, timer: null, pending: false, peer: agent.peer }
      agent.wait = w
      const done = (timedOut) => {
        clearTimeout(w.timer)
        if (agent.wait === w) agent.wait = null
        // Only the connection that asked gets (and marks read) the messages.
        if (agent.peer !== w.peer) return reject(new AgentError('superseded'))
        const entries = this._waitMatches(agent, w)
        const messages = this._deliver(agent, entries)
        let cursor
        if (thread) {
          cursor = entries.length ? entries.at(-1).msg.seq : w.since
        } else {
          agent.cursor = Math.max(agent.cursor, this.seq)
          cursor = agent.cursor
        }
        resolve({ messages, cursor, timedOut: timedOut && !messages.length })
      }
      w.check = () => {
        if (w.pending || !this._waitMatches(agent, w).length) return
        w.pending = true
        setImmediate(() => {
          w.pending = false
          if (agent.wait !== w) return
          if (this._waitMatches(agent, w).length) done(false)
        })
      }
      w.timer = setTimeout(() => { if (agent.wait === w) done(true) }, timeoutMs)
      w.timer.unref?.()
      if (this._waitMatches(agent, w).length) done(false)
    })
  },

  _waitMatches (agent, w) {
    if (!w.thread) return this.log.filter(e => agent.unread.has(e.msg.seq))
    return this.log.filter(e => e.msg.thread === w.thread && e.msg.seq > w.since && e.author !== agent.id)
  },

  _cancelWait (agent, error) {
    const w = agent.wait
    if (!w) return
    agent.wait = null
    clearTimeout(w.timer)
    if (error) w.reject(new AgentError(error))
  },

  // What's still open for the agent (#53, the closeout): its unread inbox, the open threads it
  // takes part in, and its questions and proposals that nobody answered (no message from someone
  // else with that `replyTo`) outside resolved threads.
  _pending (agent) {
    const answered = new Set()
    for (const e of this.log) if (e.msg.replyTo !== null && e.author !== agent.id) answered.add(e.msg.replyTo)
    const unanswered = this.log.filter(e => e.author === agent.id && ASKS.includes(e.msg.kind) &&
      !answered.has(e.msg.seq) && this.threads.get(e.msg.thread)?.status !== 'resolved')
    return {
      unread: agent.unread.size,
      openThreads: [...this.threads.values()].filter(t => t.status === 'open' && t.participants.has(agent.id)).map(t => t.id),
      unanswered: unanswered.map(e => e.msg.seq)
    }
  }
}

const ASKS = ['question', 'proposal']
const DONE_HINT = 'Before you stop, answer what is addressed to you, wait (up to 50 s, at most twice) for replies, then post a handoff covering anything unresolved.'
const isPending = (p) => p.unread > 0 || p.openThreads.length > 0 || p.unanswered.length > 0

export function register (r) {
  r.command('read', methods._read)
  r.command('wait', methods._wait)
  // A new message lands in its audience's inboxes, and wakes their waits.
  r.on('post', function (entry, { mentions }) {
    for (const id of entry.audience) this.agents.get(id).unread.set(entry.msg.seq, mentions.has(id))
    for (const a of this.agents.values()) a.wait?.check()
  })
  r.contribute('catchUp', function ({ agent }) {
    const unread = this.log.filter(e => agent.unread.has(e.msg.seq))
    const inbox = unread.slice(0, this.limits.readMax)
    const seen = new Set(inbox)
    const decisions = this.log.filter(e => e.msg.kind === 'decision').slice(-this.limits.decisions).filter(e => !seen.has(e))
    const recent = this.log.filter(e => e.msg.thread === null).slice(-this.limits.recent).filter(e => !seen.has(e))
    const cursor = inbox.length < unread.length ? inbox.at(-1).msg.seq : this.seq
    agent.cursor = Math.max(agent.cursor, cursor)
    return {
      decisions: this._deliver(agent, decisions),
      recent: this._deliver(agent, recent),
      inbox: this._deliver(agent, inbox),
      cursor: agent.cursor
    }
  })
  // The closeout (#53): what's still open, after the inbox above was delivered; and a status "done"
  // with something still open gets a hint.
  for (const target of ['catchUp', 'status', 'read']) {
    r.contribute(target, function ({ agent }) { return { pending: this._pending(agent) } })
  }
  r.contribute('status', function ({ msg }, result) {
    return msg.state === 'done' && isPending(result.pending) ? { hint: DONE_HINT } : null
  })
}
