import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sleep, agent, start, ok, texts } from './helpers/agents.js'

const { AgentRoom } = await import('../src/agents.js')
const { send } = await import('../src/ipc.js')

test('wait: returns on a match, times out, and a newer wait supersedes the older one', async (t) => {
  await start(t)
  const a = await agent({ harness: 'copilot' })
  const b = await agent({ harness: 'claude' })

  let waiting = b.cmd('wait', { timeoutMs: 5000 })
  await sleep(50)
  ok(await a.cmd('post', { text: 'ignored: not for b' }))
  ok(await a.cmd('post', { text: 'ping @claude-repo' }))
  let r = await waiting
  assert.deepEqual(texts(ok(r).messages), ['ping @claude-repo'])
  assert.equal(ok(r).timedOut, false)
  assert.deepEqual(r.inbox, { unread: 0, mentions: 0 })

  const t0 = Date.now()
  r = ok(await b.cmd('wait', { timeoutMs: 150 }))
  assert.deepEqual([r.messages, r.timedOut], [[], true])
  assert.ok(Date.now() - t0 >= 140)

  // Unread messages return right away.
  ok(await a.cmd('post', { text: 'already here', to: ['claude-repo'] }))
  assert.deepEqual(texts(ok(await b.cmd('wait', { timeoutMs: 5000 })).messages), ['already here'])

  // A newer wait replaces the older one.
  const first = b.cmd('wait', { timeoutMs: 5000 })
  await sleep(30)
  const second = b.cmd('wait', { timeoutMs: 5000 })
  r = await first
  assert.deepEqual([r.ok, r.error], [false, 'superseded'])
  assert.ok(r.inbox)

  // Thread waits return on any new message in that thread.
  const { thread } = ok(await a.cmd('thread', { action: 'open', title: 'naming' }))
  waiting = a.cmd('wait', { thread: thread.id, timeoutMs: 5000 })
  await sleep(30)
  ok(await b.cmd('post', { thread: thread.id, text: 'call it cache' }))
  r = ok(await waiting)
  assert.deepEqual(texts(r.messages), ['call it cache'])
  assert.equal(r.cursor, r.messages[0].seq)
  ok(await a.cmd('post', { text: 'unblock', to: ['claude-repo'] }))
  assert.deepEqual(texts(ok(await second).messages), ['unblock'])
  a.close()
  b.close()
})

const DONE_HINT = 'Before you stop, answer what is addressed to you, wait (up to 50 s, at most twice) for replies, then post a handoff covering anything unresolved.'

test('pending: status, catchUp and read say what is still open: unread, open threads you are in, your unanswered questions and proposals', async (t) => {
  await start(t, { limits: { statusGapMs: 0 } })
  const a = await agent({ harness: 'copilot' })
  const b = await agent({ harness: 'claude' })
  const c = await agent({ harness: 'codex' })
  const none = { unread: 0, openThreads: [], unanswered: [] }
  let s = ok(await a.cmd('status', { state: 'exploring' }))
  assert.deepEqual(Object.keys(s), ['card', 'overlaps', 'knownComponents', 'pending'])
  assert.deepEqual(s.pending, none)

  const q = ok(await a.cmd('post', { kind: 'question', text: 'who owns the cache?', to: ['claude-repo'] }))
  const p = ok(await a.cmd('post', { kind: 'proposal', text: 'let us split the cache module' }))
  ok(await a.cmd('post', { text: 'just a note' }))
  ok(await b.cmd('post', { kind: 'question', text: 'b asks the room' }))
  const other = ok(await b.cmd('thread', { action: 'open', title: 'b and c only', with: ['codex-repo'] }))
  ok(await b.cmd('post', { text: 'fyi @copilot-repo' }))
  ok(await b.cmd('post', { text: 'and @copilot-repo, this too' }))
  assert.equal(ok(await a.cmd('status', {})).pending.unread, 2)
  let r = ok(await a.cmd('read', { limit: 1 }))
  assert.deepEqual(Object.keys(r), ['messages', 'cursor', 'hasMore', 'pending'])
  assert.deepEqual(texts(r.messages), ['fyi @copilot-repo'])
  assert.deepEqual(r.pending, { unread: 1, openThreads: [q.thread.id], unanswered: [q.message.seq, p.message.seq] }, 'counted after the read: one of the two was returned')
  assert.ok(!r.pending.openThreads.includes(other.thread.id), 'not a thread you are in')

  // Replies from someone else answer; your own follow-up doesn't.
  ok(await a.cmd('post', { text: 'more context on my proposal', replyTo: p.message.seq }))
  ok(await b.cmd('post', { kind: 'reply', text: 'I do', replyTo: q.message.seq }))
  const cu = ok(await a.cmd('catchUp'))
  assert.deepEqual(Object.keys(cu).slice(-2), ['cursor', 'pending'])
  assert.deepEqual(cu.pending, { unread: 0, openThreads: [q.thread.id], unanswered: [p.message.seq] }, 'catchUp delivered the inbox first')

  // A question in a resolved thread isn't pending, and neither is the thread; c's open thread is c's.
  const q2 = ok(await a.cmd('post', { kind: 'question', text: 'naming: cache or store?', to: ['codex-repo'] }))
  assert.deepEqual(ok(await a.cmd('read')).pending.unanswered, [p.message.seq, q2.message.seq])
  ok(await c.cmd('thread', { action: 'resolve', thread: q2.thread.id, outcome: 'cache' }))
  ok(await a.cmd('thread', { action: 'resolve', thread: q.thread.id, outcome: 'b owns it' }))
  r = ok(await a.cmd('read'))
  assert.deepEqual(r.pending, { unread: 0, openThreads: [], unanswered: [p.message.seq] })
  assert.deepEqual(ok(await c.cmd('read')).pending.openThreads, [other.thread.id])
  // A thread read reports it too.
  assert.deepEqual(ok(await c.cmd('read', { thread: other.thread.id })).pending.openThreads, [other.thread.id])
  for (const x of [a, b, c]) x.close()
})

test('closeout: a status "done" while anything is pending gets a hint; with nothing pending, none', async (t) => {
  const { room } = await start(t, { limits: { statusGapMs: 0 } })
  const a = await agent({ harness: 'copilot' })
  const b = await agent({ harness: 'claude' })
  ok(await b.cmd('post', { text: 'can you check the parser?', to: ['copilot-repo'] }))
  let s = ok(await a.cmd('status', { state: 'editing' }))
  assert.equal(s.hint, undefined, 'only for done')
  assert.equal(s.pending.unread, 1)

  s = ok(await a.cmd('status', { state: 'done', summary: 'finished the lexer' }))
  assert.equal(s.card.state, 'done', 'done is still set')
  assert.deepEqual(Object.keys(s), ['card', 'overlaps', 'knownComponents', 'pending', 'hint'])
  assert.equal(s.hint, DONE_HINT)
  assert.equal(s.hint.split('. ').length, 1, 'one sentence')

  // Answer, and nothing's pending: no hint.
  const [ask] = ok(await a.cmd('read')).messages
  ok(await a.cmd('post', { kind: 'reply', text: 'checked: fine', replyTo: ask.seq }))
  s = ok(await a.cmd('status', { state: 'done' }))
  assert.deepEqual(s.pending, { unread: 0, openThreads: [], unanswered: [] })
  assert.equal(s.hint, undefined)

  // An open thread or an unanswered proposal is pending too.
  const { thread } = ok(await a.cmd('thread', { action: 'open', title: 'follow-up' }))
  assert.equal(ok(await a.cmd('status', { state: 'done' })).hint, DONE_HINT)
  ok(await a.cmd('thread', { action: 'resolve', thread: thread.id, outcome: 'nothing to do' }))
  ok(await a.cmd('post', { kind: 'proposal', text: 'next: split the parser' }))
  assert.equal(ok(await a.cmd('status', { state: 'done' })).hint, DONE_HINT)
  assert.ok(room.agents.size === 2)
  a.close()
  b.close()
})

// --- the doorbell (#52) -----------------------------------------------------------------------

// A room with a clock of our own, and agents driven directly (no socket): each command's result,
// as the agent's last reply says it.
function bellRoom (opts = {}) {
  const clock = { now: 1_000_000 }
  const room = new AgentRoom({ human: 'stormy-newt-59', now: () => clock.now, ...opts })
  let ids = 0
  const join = (hello) => {
    const sent = []
    const handler = room.connect({ type: 'agent-hello', v: 1, cwd: '/w', repo: 'owner/repo', ...hello }, { send: (m) => sent.push(m), end () {} })
    const a = {
      name: sent[0].agent.name,
      cmd (cmd, args = {}) {
        const id = ++ids
        handler.message({ type: 'cmd', id, cmd, ...args })
        const r = sent.findLast(m => m.type === 'reply' && m.id === id)
        if (r && !r.ok) throw new Error(r.error)
        return r?.result
      },
      close: () => handler.close()
    }
    return a
  }
  const ring = (who, parentPid) => room.doorbell({ type: 'doorbell', ...who }, { parentPid })
  return { room, clock, join, ring, later: (ms) => { clock.now += ms } }
}

test('doorbell: finds the agent by session id, then harness pid, then the pid\'s parent, and remembers each session', async (t) => {
  const { room, join, ring } = bellRoom()
  t.after(() => room.close())
  const lookups = []
  const parents = { 7100: 7000, 8100: 8000, 6100: 6000 }
  const parentPid = async (pid) => { lookups.push(pid); return parents[pid] ?? null }

  assert.deepEqual(ring({ harness: 'claude', sessionId: 's-claude', pid: 8100 }, parentPid), { text: null })
  assert.deepEqual(lookups, [], 'no agents: no lookup')

  const claude = join({ harness: 'claude', sessionId: 's-claude', harnessPid: 5000, name: 'claude-a' })
  const codex = join({ harness: 'codex', sessionId: null, harnessPid: 7000, name: 'codex-c' })
  const copilot = join({ harness: 'copilot', sessionId: 's-copilot', harnessPid: 6000, name: 'copilot-b' })
  for (const a of [claude, codex]) copilot.cmd('post', { text: 'ping', to: [a.name] })
  claude.cmd('post', { text: 'ping', to: [copilot.name] })

  // The hello's sessionId (with its harness), whatever the pid.
  assert.match(ring({ harness: 'claude', sessionId: 's-claude', pid: 1234 }).text, /^autochat: copilot-b wrote to you\./)
  // A sessionId is the harness's own: another harness's same id is someone else.
  assert.equal(ring({ harness: 'copilot', sessionId: 's-claude', pid: 1234 }).text, null)
  // The hello's harnessPid: opencode's plugin and pi's extension send their own process.
  assert.match(ring({ harness: 'copilot', sessionId: 's-other', pid: 6000 }).text, /^autochat: claude-a wrote to you\./)
  // Codex sends no session id to its MCP server: the hook's shell, whose parent is Codex.
  const found = ring({ harness: 'codex', sessionId: 'thr-1', pid: 7100 }, parentPid)
  assert.equal(typeof found.then, 'function', 'a lookup: the answer is a promise')
  assert.match((await found).text, /^autochat: copilot-b wrote to you\. Read it with mcp__autochat__read before you go on\.$/)
  assert.deepEqual(lookups, [7100])
  assert.deepEqual(ring({ harness: 'codex', sessionId: 'thr-1', pid: 7200 }, parentPid), { text: null }, 'remembered: no lookup, nothing new')
  assert.deepEqual(lookups, [7100])

  // A session that isn't in the room: one lookup, then remembered, until an agent comes or goes.
  assert.deepEqual(await ring({ harness: 'claude', sessionId: 's-nobody', pid: 8100 }, parentPid), { text: null })
  assert.deepEqual(ring({ harness: 'claude', sessionId: 's-nobody', pid: 8100 }, parentPid), { text: null })
  assert.deepEqual(lookups, [7100, 8100])
  const late = join({ harness: 'claude', sessionId: null, harnessPid: 8000, name: 'claude-late' })
  copilot.cmd('post', { text: 'welcome', to: [late.name] })
  assert.match((await ring({ harness: 'claude', sessionId: 's-nobody', pid: 8100 }, parentPid)).text, /copilot-b wrote to you/)
  assert.deepEqual(lookups, [7100, 8100, 8100])

  // No parentPid (a host without a process table), garbage fields: nothing, no throw.
  assert.deepEqual(ring({ harness: 'codex', sessionId: 'thr-2', pid: 7100 }), { text: null })
  for (const odd of [{ harness: 7, sessionId: {}, pid: 'x' }, { sessionId: '../etc' }, {}]) assert.deepEqual(ring(odd, parentPid), { text: null })
  assert.deepEqual(room.doorbell(null), { text: null })
  assert.deepEqual(await ring({ harness: 'claude', sessionId: 's-throws', pid: 9100 }, async () => { throw new Error('ps failed') }), { text: null })

  // An agent that has left isn't rung, and its session is forgotten.
  copilot.cmd('post', { text: 'again', to: [claude.name] })
  claude.close()
  room._leave([...room.agents.values()].find(x => x.name === 'claude-a'))
  assert.deepEqual(ring({ harness: 'claude', sessionId: 's-claude', pid: 5000 }), { text: null })
})

test('doorbell: rings for mentions, replies, overlaps, decisions and thread messages since the last ring, once a minute at most, never during a wait', async (t) => {
  const { room, join, ring, later } = bellRoom()
  t.after(() => room.close())
  const a = join({ harness: 'claude', sessionId: 's-a', name: 'claude-a' })
  const b = join({ harness: 'copilot', sessionId: 's-b', name: 'copilot-b' })
  const bell = () => ring({ harness: 'claude', sessionId: 's-a' }).text

  assert.equal(bell(), null, 'nothing yet')
  b.cmd('post', { text: 'for everyone, naming nobody' })
  assert.equal(bell(), null, 'not in the inbox')
  room.command({ cmd: 'agents.ack' })
  room.command({ cmd: 'agents.say', text: 'hello agents' })
  assert.equal(bell(), null, 'a human\'s message to everyone waits for the next read')

  // A question to the agent opens a thread with it.
  const q = b.cmd('post', { text: 'are you on src/greeting.js?', kind: 'question', to: ['claude-a'] })
  assert.equal(bell(), 'autochat: copilot-b asked you a question. Read it with mcp__autochat__read before you go on.')
  assert.equal(bell(), null, 'nothing new since that ring')

  // Within the minute, new messages wait; then they ring, all of them.
  b.cmd('post', { thread: q.thread.id, text: 'also the docs' })
  later(30_000)
  assert.equal(bell(), null, 'rung 30 s ago')
  const mine = a.cmd('post', { text: 'plan: rename greet()' })
  b.cmd('post', { text: 'sounds good', replyTo: mine.message.seq })
  later(31_000)
  assert.equal(bell(), 'autochat: copilot-b replied to you; copilot-b wrote in “are you on src/greeting.js?”. Read them with mcp__autochat__read before you go on.')

  // Overlaps and decisions.
  later(61_000)
  a.cmd('status', { focus: { paths: ['src/greeting.js'] } })
  later(5_000)
  b.cmd('status', { focus: { paths: ['src/greeting.js', 'test/greeting.test.js'] } })
  b.cmd('thread', { action: 'resolve', thread: q.thread.id, outcome: 'b takes greeting.js' })
  later(61_000)
  assert.equal(bell(), 'autochat: you overlap with copilot-b on src/greeting.js; copilot-b decided “are you on src/greeting.js?”. Read them with mcp__autochat__read before you go on.')

  // Reading clears: what was read never rings.
  later(61_000)
  b.cmd('post', { text: 'one more', to: ['claude-a'] })
  a.cmd('read')
  assert.equal(bell(), null)

  // Never while the agent is in a wait: it's reading the room.
  later(61_000)
  const waiting = a.cmd('wait', { timeoutMs: 1000 })
  assert.equal(waiting, undefined, 'the wait is pending')
  room.agents.forEach(x => { if (x.name === 'claude-a') assert.ok(x.wait) })
  b.cmd('post', { text: 'are you there?', to: ['claude-a'] })
  assert.equal(bell(), null)
  a.cmd('read')

  // Each harness's read tool; a count when it's long.
  later(61_000)
  for (const [harness, tool] of [['copilot', 'autochat-read'], ['opencode', 'autochat_read'], ['pi', 'autochat_read'], ['codex', 'mcp__autochat__read'], ['gemini', 'autochat\'s read tool']]) {
    const r = bellRoom()
    const x = r.join({ harness, sessionId: 's-x', name: 'x' })
    const y = r.join({ harness: 'claude', sessionId: 's-y', name: 'y' })
    y.cmd('post', { text: 'hi', to: [x.name], kind: 'proposal' })
    assert.equal(r.ring({ harness, sessionId: 's-x' }).text, `autochat: y sent you a proposal. Read it with ${tool} before you go on.`)
    r.room.close()
  }
  const busy = bellRoom({ limits: { mainPosts: 1000, threadPosts: 1000 } })
  busy.join({ harness: 'pi', sessionId: 's-x', name: 'x' })
  for (let i = 0; i < 25; i++) busy.join({ harness: 'claude', sessionId: `s-${i}`, name: `agent-with-a-long-name-${i}` }).cmd('post', { text: 'hi', to: ['x'] })
  const long = busy.ring({ harness: 'pi', sessionId: 's-x' }).text
  assert.ok(long.length <= 500, long.length)
  assert.match(long, /^autochat: agent-with-a-long-name-0 wrote to you; .*; and \d+ more\. Read them with autochat_read before you go on\.$/)
  busy.room.close()
})

test('doorbell: the one-shot message on the socket, an answer that waits for a lookup, and old daemons', async (t) => {
  const parentPid = async (pid) => pid === 7100 ? 7000 : null
  await start(t, { parentPid })
  const a = await agent({ harness: 'codex', name: 'codex-a', sessionId: null, harnessPid: 7000 })
  const b = await agent({ harness: 'claude', name: 'claude-b', sessionId: 's-b', harnessPid: 5000 })
  assert.deepEqual(await send({ type: 'doorbell', harness: 'codex', sessionId: 'thr-1', pid: 7100 }), { ok: true, text: null })
  ok(await b.cmd('post', { text: 'are you on src/greeting.js?', kind: 'question', to: ['codex-a'] }))
  assert.deepEqual(await send({ type: 'doorbell', harness: 'codex', sessionId: 'thr-1', pid: 7100 }), { ok: true, text: 'autochat: claude-b asked you a question. Read it with mcp__autochat__read before you go on.' })
  assert.deepEqual(await send({ type: 'doorbell', harness: 'codex', sessionId: 'thr-1', pid: 7100 }), { ok: true, text: null }, 'once a minute')
  assert.deepEqual(await send({ type: 'doorbell', harness: 'claude', sessionId: 's-b', pid: 5000 }), { ok: true, text: null })
  // A daemon from before the doorbell answers ok:false: the hooks stay silent (test/doorbell.test.js).
  a.close()
  b.close()
})
