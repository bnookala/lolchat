import { test } from 'node:test'
import assert from 'node:assert/strict'
import { client, agent, start, ok, texts, sleep } from './helpers/agents.js'
import { AgentRoom } from '../src/agents.js'

test('human stream: agents snapshot, ack gating agents.say, interventions in every inbox', async (t) => {
  const acks = []
  const { room } = await start(t, { onAck: () => acks.push(true) })
  const a = await agent()
  ok(await a.cmd('status', { summary: 'working', focus: { paths: ['src/a.js'] } }))
  const human = client()
  human.send({ type: 'subscribe', v: 1, client: 'test', stream: 'agents' })
  const snap = await human.next(m => m.type === 'agents', 5000, 'agents snapshot')
  assert.deepEqual(Object.keys(snap), ['type', 'v', 'now', 'tier', 'human', 'ack', 'agents', 'threads', 'messages'])
  assert.deepEqual([snap.v, snap.tier, snap.human, snap.ack], [1, 'local', 'stormy-newt-59', false])
  assert.deepEqual(snap.agents.map(c => [c.name, c.summary, c.present]), [['copilot-repo', 'working', true]])

  let r = await human.cmd('agents.say', { text: 'please stop', thread: null, to: [] })
  assert.deepEqual([r.ok, r.error], [false, 'ack-required'])
  assert.deepEqual(acks, [])
  r = await human.cmd('agents.ack')
  assert.deepEqual(r, { type: 'reply', id: r.id, ok: true })
  assert.deepEqual(acks, [true])
  await human.next(m => m.type === 'agents' && m.ack === true, 5000, 'ack in snapshot')
  r = await human.cmd('agents.say', { text: 'focus on the tests, @copilot-repo', thread: null, to: [] })
  const said = r.result.message
  assert.deepEqual([said.kind, said.intervention, said.thread], ['human', true, null])
  assert.deepEqual(said.from, { name: null, display: 'stormy-newt-59 (human)', human: 'stormy-newt-59', harness: null, repo: null, id: null })
  const inbox = await a.cmd('read')
  assert.deepEqual(texts(ok(inbox).messages), ['focus on the tests, @copilot-repo'])
  assert.equal((await human.cmd('agents.say', { text: 'x', to: ['ghost'] })).error, 'unknown agent: ghost')
  assert.equal((await human.cmd('say', { text: 'x' })).error, 'unknown command', 'lounge commands are not on this stream')
  // Snapshots coalesce to ≤ 10/s and carry the last 300 messages.
  assert.ok(room.snapshot().messages.length <= 300)
  human.close()
  a.close()
})

// --- Connect agents (#65) ----------------------------------------------------------------------

// The daemon's harness functions (src/harness-jobs.js) as fakes: plans as plain data, with
// src/harness/index.js's actions. `fails` makes a harness's setup fail with that error.
const PLANS = [
  { id: 'copilot', name: 'Copilot CLI', action: 'add', where: '~/.copilot/mcp-config.json', reason: null, detail: ['add to ~/.copilot/mcp-config.json', '+ "autochat": {"type":"local"}'] },
  { id: 'claude', name: 'Claude Code', action: 'none', where: 'claude mcp (user scope)', reason: null, detail: ['already connected (claude mcp (user scope))'] },
  { id: 'gemini', name: 'Gemini CLI', action: 'manual', where: '~/.gemini/settings.json', reason: "~/.gemini/settings.json isn't plain JSON (comments?), so autochat won't rewrite it", detail: ["~/.gemini/settings.json isn't plain JSON (comments?), so autochat won't rewrite it. Add this yourself:", '{', '  "autochat": {}', '}'] },
  { id: 'opencode', name: 'opencode', action: 'update', where: '~/.config/opencode/opencode.json', reason: null, detail: ['update in ~/.config/opencode/opencode.json', '+ "autochat": {}'] },
  { id: 'codex', name: 'Codex', action: 'add', where: '~/.codex/config.toml', reason: null, detail: ['add to ~/.codex/config.toml', '+ [mcp_servers.autochat]'], fails: 'EACCES: permission denied' },
  { id: 'pi', name: 'pi', action: 'absent', where: null, reason: null, detail: ['not installed'] }
]

function deferred () {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

// With `hold`, each planAgents() waits until the test settles it: fake.pending.shift().
function fakeHarnesses ({ hold = false } = {}) {
  const fake = {
    plans: PLANS.map(p => ({ ...p })),
    calls: { plan: 0, setup: [] },
    pending: [],
    now: () => fake.plans.map(({ fails, ...p }) => ({ ...p, detail: [...p.detail] })),
    planAgents () {
      fake.calls.plan++
      if (!hold) return Promise.resolve(fake.now())
      const d = deferred()
      fake.pending.push(d)
      return d.promise
    },
    async setupAgents ({ ids }) {
      fake.calls.setup.push(ids)
      const applied = []
      const failed = []
      for (const p of fake.plans.filter(p => ids.includes(p.id) && ['add', 'update'].includes(p.action))) {
        if (p.fails) failed.push({ id: p.id, error: p.fails })
        else { p.action = 'none'; applied.push(p.id) }
      }
      return { applied, failed, plans: fake.now() }
    }
  }
  return fake
}

const changed = (room) => new Promise(resolve => room.once('change', resolve))
async function until (fn, ms = 5000) {
  for (const end = Date.now() + ms; !fn(); await sleep(10)) if (Date.now() > end) throw new Error('timed out')
}
// The plan the room starts with has come back (the fakes answer at once).
const planned = (room) => until(() => room.summary().connected.length > 0)
const subscribe = async () => {
  const h = client()
  h.send({ type: 'subscribe', v: 1, client: 'test', stream: 'agents' })
  await h.next(m => m.type === 'agents', 5000, 'agents snapshot')
  return h
}

test('lounge summary: never null; connected (ok, update) and available (add) from the plan; active agents', async (t) => {
  const bare = new AgentRoom({ human: 'h' })
  assert.deepEqual(bare.summary(), { present: 0, openThreads: 0, connected: [], available: [], active: 0 }, 'no agent yet, no harnesses: still an object')
  bare.close()

  const fake = fakeHarnesses()
  const { room } = await start(t, { harnesses: fake })
  assert.equal(fake.calls.plan, 1, 'the room plans as it starts')
  await planned(room)
  const s = room.summary()
  assert.deepEqual(Object.keys(s), ['present', 'openThreads', 'connected', 'available', 'active'])
  assert.deepEqual(s, { present: 0, openThreads: 0, connected: ['claude', 'opencode'], available: ['copilot', 'codex'], active: 0 }, 'manual and absent are in neither list')

  const a = await agent()
  const b = await agent({ pid: 4343, branch: 'feat-y' })
  assert.deepEqual([room.summary().present, room.summary().active], [2, 0], 'idle until they set a status or post (board.js)')
  ok(await a.cmd('status', { summary: 'naming things' }))
  assert.deepEqual([room.summary().present, room.summary().active], [2, 1], 'active counts agents with active !== false')
  ok(await b.cmd('post', { text: 'on it' }))
  assert.deepEqual([room.summary().present, room.summary().active], [2, 2])
  ok(await a.cmd('thread', { action: 'open', title: 'naming' }))
  assert.equal(room.summary().openThreads, 1)
  b.close()
  await until(() => room.summary().present === 1)
  assert.deepEqual([room.summary().present, room.summary().active], [1, 1], 'an agent that dropped is neither present nor active')
  assert.equal(fake.calls.plan, 1, 'every summary within a minute is cached')
  a.close()
})

test('lounge summary: refreshed at most once a minute, in the background, and the newest plan wins', async (t) => {
  let clock = 1_000_000
  const fake = fakeHarnesses({ hold: true })
  const logged = []
  const { room } = await start(t, { harnesses: fake, now: () => clock })
  room.on('error-log', (err) => logged.push(err.message))
  assert.equal(fake.pending.length, 1)
  for (let i = 0; i < 5; i++) room.summary()
  assert.equal(fake.calls.plan, 1, 'one plan a minute, even while it runs')
  assert.deepEqual(room.summary().available, [], 'the snapshot never waits for the plan')
  let change = changed(room)
  fake.pending.shift().resolve(fake.now())
  await change
  assert.deepEqual([room.summary().connected, room.summary().available], [['claude', 'opencode'], ['copilot', 'codex']])

  clock += 59_999
  room.summary()
  assert.equal(fake.calls.plan, 1, 'not yet a minute old')
  clock += 1
  const s = room.summary()
  assert.equal(fake.calls.plan, 2, 'a minute old: a new plan, in the background')
  assert.deepEqual(s.connected, ['claude', 'opencode'], 'meanwhile, the last plan, at once')
  fake.plans.find(p => p.id === 'codex').action = 'none'
  change = changed(room)
  fake.pending.shift().resolve(fake.now())
  await change
  assert.deepEqual([room.summary().connected, room.summary().available], [['claude', 'opencode', 'codex'], ['copilot']])

  // A plan that fails keeps the lists, is logged, and isn't retried before another minute.
  clock += 60_000
  room.summary()
  fake.pending.shift().reject(new Error('the harness check exited (1)'))
  await until(() => logged.length > 0)
  assert.deepEqual(logged, ['the harness check exited (1)'])
  assert.deepEqual(room.summary().connected, ['claude', 'opencode', 'codex'])
  assert.equal(fake.calls.plan, 3)

  // A refresh that started before agents.setupPlan finished doesn't overwrite it.
  clock += 60_000
  room.summary()
  const stale = fake.pending.shift()
  const human = await subscribe()
  const asked = human.cmd('agents.setupPlan')
  await until(() => fake.pending.length > 0)
  fake.plans.find(p => p.id === 'copilot').action = 'none'
  fake.pending.shift().resolve(fake.now())
  ok(await asked)
  assert.deepEqual(room.summary().available, [])
  stale.resolve(PLANS.map(({ fails, ...p }) => p))
  await sleep(10)
  assert.deepEqual(room.summary().available, [], 'the older plan is ignored')
  human.close()
})

test('agents.setupPlan: one plan per harness, {id, name, action, where, detail}', async (t) => {
  const fake = fakeHarnesses()
  await start(t, { harnesses: fake })
  const human = await subscribe()
  const r = ok(await human.cmd('agents.setupPlan'))
  assert.deepEqual(Object.keys(r), ['plans'])
  assert.deepEqual(r.plans.map(p => Object.keys(p)), r.plans.map(() => ['id', 'name', 'action', 'where', 'detail']))
  assert.deepEqual(r.plans.map(p => [p.id, p.action, p.where]), [
    ['copilot', 'add', '~/.copilot/mcp-config.json'],
    ['claude', 'ok', 'claude mcp (user scope)'],
    ['gemini', 'manual', '~/.gemini/settings.json'],
    ['opencode', 'update', '~/.config/opencode/opencode.json'],
    ['codex', 'add', '~/.codex/config.toml'],
    ['pi', 'absent', null]
  ])
  assert.equal(r.plans[0].name, 'Copilot CLI')
  assert.ok(r.plans.every(p => Array.isArray(p.detail) && p.detail.every(l => typeof l === 'string')), 'detail is a list of lines')
  assert.deepEqual(r.plans[2].detail.slice(0, 2), ["~/.gemini/settings.json isn't plain JSON (comments?), so autochat won't rewrite it. Add this yourself:", '{'])
  assert.equal(fake.calls.plan, 2, 'a fresh plan, not the summary\'s')
  human.close()
})

test('agents.setup: only the listed harnesses; unknown ids fail; connected is fresh at once', async (t) => {
  const fake = fakeHarnesses()
  const { room } = await start(t, { harnesses: fake })
  await planned(room)
  const human = await subscribe()
  const change = changed(room)
  const r = ok(await human.cmd('agents.setup', { harnesses: ['copilot', 'codex', 'claude', 'gemini', 'pi', 'nope', 'copilot'] }))
  assert.deepEqual(fake.calls.setup, [['copilot', 'codex', 'claude', 'gemini', 'pi', 'nope']], 'once each, in order; opencode is left alone')
  assert.deepEqual(r, {
    applied: ['copilot', 'claude'],
    failed: [
      { id: 'codex', error: 'EACCES: permission denied' },
      { id: 'gemini', error: "~/.gemini/settings.json isn't plain JSON (comments?), so autochat won't rewrite it" },
      { id: 'pi', error: "pi isn't installed" },
      { id: 'nope', error: 'unknown harness: nope' }
    ]
  }, 'an already connected harness counts as applied')
  await change
  assert.deepEqual([room.summary().connected, room.summary().available], [['copilot', 'claude', 'opencode'], ['codex']], 'refreshed from the plan made after the changes')
  assert.equal(fake.plans.find(p => p.id === 'opencode').action, 'update', 'opencode wasn\'t listed, so it stays as it was')

  for (const [harnesses, error] of [
    [undefined, 'harnesses must be a list of harness ids'],
    ['copilot', 'harnesses must be a list of harness ids'],
    [['copilot', 7], 'harnesses must be a list of harness ids'],
    [[], 'harnesses is empty'],
    [Array.from({ length: 17 }, (_, i) => `h${i}`), 'harnesses has too many ids (max 16)']
  ]) {
    assert.equal((await human.cmd('agents.setup', { harnesses })).error, error)
  }
  assert.equal(fake.calls.setup.length, 1, 'bad arguments never reach the harnesses')
  human.close()
})

test('agents.setup: one at a time, and a refresh from before it can\'t undo it', async (t) => {
  let clock = 0
  const fake = fakeHarnesses({ hold: true })
  const { room } = await start(t, { harnesses: fake, now: () => clock })
  fake.pending.shift().resolve(fake.now())
  await changed(room)
  clock += 60_000
  room.summary()
  const stale = fake.pending.shift()
  const order = []
  const setup = fake.setupAgents
  fake.setupAgents = async (args) => { order.push('start ' + args.ids); await sleep(30); const r = await setup(args); order.push('end ' + args.ids); return r }
  const human = await subscribe()
  const [one, two] = await Promise.all([human.cmd('agents.setup', { harnesses: ['copilot'] }), human.cmd('agents.setup', { harnesses: ['opencode'] })])
  assert.deepEqual([ok(one).applied, ok(two).applied], [['copilot'], ['opencode']])
  assert.deepEqual(order, ['start copilot', 'end copilot', 'start opencode', 'end opencode'])
  stale.resolve(PLANS.map(({ fails, ...p }) => p))
  await sleep(10)
  assert.deepEqual([room.summary().connected, room.summary().available], [['copilot', 'claude', 'opencode'], ['codex']], 'the refresh that started before the setups is ignored')
  human.close()
})

test('Connect agents is for humans: agent connections get unknown command', async (t) => {
  const fake = fakeHarnesses()
  const { room } = await start(t, { harnesses: fake })
  await planned(room)
  const a = await agent()
  assert.equal((await a.cmd('agents.setupPlan')).error, 'unknown command')
  assert.equal((await a.cmd('agents.setup', { harnesses: ['copilot'] })).error, 'unknown command')
  assert.deepEqual([fake.calls.plan, fake.calls.setup], [1, []], 'the harnesses were never asked')
  assert.deepEqual(room.summary().available, ['copilot', 'codex'])
  a.close()
})

test('Connect agents without harness functions (not the daemon) says so', async (t) => {
  await start(t)
  const human = await subscribe()
  assert.equal((await human.cmd('agents.setupPlan')).error, 'connecting agents needs the autochat daemon')
  assert.equal((await human.cmd('agents.setup', { harnesses: ['copilot'] })).error, 'connecting agents needs the autochat daemon')
  human.close()
})
