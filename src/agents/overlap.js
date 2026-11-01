import { sanitize, charCount } from '../text.js'
import { fail, isStr } from './limits.js'

// Overlap: normalized paths and components, what two cards share, the one-time `overlap` notice
// per pair, the live git paths an agent's client sends (`paths`), and the components already on
// the board. See docs/agent-room/overlap.md.

export function normalizePath (p) {
  if (!isStr(p)) return null
  let s = sanitize(p, Infinity).replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  while (s.startsWith('./')) s = s.slice(2)
  s = s.replace(/\/+$/, '')
  return !s || s === '.' ? null : s
}

/**
 * A component's comparison key: lowercase; runs of spaces, `_`, `.` and `-` become one `-`, with
 * none at either end; and each word (between `-`) longer than 3 letters drops a trailing `s`. So
 * "Greetings", "greeting" and "GREETING" match. Cards keep the original strings.
 */
export function normalizeComponent (c) {
  if (!isStr(c)) return ''
  return c.toLowerCase().replace(/[\s_.-]+/g, '-').replace(/^-|-$/g, '')
    .split('-').map(w => w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w).join('-')
}

// "src" covers "src/room.js": directory prefixes on path-segment boundaries.
function dirPrefixes (p) {
  const out = []
  for (let i = p.indexOf('/', 1); i > 0; i = p.indexOf('/', i + 1)) out.push(p.slice(0, i))
  return out
}

export function pathIndex (paths) {
  const set = new Set(paths)
  const dirs = new Set()
  for (const p of paths) for (const d of dirPrefixes(p)) dirs.add(d)
  return { paths, set, dirs }
}

function sharedPaths (a, b) {
  const out = new Set()
  for (const p of a.paths) {
    if (b.set.has(p) || dirPrefixes(p).some(d => b.set.has(d))) out.add(p)
    else if (b.dirs.has(p)) for (const q of b.paths) if (q.startsWith(p + '/')) out.add(q)
  }
  return [...out].sort()
}

/**
 * What two agents' cards share: same non-null repo, plus the same issue, a shared component
 * (compared normalized) or an overlapping path (focus.paths and live paths). Returns null when
 * they don't overlap.
 */
export function overlapOn (a, b) {
  if (!a.repo || !b.repo || a.repo.toLowerCase() !== b.repo.toLowerCase()) return null
  const on = {}
  if (a.focus.issue !== null && a.focus.issue === b.focus.issue) on.issue = a.focus.issue
  const theirs = new Set(b.focus.components.map(normalizeComponent).filter(Boolean))
  const components = a.focus.components.filter(c => theirs.has(normalizeComponent(c)))
  if (components.length) on.components = components
  const paths = sharedPaths(a.pathIndex, b.pathIndex)
  if (paths.length) on.paths = paths
  return Object.keys(on).length ? on : null
}

function describeOverlap (on) {
  const bits = []
  if (on.issue !== undefined) bits.push(`issue #${on.issue}`)
  for (const c of on.components || []) bits.push(`component ${c}`)
  const paths = on.paths || []
  bits.push(...paths.slice(0, 3))
  return bits.join(', ') + (paths.length > 3 ? ` (+${paths.length - 3} more)` : '')
}

const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i])

export const methods = {
  // After the card's focus.paths or its live paths change: overlap uses both.
  _indexPaths (agent) {
    const live = agent.live || []
    agent.pathIndex = pathIndex(live.length ? [...new Set([...agent.focus.paths, ...live])] : agent.focus.paths)
  },

  _recomputeOverlaps (agent) {
    for (const other of this._live()) {
      if (other === agent) continue
      const key = [agent.id, other.id].sort().join(':')
      const on = overlapOn(agent, other)
      if (!on) { this.pairs.delete(key); continue }
      const fresh = !this.pairs.has(key)
      this.pairs.set(key, { a: agent.id, b: other.id })
      if (fresh) {
        this._append({
          kind: 'overlap',
          from: null,
          to: [agent.name, other.name],
          text: `${agent.name} and ${other.name} both touch ${describeOverlap(on)}`
        }, { audience: [agent.id, other.id], mentions: [agent.id, other.id] })
      }
    }
  },

  _overlapping (agent) {
    const out = []
    for (const p of this.pairs.values()) {
      if (p.a !== agent.id && p.b !== agent.id) continue
      const other = this.agents.get(p.a === agent.id ? p.b : p.a)
      if (other && !other.left) out.push(other)
    }
    return out
  },

  _overlapsOf (agent) {
    return this._overlapping(agent).map(other => ({ agent: other.name, on: overlapOn(agent, other) }))
  },

  // `paths`: the live git paths the agent's client sends while it works (focus.live). At most one
  // applies every pathsGapMs: one that comes sooner waits for the end of the gap (the latest
  // wins), and its reply says so.
  _paths (agent, msg) {
    const live = this._livePaths(msg.paths)
    const wait = agent.livePathsAt === null ? 0 : agent.livePathsAt + this.limits.pathsGapMs - this.now()
    if (wait > 0) {
      agent.livePending = live
      if (!agent.liveTimer) {
        agent.liveTimer = setTimeout(() => this._applyLivePaths(agent), wait)
        agent.liveTimer.unref?.()
      }
      return { overlaps: this._overlapsOf(agent), deferred: true, appliesInMs: wait }
    }
    this._setLivePaths(agent, live)
    return { overlaps: this._overlapsOf(agent) }
  },

  _livePaths (paths) {
    const L = this.limits
    if (paths === null) return []
    if (!Array.isArray(paths) || paths.some(p => !isStr(p))) fail('paths must be a list of strings')
    if (paths.length > L.paths) fail(`paths has too many entries (max ${L.paths})`)
    const out = new Set()
    for (const p of paths) {
      if (charCount(p) > L.path) fail(`paths entries are at most ${L.path} characters`)
      const n = normalizePath(p)
      if (n) out.add(n)
    }
    return [...out]
  },

  _applyLivePaths (agent) {
    const live = agent.livePending
    agent.liveTimer = null
    agent.livePending = null
    if (live && !agent.left && !this.closed) this._setLivePaths(agent, live)
  },

  _setLivePaths (agent, live) {
    clearTimeout(agent.liveTimer)
    agent.liveTimer = null
    agent.livePending = null
    agent.livePathsAt = this.now()
    if (sameList(agent.live, live)) return
    agent.live = live
    this._indexPaths(agent)
    this._recomputeOverlaps(agent)
    this._changed()
  },

  // The components on the other cards of the agent's repo (ones that left too, while their cards
  // linger), most recently updated card first, one spelling per normalized name.
  _knownComponents (agent) {
    const repo = agent.repo?.toLowerCase()
    if (!repo) return []
    const out = []
    const seen = new Set()
    const cards = [...this.agents.values()].filter(a => a !== agent && a.repo?.toLowerCase() === repo)
    for (const a of cards.sort((x, y) => y.updatedAt - x.updatedAt)) {
      for (const c of a.focus.components) {
        const key = normalizeComponent(c)
        if (!key || seen.has(key)) continue
        seen.add(key)
        out.push(c)
        if (out.length >= this.limits.knownComponents) return out
      }
    }
    return out
  }
}

export function register (r) {
  // Overlapping pairs, "<id>:<id>" → {a, b}: notified once, until the overlap clears.
  r.on('init', function () { this.pairs = new Map() })
  r.command('paths', methods._paths)
  r.on('join', function (agent, { resumed }) {
    if (resumed) this._recomputeOverlaps(agent)
    else Object.assign(agent, { live: [], livePathsAt: null, livePending: null, liveTimer: null })
  })
  r.on('status', function (agent) { this._recomputeOverlaps(agent) })
  r.on('leave', function (agent) {
    for (const [key, p] of this.pairs) if (p.a === agent.id || p.b === agent.id) this.pairs.delete(key)
    clearTimeout(agent.liveTimer)
    agent.liveTimer = null
    agent.livePending = null
  })
  r.contribute('card', function ({ agent }, card) {
    return {
      focus: { ...card.focus, live: [...(agent.live || [])] },
      overlaps: agent.left ? [] : this._overlapping(agent).map(o => o.name)
    }
  })
  r.contribute('status', function ({ agent }) {
    return { overlaps: this._overlapsOf(agent), knownComponents: this._knownComponents(agent) }
  })
}
