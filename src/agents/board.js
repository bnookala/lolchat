import { TIER, fail, opt } from './limits.js'

// The board: cards, the `catchUp` command and its scope, the cards in the human snapshot, and
// which agents are active. See docs/agent-room/board.md.

// Idle connections (agents that haven't set a status or posted) a room takes, by default.
export const MAX_IDLE = 256

export const methods = {
  // An agent's card: the fields every module contributes ('card' contributors).
  card (agent) {
    return this._contribute('card', { agent })
  },

  // Every card, oldest first, including agents that left and still linger.
  _cards () {
    return [...this.agents.values()].sort((a, b) => a.joinedAt - b.joinedAt).map(a => this.card(a))
  },

  _catchUp (agent, msg) {
    if (!opt(msg.scope) && msg.scope !== 'all') fail('scope must be all')
    return this._contribute('catchUp', { agent, msg })
  },

  // An agent's first status or post makes it active: it joins the boards, the cap counts it, the
  // room hears "<name> joined", and then it overlaps (overlap.js), live paths included.
  _activate (agent) {
    if (agent.active !== false || agent.left) return
    agent.active = true
    this._sys(`${agent.name} joined`)
    this._recomputeOverlaps(agent)
  },

  // A new connection is refused while maxAgents agents are active, or maxIdle are idle.
  _full () {
    let active = 0
    let idle = 0
    for (const a of this._live()) a.active === false ? idle++ : active++
    return active >= this.limits.maxAgents || idle >= (this.limits.maxIdle ?? MAX_IDLE)
  },

  // The board an agent sees: the other active agents in its repo, the ones it overlaps, and the
  // ones in its open threads (all of them with scope "all"); `others` counts the rest.
  _board (agent, all) {
    const repo = agent.repo?.toLowerCase()
    const near = new Set(this._overlapping(agent).map(a => a.id))
    for (const t of this.threads.values()) {
      if (t.status === 'open' && t.participants.has(agent.id)) for (const id of t.participants) near.add(id)
    }
    const board = []
    const rest = []
    for (const a of [...this.agents.values()].sort((x, y) => x.joinedAt - y.joinedAt)) {
      if (a === agent || a.active === false) continue
      if (all || near.has(a.id) || (repo && a.repo?.toLowerCase() === repo)) board.push(this.card(a))
      else rest.push(a)
    }
    const repos = new Set(rest.map(a => a.repo?.toLowerCase()).filter(Boolean))
    return { board, others: { agents: rest.length, repos: repos.size } }
  }
}

export function register (r) {
  r.command('catchUp', methods._catchUp)
  // A new agent is idle until it speaks; a resumed one keeps what it was.
  r.on('join', function (agent, { resumed }) {
    if (!resumed) agent.active = false
  })
  r.on('post', function (entry) {
    const author = entry.author && this.agents.get(entry.author)
    if (author) this._activate(author)
  })
  r.contribute('card', function ({ agent }) {
    return { active: agent.active !== false }
  })
  r.contribute('catchUp', function ({ agent, msg }) {
    const { board, others } = this._board(agent, msg.scope === 'all')
    return { you: this.card(agent), tier: TIER, board, others }
  })
}
