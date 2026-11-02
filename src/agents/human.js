import { AGENT_PROTOCOL, TIER, fail, isStr, label } from './limits.js'

// Humans: the `agents` stream snapshot, the lounge's summary of the room, and the agents-stream
// commands `agents.ack`, `agents.say`, and Connect agents' `agents.setupPlan` and `agents.setup`.
// See docs/agent-room/human.md.

// Connect agents: the daemon passes `harnesses` ({planAgents, setupAgents}, src/harness-jobs.js).
// Their plans carry src/harness/index.js's actions; the protocol says `ok` for `none`.
const SETUP_ACTIONS = new Map([['add', 'add'], ['update', 'update'], ['none', 'ok'], ['manual', 'manual'], ['absent', 'absent']])
// How old the summary's `connected` and `available` may get while someone reads it.
const HARNESS_REFRESH_MS = 60000
const MAX_HARNESSES = 16
const UNAVAILABLE = 'connecting agents needs the autochat daemon'

export const methods = {
  snapshot () {
    return {
      type: 'agents',
      v: AGENT_PROTOCOL,
      now: this.now(),
      tier: TIER,
      human: this.human,
      ack: this.ack,
      agents: this._cards(),
      threads: this._threadList(),
      messages: this.log.slice(-this.limits.snapshotMessages).map(e => this._msgView(e))
    }
  },

  // For the lounge `state` snapshot. It never waits: `connected` and `available` are the last
  // plan's, and a plan a minute old starts a new one in the background.
  summary () {
    let open = 0
    for (const t of this.threads.values()) if (t.status === 'open') open++
    const here = [...this.agents.values()].filter(a => a.present)
    this._refreshHarnesses()
    return {
      present: here.length,
      openThreads: open,
      connected: [...this.harnessPlan.connected],
      available: [...this.harnessPlan.available],
      // Present agents that have set a status or posted (agent.active, board.js).
      active: here.filter(a => a.active !== false).length
    }
  },

  _ack () {
    if (!this.ack) {
      this.ack = true
      this.onAck()
      this._changed()
    }
    return undefined
  },

  _say (msg) {
    if (!this.ack) fail('ack-required')
    const text = this._text(msg.text, this.limits.text)
    const thread = this._openThread(msg.thread)
    const toIds = this._resolveNames(msg.to)
    const entry = this._append({
      kind: 'human',
      from: { name: null, display: `${this.human} (human)`, human: this.human, harness: null, repo: null, id: null },
      thread: thread ? thread.id : null,
      to: toIds.map(id => this._nameOf(id)),
      text
    }, { toIds })
    return { message: this._msgView(entry) }
  },

  // --- Connect agents ------------------------------------------------------------------------

  async _setupPlan () {
    const plans = await this._planHarnesses()
    return {
      plans: plans.map(p => ({
        id: p.id,
        name: p.name,
        action: SETUP_ACTIONS.get(p.action) ?? 'manual',
        where: p.where ?? null,
        detail: Array.isArray(p.detail) ? p.detail : []
      }))
    }
  },

  // One setup at a time: each one plans, writes and plans again from the files as they are then.
  _setupAgents (msg) {
    const ids = harnessIds(msg.harnesses)
    if (!this.harnesses) fail(UNAVAILABLE)
    const run = this.harnessPlan.busy.then(() => this._applyHarnesses(ids))
    this.harnessPlan.busy = run.catch(() => {})
    return run
  },

  async _applyHarnesses (ids) {
    const r = await this.harnesses.setupAgents({ ids })
    const plans = Array.isArray(r?.plans) ? r.plans : null
    if (plans) {
      // Planned after the changes: newer than any refresh still running, so it wins.
      this.harnessPlan.gen++
      this.harnessPlan.checkedAt = this.now()
      this._noteHarnesses(plans)
    }
    const byId = new Map((plans || []).map(p => [p.id, p]))
    const done = new Set(r?.applied || [])
    const errors = new Map((r?.failed || []).map(f => [f.id, f.error]))
    const applied = []
    const failed = []
    for (const id of ids) {
      const p = byId.get(id)
      if (done.has(id) || (!errors.has(id) && p?.action === 'none')) applied.push(id)
      else if (errors.has(id)) failed.push({ id, error: String(errors.get(id) || 'failed') })
      else if (!p) failed.push({ id, error: `unknown harness: ${label(id)}` })
      else if (p.action === 'absent') failed.push({ id, error: `${p.name} isn't installed` })
      else failed.push({ id, error: p.reason || `${p.name} wasn't set up (${p.action})` })
    }
    return { applied, failed }
  },

  // A fresh plan. The newest one started also becomes the summary's.
  async _planHarnesses () {
    if (!this.harnesses) fail(UNAVAILABLE)
    const h = this.harnessPlan
    const gen = ++h.gen
    h.checkedAt = this.now()
    const plans = await this.harnesses.planAgents()
    if (!Array.isArray(plans)) throw new Error('planAgents() returned no plans')
    if (gen === h.gen) this._noteHarnesses(plans)
    return plans
  },

  // `connected`: autochat is registered (plan `none`, or `update` when it's out of date).
  // `available`: installed, and autochat can register itself (`add`).
  _noteHarnesses (plans) {
    const h = this.harnessPlan
    const ids = (...actions) => plans.filter(p => actions.includes(p.action)).map(p => p.id)
    const connected = ids('none', 'update')
    const available = ids('add')
    if (connected.join() === h.connected.join() && available.join() === h.available.join()) return
    h.connected = connected
    h.available = available
    this._changed()
  },

  // A plan counts from when it starts, and gives up long before a minute (src/harness-jobs.js),
  // so background plans never overlap.
  _refreshHarnesses () {
    if (!this.harnesses || this.closed || this.now() - this.harnessPlan.checkedAt < HARNESS_REFRESH_MS) return
    this._planHarnesses().catch((err) => this.emit('error-log', err))
  }
}

function harnessIds (v) {
  if (!Array.isArray(v) || v.some(id => !isStr(id))) fail('harnesses must be a list of harness ids')
  if (!v.length) fail('harnesses is empty')
  if (v.length > MAX_HARNESSES) fail(`harnesses has too many ids (max ${MAX_HARNESSES})`)
  return [...new Set(v)]
}

export function register (r) {
  r.on('init', function () {
    // Connect agents: the last plan's harnesses, when it started, and the setup running now.
    this.harnessPlan = { connected: [], available: [], checkedAt: -Infinity, gen: 0, busy: Promise.resolve() }
    this._refreshHarnesses()
  })
  r.humanCommand('agents.ack', methods._ack)
  r.humanCommand('agents.say', methods._say)
  r.humanCommand('agents.setupPlan', methods._setupPlan)
  r.humanCommand('agents.setup', methods._setupAgents)
}
