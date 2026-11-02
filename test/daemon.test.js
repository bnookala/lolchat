import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import net from 'node:net'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import createTestnet from 'hyperdht/testnet.js'

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'autochat.js')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autochat-daemon-'))
process.env.AUTOCHAT_HOME = path.join(tmp, 'lc')
process.env.COPILOT_HOME = path.join(tmp, 'copilot')
const { serve, send, MAX } = await import('../src/ipc.js')
const { sockPath } = await import('../src/paths.js')

// A protocol client: newline-delimited JSON; next() waits for (and consumes) the first matching line.
function client () {
  const sock = net.connect(sockPath())
  const lines = []
  const waiters = []
  let buf = ''
  const check = () => {
    for (const w of [...waiters]) {
      const i = lines.findIndex(w.pred)
      if (i === -1) continue
      const [m] = lines.splice(i, 1)
      waiters.splice(waiters.indexOf(w), 1)
      clearTimeout(w.timer)
      w.resolve(m)
    }
  }
  sock.setEncoding('utf8')
  sock.on('error', () => {})
  sock.on('data', (d) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) !== -1) {
      lines.push(JSON.parse(buf.slice(0, i)))
      buf = buf.slice(i + 1)
    }
    check()
  })
  const closed = new Promise((resolve) => sock.on('close', resolve))
  return {
    lines,
    closed,
    send: (m) => sock.write((typeof m === 'string' ? m : JSON.stringify(m)) + '\n'),
    next: (pred = () => true, ms = 10000, label = 'message') => new Promise((resolve, reject) => {
      const w = { pred, resolve, timer: setTimeout(() => reject(new Error('timed out waiting for ' + label)), ms) }
      waiters.push(w)
      check()
    }),
    close: () => sock.end()
  }
}

const isState = (pred = () => true) => (m) => m.type === 'state' && pred(m)
const isReply = (id) => (m) => m.type === 'reply' && m.id === id
// A daemon plans Connect agents from the harness installs it sees (docs/agent-room/human.md): a
// throwaway HOME and no harness binaries, so it never reads this machine's.
const noHarnesses = (dir) => ({ HOME: dir, XDG_CONFIG_HOME: path.join(dir, '.config'), AUTOCHAT_HARNESS_PATH: '', CLAUDE_CONFIG_DIR: undefined, CODEX_HOME: undefined, PI_CODING_AGENT_DIR: undefined })
const counts = ({ present, openThreads, active }) => ({ present, openThreads, active })

test('subscribers get snapshots, coalesced updates, and command replies; one-shots are unchanged', async (t) => {
  let n = 0
  const server = await serve((msg) => msg.type === 'ping' ? { pong: true } : {}, {
    state: () => ({ type: 'state', v: 1, n }),
    command: async (msg) => { if (msg.cmd !== 'ok') throw new Error('unknown command') },
    maxSubscribers: 2
  })
  t.after(() => server.close())

  assert.deepEqual(await send({ type: 'ping' }), { ok: true, pong: true })

  const a = client()
  a.send({ type: 'subscribe', v: 1, client: 'test' })
  assert.deepEqual(await a.next(), { type: 'state', v: 1, n: 0 })
  n = 1
  for (let i = 0; i < 10; i++) server.publish()
  assert.equal((await a.next(isState())).n, 1)
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.equal(a.lines.filter(m => m.type === 'state').length, 0, 'a burst of changes is one snapshot')

  a.send({ type: 'cmd', id: 1, cmd: 'ok' })
  a.send({ type: 'cmd', id: 2, cmd: 'nope' })
  a.send({ type: 'ping', id: 3 })
  a.send('not json')
  assert.deepEqual(await a.next(isReply(1)), { type: 'reply', id: 1, ok: true })
  assert.deepEqual(await a.next(isReply(2)), { type: 'reply', id: 2, ok: false, error: 'unknown command' })
  assert.equal((await a.next(isReply(3))).ok, false)
  assert.equal((await a.next(isReply(null))).error, 'invalid json')

  const b = client()
  b.send({ type: 'subscribe', v: 1 })
  await b.next(isState())
  const c = client()
  c.send({ type: 'subscribe', v: 1 })
  assert.deepEqual(await c.next(), { type: 'error', v: 1, error: 'too many subscribers' })
  await c.closed
  b.close()
  await b.closed
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(server.subscribers.size, 1)

  const d = client()
  d.send({ type: 'subscribe', v: 2 })
  assert.equal((await d.next()).error, 'unsupported protocol version')
  a.close()
})

test('snapshots stay under the line cap; servers without state refuse subscriptions', async (t) => {
  const messages = Array.from({ length: 2000 }, (_, i) => ({ id: i, kind: 'chat', text: 'x'.repeat(400) }))
  const server = await serve(() => ({}), { state: () => ({ type: 'state', v: 1, messages }), command: () => {} })
  const a = client()
  a.send({ type: 'subscribe', v: 1 })
  const s = await a.next()
  assert.ok(JSON.stringify(s).length <= MAX)
  assert.ok(s.messages.length > 100 && s.messages.length < 2000)
  assert.equal(s.messages.at(-1).id, 1999, 'the newest messages are kept')
  a.close()
  server.close()
  await a.closed

  const plain = await serve(() => ({}))
  t.after(() => plain.close())
  const b = client()
  b.send({ type: 'subscribe', v: 1 })
  assert.equal((await b.next()).error, 'subscriptions not supported')
})

test('autochat daemon: headless, driven by hooks and subscribers, clean SIGTERM', { timeout: 60000 }, async (t) => {
  const testnet = await createTestnet(3)
  t.after(() => testnet.destroy())
  const home = path.join(tmp, 'd')
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ room: 'lc1-daemon-' + Math.random().toString(36).slice(2, 12), announce: false }))
  process.env.AUTOCHAT_HOME = home
  const env = {
    ...process.env,
    AUTOCHAT_HOME: home,
    AUTOCHAT_BOOTSTRAP: testnet.bootstrap.map(b => `${b.host}:${b.port}`).join(','),
    AUTOCHAT_NO_NOTIFY: '1',
    AUTOCHAT_NO_FOCUS: '1',
    AUTOCHAT_COUNTDOWN_MS: '1500',
    ...noHarnesses(path.join(tmp, 'd-home'))
  }
  const daemon = spawn(process.execPath, [BIN, 'daemon'], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  daemon.stderr.on('data', (d) => { stderr += d })
  const exited = new Promise((resolve) => daemon.on('exit', (code, signal) => resolve({ code, signal })))
  t.after(() => daemon.kill('SIGKILL'))

  let pong = null
  for (let i = 0; i < 100 && !pong; i++) {
    pong = await send({ type: 'ping' }, 300)
    if (!pong) await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.equal(pong?.daemon, true, 'ping tells a daemon from a TUI')
  assert.equal(pong.phase, 'lounge')
  assert.equal(pong.pid, daemon.pid)

  const ui = spawnSync(process.execPath, [BIN, 'ui'], { env, encoding: 'utf8' })
  assert.equal(ui.status, 0)
  assert.match(ui.stdout, /running in the menu bar app/)
  const second = spawnSync(process.execPath, [BIN, 'daemon'], { env, encoding: 'utf8' })
  assert.equal(second.status, 3, 'a second daemon does not fight for the socket')

  const a = client()
  a.send({ type: 'subscribe', v: 1, client: 'test' })
  const first = await a.next(isState(), 10000, 'first snapshot')
  assert.equal(first.phase, 'lounge')
  assert.match(first.me.handle, /^[a-z]+-[a-z]+-[0-9a-f]{2}$/)
  assert.match(first.me.color, /^#[0-9a-f]{6}$/)
  assert.equal(first.room.activeCount, 0)
  assert.deepEqual([first.request, first.countdown, first.banner], [null, null, null])
  assert.deepEqual(first.sessions, [])

  // The daemon hosts the agent room; the lounge snapshot summarizes it, even before an agent connects.
  assert.equal(pong.agentRoom, true)
  assert.deepEqual(counts(first.agents), { present: 0, openThreads: 0, active: 0 })
  const agent = client()
  agent.send({ type: 'agent-hello', v: 1, harness: 'copilot', name: null, pid: process.pid, cwd: '/w/x', repo: 'owner/x', resume: null })
  const welcome = await agent.next((m) => m.type === 'agent-welcome', 10000, 'agent welcome')
  assert.equal(welcome.agent.human, first.me.handle)
  assert.deepEqual(counts((await a.next(isState(s => s.agents?.present === 1), 10000, 'agents summary')).agents), { present: 1, openThreads: 0, active: 0 }, 'idle until it sets a status or posts')
  agent.send({ type: 'cmd', id: 1, cmd: 'thread', action: 'open', title: 'naming' })
  assert.equal((await agent.next(isReply(1))).ok, true)
  await a.next(isState(s => s.agents?.openThreads === 1), 10000, 'open thread in the summary')
  agent.send({ type: 'cmd', id: 2, cmd: 'status', summary: 'naming things' })
  assert.equal((await agent.next(isReply(2))).ok, true)
  assert.deepEqual(counts((await a.next(isState(s => s.agents?.active === 1), 10000, 'an active agent')).agents), { present: 1, openThreads: 1, active: 1 })
  agent.close()
  await a.next(isState(s => s.agents?.present === 0), 10000, 'agent away')

  // Hooks keep talking to the socket exactly as they do to the TUI.
  const delivered = await send({ type: 'hook', event: 'postToolUse', sessionId: 'dm1', kind: 'activity', mode: 'autopilot', cwd: '/w/dm1', ts: Date.now() })
  assert.equal(delivered.tracked, true)
  const inRoom = await a.next(isState(s => s.phase === 'room'), 10000, 'room snapshot')
  assert.deepEqual(inRoom.sessions, [{ sid: 'dm1', state: 'running', cwd: '/w/dm1' }])
  assert.equal(inRoom.members.find(m => m.you).handle, first.me.handle)

  a.send({ type: 'cmd', id: 7, cmd: 'say', text: 'lol same' })
  assert.deepEqual(await a.next(isReply(7)), { type: 'reply', id: 7, ok: true })
  const said = await a.next(isState(s => s.messages.some(m => m.kind === 'chat')), 10000, 'chat in snapshot')
  const chat = said.messages.find(m => m.kind === 'chat')
  assert.equal(chat.from, first.me.handle)
  assert.equal(chat.text, 'lol same')
  assert.equal(chat.you, true)
  assert.ok(said.messages.every(m => Number.isInteger(m.id) && typeof m.ts === 'number'))

  a.send({ type: 'cmd', id: 8, cmd: 'bogus' })
  assert.equal((await a.next(isReply(8))).error, 'unknown command')

  // Autopilot ends: a countdown (still chatting), then the pull-back, which never exits the daemon.
  await send({ type: 'hook', event: 'sessionEnd', sessionId: 'dm1', kind: 'end', mode: 'autopilot', ts: Date.now() })
  const counting = await a.next(isState(s => s.countdown), 10000, 'countdown')
  assert.equal(counting.phase, 'room')
  assert.deepEqual({ ...counting.countdown, endsAt: 0 }, { endsAt: 0, total: 1.5, reason: 'end', summary: null, cwd: '/w/dm1', remaining: 2 })
  a.send({ type: 'cmd', id: 9, cmd: 'say', text: 'brb' })
  assert.equal((await a.next(isReply(9))).ok, true, 'chat works during the countdown')
  const banner = await a.next(isState(s => s.banner), 10000, 'banner')
  assert.equal(banner.banner.kind, 'reality')
  assert.equal(banner.banner.reason, 'end')
  assert.equal(banner.countdown, null)
  await a.next(isState(s => s.phase === 'lounge'), 10000, 'back to the lounge')
  assert.equal((await send({ type: 'ping' })).phase, 'lounge', 'still running')

  daemon.kill('SIGTERM')
  const { code, signal } = await exited
  assert.deepEqual({ code, signal }, { code: 0, signal: null }, stderr)
  await a.closed
  assert.equal(fs.existsSync(sockPath()), false, 'socket removed')
  assert.match(stderr, /SIGTERM, leaving the room/)
})

test('autochat join/host/leave reach a running daemon: the lounge shows the new room at once', { timeout: 60000 }, async (t) => {
  const testnet = await createTestnet(3)
  t.after(() => testnet.destroy())
  const home = path.join(tmp, 'r')
  fs.mkdirSync(home, { recursive: true })
  process.env.AUTOCHAT_HOME = home
  const env = {
    ...process.env,
    AUTOCHAT_HOME: home,
    AUTOCHAT_BOOTSTRAP: testnet.bootstrap.map(b => `${b.host}:${b.port}`).join(','),
    AUTOCHAT_NO_NOTIFY: '1',
    AUTOCHAT_NO_FOCUS: '1',
    ...noHarnesses(path.join(tmp, 'r-home'))
  }
  const daemon = spawn(process.execPath, [BIN, 'daemon'], { env, stdio: ['ignore', 'ignore', 'ignore'] })
  const exited = new Promise((resolve) => daemon.on('exit', resolve))
  t.after(() => daemon.kill('SIGKILL'))
  let pong = null
  for (let i = 0; i < 100 && !pong; i++) {
    pong = await send({ type: 'ping' }, 300)
    if (!pong) await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.equal(pong?.daemon, true)

  const a = client()
  a.send({ type: 'subscribe', v: 1, client: 'test' })
  assert.equal((await a.next(isState(), 10000, 'first snapshot')).room.display, '#lobby')
  const cli = (...args) => {
    const r = spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
  }
  cli('join', 'lc1-brave-otter-abcd2345efgh')
  await a.next(isState(s => s.room.display === 'private:brave-otter'), 10000, 'joined room shown')
  cli('host', 'rustaceans')
  await a.next(isState(s => s.room.display === '#rustaceans'), 10000, 'hosted room shown')
  cli('leave')
  await a.next(isState(s => s.room.display === '#lobby'), 10000, 'back to #lobby')
  assert.deepEqual(await send({ type: 'reload' }), { ok: true, reloaded: true, room: '#lobby' })

  daemon.kill('SIGTERM')
  assert.equal(await exited, 0)
  await a.closed
})

test('autochat daemon: Connect agents sets up a harness, and the lounge shows it connected', { timeout: 60000 }, async (t) => {
  const testnet = await createTestnet(3)
  t.after(() => testnet.destroy())
  const home = path.join(tmp, 'ca')
  const userHome = path.join(tmp, 'ca-home')
  // Copilot CLI is installed (its config dir exists), and autochat isn't registered with it yet.
  const copilotHome = path.join(userHome, '.copilot')
  fs.mkdirSync(copilotHome, { recursive: true })
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ room: 'lc1-connect-' + Math.random().toString(36).slice(2, 12), announce: false }))
  process.env.AUTOCHAT_HOME = home
  const env = {
    ...process.env,
    AUTOCHAT_HOME: home,
    AUTOCHAT_BOOTSTRAP: testnet.bootstrap.map(b => `${b.host}:${b.port}`).join(','),
    AUTOCHAT_NO_NOTIFY: '1',
    AUTOCHAT_NO_FOCUS: '1',
    ...noHarnesses(userHome),
    COPILOT_HOME: copilotHome
  }
  const daemon = spawn(process.execPath, [BIN, 'daemon'], { env, stdio: ['ignore', 'ignore', 'ignore'] })
  const exited = new Promise((resolve) => daemon.on('exit', resolve))
  t.after(() => daemon.kill('SIGKILL'))
  let pong = null
  for (let i = 0; i < 100 && !pong; i++) {
    pong = await send({ type: 'ping' }, 300)
    if (!pong) await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.equal(pong?.agentRoom, true)

  const lounge = client()
  lounge.send({ type: 'subscribe', v: 1, client: 'test' })
  const before = await lounge.next(isState(s => s.agents?.available?.length > 0), 10000, 'copilot available')
  assert.deepEqual(before.agents, { present: 0, openThreads: 0, connected: [], available: ['copilot'], active: 0 })

  const human = client()
  human.send({ type: 'subscribe', v: 1, client: 'test', stream: 'agents' })
  await human.next(m => m.type === 'agents', 10000, 'agents snapshot')
  human.send({ type: 'cmd', id: 1, cmd: 'agents.setupPlan' })
  const plan = await human.next(isReply(1), 20000, 'agents.setupPlan')
  assert.equal(plan.ok, true, plan.error)
  assert.deepEqual(plan.result.plans.map(p => [p.id, p.action]), [['copilot', 'add'], ['claude', 'absent'], ['gemini', 'absent'], ['opencode', 'absent'], ['codex', 'absent'], ['pi', 'absent']])
  assert.equal(plan.result.plans[0].where, '~/.copilot/mcp-config.json')
  assert.equal(plan.result.plans[0].detail[0], 'add to ~/.copilot/mcp-config.json')

  human.send({ type: 'cmd', id: 2, cmd: 'agents.setup', harnesses: ['copilot', 'nope'] })
  const setup = await human.next(isReply(2), 60000, 'agents.setup')
  assert.deepEqual(setup.result, { applied: ['copilot'], failed: [{ id: 'nope', error: 'unknown harness: nope' }] })
  const written = JSON.parse(fs.readFileSync(path.join(copilotHome, 'mcp-config.json'), 'utf8')).mcpServers.autochat
  assert.deepEqual([written.command, ...written.args.slice(1)], [process.execPath, 'mcp', '--harness', 'copilot'], "the daemon's own node and autochat")
  const after = await lounge.next(isState(s => s.agents?.connected?.length > 0), 10000, 'copilot connected')
  assert.deepEqual(after.agents, { present: 0, openThreads: 0, connected: ['copilot'], available: [], active: 0 })

  // Agents can't: only the agents stream has these commands.
  const agent = client()
  agent.send({ type: 'agent-hello', v: 1, harness: 'copilot', name: null, pid: process.pid, cwd: '/w/x', repo: 'owner/x', resume: null })
  await agent.next((m) => m.type === 'agent-welcome', 10000, 'agent welcome')
  agent.send({ type: 'cmd', id: 3, cmd: 'agents.setup', harnesses: ['copilot'] })
  assert.equal((await agent.next(isReply(3))).error, 'unknown command')
  agent.close()
  human.close()

  daemon.kill('SIGTERM')
  assert.equal(await exited, 0)
  await lounge.closed
})

test('autochat daemon: the doorbell rings its agents, finds a session by its process, and `autochat config doorbell off` silences it', { timeout: 60000 }, async (t) => {
  const testnet = await createTestnet(3)
  t.after(() => testnet.destroy())
  const home = path.join(tmp, 'b')
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ room: 'lc1-bell-' + Math.random().toString(36).slice(2, 12), announce: false }))
  process.env.AUTOCHAT_HOME = home
  const env = { ...process.env, AUTOCHAT_HOME: home, AUTOCHAT_BOOTSTRAP: testnet.bootstrap.map(b => `${b.host}:${b.port}`).join(','), AUTOCHAT_NO_NOTIFY: '1', AUTOCHAT_NO_FOCUS: '1', ...noHarnesses(path.join(tmp, 'b-home')) }
  const daemon = spawn(process.execPath, [BIN, 'daemon'], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  daemon.stderr.on('data', (d) => { stderr += d })
  t.after(() => daemon.kill('SIGKILL'))
  for (let i = 0; i < 100 && !await send({ type: 'ping' }, 300); i++) await new Promise(resolve => setTimeout(resolve, 100))

  const join = async (hello) => {
    const c = client()
    c.send({ type: 'agent-hello', v: 1, cwd: home, repo: 'owner/repo', ...hello })
    await c.next(m => m.type === 'agent-welcome', 10000, 'welcome')
    return c
  }
  // Claude Code: by its session id. Codex: by the parent of the process that rang (this test
  // process plays Codex, and a child of it the hook's shell).
  const claude = await join({ harness: 'claude', name: 'claude-a', sessionId: 's-claude', harnessPid: 999999 })
  const codex = await join({ harness: 'codex', name: 'codex-c', sessionId: null, harnessPid: process.pid })
  const copilot = await join({ harness: 'copilot', name: 'copilot-b', sessionId: 's-copilot' })
  copilot.send({ type: 'cmd', id: 1, cmd: 'post', text: 'are you on src/greeting.js?', kind: 'question', to: ['claude-a', 'codex-c'] })
  assert.equal((await copilot.next(isReply(1))).ok, true)

  const cli = (...args) => assert.equal(spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8' }).status, 0)
  cli('config', 'doorbell', 'off')
  assert.deepEqual(await send({ type: 'doorbell', harness: 'claude', sessionId: 's-claude', pid: 1 }), { ok: true, text: null }, 'off')
  assert.equal(spawnSync(process.execPath, [BIN, 'config', 'doorbell', 'loud'], { env, encoding: 'utf8' }).status, 1)
  cli('config', 'doorbell', 'on')
  await new Promise(resolve => setTimeout(resolve, 1100))
  assert.deepEqual(await send({ type: 'doorbell', harness: 'claude', sessionId: 's-claude', pid: 1 }), { ok: true, text: 'autochat: copilot-b asked you a question. Read it with mcp__autochat__read before you go on.' })

  const shell = spawn('sleep', ['10'])
  t.after(() => shell.kill())
  const r = await send({ type: 'doorbell', harness: 'codex', sessionId: 'thr-1', pid: shell.pid }, 3000)
  assert.deepEqual(r, { ok: true, text: 'autochat: copilot-b asked you a question. Read it with mcp__autochat__read before you go on.' })
  assert.deepEqual(await send({ type: 'doorbell', harness: 'codex', sessionId: 'nobody', pid: 1 }), { ok: true, text: null })
  assert.match(stderr, /rang claude-a \(claude\): autochat: copilot-b asked you a question/)
  assert.match(stderr, /rang codex-c \(codex\): /)
  for (const c of [claude, codex, copilot]) c.close()
})
