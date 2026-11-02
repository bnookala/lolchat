import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sleep, agent, start, ok, texts } from './helpers/agents.js'

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
