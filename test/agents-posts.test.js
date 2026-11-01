import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sleep, agent, start, ok, texts } from './helpers/agents.js'

test('post/read: inbox vs all, cursors, mentions, replies, and hasMore', async (t) => {
  const { room } = await start(t)
  const a = await agent({ harness: 'copilot' })
  const b = await agent({ harness: 'claude' })
  const c = await agent({ harness: 'codex' })

  const note = ok(await a.cmd('post', { text: 'heads up: \x1b[31mredoing\x1b[0m the cache\n\n\n\n\nlayer\u202e' }))
  assert.equal(note.message.kind, 'note')
  assert.equal(note.message.text, 'heads up: redoing the cache\n\n\nlayer', 'multiline sanitize keeps \\n and collapses blank lines')
  assert.deepEqual(Object.keys(note.message), ['seq', 'id', 'ts', 'kind', 'from', 'thread', 'to', 'replyTo', 'text', 'intervention'])
  assert.deepEqual(note.message.from, { name: 'copilot-repo', display: 'repo@feat-x', human: 'stormy-newt-59', harness: 'copilot', repo: 'owner/repo', id: a.welcome.agent.id, title: 'repo@feat-x' })
  assert.equal(note.thread, undefined)

  // A main-stream note to nobody isn't in anyone's inbox, but scope:"all" has it.
  let r = await b.cmd('read')
  assert.deepEqual(r.inbox, { unread: 0, mentions: 0 })
  assert.deepEqual(ok(r).messages, [])
  r = ok(await b.cmd('read', { scope: 'all', since: 0 }))
  assert.ok(texts(r.messages).includes(note.message.text))

  const direct = ok(await a.cmd('post', { text: 'can you look at the cache tests?', to: ['claude-repo'] }))
  const mention = ok(await a.cmd('post', { text: 'cc @codex-repo, and @claude-repo too' }))
  assert.equal(direct.message.thread, null, 'notes with `to` stay in the main stream')
  let reply = await b.cmd('status', {})
  assert.deepEqual(reply.inbox, { unread: 2, mentions: 2 }, 'every reply carries the doorbell')
  assert.deepEqual((await c.cmd('status', {})).inbox, { unread: 1, mentions: 1 })

  // Replies to X's messages are in X's inbox.
  const theirs = ok(await b.cmd('post', { text: 'on it', replyTo: direct.message.seq }))
  assert.equal(theirs.message.replyTo, direct.message.seq)
  assert.deepEqual((await a.cmd('status', {})).inbox, { unread: 1, mentions: 0 })

  // read advances the cursor and marks the inbox read; limit + hasMore page through.
  r = ok(await b.cmd('read', { limit: 1 }))
  assert.deepEqual(texts(r.messages), [direct.message.text])
  assert.equal(r.hasMore, true)
  assert.equal(r.cursor, direct.message.seq)
  reply = await b.cmd('read')
  assert.deepEqual(texts(ok(reply).messages), [mention.message.text])
  assert.equal(ok(reply).hasMore, false)
  assert.equal(ok(reply).cursor, room.seq)
  assert.deepEqual(reply.inbox, { unread: 0, mentions: 0 })
  assert.deepEqual(ok(await b.cmd('read')).messages, [], 'nothing new')
  r = ok(await b.cmd('read', { since: direct.message.seq - 1, limit: 2 }))
  assert.deepEqual(texts(r.messages), [direct.message.text, mention.message.text], 'since re-reads')
  assert.equal(ok(await a.cmd('read')).messages[0].text, 'on it')

  // Unknown names are errors, so typos get noticed; bad args say what's wrong.
  assert.equal((await a.cmd('post', { text: 'x', to: ['claud-repo'] })).error, 'unknown agent: claud-repo')
  assert.equal((await a.cmd('post', { text: 'x', kind: 'shout' })).error, 'kind must be one of note, question, reply, proposal, decision, handoff')
  assert.equal((await a.cmd('post', { text: '   ' })).error, 'text is empty')
  assert.equal((await a.cmd('post', { text: 'x'.repeat(2001) })).error, 'text too long (max 2000 characters)')
  assert.equal((await a.cmd('read', { limit: 101 })).error, 'limit must be 1-100')
  assert.equal((await a.cmd('nope')).error, 'unknown command')
  a.send({ type: 'bogus', id: 99 })
  assert.equal((await a.next(m => m.id === 99)).error, 'unknown message type')
  for (const x of [a, b, c]) x.close()
})

const until = async (fn, label, ms = 3000) => {
  const end = Date.now() + ms
  for (;;) {
    if (await fn()) return
    if (Date.now() > end) throw new Error('timed out waiting for ' + label)
    await sleep(20)
  }
}

test('post recipients: here gets it, away gets it if it resumes, left never does; a post only for agents that left is a main-stream handoff', async (t) => {
  const { room } = await start(t, { limits: { resumeMs: 60000 } })
  const a = await agent({ harness: 'copilot' })
  const b = await agent({ harness: 'claude' })
  const c = await agent({ harness: 'codex' })
  const d = await agent({ harness: 'gemini' })
  ok(await b.cmd('status', { state: 'editing' }))
  ok(await d.cmd('status', { state: 'testing' }))
  c.close()
  await c.closed
  await until(() => !room.agents.get(c.welcome.agent.id).present, 'c away')
  ok(await d.cmd('bye'))

  // Here, away, left, yourself and a repeat: one entry per agent, in order, without you.
  const mixed = ok(await a.cmd('post', { text: 'heads up: the cache moves', to: ['claude-repo', '@codex-repo', 'stormy-newt-59/gemini-repo', 'copilot-repo', 'claude-repo'] }))
  assert.deepEqual(mixed.recipients, [
    { name: 'claude-repo', presence: 'here', state: 'editing', delivered: true },
    { name: 'codex-repo', presence: 'away', state: 'idle', delivered: false },
    { name: 'gemini-repo', presence: 'left', state: 'testing', delivered: false }
  ])
  assert.equal(mixed.rerouted, undefined)
  assert.deepEqual([mixed.message.kind, mixed.message.thread, mixed.message.to], ['note', null, ['claude-repo', 'codex-repo', 'gemini-repo']])
  assert.deepEqual(Object.keys(mixed), ['message', 'recipients'])
  assert.deepEqual(texts(ok(await b.cmd('read')).messages), ['heads up: the cache moves'])
  const c2 = await agent({ harness: 'codex', resume: c.welcome.resume })
  assert.equal(c2.welcome.agent.id, c.welcome.agent.id)
  assert.deepEqual(texts(ok(await c2.cmd('read')).messages), ['heads up: the cache moves'], 'away: it waited in their inbox')
  assert.deepEqual(ok(await a.cmd('post', { text: 'no one in particular' })).recipients, [], 'no `to`: no recipients')

  // A question with here and left recipients opens a thread with those still here.
  const q = ok(await a.cmd('post', { kind: 'question', text: 'who owns the parser?', to: ['claude-repo', 'gemini-repo'] }))
  assert.deepEqual([q.message.kind, q.message.to, q.thread.participants], ['question', ['claude-repo', 'gemini-repo'], ['copilot-repo', 'claude-repo']])
  assert.deepEqual(q.recipients.map(r => [r.name, r.delivered]), [['claude-repo', true], ['gemini-repo', false]])

  // Only for agents that left: the main stream, as a handoff, still addressed to them; a question
  // opens no thread, and a thread post leaves its thread.
  const asked = ok(await a.cmd('post', { kind: 'question', text: 'did you finish the parser?', to: ['gemini-repo'] }))
  assert.equal(asked.rerouted, 'handoff')
  assert.deepEqual([asked.message.kind, asked.message.thread, asked.message.to], ['handoff', null, ['gemini-repo']])
  assert.equal(asked.thread, undefined, 'no thread')
  assert.deepEqual(asked.recipients, [{ name: 'gemini-repo', presence: 'left', state: 'testing', delivered: false }])
  assert.deepEqual(Object.keys(asked), ['message', 'recipients', 'rerouted'])
  const moved = ok(await a.cmd('post', { kind: 'reply', thread: q.thread.id, replyTo: q.message.seq, text: 'parser notes for gemini', to: ['gemini-repo', 'copilot-repo'] }))
  assert.deepEqual([moved.rerouted, moved.message.kind, moved.message.thread, moved.message.replyTo], ['handoff', 'handoff', null, q.message.seq])
  assert.equal(moved.thread, undefined)
  assert.equal(ok(await a.cmd('thread', { action: 'list' })).threads[0].messages, 1, 'the thread has only the question')
  const all = ok(await b.cmd('read', { scope: 'all', since: q.message.seq }))
  assert.deepEqual(all.messages.map(m => [m.kind, m.text]), [['handoff', 'did you finish the parser?'], ['handoff', 'parser notes for gemini']], 'the room sees them')
  assert.deepEqual(texts(ok(await b.cmd('catchUp')).recent).slice(-2), ['did you finish the parser?', 'parser notes for gemini'])

  // A new agent may take the name of one that left: then `to` means the new agent.
  const d2 = await agent({ harness: 'gemini' })
  assert.equal(d2.name, 'gemini-repo')
  const fresh = ok(await a.cmd('post', { text: 'welcome back', to: ['gemini-repo'] }))
  assert.equal(fresh.rerouted, undefined)
  assert.deepEqual(fresh.recipients, [{ name: 'gemini-repo', presence: 'here', state: 'idle', delivered: true }])
  assert.deepEqual(texts(ok(await d2.cmd('read')).messages), ['welcome back'])
  for (const x of [a, b, c2, d2]) x.close()
})

test('post: no more "left the room": a left card is addressable until it goes, then the name is unknown; `with` still refuses it', async (t) => {
  await start(t, { limits: { lingerMs: 300 } })
  const a = await agent({ harness: 'copilot' })
  const b = await agent({ harness: 'claude' })
  ok(await b.cmd('bye'))
  assert.equal(ok(await a.cmd('post', { text: 'are you still there?', to: ['claude-repo'] })).rerouted, 'handoff')
  assert.equal((await a.cmd('thread', { action: 'open', title: 'x', with: ['claude-repo'] })).error, 'claude-repo left the room')
  assert.equal((await a.cmd('post', { text: 'x', to: ['claude-repo', 7] })).error, 'to must be a list of agent names')
  assert.equal((await a.cmd('post', { text: 'x', to: 'claude-repo' })).error, 'to must be a list of agent names')
  assert.equal((await a.cmd('post', { text: 'x', to: Array(17).fill('claude-repo') })).error, 'to has too many names (max 16)')
  assert.equal((await a.cmd('post', { text: 'x', to: ['claude-repo', 'nobody'] })).error, 'unknown agent: nobody')
  await sleep(400)
  assert.equal((await a.cmd('post', { text: 'x', to: ['claude-repo'] })).error, 'unknown agent: claude-repo', 'its card is gone')
  a.close()
})

test('post: a recipient that is done gets a hint to post a handoff to the room instead', async (t) => {
  await start(t)
  const a = await agent({ harness: 'copilot' })
  const b = await agent({ harness: 'claude' })
  const c = await agent({ harness: 'codex' })
  const d = await agent({ harness: 'gemini' })
  ok(await b.cmd('status', { state: 'done' }))
  ok(await c.cmd('status', { state: 'done' }))
  ok(await d.cmd('status', { state: 'testing' }))

  const r = ok(await a.cmd('post', { kind: 'question', text: 'can you review my cache change?', to: ['claude-repo', 'gemini-repo'] }))
  assert.equal(r.hint, 'claude-repo is done; post a handoff to the room instead')
  assert.deepEqual(Object.keys(r), ['message', 'thread', 'recipients', 'hint'])
  assert.deepEqual(r.recipients.map(x => [x.name, x.state, x.delivered]), [['claude-repo', 'done', true], ['gemini-repo', 'testing', true]], 'it was still delivered')
  assert.equal(ok(await a.cmd('post', { text: 'fyi', to: ['codex-repo', 'claude-repo'] })).hint, 'codex-repo, claude-repo are done; post a handoff to the room instead')
  assert.equal(ok(await a.cmd('post', { text: 'fyi', to: ['gemini-repo'] })).hint, undefined, 'not done: no hint')
  assert.equal(ok(await a.cmd('post', { kind: 'handoff', text: 'cache review still open', to: ['claude-repo'] })).hint, undefined, 'a handoff is what the hint asks for')

  // Done and then gone: the post is rerouted as a handoff already, so no hint.
  ok(await b.cmd('bye'))
  const gone = ok(await a.cmd('post', { text: 'thanks!', to: ['claude-repo'] }))
  assert.deepEqual([gone.rerouted, gone.hint], ['handoff', undefined])
  for (const x of [a, c, d]) x.close()
})
