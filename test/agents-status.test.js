import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sleep, agent, start, ok, texts } from './helpers/agents.js'

const until = async (fn, label, ms = 5000) => {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error('timed out waiting for ' + label)
    await sleep(20)
  }
}
const cardOf = (room, name) => room.snapshot().agents.find(c => c.name === name)

test('status within the gap: deferred with the card as it is now, coalesced, applied when the gap ends with its overlaps', async (t) => {
  const { room } = await start(t, { limits: { statusGapMs: 1000 } })
  const a = await agent({ harness: 'copilot' })
  const b = await agent({ harness: 'claude' })
  let r = ok(await a.cmd('status', { summary: 'one', state: 'editing', focus: { paths: ['src/a.js'] } }))
  assert.deepEqual(Object.keys(r), ['card', 'overlaps', 'knownComponents', 'pending'], 'an applied status is not marked deferred')
  ok(await b.cmd('status', { summary: 'b', focus: { paths: ['src/b.js'] } }))

  r = ok(await a.cmd('status', { state: 'testing', focus: { issue: 7 } }))
  assert.deepEqual(Object.keys(r), ['card', 'overlaps', 'knownComponents', 'pending', 'deferred', 'appliesInMs'])
  assert.equal(r.deferred, true)
  assert.ok(r.appliesInMs > 0 && r.appliesInMs <= 1000, String(r.appliesInMs))
  assert.deepEqual([r.card.summary, r.card.state, r.card.focus], ['one', 'editing', { issue: null, components: [], paths: ['src/a.js'], live: [] }], 'the card as it is now')
  const updatedAt = r.card.updatedAt

  // A second one in the same gap merges into the first: the latest value of each field, focus
  // field by field, and a null changes nothing.
  const second = ok(await a.cmd('status', { summary: 'two', state: null, focus: { paths: ['src/b.js'] } }))
  assert.equal(second.deferred, true)
  assert.ok(second.appliesInMs <= r.appliesInMs)

  // Nobody sees it yet: not the board, not the human snapshot, and no overlap notice.
  const board = ok(await b.cmd('catchUp')).board.find(c => c.name === 'copilot-repo')
  assert.deepEqual([board.summary, board.state], ['one', 'editing'])
  assert.equal(cardOf(room, 'copilot-repo').state, 'editing')
  assert.equal(room.snapshot().messages.filter(m => m.kind === 'overlap').length, 0)

  await until(() => cardOf(room, 'copilot-repo').state === 'testing', 'the deferred status')
  const card = cardOf(room, 'copilot-repo')
  assert.deepEqual([card.summary, card.state, card.focus], ['two', 'testing', { issue: 7, components: [], paths: ['src/b.js'], live: [] }])
  assert.ok(card.updatedAt >= updatedAt)
  assert.deepEqual(card.overlaps, ['claude-repo'])
  // Applied like any status: the overlap notice reaches both agents.
  const notice = 'copilot-repo and claude-repo both touch src/b.js'
  assert.deepEqual(texts(room.snapshot().messages.filter(m => m.kind === 'overlap')), [notice])
  assert.deepEqual(texts(ok(await b.cmd('read')).messages), [notice])
  const mine = await a.cmd('read')
  assert.deepEqual(texts(ok(mine).messages), [notice])

  // The gap runs from the status that was applied, so the next one waits again.
  r = ok(await a.cmd('status', { state: 'done' }))
  assert.equal(r.deferred, true)
  await until(() => cardOf(room, 'copilot-repo').state === 'done', 'the next deferred status')
  await sleep(1100)
  r = ok(await a.cmd('status', { summary: 'three' }))
  assert.equal(r.deferred, undefined, 'after the gap, a status applies at once')
  assert.equal(r.card.summary, 'three')
  for (const x of [a, b]) x.close()
})

test('a deferred status: bad arguments still fail at once, renames wait too, and leaving cancels it', async (t) => {
  const { room } = await start(t, { limits: { statusGapMs: 1000, resumeMs: 50 } })
  const errors = []
  room.on('error-log', (err) => errors.push(err))
  const a = await agent({ harness: 'copilot' })
  const b = await agent({ harness: 'claude' })
  ok(await a.cmd('status', { state: 'editing' }))
  assert.equal((await a.cmd('status', { summary: 'x'.repeat(141) })).error, 'summary too long (max 140 characters)')
  assert.equal((await a.cmd('status', { state: 'napping' })).error, 'state must be one of exploring, editing, testing, blocked, done, idle')

  const r = ok(await a.cmd('status', { name: 'copilot-auth' }))
  assert.deepEqual([r.deferred, r.card.name], [true, 'copilot-repo'])
  await until(() => cardOf(room, 'copilot-auth'), 'the rename')
  assert.equal(room.snapshot().messages.at(-1).text, 'copilot-repo is now copilot-auth')

  ok(await b.cmd('status', { state: 'editing' }))
  assert.equal(ok(await b.cmd('status', { state: 'done', summary: 'shipped' })).deferred, true)
  b.close()
  await until(() => room.snapshot().messages.some(m => m.text === 'claude-repo left'), 'b left')
  await sleep(1100)
  const card = cardOf(room, 'claude-repo')
  assert.deepEqual([card.state, card.summary], ['editing', null], 'never applied after the agent left')
  assert.deepEqual(errors, [])
  a.close()
})

test('a deferred status keeps the title and parent set earlier in the same gap; parent null clears it', async (t) => {
  const { room } = await start(t, { limits: { statusGapMs: 300 } })
  const lead = await agent({ harness: 'claude' })
  const a = await agent({ harness: 'copilot' })
  ok(await a.cmd('status', { state: 'editing' }))
  assert.equal(ok(await a.cmd('status', { title: 'Login page fix', parent: 'claude-repo' })).deferred, true)
  assert.equal(ok(await a.cmd('status', { state: 'testing' })).deferred, true)
  await until(() => cardOf(room, 'copilot-repo').state === 'testing', 'the deferred status')
  let card = cardOf(room, 'copilot-repo')
  assert.deepEqual([card.title, card.parent], ['Login page fix', 'claude-repo'], 'neither is lost to the later call')

  ok(await a.cmd('status', { state: 'editing' }))
  await until(() => cardOf(room, 'copilot-repo').state === 'editing', 'the next status')
  assert.equal(ok(await a.cmd('status', { title: '', parent: null })).deferred, true)
  assert.equal(ok(await a.cmd('status', { summary: 'back to the default title' })).deferred, true)
  await until(() => cardOf(room, 'copilot-repo').summary === 'back to the default title', 'the merged status')
  card = cardOf(room, 'copilot-repo')
  assert.deepEqual([card.title, card.parent], ['repo@feat-x', null])
  for (const x of [lead, a]) x.close()
})

test('a deferred "done" gets pending and its hint at once; the card says done, and posts to it get their hint, once it applies', async (t) => {
  const { room } = await start(t, { limits: { statusGapMs: 300 } })
  const a = await agent({ harness: 'copilot' })
  const b = await agent({ harness: 'claude' })
  ok(await b.cmd('post', { text: 'can you check the parser?', to: ['copilot-repo'] }))
  ok(await a.cmd('status', { state: 'editing' }))
  const r = ok(await a.cmd('status', { state: 'done' }))
  assert.deepEqual(Object.keys(r), ['card', 'overlaps', 'knownComponents', 'pending', 'hint', 'deferred', 'appliesInMs'])
  assert.deepEqual([r.card.state, r.pending.unread], ['editing', 1])
  assert.match(r.hint, /^Before you stop, answer what is addressed to you/)
  assert.equal(ok(await b.cmd('post', { text: 'one more thing', to: ['copilot-repo'] })).hint, undefined, 'not done yet')
  await until(() => cardOf(room, 'copilot-repo').state === 'done', 'the deferred done')
  assert.equal(ok(await b.cmd('post', { text: 'and another', to: ['copilot-repo'] })).hint, 'copilot-repo is done; post a handoff to the room instead')
  for (const x of [a, b]) x.close()
})
