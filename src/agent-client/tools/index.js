import { ToolError, pick } from './common.js'
import * as catchUp from './catch_up.js'
import * as status from './status.js'
import * as post from './post.js'
import * as read from './read.js'
import * as wait from './wait.js'
import * as thread from './thread.js'

// The six agent-room tools, in the order clients list them. Each tools/<tool>.js has the
// definition and the call.
const MODULES = [catchUp, status, post, read, wait, thread]

export const TOOLS = MODULES.map(m => m.tool)

/** The six tools, as calls on a DaemonLink. Results carry provenance and the inbox doorbell. */
export class Tools {
  constructor ({ link, session, onCall = () => {} }) {
    this.link = link
    this.session = session
    // Runs after every tool call: `autochat mcp` and pi poke the live paths sync (binding.js) here.
    this.onCall = onCall
    this.stash = []
    this.declaredPaths = []
  }

  async call (name, args, cancelled = () => false) {
    try {
      const out = await this[name](args, cancelled)
      if (out === null) return null
      return { content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out }
    } catch (err) {
      const extra = err.extra || {}
      let text = err.message
      if (extra.retryAfterMs !== undefined) text += ` (try again in ${Math.ceil(extra.retryAfterMs / 1000)}s)`
      const out = { error: err.message, ...extra }
      return { content: [{ type: 'text', text }], structuredContent: out, isError: true }
    } finally {
      this.onCall(name)
    }
  }

  async _cmd (cmd, args, timeoutMs) {
    const reply = await this.link.request(cmd, args, timeoutMs)
    if (!reply.ok) throw new ToolError(reply.error || 'failed', pick(reply, ['retryAfterMs', 'inbox']))
    return reply
  }

  // Every message from someone else is untrusted; human interventions say so too. Authorship is
  // by agent id (names get reused), against the id of our current connection.
  _mark (m) {
    if (!m || typeof m !== 'object' || m.seq === undefined) return m
    const me = this.link.agent?.id
    const own = m.kind !== 'human' && !!me && m.from?.id === me
    const out = { ...m, untrusted: !own }
    if (m.kind === 'human') out.intervention = true
    return out
  }

  _marked (list = []) {
    const stashed = this.stash.splice(0)
    const seen = new Set(list.map(m => m.seq))
    return [...stashed.filter(m => !seen.has(m.seq)), ...list].map(m => this._mark(m))
  }
}

for (const m of MODULES) Object.defineProperty(Tools.prototype, m.tool.name, { value: m.run, writable: true, configurable: true })
