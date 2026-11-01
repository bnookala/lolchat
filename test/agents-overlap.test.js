import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agent, start, ok, texts, sleep } from './helpers/agents.js'
const { overlapOn } = await import('../src/agents.js')
const { normalizeComponent } = await import('../src/agents/overlap.js')

test('status → overlap notices once per pair, until the overlap clears and comes back', async (t) => {
  let clock = 1_000_000
  const { room } = await start(t, { now: () => clock })
  const a = await agent({ harness: 'copilot' })
  const b = await agent({ harness: 'claude' })
  const other = await agent({ harness: 'gemini', repo: 'owner/elsewhere' })
  ok(await other.cmd('status', { focus: { paths: ['src/room.js'], issue: 17 } }))

  let r = ok(await a.cmd('status', { summary: 'room refactor', state: 'editing', focus: { issue: 17, components: ['Room'], paths: ['src/room.js', 'test/room.test.js'] } }))
  assert.deepEqual(r.overlaps, [], 'a different repo never overlaps')
  assert.equal(r.card.state, 'editing')
  assert.equal(r.card.summary, 'room refactor')
  assert.deepEqual(r.card.focus, { issue: 17, components: ['Room'], paths: ['src/room.js', 'test/room.test.js'], live: [] })

  r = ok(await b.cmd('status', { focus: { components: ['room'], paths: ['./src/'] } }))
  assert.deepEqual(r.overlaps, [{ agent: 'copilot-repo', on: { components: ['room'], paths: ['src/room.js'] } }])
  assert.deepEqual(r.card.overlaps, ['copilot-repo'])
  assert.deepEqual(r.card.focus.paths, ['src'], 'paths are normalized')
  const notice = room.snapshot().messages.filter(m => m.kind === 'overlap')
  assert.equal(notice.length, 1)
  assert.equal(notice[0].text, 'claude-repo and copilot-repo both touch component room, src/room.js')
  assert.deepEqual([notice[0].from, notice[0].thread, notice[0].to], [null, null, ['claude-repo', 'copilot-repo']])
  // One message, in both agents' inboxes.
  const aInbox = ok(await a.cmd('read'))
  assert.deepEqual(texts(aInbox.messages), [notice[0].text])
  assert.deepEqual(texts(ok(await b.cmd('read')).messages), [notice[0].text])

  // Still overlapping: no repeat.
  clock += 5000
  r = ok(await a.cmd('status', { focus: { paths: ['src/room.js', 'src/ipc.js'] } }))
  assert.deepEqual(r.overlaps.map(o => o.agent), ['claude-repo'])
  assert.equal(room.snapshot().messages.filter(m => m.kind === 'overlap').length, 1)
  assert.deepEqual(room.snapshot().agents.find(c => c.name === 'claude-repo').overlaps, ['copilot-repo'])

  // Clears (no shared component, path or issue), then comes back: notified again.
  clock += 5000
  ok(await b.cmd('status', { focus: { components: [], paths: ['docs'] } }))
  assert.deepEqual(room.snapshot().agents.find(c => c.name === 'copilot-repo').overlaps, [])
  clock += 5000
  r = ok(await b.cmd('status', { focus: { issue: 17 } }))
  assert.deepEqual(r.overlaps, [{ agent: 'copilot-repo', on: { issue: 17 } }])
  const notices = room.snapshot().messages.filter(m => m.kind === 'overlap')
  assert.equal(notices.length, 2)
  assert.equal(notices[1].text, 'claude-repo and copilot-repo both touch issue #17')
  for (const x of [a, b, other]) x.close()
})

test('path overlap: equal, or a directory prefix on segment boundaries', () => {
  const card = (repo, paths, extra = {}) => ({ repo, focus: { issue: null, components: [], paths, ...extra }, pathIndex: { paths, set: new Set(paths), dirs: new Set(paths.flatMap(p => p.split('/').slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join('/')))) } })
  assert.deepEqual(overlapOn(card('o/r', ['src/room.js']), card('o/r', ['src/room.js'])), { paths: ['src/room.js'] })
  assert.deepEqual(overlapOn(card('o/r', ['src']), card('o/r', ['src/room.js', 'src/a/b.js'])), { paths: ['src/a/b.js', 'src/room.js'] })
  assert.equal(overlapOn(card('o/r', ['src/ro']), card('o/r', ['src/room.js'])), null, 'not a segment boundary')
  assert.equal(overlapOn(card('O/R', ['a']), card('o/r', ['a'])).paths[0], 'a', 'repos compare case-insensitively')
  assert.equal(overlapOn(card(null, ['a']), card(null, ['a'])), null, 'repo must be non-null')
  assert.deepEqual(overlapOn(card('o/r', [], { components: ['IPC'] }), card('o/r', [], { components: ['ipc', 'x'] })), { components: ['IPC'] })
})

// --- overlap from intent (#56): live paths, normalized components, knownComponents --------------

const notices = (room) => room.snapshot().messages.filter(m => m.kind === 'overlap').map(m => m.text)
const cardOf = (room, name) => room.snapshot().agents.find(c => c.name === name)
async function until (pred, label, ms = 5000) {
  const end = Date.now() + ms
  while (!pred()) {
    if (Date.now() > end) throw new Error('timed out waiting for ' + label)
    await sleep(20)
  }
}

test('paths sets focus.live (normalized, at most 200) and returns your overlaps; bad lists fail', async (t) => {
  const { room } = await start(t, { limits: { pathsGapMs: 0 } })
  const a = await agent()
  assert.deepEqual(ok(await a.cmd('paths', { paths: ['./src/a.js', 'src/a.js', 'docs/', 'src//b.js', ''] })), { overlaps: [] })
  const card = cardOf(room, a.name)
  assert.deepEqual(card.focus, { issue: null, components: [], paths: [], live: ['src/a.js', 'docs', 'src/b.js'] })
  assert.deepEqual([card.state, card.summary], ['idle', null], 'paths is not a status')
  const many = Array.from({ length: 200 }, (_, i) => `src/f${i}.js`)
  ok(await a.cmd('paths', { paths: many }))
  assert.equal(cardOf(room, a.name).focus.live.length, 200)
  for (const [args, error] of [
    [{}, 'paths must be a list of strings'],
    [{ paths: 'src/a.js' }, 'paths must be a list of strings'],
    [{ paths: ['a', 7] }, 'paths must be a list of strings'],
    [{ paths: [...many, 'one-more.js'] }, 'paths has too many entries (max 200)'],
    [{ paths: ['x'.repeat(301)] }, 'paths entries are at most 300 characters']
  ]) {
    assert.equal((await a.cmd('paths', args)).error, error)
  }
  assert.equal(cardOf(room, a.name).focus.live.length, 200, 'a failed call changes nothing')
  ok(await a.cmd('paths', { paths: null }))
  assert.deepEqual(cardOf(room, a.name).focus.live, [], 'null (or []) clears them')
  a.close()
})

test('paths: at most one every 2 s, the latest waits for the gap; the 5 s status rule does not apply', async (t) => {
  let clock = 1_000_000
  const { room } = await start(t, { now: () => clock })
  const a = await agent()
  ok(await a.cmd('status', { summary: 'editing the greeting' }))
  assert.deepEqual(ok(await a.cmd('paths', { paths: ['a.js'] })), { overlaps: [] }, 'right after a status')
  clock += 2000
  assert.deepEqual(ok(await a.cmd('paths', { paths: ['b.js'] })), { overlaps: [] }, '2 s later: applies at once')
  assert.deepEqual(cardOf(room, a.name).focus.live, ['b.js'])
  clock += 1900
  assert.deepEqual(ok(await a.cmd('paths', { paths: ['c.js'] })), { overlaps: [], deferred: true, appliesInMs: 100 })
  clock += 50
  assert.deepEqual(ok(await a.cmd('paths', { paths: ['d.js'] })), { overlaps: [], deferred: true, appliesInMs: 50 })
  assert.deepEqual(cardOf(room, a.name).focus.live, ['b.js'], 'not yet')
  await until(() => cardOf(room, a.name).focus.live[0] === 'd.js', 'the latest paths')
  await sleep(150)
  assert.deepEqual(cardOf(room, a.name).focus.live, ['d.js'], 'only the latest applies, once')
  assert.equal((await a.cmd('status', { summary: 'too soon' })).error, 'rate limited', 'status keeps its own rule')
  a.close()
})

test('live paths overlap: notices between two agents without any status, with focus.paths too, again after clearing', async (t) => {
  const { room } = await start(t, { limits: { pathsGapMs: 0 } })
  const a = await agent({ harness: 'copilot' })
  const b = await agent({ harness: 'claude' })
  const other = await agent({ harness: 'gemini', repo: 'owner/elsewhere' })
  ok(await other.cmd('paths', { paths: ['src/greeting.js'] }))
  assert.deepEqual(ok(await a.cmd('paths', { paths: ['src/greeting.js', 'README.md'] })), { overlaps: [] })
  const r = ok(await b.cmd('paths', { paths: ['src/greeting.js'] }))
  assert.deepEqual(r.overlaps, [{ agent: 'copilot-repo', on: { paths: ['src/greeting.js'] } }])
  const text = 'claude-repo and copilot-repo both touch src/greeting.js'
  assert.deepEqual(notices(room), [text])
  assert.deepEqual(texts(ok(await a.cmd('read')).messages), [text], 'in both inboxes')
  assert.deepEqual(texts(ok(await b.cmd('read')).messages), [text])
  assert.deepEqual(cardOf(room, 'copilot-repo').overlaps, ['claude-repo'])
  assert.deepEqual(cardOf(room, 'claude-repo').focus.live, ['src/greeting.js'])
  assert.deepEqual(cardOf(room, 'gemini-elsewhere').overlaps, [], 'a different repo never overlaps')

  // Unchanged paths: no new notice.
  ok(await b.cmd('paths', { paths: ['src/greeting.js'] }))
  assert.equal(notices(room).length, 1)
  // B's paths go: the overlap clears.
  assert.deepEqual(ok(await b.cmd('paths', { paths: [] })).overlaps, [])
  assert.deepEqual(cardOf(room, 'copilot-repo').overlaps, [])
  // B declares a directory in its status: it covers A's live path, and that is a new overlap.
  const s = ok(await b.cmd('status', { focus: { paths: ['src'] } }))
  assert.deepEqual(s.overlaps, [{ agent: 'copilot-repo', on: { paths: ['src/greeting.js'] } }])
  assert.deepEqual(notices(room), [text, text])
  // A's live paths go too: nothing is shared any more.
  ok(await a.cmd('paths', { paths: [] }))
  assert.deepEqual(cardOf(room, 'claude-repo').overlaps, [])
  for (const x of [a, b, other]) x.close()
})

test('live paths and presence: an away agent keeps its overlaps (and its paths on resume); one that left has none', async (t) => {
  const { room } = await start(t, { limits: { pathsGapMs: 0, resumeMs: 300 } })
  const a = await agent({ harness: 'copilot' })
  const b = await agent({ harness: 'claude' })
  ok(await a.cmd('paths', { paths: ['src/x.js'] }))
  assert.equal(ok(await b.cmd('paths', { paths: ['src/x.js'] })).overlaps.length, 1)
  a.close()
  await until(() => cardOf(room, 'copilot-repo').present === false, 'A away')
  assert.deepEqual(cardOf(room, 'claude-repo').overlaps, ['copilot-repo'], 'away: still overlapping')
  assert.deepEqual(ok(await b.cmd('paths', { paths: ['src/x.js', 'src/y.js'] })).overlaps.map(o => o.agent), ['copilot-repo'])

  const again = await agent({ harness: 'copilot', resume: a.welcome.resume })
  assert.equal(again.name, 'copilot-repo')
  assert.deepEqual(cardOf(room, 'copilot-repo').focus.live, ['src/x.js'], 'a resume keeps the live paths')
  assert.deepEqual(cardOf(room, 'copilot-repo').overlaps, ['claude-repo'])
  assert.equal(notices(room).length, 1, 'no new notice for the same overlap')

  again.close()
  await until(() => room.snapshot().messages.some(m => m.kind === 'sys' && m.text === 'copilot-repo left'), 'A left')
  assert.deepEqual(cardOf(room, 'claude-repo').overlaps, [], 'left: no overlaps')
  assert.deepEqual(cardOf(room, 'copilot-repo').overlaps, [])
  assert.deepEqual(ok(await b.cmd('paths', { paths: ['src/x.js'] })).overlaps, [])
  assert.equal(notices(room).length, 1)
  b.close()
})

test('components compare normalized: case, spaces, _ and . and -, a plural s; cards keep the original strings', async (t) => {
  for (const [raw, key] of [
    ['Greetings', 'greeting'], ['greeting', 'greeting'], ['GREETING', 'greeting'],
    ['Agent Room', 'agent-room'], ['agent_rooms', 'agent-room'], ['agent.room', 'agent-room'], ['agent - room', 'agent-room'],
    ['  --UI--  ', 'ui'], ['.github', 'github'], ['tests', 'test'], ['apis', 'api'],
    ['bus', 'bus'], ['ids', 'ids'], ['css', 'css'], ['auth.flows', 'auth-flow'], ['...', ''], ['', '']
  ]) {
    assert.equal(normalizeComponent(raw), key, raw)
  }
  const card = (components) => ({ repo: 'o/r', focus: { issue: null, components, paths: [] }, pathIndex: { paths: [], set: new Set(), dirs: new Set() } })
  assert.deepEqual(overlapOn(card(['agent_rooms', 'CLI']), card(['Agent Room'])), { components: ['agent_rooms'] })
  assert.equal(overlapOn(card(['.']), card(['_'])), null, 'empty names never match')

  const { room } = await start(t)
  const a = await agent({ harness: 'copilot' })
  const b = await agent({ harness: 'claude' })
  ok(await a.cmd('status', { focus: { components: ['Greetings', 'Agent Room'] } }))
  const r = ok(await b.cmd('status', { focus: { components: ['greeting', 'agent_room', 'cli'] } }))
  assert.deepEqual(r.overlaps, [{ agent: 'copilot-repo', on: { components: ['greeting', 'agent_room'] } }])
  assert.deepEqual(notices(room), ['claude-repo and copilot-repo both touch component greeting, component agent_room'])
  assert.deepEqual(cardOf(room, 'copilot-repo').focus.components, ['Greetings', 'Agent Room'], 'cards keep what the agents wrote')
  a.close()
  b.close()
})

test('status returns knownComponents: the other cards\' components for your repo, newest first, one per name, up to 20', async (t) => {
  let clock = 1_000_000
  const { room } = await start(t, { now: () => clock, limits: { resumeMs: 200 } })
  const a = await agent({ harness: 'copilot' })
  const b = await agent({ harness: 'claude' })
  const c = await agent({ harness: 'gemini', repo: 'OWNER/REPO' })
  const elsewhere = await agent({ harness: 'codex', repo: 'owner/elsewhere' })
  const nowhere = await agent({ harness: 'pi', repo: null })
  ok(await elsewhere.cmd('status', { focus: { components: ['billing'] } }))
  clock += 10
  let r = ok(await a.cmd('status', { focus: { components: ['Greetings', 'i18n'] } }))
  assert.deepEqual(r.knownComponents, [], 'only other cards, only your repo')
  assert.deepEqual(Object.keys(r), ['card', 'overlaps', 'knownComponents'])
  clock += 10
  r = ok(await b.cmd('status', { focus: { components: ['greeting', 'cli'] } }))
  assert.deepEqual(r.knownComponents, ['Greetings', 'i18n'])
  clock += 10
  r = ok(await c.cmd('status', { summary: 'just looking' }))
  assert.deepEqual(r.knownComponents, ['greeting', 'cli', 'i18n'], 'newest card first; "Greetings" is "greeting"; repos compare case-insensitively')
  assert.deepEqual(ok(await nowhere.cmd('status', { focus: { components: ['greeting'] } })).knownComponents, [], 'no repo, nothing known')

  // A left agent's components count while its card lingers.
  a.close()
  await until(() => room.snapshot().messages.some(m => m.text === 'copilot-repo left'), 'A left')
  clock += 5000
  assert.deepEqual(ok(await c.cmd('status', { summary: 'still looking' })).knownComponents, ['greeting', 'cli', 'i18n'])

  // At most 20.
  const d = await agent({ harness: 'opencode' })
  ok(await d.cmd('status', { focus: { components: Array.from({ length: 10 }, (_, i) => `d${i}`) } }))
  const e = await agent({ harness: 'opencode' })
  clock += 10
  ok(await e.cmd('status', { focus: { components: Array.from({ length: 10 }, (_, i) => `e${i}`) } }))
  clock += 5000
  r = ok(await c.cmd('status', { summary: 'and now' }))
  assert.equal(r.knownComponents.length, 20)
  assert.deepEqual(r.knownComponents.slice(0, 11), [...Array.from({ length: 10 }, (_, i) => `e${i}`), 'd0'])
  for (const x of [b, c, d, e, elsewhere, nowhere]) x.close()
})
