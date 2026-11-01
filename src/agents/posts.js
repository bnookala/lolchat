import { POST_KINDS, fail, int, isStr, opt } from './limits.js'
import { normalizeName } from './names.js'

// Posts: the `post` command, its recipients, and the question that opens a thread.
// See docs/agent-room/posts.md.

export const methods = {
  _agentPost (agent, msg) {
    let kind = opt(msg.kind) ? 'note' : msg.kind
    if (!POST_KINDS.includes(kind)) fail('kind must be one of ' + POST_KINDS.join(', '))
    const text = this._text(msg.text, this.limits.text)
    let replyTo = null
    if (!opt(msg.replyTo)) {
      if (!int(msg.replyTo) || !this.bySeq.has(msg.replyTo)) fail('replyTo must be the seq of a message in the room')
      replyTo = msg.replyTo
    }
    let thread = this._openThread(msg.thread)
    // A reply to a thread message lands in that thread, unless `thread` says otherwise.
    if (msg.thread === undefined && replyTo !== null) {
      const parent = this.threads.get(this.bySeq.get(replyTo).msg.thread)
      if (parent?.status === 'open') thread = parent
    }
    const recipients = this._postTo(agent, msg.to)
    const toIds = recipients.filter(a => !a.left).map(a => a.id)
    // Everyone it's for has left: it goes to the main stream as a handoff, for whoever picks it up.
    const rerouted = recipients.length > 0 && !toIds.length
    if (rerouted) { kind = 'handoff'; thread = null }
    const autoThread = !thread && kind === 'question' && toIds.length > 0
    if (autoThread || !thread) {
      const wait = this._budget(agent, 'main')
      if (wait !== null) fail('rate limited', { retryAfterMs: wait })
    }
    if (autoThread || thread) {
      const wait = this._budget(agent, 'thread')
      if (wait !== null) fail('rate limited', { retryAfterMs: wait })
    }
    if (autoThread) {
      const title = this._threadTitle(msg.title, text)
      this._spend(agent, 'main')
      thread = this._createThread(agent, title, toIds)
    }
    if (thread) {
      this._spend(agent, 'thread')
      thread.participants.add(agent.id)
      for (const id of toIds) thread.participants.add(id)
    } else {
      this._spend(agent, 'main')
    }
    const entry = this._append({
      kind,
      from: this._from(agent),
      thread: thread ? thread.id : null,
      to: recipients.map(a => a.name),
      replyTo,
      text
    }, { author: agent.id, toIds, replyTo })
    const result = this._contribute('post', { agent, msg, entry, thread })
    result.recipients = recipients.map(a => this._recipient(a))
    if (rerouted) result.rerouted = 'handoff'
    // The closeout (#53): an agent that's done may stop reading. A handoff is what the hint asks for.
    const done = kind === 'handoff' ? [] : recipients.filter(a => a.state === 'done').map(a => a.name)
    if (done.length) result.hint = `${done.join(', ')} ${done.length > 1 ? 'are' : 'is'} done; post a handoff to the room instead`
    return result
  },

  // `to` → the agents it's for, in order, without the poster. Names resolve as everywhere else
  // (names.js), except that the name of an agent that left resolves to its lingering card.
  _postTo (agent, names) {
    // A `to` that isn't a list, or is too long, fails as everywhere else.
    const list = Array.isArray(names) && names.length <= this.limits.to ? names : null
    const gone = list ? list.map(raw => this._leftNamed(raw)) : []
    this._resolveNames(list ? list.filter((raw, i) => !gone[i]) : names)
    const out = []
    for (const [i, raw] of (list || []).entries()) {
      const a = gone[i] || this.agents.get(this._resolveNames([raw])[0])
      if (a !== agent && !out.includes(a)) out.push(a)
    }
    return out
  },

  // The agent that left under this name, unless an agent in the room has the name now.
  _leftNamed (raw) {
    if (!isStr(raw)) return null
    const name = normalizeName(raw.replace(/^@/, '').replace(/^.*\//, ''))
    if (!name || this._live().some(a => a.name === name)) return null
    let found = null
    for (const a of this.agents.values()) if (a.left && a.name === name && (!found || a.leftAt > found.leftAt)) found = a
    return found
  },

  // An entry of the post result's `recipients`.
  _recipient (a) {
    const presence = this._presence(a)
    return { name: a.name, presence, state: a.state, delivered: presence === 'here' }
  }
}

export function register (r) {
  r.command('post', methods._agentPost)
  r.contribute('post', function ({ entry }) {
    return { message: this._msgView(entry) }
  })
}
