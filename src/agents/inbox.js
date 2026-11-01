import { AgentError, fail, int, isStr, label, opt } from './limits.js'
import { normalizeName } from './names.js'
import { sanitize } from '../text.js'

// The inbox: who gets a message (its audience), the doorbell, delivering (marking read), the
// cursor, and the `read` and `wait` commands. See docs/agent-room/inbox.md.

// The doorbell names the read tool as each harness shows it to its model.
const READ_TOOL = { copilot: 'autochat-read', claude: 'mcp__autochat__read', codex: 'mcp__autochat__read', opencode: 'autochat_read', pi: 'autochat_read' }
// What rings, most important first: anything else in the inbox (a human's message to everyone)
// waits for the agent's next read.
const RINGS = ['mention', 'reply', 'overlap', 'decision', 'thread']
const MENTION_VERBS = {
  question: ['asked you a question', 'asked you {n} questions'],
  proposal: ['sent you a proposal', 'sent you {n} proposals'],
  handoff: ['handed off to you', 'handed off to you {n} times']
}
const plural = ([one, many], n) => n === 1 ? one : many.replace('{n}', n)
const quote = (s) => `“${sanitize(s || '', 60)}”`

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
  },

  // --- the doorbell (#52) ---------------------------------------------------------------------

  /**
   * The one-shot `doorbell` message from a harness hook, plugin or extension, after one of its
   * agent's tool calls: `{text}`, the line the harness puts in front of its model, or
   * `{text: null}`. `parentPid(pid)`, when given, resolves to a process's parent: then the
   * answer may be a promise (see hello.js's _sessionAgent).
   */
  doorbell (msg, { parentPid = null } = {}) {
    if (!this.agents.size || !msg || typeof msg !== 'object') return { text: null }
    const who = {
      harness: isStr(msg.harness) ? normalizeName(msg.harness).slice(0, 20) || null : null,
      sessionId: isStr(msg.sessionId) && /^[A-Za-z0-9_-]{1,128}$/.test(msg.sessionId) ? msg.sessionId : null,
      pid: int(msg.pid) && msg.pid > 1 ? msg.pid : null
    }
    const found = this._sessionAgent(who, parentPid)
    if (found && typeof found.then === 'function') return found.then((agent) => ({ text: this._ring(agent, who.harness) }))
    return { text: this._ring(found, who.harness) }
  },

  // What's arrived for the agent since its last ring, as one line, or null: nothing new, rung
  // in the last minute, or reading the room right now (a wait).
  _ring (agent, harness) {
    if (!agent || agent.left || agent.wait || this.closed) return null
    const now = this.now()
    if (agent.bell.at && now - agent.bell.at < this.limits.doorbellMs) return null
    const items = []
    for (const [seq, mention] of agent.unread) {
      if (seq <= agent.bell.seq) continue
      const entry = this.bySeq.get(seq)
      const kind = entry && this._bellKind(agent, entry, mention)
      if (kind) items.push({ entry, kind })
    }
    if (!items.length) return null
    agent.bell = { seq: items.at(-1).entry.msg.seq, at: now }
    const text = this._bellText(agent, items, harness || agent.harness)
    this.emit('doorbell', this.card(agent), text)
    return text
  },

  _bellKind (agent, entry, mention) {
    const m = entry.msg
    if (m.kind === 'overlap') return 'overlap'
    if (m.kind === 'decision') return 'decision'
    if (mention) return 'mention'
    if (m.replyTo !== null && this.bySeq.get(m.replyTo)?.author === agent.id) return 'reply'
    if (m.thread !== null && this.threads.get(m.thread)?.participants.has(agent.id)) return 'thread'
    return null
  },

  // "autochat: copilot-x asked you a question; you overlap with claude-web on src/a.js. Read them
  // with mcp__autochat__read before you go on." Who, what, and what to do: a real model brought
  // up a line like that, and not a bare count.
  _bellText (agent, items, harness) {
    const who = (m) => m.from?.name || m.from?.display || 'someone'
    const thread = (m) => this.threads.get(m.thread)
    const parts = new Map()
    const add = (key, n, text) => {
      const p = parts.get(key)
      if (p) p.n += n
      else parts.set(key, { n, text })
    }
    const sorted = [...items].sort((a, b) => RINGS.indexOf(a.kind) - RINGS.indexOf(b.kind) || a.entry.msg.seq - b.entry.msg.seq)
    for (const { entry: { msg: m }, kind } of sorted) {
      if (kind === 'mention') {
        const verbs = MENTION_VERBS[m.kind] || ['wrote to you', 'wrote to you {n} times']
        add(`mention:${who(m)}:${verbs[0]}`, 1, (n) => `${who(m)} ${plural(verbs, n)}`)
      } else if (kind === 'reply') {
        add(`reply:${who(m)}`, 1, (n) => `${who(m)} ${plural(['replied to you', 'replied to you {n} times'], n)}`)
      } else if (kind === 'overlap') {
        const other = m.to.find(name => name !== agent.name) || 'another agent'
        const on = m.text.includes(' both touch ') ? m.text.slice(m.text.indexOf(' both touch ') + 12) : ''
        add(`overlap:${m.seq}`, 1, () => `you overlap with ${other}${on ? ` on ${sanitize(on, 100)}` : ''}`)
      } else if (kind === 'decision') {
        add(`decision:${m.seq}`, 1, () => thread(m) ? `${who(m)} decided ${quote(thread(m).title)}` : `${who(m)} posted a decision`)
      } else {
        add(`thread:${m.thread}`, 1, (n) => n === 1 ? `${who(m)} wrote in ${quote(thread(m)?.title)}` : `${n} new messages in ${quote(thread(m)?.title)}`)
      }
    }
    const max = this.limits.doorbellText
    const tool = READ_TOOL[harness] || 'autochat\'s read tool'
    const end = `. Read ${items.length === 1 ? 'it' : 'them'} with ${tool} before you go on.`
    let line = 'autochat: '
    let left = items.length
    let first = true
    for (const { n, text } of parts.values()) {
      const part = (first ? '' : '; ') + text(n)
      const rest = left - n ? `; and ${left - n} more` : ''
      if (line.length + part.length + rest.length + end.length > max) break
      line += part
      left -= n
      first = false
    }
    if (first) line += `${items.length} new for you`
    else if (left) line += `; and ${left} more`
    return sanitize(line + end, max)
  }
}

const ASKS = ['question', 'proposal']
const DONE_HINT = 'Before you stop, answer what is addressed to you, wait (up to 50 s, at most twice) for replies, then post a handoff covering anything unresolved.'
const isPending = (p) => p.unread > 0 || p.openThreads.length > 0 || p.unanswered.length > 0

export function register (r) {
  r.command('read', methods._read)
  r.command('wait', methods._wait)
  // The doorbell's state: what the agent was last rung for (its newest seq), and when.
  r.on('join', function (agent, { resumed }) {
    if (!resumed || !agent.bell) agent.bell = { seq: this.seq, at: 0 }
  })
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
