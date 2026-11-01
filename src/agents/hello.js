import { AGENT_PROTOCOL, TIER, hex, isStr, int } from './limits.js'
import { normalizeName, defaultName, dedupeName } from './names.js'
import { pathIndex } from './overlap.js'
import { sanitize } from '../text.js'

// Hello: an agent connects, its hello is parsed, it gets a welcome and a resume token, and a
// resume reclaims the same agent. See docs/agent-room/hello.md.

export const methods = {
  /**
   * A new agent connection whose first line was `agent-hello`. `peer` is
   * {send(obj), end(obj)}. Returns the connection handler {message(msg), close()}, or null
   * after refusing (the error line is sent and the connection ended).
   */
  connect (hello, peer) {
    const refuse = (error) => { peer.end({ type: 'error', v: AGENT_PROTOCOL, error }); return null }
    if (this.closed) return refuse('shutting down')
    if (hello.v !== undefined && hello.v !== AGENT_PROTOCOL) return refuse('unsupported protocol version')
    const info = this._helloInfo(hello)
    let agent = isStr(hello.resume) ? this.agents.get(this.tokens.get(hello.resume)) : null
    if (agent?.left) agent = null
    const resumed = !!agent
    if (agent) {
      clearTimeout(agent.awayTimer)
      agent.awayTimer = null
      this._cancelWait(agent, 'superseded')
      const old = agent.peer
      agent.peer = null
      if (old) old.end()
      Object.assign(agent, info)
    } else {
      if (this._full()) return refuse('too many agents')
      const now = this.now()
      const taken = this._takenNames()
      const name = dedupeName(normalizeName(hello.name) || defaultName(info), taken, info.branch)
      agent = {
        id: this._newAgentId(),
        token: hex(16),
        name,
        ...info,
        state: 'idle',
        summary: null,
        focus: { issue: null, components: [], paths: [] },
        pathIndex: pathIndex([]),
        joinedAt: now,
        updatedAt: now,
        present: true,
        left: false,
        leftAt: null,
        cursor: this.seq,
        unread: new Map(),
        posts: { main: [], thread: [] },
        lastStatusAt: null,
        wait: null,
        awayTimer: null,
        removeTimer: null,
        peer: null
      }
      this.agents.set(agent.id, agent)
      this.tokens.set(agent.token, agent.id)
    }
    agent.peer = peer
    agent.present = true
    this.everConnected = true
    peer.send({
      type: 'agent-welcome',
      v: AGENT_PROTOCOL,
      tier: TIER,
      room: 'local',
      resume: agent.token,
      agent: { id: agent.id, name: agent.name, human: this.human, display: this._display(agent), harness: agent.harness, title: this._titleOf(agent) }
    })
    // board.js makes a new agent idle until it speaks; overlap.js recomputes a resumed one's.
    this._hook('join', agent, { resumed })
    this.emit('presence', resumed ? 'back' : 'joined', this.card(agent))
    this._changed()
    return {
      message: (msg) => this._onLine(agent, peer, msg),
      close: () => this._onClose(agent, peer)
    }
  },

  _helloInfo (h) {
    const str = (v, max) => isStr(v) && v ? sanitize(v, max) : null
    const pid = (v) => int(v) && v > 0 ? v : null
    const repo = isStr(h.repo) && /^[\w.-]+\/[\w.-]+$/.test(h.repo) && h.repo.length <= 140 ? h.repo : null
    return {
      helloTitle: this._helloTitle(h.title),
      harness: normalizeName(h.harness).slice(0, 20) || 'agent',
      pid: pid(h.pid),
      harnessPid: pid(h.harnessPid),
      sessionId: str(h.sessionId, 128),
      cwd: str(h.cwd, 300),
      repo,
      branch: str(h.branch, 200),
      worktree: str(h.worktree, 100)
    }
  },

  _newAgentId () {
    let id
    do id = hex(4); while (this.agents.has(id))
    return id
  },

  // --- which agent a harness session is (the doorbell) -------------------------------------

  // Keeps the session and harness-pid index in step with the agent's hello.
  _indexHello (agent) {
    this._unindexHello(agent)
    const key = agent.sessionId ? `${agent.harness}:${agent.sessionId}` : null
    if (key) this.helloSessions.set(key, agent.id)
    if (agent.harnessPid) {
      if (!this.helloPids.has(agent.harnessPid)) this.helloPids.set(agent.harnessPid, new Set())
      this.helloPids.get(agent.harnessPid).add(agent.id)
    }
    agent.indexed = { key, pid: agent.harnessPid }
    this.helloGen++
  },

  _unindexHello (agent) {
    const was = agent.indexed
    if (!was) return
    if (was.key && this.helloSessions.get(was.key) === agent.id) this.helloSessions.delete(was.key)
    const ids = this.helloPids.get(was.pid)
    if (ids) { ids.delete(agent.id); if (!ids.size) this.helloPids.delete(was.pid) }
    agent.indexed = null
    this.helloGen++
  },

  // The live agent with this harnessPid; the one that joined last, when there are several (pi
  // starts a new session in the same process).
  _agentByPid (pid) {
    let best = null
    for (const id of this.helloPids.get(pid) || []) {
      const a = this.agents.get(id)
      if (a && !a.left && (!best || a.joinedAt >= best.joinedAt)) best = a
    }
    return best
  },

  /**
   * The agent a harness session belongs to, or null: the one whose hello has this `sessionId`,
   * else this `harnessPid`, else the harnessPid of `pid`'s parent (a hook runs in a shell under
   * its harness): `parentPid(pid)` resolves to it, so the answer may be a promise. Remembered
   * per session, so a session that isn't in the room costs one map lookup until agents come or
   * go.
   */
  _sessionAgent ({ harness, sessionId, pid }, parentPid = null) {
    const key = sessionId ? `${harness}:${sessionId}` : null
    const hit = key && this.helloCache.get(key)
    if (hit) {
      const a = hit.id && this.agents.get(hit.id)
      if (a && !a.left) return a
      if (!hit.id && hit.gen === this.helloGen) return null
      this.helloCache.delete(key)
    }
    const gen = this.helloGen
    const remember = (a) => {
      if (key && gen === this.helloGen) {
        this.helloCache.delete(key)
        this.helloCache.set(key, { id: a ? a.id : null, gen })
        if (this.helloCache.size > 512) this.helloCache.delete(this.helloCache.keys().next().value)
      }
      return a
    }
    const id = key && this.helloSessions.get(key)
    const known = (id && this.agents.get(id)) || (pid && this._agentByPid(pid))
    if (known && !known.left) return remember(known)
    if (!pid || !parentPid || !this.helloPids.size) return remember(null)
    return Promise.resolve()
      .then(() => parentPid(pid))
      .then((ppid) => remember(int(ppid) && ppid > 1 ? this._agentByPid(ppid) : null), () => remember(null))
  }
}

export function register (r) {
  // Resume tokens → agent ids, while an agent can still resume.
  r.on('init', function () { this.tokens = new Map() })
  // board.js: a first status makes the agent active. Registered here, before overlap.js, so its
  // "<name> joined" comes before that status's overlap notices.
  r.on('status', function (agent) { this._activate(agent) })
  // For the doorbell: "<harness>:<sessionId>" and harnessPid → agent ids, from the hellos of the
  // agents that haven't left; which agent each harness session that rang is (or null for none,
  // while helloGen, the index's version, stays the same).
  r.on('init', function () {
    this.helloSessions = new Map()
    this.helloPids = new Map()
    this.helloCache = new Map()
    this.helloGen = 0
  })
  r.on('join', function (agent) { this._indexHello(agent) })
  r.on('leave', function (agent) { this._unindexHello(agent) })
  r.contribute('card', function ({ agent }) {
    return { harness: agent.harness, repo: agent.repo, branch: agent.branch, worktree: agent.worktree }
  })
}
