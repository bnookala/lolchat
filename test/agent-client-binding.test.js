import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { spawnSync } from 'node:child_process'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autochat-binding-'))
process.env.AUTOCHAT_HOME = path.join(tmp, 'ac')
const { matchHarness, parseRemote, bindSession, changedPaths, parseStatusV2, livePaths, syncLivePaths } = await import('../src/agent-client.js')

test('harness detection: package paths and binaries; remotes → owner/repo', () => {
  assert.equal(matchHarness('node /Users/me/.nvm/versions/node/v22/bin/copilot --autopilot'), 'copilot')
  assert.equal(matchHarness('/Users/me/.nvm/v22/lib/node_modules/@github/copilot/node_modules/@github/copilot-darwin-arm64/copilot'), 'copilot')
  assert.equal(matchHarness('claude --continue'), 'claude')
  assert.equal(matchHarness('node /opt/homebrew/lib/node_modules/@google/gemini-cli/dist/index.js'), 'gemini')
  assert.equal(matchHarness('/opt/homebrew/bin/opencode'), 'opencode')
  assert.equal(matchHarness('node /Users/me/Library/pnpm/global/5/node_modules/@mariozechner/pi-coding-agent/dist/cli.js'), 'pi')
  assert.equal(matchHarness('codex exec "fix it"'), 'codex')
  assert.equal(matchHarness('/bin/zsh -l'), null)
  assert.equal(matchHarness('node /x/bin/autochat.js mcp --harness copilot'), null, 'our own flags are not a harness')

  for (const url of ['git@github.com:owner/repo.git', 'https://github.com/owner/repo', 'https://github.com/owner/repo.git/', 'ssh://git@github.com/owner/repo.git', 'https://x-access-token@ghe.example.com/owner/repo']) {
    assert.equal(parseRemote(url), 'owner/repo', url)
  }
  assert.equal(parseRemote(''), null)

  // The nearest matching ancestor; --harness picks which one.
  const table = new Map([
    [100, { ppid: 90, command: 'node /x/bin/autochat.js mcp' }],
    [90, { ppid: 80, command: '/bin/sh -c node /x/bin/autochat.js mcp' }],
    [80, { ppid: 70, command: 'claude' }],
    [70, { ppid: 1, command: 'node /n/bin/copilot' }]
  ])
  const none = path.join(tmp, 'not-a-repo')
  fs.mkdirSync(none, { recursive: true })
  const auto = bindSession({ env: {}, cwd: none, ps: () => table, pid: 100 })
  assert.deepEqual([auto.harness, auto.harnessPid], ['claude', 80])
  assert.deepEqual([auto.hello.repo, auto.hello.branch, auto.hello.worktree], [null, null, null], 'null outside git')
  const flagged = bindSession({ harness: 'copilot', env: {}, cwd: none, ps: () => table, pid: 100 })
  assert.deepEqual([flagged.harness, flagged.harnessPid], ['copilot', 70])
  const hinted = bindSession({ env: { CLAUDECODE: '1', AUTOCHAT_AGENT_NAME: 'Reviewer' }, cwd: none, ps: () => new Map(), pid: 100 })
  assert.deepEqual([hinted.harness, hinted.harnessPid, hinted.hello.name], ['claude', null, 'Reviewer'])
  assert.equal(bindSession({ env: {}, cwd: none, ps: () => new Map(), pid: 100 }).harness, 'agent')
})

test('session titles: Copilot\'s session name from its workspace.yaml, in the hello; read again by status', async () => {
  const { yamlField, sessionTitle } = await import('../src/agent-client/binding.js')
  const yaml = (v) => yamlField(`id: x\ncwd: /w\nname: ${v}\r\nsummary: s\n`, 'name')
  assert.equal(yaml('Lolchat macos menu bar app'), 'Lolchat macos menu bar app')
  assert.equal(yaml('What can you do?'), 'What can you do?')
  assert.equal(yaml('"Fix: the \\"bug\\" \\u00e9\\x41"'), 'Fix: the "bug" éA')
  assert.equal(yaml("'It''s done # here'"), "It's done # here")
  assert.equal(yaml('Fix it # a comment'), 'Fix it')
  for (const v of ['', '~', 'null', '|-', '"unterminated']) assert.equal(yaml(v), null, v)
  assert.equal(yamlField('  name: nested\n', 'name'), null, 'top-level keys only')

  // COPILOT_HOME/session-state/<COPILOT_AGENT_SESSION_ID>/workspace.yaml
  const home = path.join(tmp, 'copilot-home')
  const sid = '0b7c9d36-5b2e-4c55-9d0e-6f1f3f0a8c11'
  const ws = path.join(home, 'session-state', sid)
  fs.mkdirSync(ws, { recursive: true })
  fs.writeFileSync(path.join(ws, 'workspace.yaml'), `id: ${sid}\ncwd: /w\nsummary_count: 0\n`)
  const env = { COPILOT_HOME: home, COPILOT_AGENT_SESSION_ID: sid }
  const none = path.join(tmp, 'not-a-repo')
  fs.mkdirSync(none, { recursive: true })
  const unnamed = bindSession({ harness: 'copilot', env, cwd: none, ps: () => new Map(), pid: 100 })
  assert.deepEqual([unnamed.sessionId, unnamed.hello.sessionId, unnamed.hello.title], [sid, sid, null], 'not named yet')
  fs.writeFileSync(path.join(ws, 'workspace.yaml'), `id: ${sid}\ncwd: /w\nname: Lolchat macos menu bar app\nsummary_count: 0\n`)
  assert.equal(unnamed.readTitle(), 'Lolchat macos menu bar app', 'read again later')
  const named = bindSession({ harness: 'copilot', env, cwd: none, ps: () => new Map(), pid: 100 })
  assert.equal(named.hello.title, 'Lolchat macos menu bar app')
  assert.deepEqual(Object.keys(named.hello), ['type', 'v', 'harness', 'name', 'pid', 'harnessPid', 'sessionId', 'cwd', 'repo', 'branch', 'worktree', 'title', 'resume'])
  assert.equal(bindSession({ harness: 'claude', env: { ...env, CLAUDE_CODE_SESSION_ID: sid }, cwd: none, ps: () => new Map(), pid: 100 }).hello.title, null, 'only Copilot\'s')
  assert.equal(sessionTitle({ harness: 'copilot', sessionId: '../../etc', env }), null, 'session ids are checked')
  fs.writeFileSync(path.join(ws, 'workspace.yaml'), `name: "${'x'.repeat(120)}"\n`)
  assert.equal(Array.from(sessionTitle({ harness: 'copilot', sessionId: sid, env })).length, 80)
  fs.writeFileSync(path.join(ws, 'workspace.yaml'), `name: use ${['ghp', 'a'.repeat(36)].join('_')}\n`)
  assert.equal(sessionTitle({ harness: 'copilot', sessionId: sid, env }), null, 'never a secret')

  // The status tool sends the session's title when it changed since the hello, once.
  const { Tools } = await import('../src/agent-client.js')
  const sent = []
  let limited = false
  const link = { hello: { title: null }, agent: null, request: async (cmd, args) => { sent.push(args); return limited ? { ok: false, error: 'rate limited' } : { ok: true, result: { card: {} }, inbox: {} } } }
  let title = null
  const tools = new Tools({ link, session: { cwd: none, top: null, readTitle: () => title } })
  await tools.status({ summary: 'a' })
  title = 'Readable names'
  limited = true
  assert.equal((await tools.call('status', { summary: 'b' })).isError, true)
  limited = false
  await tools.status({ summary: 'b' })
  await tools.status({ summary: 'c' })
  title = 'Renamed'
  await tools.status({ title: 'My own', parent: 'lead' })
  assert.deepEqual(sent, [{ summary: 'a' }, { summary: 'b', title: 'Readable names' }, { summary: 'b', title: 'Readable names' }, { summary: 'c' }, { title: 'My own', parent: 'lead' }], 'until a status that carries it succeeds')
  assert.equal(link.hello.title, 'Renamed', 'a reconnect says hello with the newest title')

  // pi: the session's /name.
  const { register } = await import('../src/harness/pi-extension.js')
  const handlers = {}
  const pi = { on: (e, fn) => { handlers[e] = fn }, registerTool () {} }
  const out = await register(pi, { room: true, env: {}, joinDelayMs: 60000 })
  handlers.session_start({ reason: 'startup' }, { cwd: none, hasUI: false, sessionManager: { getSessionId: () => 'pi-1', getSessionName: () => 'Teach pi the room' } })
  assert.deepEqual([out.room.link.hello.harness, out.room.link.hello.sessionId, out.room.link.hello.title], ['pi', 'pi-1', 'Teach pi the room'])
  handlers.session_shutdown({ reason: 'quit' })
})

// --- live paths (#56) ----------------------------------------------------------------------------

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))
fs.writeFileSync(path.join(tmp, 'gitconfig'), '')
process.env.GIT_CONFIG_GLOBAL = path.join(tmp, 'gitconfig')
process.env.GIT_CONFIG_NOSYSTEM = '1'
function git (cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' })
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}

test('parseStatusV2: the HEAD commit, and changed, renamed (both sides), unmerged and untracked paths', () => {
  const out = [
    '# branch.oid 4c5ca22fa73dc58ee8b87c51dbcb62773bda3681', '# branch.head feat',
    '1 .M N... 100644 100644 100644 7898192 7898192 src/a.js',
    '1 M. N... 100644 100644 100644 6178079 b89df23 src/b c.js',
    '2 R. N... 100644 100644 100644 4286f42 4286f42 R100 src/new.js', 'src/old.js',
    'u UU N... 100644 100644 100644 100644 a1 a2 a3 src/conflict.js',
    '? notes/new file.txt', '? tmpdir/', '! ignored.log', ''
  ].join('\0')
  assert.deepEqual(parseStatusV2(out), {
    oid: '4c5ca22fa73dc58ee8b87c51dbcb62773bda3681',
    paths: ['src/a.js', 'src/b c.js', 'src/new.js', 'src/old.js', 'src/conflict.js', 'notes/new file.txt', 'tmpdir/']
  })
  assert.deepEqual(parseStatusV2('# branch.oid (initial)\0# branch.head main\0? a.txt\0'), { oid: null, paths: ['a.txt'] })
  assert.deepEqual(parseStatusV2(null), { oid: null, paths: [] })
})

test('livePaths: the same files as status()\'s auto paths, one git status per call, the branch diff cached per commit', async () => {
  const top = fs.realpathSync(fs.mkdtempSync(path.join(tmp, 'live-')))
  fs.mkdirSync(path.join(top, 'src'))
  fs.mkdirSync(path.join(top, 'docs'))
  for (const [f, text] of [['src/a.js', 'a\n'], ['src/old.js', 'old\n'], ['docs/d.md', 'd\n'], ['README.md', 'r\n']]) fs.writeFileSync(path.join(top, f), text)
  git(top, 'init', '-q')
  git(top, 'add', '-A')
  git(top, 'commit', '-qm', 'init')
  git(top, 'checkout', '-qb', 'feat')
  fs.appendFileSync(path.join(top, 'docs', 'd.md'), 'more\n')
  git(top, 'commit', '-qam', 'docs')
  git(top, 'mv', 'src/old.js', 'src/new.js')
  fs.appendFileSync(path.join(top, 'src', 'a.js'), 'edit\n')
  fs.writeFileSync(path.join(top, 'src', 'brand new.js'), 'n\n')

  const calls = []
  const read = livePaths(top, { git: (cwd, args, env) => { calls.push({ cmd: args[0], locks: env.GIT_OPTIONAL_LOCKS }); return gitAsyncForTest(cwd, args, env) } })
  const first = await read()
  assert.deepEqual(first.slice().sort(), ['docs/d.md', 'src/a.js', 'src/brand new.js', 'src/new.js', 'src/old.js'])
  assert.deepEqual(first.slice().sort(), [...new Set(await changedPaths(top))].sort(), 'the same files as status() adds')
  assert.ok(calls.some(c => c.cmd === 'diff'), 'the branch diff, the first time')
  assert.ok(calls.every(c => c.locks === '0'), 'never the index lock')
  calls.length = 0
  fs.writeFileSync(path.join(top, 'README.md'), 'r2\n')
  assert.deepEqual((await read()).slice().sort(), ['README.md', 'docs/d.md', 'src/a.js', 'src/brand new.js', 'src/new.js', 'src/old.js'])
  assert.deepEqual(calls.map(c => c.cmd), ['status'], 'same commit: one git status, nothing else')

  // A commit moves HEAD: the branch diff is computed again, so committed files stay.
  git(top, 'add', '-A')
  git(top, 'commit', '-qm', 'work')
  calls.length = 0
  assert.deepEqual((await read()).slice().sort(), ['README.md', 'docs/d.md', 'src/a.js', 'src/brand new.js', 'src/new.js', 'src/old.js'])
  assert.ok(calls.some(c => c.cmd === 'diff'))
  // On the default branch, only what git status shows.
  git(top, 'checkout', '-q', 'main')
  assert.deepEqual(await read(), [])
  assert.equal(await livePaths(path.join(tmp, 'not-a-repo'))(), null, 'git failed: null')
})

function gitAsyncForTest (cwd, args, env) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env })
  return Promise.resolve(r.status === 0 ? r.stdout : null)
}

// A stand-in for the DaemonLink: connected or not, and a `request` that records what is sent.
function fakeLink (reply = () => ({ ok: true, result: { overlaps: [] } })) {
  const link = new EventEmitter()
  Object.assign(link, {
    connected: false,
    closed: false,
    sent: [],
    request: async (cmd, args) => { link.sent.push({ cmd, args }); return reply(cmd, args) },
    up () { link.connected = true; link.emit('connected', {}) },
    down () { link.connected = false; link.emit('disconnected') }
  })
  return link
}

test('syncLivePaths: sends on connect, then only when the paths change; a 15 s timer, pokes, one check at a time', async () => {
  let paths = ['src/a.js']
  let clock = 0
  let reads = 0
  const link = fakeLink()
  const live = syncLivePaths({ link, top: '/w', intervalMs: 15000, now: () => clock, read: async () => { reads++; return paths } })
  await live.check()
  live.poke()
  assert.equal(reads, 0, 'nothing while not connected')

  link.up()
  await sleep(10)
  assert.deepEqual(link.sent, [{ cmd: 'paths', args: { paths: ['src/a.js'] } }], 'sent on connect')
  await live.check()
  assert.equal(link.sent.length, 1, 'unchanged: not sent again')
  paths = ['src/a.js', 'src/b.js']
  clock += 5000
  live.poke()
  await sleep(10)
  assert.equal(link.sent.length, 1, 'a poke within 15 s of the last check does nothing')
  clock += 10000
  live.poke()
  await sleep(10)
  assert.deepEqual(link.sent.at(-1), { cmd: 'paths', args: { paths: ['src/a.js', 'src/b.js'] } }, 'a poke 15 s after the last check')

  // At most 200 paths of up to 300 characters.
  paths = ['x'.repeat(301), ...Array.from({ length: 250 }, (_, i) => `f${i}.js`)]
  await live.check()
  assert.equal(link.sent.at(-1).args.paths.length, 200)
  assert.equal(link.sent.at(-1).args.paths[0], 'f0.js')

  // A failed git read sends nothing (and clears nothing).
  const n = link.sent.length
  paths = null
  await live.check()
  assert.equal(link.sent.length, n)

  // One check at a time: a check that starts while another runs (a slow git) is skipped.
  let release
  let slowReads = 0
  const l2 = fakeLink()
  const one = syncLivePaths({ link: l2, top: '/w', intervalMs: 15000, read: () => { slowReads++; return new Promise(resolve => { release = () => resolve(['slow.js']) }) } })
  l2.up()
  await one.check()
  await one.check()
  assert.equal(slowReads, 1, 'skipped while the first still runs')
  release()
  await sleep(10)
  assert.deepEqual(l2.sent, [{ cmd: 'paths', args: { paths: ['slow.js'] } }])
  for (const s of [live, one]) s.stop()
})

test('syncLivePaths: the timer runs while connected, stops on disconnect; a reconnect sends again; an older daemon turns it off', async () => {
  let paths = ['a.js']
  const link = fakeLink()
  const live = syncLivePaths({ link, top: '/w', intervalMs: 30, read: async () => paths })
  link.up()
  await sleep(10)
  assert.equal(link.sent.length, 1)
  paths = ['a.js', 'b.js']
  await sleep(80)
  assert.deepEqual(link.sent.map(s => s.args.paths), [['a.js'], ['a.js', 'b.js']], 'the timer sends the change')
  await sleep(80)
  assert.equal(link.sent.length, 2, 'and nothing while it stays the same')

  link.down()
  paths = ['c.js']
  await sleep(80)
  assert.equal(link.sent.length, 2, 'nothing while disconnected')
  paths = ['a.js', 'b.js']
  link.up()
  await sleep(10)
  assert.deepEqual(link.sent.at(-1).args.paths, ['a.js', 'b.js'], 'a (re)connect sends even unchanged paths: the daemon may be new')

  // A daemon without `paths`: no more checks until the next connect.
  let checks = 0
  const old = fakeLink(() => ({ ok: false, error: 'unknown command' }))
  const off = syncLivePaths({ link: old, top: '/w', intervalMs: 20, read: async () => { checks++; return ['a.js'] } })
  old.up()
  await sleep(100)
  assert.equal(checks, 1)
  // Closing the link stops it too.
  link.closed = true
  const before = link.sent.length
  paths = ['d.js']
  await sleep(80)
  assert.equal(link.sent.length, before)

  // AUTOCHAT_AGENT_PATHS_MS=0 turns live paths off; outside git there is nothing to read.
  const quiet = fakeLink()
  syncLivePaths({ link: quiet, top: '/w', env: { AUTOCHAT_AGENT_PATHS_MS: '0' }, read: async () => ['a.js'] })
  syncLivePaths({ link: quiet, top: null })
  quiet.up()
  await sleep(20)
  assert.deepEqual(quiet.sent, [])
  for (const s of [live, off]) s.stop()
})
