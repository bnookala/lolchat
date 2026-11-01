import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agent, start, ok, texts, sleep } from './helpers/agents.js'

test('catchUp: you, tier, board, others, threads, last decisions, recent main stream, unread inbox, cursor', async (t) => {
  const { room } = await start(t)
  const a = await agent({ harness: 'copilot' })
  const b = await agent({ harness: 'claude' })
  ok(await a.cmd('status', { summary: 'auth', state: 'exploring' }))
  for (let i = 0; i < 3; i++) ok(await a.cmd('post', { text: 'note ' + i }))
  ok(await a.cmd('post', { kind: 'decision', text: 'use the lock' }))
  ok(await a.cmd('post', { text: 'for you', to: ['claude-repo'] }))
  const reply = await b.cmd('catchUp')
  const r = ok(reply)
  assert.deepEqual(Object.keys(r), ['you', 'tier', 'board', 'others', 'threads', 'relevant', 'decisions', 'recent', 'inbox', 'cursor', 'pending'])
  assert.equal(r.you.name, 'claude-repo')
  assert.equal(r.tier, 'local')
  assert.deepEqual(r.board.map(c => [c.name, c.summary, c.state, c.present, c.active]), [['copilot-repo', 'auth', 'exploring', true, true]])
  assert.deepEqual(r.others, { agents: 0, repos: 0 })
  assert.deepEqual(texts(r.inbox), ['use the lock', 'for you'], 'unread inbox; decisions count')
  assert.deepEqual(r.decisions, [], 'not repeated when already in the inbox')
  assert.deepEqual(texts(r.recent), ['copilot-repo joined', 'note 0', 'note 1', 'note 2'], 'claude-repo is idle: no joined line')
  assert.equal(r.cursor, room.seq)
  assert.deepEqual(reply.inbox, { unread: 0, mentions: 0 }, 'catchUp marks the inbox read')
  // A card before any status: idle, no summary, empty focus, not active.
  const fresh = await agent({ harness: 'gemini' })
  const card = ok(await fresh.cmd('catchUp')).you
  assert.deepEqual([card.state, card.summary, card.focus, card.active], ['idle', null, { issue: null, components: [], paths: [], live: [] }, false])
  assert.deepEqual(Object.keys(card), ['id', 'name', 'display', 'human', 'title', 'parent', 'harness', 'repo', 'branch', 'worktree', 'state', 'summary', 'focus', 'present', 'joinedAt', 'updatedAt', 'presence', 'leftAt', 'overlaps', 'active'])
  assert.equal((await fresh.cmd('catchUp', { scope: 'everyone' })).error, 'scope must be all')
  for (const x of [a, b, fresh]) x.close()
})

// Agents straight on the room, without sockets: commands are synchronous.
function direct (room, hello) {
  const sent = []
  const handler = room.connect({ type: 'agent-hello', v: 1, pid: 1, cwd: '/w', ...hello }, { send: (m) => sent.push(m), end: (m) => { if (m) sent.push(m) } })
  const welcome = sent[0]
  let ids = 0
  return {
    welcome,
    id: welcome.agent?.id,
    name: welcome.agent?.name,
    cmd (cmd, args = {}) {
      handler.message({ type: 'cmd', id: ++ids, cmd, ...args })
      return sent.at(-1)
    },
    close: () => handler?.close()
  }
}

test('scale: 100 agents in 10 repos; the board has only your repo, your overlaps and your threads, plus counts', async (t) => {
  const { room } = await start(t, { limits: { maxAgents: 1000, statusGapMs: 0 } })
  // Agent i works in repo r<i % 10>. The first 60 set a status (active); the other 40 stay idle.
  const agents = []
  for (let i = 0; i < 100; i++) agents.push(direct(room, { harness: 'copilot', name: `agent-${i}`, repo: `o/r${i % 10}`, branch: 'main' }))
  for (let i = 0; i < 60; i++) ok(agents[i].cmd('status', { summary: `task ${i}`, focus: { paths: [`src/f${i}.js`] } }))
  const me = agents[0]
  // A thread with an agent in r3 (open), and one with an agent in r5 (resolved).
  ok(me.cmd('thread', { action: 'open', title: 'cross-repo api', with: ['agent-13'] }))
  const done = ok(me.cmd('thread', { action: 'open', title: 'old question', with: ['agent-15'] })).thread
  ok(me.cmd('thread', { action: 'resolve', thread: done.id, outcome: 'settled' }))
  // An agent in r7 starts a thread with an idle agent in r0: neither is on my board.
  ok(agents[7].cmd('thread', { action: 'open', title: 'not mine', with: ['agent-70'] }))

  let r = ok(me.cmd('catchUp'))
  const names = r.board.map(c => c.name)
  assert.deepEqual(names, ['agent-10', 'agent-13', 'agent-20', 'agent-30', 'agent-40', 'agent-50'], 'my active repo-mates and my open thread\'s participant')
  assert.ok(r.board.every(c => c.active), 'never an idle agent')
  // 59 other active agents; 6 on the board; 53 left out, in 9 repos (r1 … r9).
  assert.deepEqual(r.others, { agents: 53, repos: 9 })

  // An overlap brings an agent from my repo… (overlaps are within a repo); a later status keeps it.
  ok(agents[10].cmd('status', { focus: { paths: ['src/f0.js'] } }))
  assert.ok(ok(me.cmd('catchUp')).board.some(c => c.name === 'agent-10' && c.overlaps.includes('agent-0')))

  // scope "all": every active card but mine.
  r = ok(me.cmd('catchUp', { scope: 'all' }))
  assert.equal(r.board.length, 59)
  assert.ok(r.board.every(c => c.active))
  assert.deepEqual(r.others, { agents: 0, repos: 0 })

  // An agent outside git sees only the participants of its threads.
  const loose = direct(room, { harness: 'claude', name: 'loose', repo: null, branch: null })
  ok(loose.cmd('post', { kind: 'question', text: 'who owns r4?', to: ['agent-4'] }))
  r = ok(loose.cmd('catchUp'))
  assert.deepEqual([r.board.map(c => c.name), r.others], [['agent-4'], { agents: 59, repos: 10 }])

  // The human snapshot still lists everyone; cards carry `active`.
  const snap = room.snapshot()
  assert.equal(snap.agents.length, 101)
  assert.deepEqual([snap.agents.filter(c => c.active).length, snap.agents.filter(c => !c.active).length], [61, 40])
  for (const a of [...agents, loose]) a.close()
})

test('caps: maxAgents counts active agents only; idle connections are capped too (too many agents)', async (t) => {
  const { room } = await start(t, { limits: { maxAgents: 2, maxIdle: 3, resumeMs: 20, lingerMs: 20 } })
  const idle = [1, 2, 3].map(i => direct(room, { harness: 'copilot', name: `idle-${i}` }))
  assert.ok(idle.every(a => a.welcome.type === 'agent-welcome'))
  const refused = direct(room, { harness: 'copilot', name: 'one-more' })
  assert.deepEqual(refused.welcome, { type: 'error', v: 1, error: 'too many agents' }, 'past the idle cap')
  // Two of them speak: they're active, and the idle cap has room again…
  ok(idle[0].cmd('status', { summary: 'busy' }))
  ok(idle[1].cmd('post', { text: 'hello' }))
  // …but maxAgents (2) are active, so a new connection is refused.
  assert.deepEqual(direct(room, { harness: 'copilot', name: 'late' }).welcome.error, 'too many agents')
  // One active agent leaves: room again.
  idle[0].close()
  await sleep(60)
  const next = direct(room, { harness: 'copilot', name: 'next' })
  assert.equal(next.welcome.type, 'agent-welcome')
  // An idle agent that's already in may still become active.
  ok(idle[2].cmd('status', { summary: 'me too' }))
  assert.deepEqual(room.snapshot().agents.filter(c => c.active && c.present).map(c => c.name), ['idle-2', 'idle-3'])
  for (const a of [...idle, next]) a.close()
})

test('joined and left: an agent joins when it first sets a status or posts; idle connections come and go silently', async (t) => {
  const { room } = await start(t, { limits: { resumeMs: 20, lingerMs: 1000, statusGapMs: 0 } })
  const lines = () => room.snapshot().messages.filter(m => m.kind === 'sys').map(m => m.text)
  // Idle: no line when it connects, renames or leaves.
  const idle = direct(room, { harness: 'copilot', name: 'idle-one' })
  idle.close()
  await sleep(60)
  assert.deepEqual(lines(), [])
  assert.equal(room.snapshot().agents.find(c => c.name === 'idle-one').present, false)

  // A first status: joined, before that status's overlap notices; a rename while idle is silent.
  const a = direct(room, { harness: 'copilot', name: 'a', repo: 'o/r' })
  const b = direct(room, { harness: 'claude', name: 'b', repo: 'o/r' })
  ok(a.cmd('post', { text: 'first words' }))
  assert.deepEqual(room.snapshot().messages.slice(-2).map(m => m.text), ['first words', 'a joined'], 'a first post: right after it')
  ok(a.cmd('status', { focus: { paths: ['src/x.js'] } }))
  ok(b.cmd('status', { name: 'bee', focus: { paths: ['src/x.js'] } }))
  assert.deepEqual(room.snapshot().messages.slice(-2).map(m => [m.kind, m.text]), [['sys', 'bee joined'], ['overlap', 'bee and a both touch src/x.js']])
  assert.ok(!lines().some(l => l.includes(' is now ')), 'no rename line for an idle agent')
  // Active agents rename and leave out loud; a resume is silent.
  ok(b.cmd('status', { name: 'bea' }))
  const token = a.welcome.resume
  a.close()
  const back = direct(room, { harness: 'copilot', resume: token })
  assert.equal(back.id, a.id)
  back.close()
  await sleep(60)
  assert.deepEqual(lines(), ['a joined', 'bee joined', 'bee is now bea', 'a left'])
  b.close()
})
