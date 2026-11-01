import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import createTestnet from 'hyperdht/testnet.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BIN = path.join(ROOT, 'bin', 'autochat.js')
const MODULE = path.join(ROOT, 'src', 'harness', 'pi-extension.js')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autochat-pi-'))
process.env.AUTOCHAT_HOME = path.join(tmp, 'ac')
process.env.COPILOT_HOME = path.join(tmp, 'copilot')
const H = await import('../src/harness/index.js')
const { extensionSource, readExtension, extensionFile, agentDir } = await import('../src/harness/pi.js')
const X = await import('../src/harness/pi-extension.js')
const { hookMessage } = await import('../src/harness/event.js')
const { Controller } = await import('../src/controller.js')
const { ephemeralIdentity } = await import('../src/identity.js')
const { send } = await import('../src/ipc.js')
const { INSTRUCTIONS } = await import('../src/mcp.js')

// Recorded from the real pi 0.74.0 (see each file's `how`).
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'pi', name + '.json'), 'utf8')).events
const pi = H.adapter('pi')
const replay = (events, config = {}) => events.map(e => H.sessionEvent(pi, e.event, e.payload, { env: e.env, config }))
const pick = (evs, k) => evs.map(e => e[k] ?? null)
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

test('fixtures: print and json runs are headless and autonomous; edits name their files', () => {
  const evs = replay(fixture('print'))
  assert.deepEqual(pick(evs, 'kind'), ['start', 'activity', 'activity', 'activity', 'idle', 'end'])
  assert.deepEqual(pick(evs, 'autonomy'), Array(6).fill('autonomous'))
  assert.ok(evs.every(e => e.harness === 'pi' && e.sid === evs[0].sid && e.mode === 'print' && e.headless === true && e.cwd === '/Users/me/code/demo'))
  assert.equal(evs[4].summary, 'Done with room.')
  assert.equal(evs[5].reason, 'quit')

  const json = replay(fixture('json'))
  assert.deepEqual(pick(json, 'kind'), ['start', 'activity', 'idle', 'end'])
  assert.ok(json.every(e => e.mode === 'json' && e.autonomy === 'autonomous'))
  assert.deepEqual(json[1].files, ['notes.txt'], 'the write tool names its file')
  assert.ok(replay(fixture('print'), { trigger: { pi: 'never' } }).every(e => e.autonomy === 'interactive'))
})

test('fixtures: the TUI is interactive, and agent_end waits at its prompt; rpc counts only when configured', () => {
  const tui = replay(fixture('interactive'))
  assert.deepEqual(pick(tui, 'kind'), ['start', 'activity', 'activity', 'waiting', 'end'])
  assert.deepEqual(pick(tui, 'autonomy'), Array(5).fill('interactive'))
  assert.ok(tui.every(e => e.mode === 'interactive' && e.headless === false))
  assert.equal(tui[3].summary, 'Done with bash.')

  const rpc = replay(fixture('rpc'))
  assert.deepEqual(pick(rpc, 'kind'), ['start', 'activity', 'idle', 'end'], 'an rpc client may send another prompt')
  assert.deepEqual(pick(rpc, 'autonomy'), Array(4).fill('interactive'))
  assert.deepEqual(pick(replay(fixture('rpc'), { trigger: { pi: ['rpc', 'headless'] } }), 'autonomy'), Array(4).fill('autonomous'), 'autochat config trigger pi rpc,headless')
  assert.deepEqual(H.parseTrigger('pi', 'rpc,headless'), ['rpc', 'headless'])
  assert.throws(() => H.parseTrigger('pi', 'yolo'), /pi modes: interactive, rpc, print, json, headless/)
})

test('fixtures: /new ends one session and starts another; /reload is the same session', () => {
  const evs = replay(fixture('new-reload'))
  assert.deepEqual(pick(evs, 'kind'), ['start', 'end', 'start', 'notice', 'start', 'end'])
  assert.deepEqual(pick(evs, 'reason'), [null, 'new', null, null, null, 'quit'])
  assert.notEqual(evs[0].sid, evs[2].sid, '/new is a new session')
  assert.deepEqual([evs[3].sid, evs[4].sid, evs[5].sid], [evs[2].sid, evs[2].sid, evs[2].sid], '/reload keeps it')
})

test('normalize: odd input, and payloads without a mode', () => {
  for (const bad of [null, [], 'x', {}, { session_id: '../x' }]) assert.equal(pi.normalize('tool_call', bad, {}), null)
  const p = { session_id: 's-1', hook_event_name: 'agent_start' }
  assert.equal(H.sessionEvent(pi, 'agent_start', p, { env: {} }).autonomy, 'unknown', 'nothing says')
  assert.equal(H.sessionEvent(pi, 'agent_start', { ...p, has_ui: false }, { env: {} }).autonomy, 'autonomous', 'no UI: headless')
  assert.equal(H.sessionEvent(pi, 'agent_start', { ...p, has_ui: true }, { env: {} }).autonomy, 'unknown', 'a UI, but not which mode')
  assert.equal(pi.normalize('agent_end', { session_id: 's-1' }, {}).kind, 'idle', 'the event from the command line when the payload has none')
  assert.equal(pi.normalize('turn_end', { session_id: 's-1' }, {}).kind, 'notice')
  assert.deepEqual(pi.normalize('tool_call', { ...p, hook_event_name: 'tool_call', files: ['a', 3, '', 'b\u001b[31m'] }, {}).files, ['a', 'b'])
  assert.deepEqual(pi.normalize('agent_start', p, { TMUX: '/t,1,0', TMUX_PANE: '%4' }).origin, { tmux: '/t,1,0', tmuxPane: '%4', termProgram: undefined, bundleId: undefined })
})

// --- install, rerun, uninstall ------------------------------------------------------------------

// A user's pi agent dir with extensions of their own.
const THEIRS = {
  'extensions/permission-gate.ts': 'export default function (pi) {\n  pi.on("tool_call", () => {})\n}\n',
  'extensions/tools/index.ts': 'export default function (pi) {}\n',
  'settings.json': '{\n  "defaultProvider": "anthropic",\n  "extensions": ["/x/y.ts"]\n}\n'
}
function user (name, { agent = null, theirs = THEIRS } = {}) {
  const home = path.join(tmp, name)
  const dir = agent || path.join(home, '.pi', 'agent')
  for (const [f, text] of Object.entries(theirs)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true })
    fs.writeFileSync(path.join(dir, f), text)
  }
  const node = path.join(home, 'node')
  const bin = path.join(home, 'autochat', 'bin', 'autochat.js')
  fs.mkdirSync(path.join(home, 'autochat', 'src', 'harness'), { recursive: true })
  fs.mkdirSync(path.dirname(bin), { recursive: true })
  for (const f of [node, bin, path.join(home, 'autochat', 'src', 'harness', 'pi-extension.js')]) fs.writeFileSync(f, '')
  const env = { HOME: home, PATH: '', ...(agent && { PI_CODING_AGENT_DIR: agent }) }
  const ctx = H.harnessContext({ env, node, bin })
  const file = path.join(dir, 'extensions', 'autochat.ts')
  const snapshot = () => Object.fromEntries(Object.keys(theirs).map(f => [f, fs.readFileSync(path.join(dir, f), 'utf8')]))
  return { home, dir, ctx, node, bin, file, snapshot, read: () => fs.readFileSync(file, 'utf8') }
}

test('install: autochat.ts next to the user\'s extensions; the lounge and the room are separate; uninstall removes only ours', () => {
  const u = user('install')
  const plan = pi.planHooks(u.ctx)
  assert.deepEqual([plan.action, plan.file], ['add', u.file])
  assert.deepEqual(plan.entries, ['autochat.ts: lifecycle events → autochat hook --harness pi'])
  plan.apply()
  assert.deepEqual(readExtension(u.read()), { node: u.node, bin: u.bin, module: path.join(u.home, 'autochat', 'src', 'harness', 'pi-extension.js'), lounge: true, room: false })
  assert.deepEqual(u.snapshot(), THEIRS, 'their extensions and settings are untouched')
  assert.deepEqual(pi.hookStatus(u.ctx), { installed: true, file: u.file, valid: true })
  assert.deepEqual(pi.mcp.status(u.ctx), { registered: false })

  const mtime = fs.statSync(u.file).mtimeMs
  assert.equal(pi.planHooks(u.ctx).action, 'none')
  assert.equal(H.setupHooks({ ids: ['pi'], ctx: u.ctx, out: () => {} }).applied.length, 0)
  assert.equal(fs.statSync(u.file).mtimeMs, mtime, 'rerunning writes nothing')

  // setup --agents turns the room on in the same file.
  const room = H.planAgents(u.ctx).find(p => p.id === 'pi')
  assert.deepEqual([room.action, room.where], ['add', '~/.pi/agent/extensions/autochat.ts'])
  assert.match(H.describePlan(room, u.ctx).join('\n'), /pi {7}add to ~\/\.pi\/agent\/extensions\/autochat\.ts\n {9}\+ autochat\.ts: agent-room tools: autochat_catch_up, /)
  assert.deepEqual(H.setupAgents({ ctx: u.ctx, out: () => {}, plans: [room] }).applied, ['pi'])
  assert.deepEqual([readExtension(u.read()).lounge, readExtension(u.read()).room], [true, true])
  const st = H.agentsStatus(u.ctx).find(h => h.id === 'pi')
  assert.deepEqual([st.installed, st.registered, st.valid], [true, true, true])

  // Uninstall: the hooks (lounge) first, then the room; the file goes with the last part.
  assert.deepEqual(H.removeHooks({ ctx: u.ctx, out: () => {} }), ['pi'])
  assert.deepEqual([readExtension(u.read()).lounge, readExtension(u.read()).room], [false, true])
  assert.equal(pi.hookStatus(u.ctx).installed, false)
  assert.deepEqual(H.removeAgents({ ctx: u.ctx, out: () => {} }), ['pi'])
  assert.equal(fs.existsSync(u.file), false)
  assert.deepEqual(u.snapshot(), THEIRS)
  assert.deepEqual(fs.readdirSync(path.join(u.dir, 'extensions')).sort(), ['permission-gate.ts', 'tools'], 'nothing else left behind')
  assert.equal(pi.unplanHooks(u.ctx).action, 'none')
  assert.equal(pi.mcp.unplan(u.ctx).action, 'none')
})

test('a foreign autochat.ts is never overwritten; a moved install updates in place; PI_CODING_AGENT_DIR', () => {
  const u = user('foreign', { theirs: { ...THEIRS, 'extensions/autochat.ts': '// my own thing\nexport default function () {}\n' } })
  const manual = pi.planHooks(u.ctx)
  assert.equal(manual.action, 'manual')
  assert.equal(manual.apply, undefined)
  assert.match(H.describeHookPlan(manual, u.ctx).join('\n'), /autochat\.ts isn't autochat's, so autochat won't overwrite it \(move it aside and rerun\)\. Add this yourself:\n {9}\/\/ autochat for pi/)
  assert.equal(pi.mcp.plan(u.ctx).action, 'manual')
  assert.equal(pi.unplanHooks(u.ctx).action, 'none')
  assert.equal(pi.mcp.unplan(u.ctx).action, 'none')
  assert.equal(H.agentsStatus(u.ctx).find(h => h.id === 'pi').registered, false)
  assert.equal(u.read(), '// my own thing\nexport default function () {}\n')

  const m = user('moved')
  pi.planHooks(m.ctx).apply()
  pi.mcp.plan(m.ctx).apply()
  const moved = H.harnessContext({ env: { HOME: m.home, PATH: '' }, node: m.node, bin: path.join(m.home, 'new', 'bin', 'autochat.js') })
  assert.equal(pi.hookStatus(moved).valid, true, 'the stub on disk still points at the old, existing install')
  const up = pi.planHooks(moved)
  assert.equal(up.action, 'update')
  up.apply()
  assert.deepEqual(readExtension(m.read()), { node: m.node, bin: path.join(m.home, 'new', 'bin', 'autochat.js'), module: path.join(m.home, 'new', 'src', 'harness', 'pi-extension.js'), lounge: true, room: true })
  assert.equal(pi.hookStatus(moved).valid, false, "the new paths don't exist on disk")
  assert.match(H.agentsStatus(moved).find(h => h.id === 'pi').command, /^pi extension ~\/\.pi\/agent\/extensions\/autochat\.ts → /)

  const agent = path.join(tmp, 'elsewhere', 'agent')
  const e = user('env-dir', { agent })
  assert.equal(extensionFile(e.ctx), path.join(agent, 'extensions', 'autochat.ts'))
  assert.equal(agentDir(H.harnessContext({ env: { HOME: '/h', PI_CODING_AGENT_DIR: '~/pi' } })), '/h/pi')
  assert.equal(pi.detect(e.ctx).installed, true, 'the agent dir exists')
  assert.equal(pi.detect(H.harnessContext({ env: { HOME: path.join(tmp, 'nobody'), PATH: '' } })).installed, false)
  pi.planHooks(e.ctx).apply()
  assert.ok(fs.existsSync(path.join(agent, 'extensions', 'autochat.ts')))
  assert.equal(fs.existsSync(path.join(e.home, '.pi')), false)
})

// The parent env minus anything that points at a real home or harness.
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(AUTOCHAT|LOLCHAT|PI)_|^(HOME|COPILOT_HOME|XDG_CONFIG_HOME|CODEX_HOME|CLAUDE_CONFIG_DIR|TMUX|TMUX_PANE|TERM_PROGRAM|__CFBundleIdentifier)$/.test(k)))

test('CLI: setup offers pi, setup --harness pi and --agents write the extension, uninstall removes it', () => {
  const u = user('cli')
  const env = { ...baseEnv, HOME: u.home, AUTOCHAT_HOME: path.join(tmp, 'cli-ac'), COPILOT_HOME: path.join(u.home, '.copilot'), AUTOCHAT_HARNESS_PATH: path.join(tmp, 'no-bins'), AUTOCHAT_APP_DIRS: path.join(tmp, 'no-apps') }
  const cli = (...args) => spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8' })
  const plain = cli('setup')
  assert.equal(plain.status, 0, plain.stderr)
  assert.match(plain.stdout, /Also found pi\. To go to the lounge from it too: autochat setup --harness pi/)
  assert.equal(fs.existsSync(u.file), false, 'plain setup without a terminal writes nothing for pi')

  const dry = cli('setup', '--harness', 'pi', '--dry-run')
  assert.match(dry.stdout, /pi {7}add hooks to ~\/\.pi\/agent\/extensions\/autochat\.ts\n {11}\+ autochat\.ts: lifecycle events → autochat hook --harness pi/)
  assert.equal(fs.existsSync(u.file), false)
  assert.match(cli('setup', '--harness', 'pi').stdout, /✔ pi hooks installed\nNew pi sessions load the extension; running ones pick it up on \/reload\./)
  assert.match(cli('setup', '--agents').stdout, /✔ pi connected/)
  const cfg = readExtension(u.read())
  assert.deepEqual([cfg.bin, cfg.module, cfg.lounge, cfg.room], [BIN, MODULE, true, true], 'the real install')
  const un = cli('uninstall')
  assert.equal(un.status, 0, un.stderr)
  assert.match(un.stdout, /removed autochat's hooks from pi \(~\/\.pi\/agent\/extensions\/autochat\.ts\)\n/)
  assert.match(un.stdout, /removed the autochat MCP server from pi \(~\/\.pi\/agent\/extensions\/autochat\.ts\)\n/)
  assert.equal(fs.existsSync(u.file), false)
  assert.deepEqual(u.snapshot(), THEIRS)
})

// --- the extension ------------------------------------------------------------------------------

// pi's ExtensionAPI, as far as the extension uses it.
function fakePi () {
  const handlers = new Map()
  const tools = new Map()
  let active = null
  return {
    tools,
    on: (name, fn) => handlers.set(name, [...(handlers.get(name) || []), fn]),
    registerTool: (def) => tools.set(def.name, def),
    getActiveTools: () => active ?? [...tools.keys()],
    setActiveTools: (names) => { active = names },
    async emit (name, event = {}, ctx = {}) {
      let out
      for (const fn of handlers.get(name) || []) {
        const r = await fn({ type: name, ...event }, ctx)
        if (r !== undefined) out = r
      }
      return out
    }
  }
}
const ctxFor = ({ sid = 'pi-sess-1', cwd = tmp, hasUI = false } = {}) => ({ cwd, hasUI, sessionManager: { getSessionId: () => sid } })

test('extension: run modes and payloads', () => {
  assert.equal(X.runMode(false, ['node', 'cli.js', '-p', 'x']), 'print')
  assert.equal(X.runMode(false, ['node', 'cli.js', '--mode', 'json', 'x']), 'json')
  assert.equal(X.runMode(true, ['node', 'cli.js', '--mode', 'rpc']), 'rpc')
  assert.equal(X.runMode(true, ['node', 'cli.js']), 'interactive')
  assert.equal(X.runMode(undefined, []), null)
  const ctx = ctxFor({ cwd: '/w' })
  assert.deepEqual(X.hookPayload('tool_call', { toolName: 'edit', input: { path: 'src/a.js', edits: [] } }, ctx, ['node', 'pi', '-p']), { hook_event_name: 'tool_call', session_id: 'pi-sess-1', cwd: '/w', mode: 'print', has_ui: false, tool_name: 'edit', files: ['src/a.js'] })
  assert.equal(X.hookPayload('tool_call', { toolName: 'bash', input: { command: 'ls', path: 'x' } }, ctx).files, undefined, 'only edit and write name files')
  const end = X.hookPayload('agent_end', { messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: [{ type: 'toolCall', name: 'x' }, { type: 'text', text: 'Done.' }] }, { role: 'toolResult', content: [] }] }, ctx)
  assert.equal(end.last_assistant_message, 'Done.')
  assert.equal(X.hookPayload('session_shutdown', { reason: 'new' }, ctx).reason, 'new')
  assert.equal(X.EVENTS.length, 5)
})

// A child process as the hook: records its argv and stdin.
function fakeSpawn (calls, { delayMs = 5 } = {}) {
  return (cmd, args, opts) => {
    const child = new EventEmitter()
    let input = ''
    child.stdin = new EventEmitter()
    child.stdin.end = (data) => { input = data }
    child.unref = () => {}
    calls.push({ cmd, args, opts, get payload () { return JSON.parse(input) } })
    setTimeout(() => child.emit('exit', 0), delayMs)
    return child
  }
}

test('extension: one hook at a time, in order; queued activity coalesces; shutdown waits for the rest', async () => {
  const calls = []
  const p = fakePi()
  const { hooks } = await X.register(p, { node: '/n/node', bin: '/a/bin/autochat.js', lounge: true, spawnHook: fakeSpawn(calls, { delayMs: 30 }), argv: ['node', 'pi', '-p'] })
  assert.equal(p.tools.size, 0, 'the room is off')
  const ctx = ctxFor()
  await p.emit('session_start', { reason: 'startup' }, ctx)
  await p.emit('agent_start', {}, ctx)
  for (const n of ['read', 'bash', 'write']) await p.emit('tool_call', { toolName: n, input: { path: 'f.txt' } }, ctx)
  await p.emit('agent_end', { messages: [{ role: 'assistant', content: [{ type: 'text', text: 'ok' }] }] }, ctx)
  assert.equal(calls.length, 1, 'the first hook is still running')
  await p.emit('session_shutdown', { reason: 'quit' }, ctx)
  assert.equal(hooks.pending, 0, 'shutdown returned once everything was handed over')
  assert.deepEqual(calls.map(c => c.args.at(-1)), ['session_start', 'tool_call', 'agent_end', 'session_shutdown'])
  assert.deepEqual(calls[0].args, ['/a/bin/autochat.js', 'hook', '--harness', 'pi', 'session_start'])
  assert.equal(calls[0].cmd, '/n/node')
  assert.equal(calls[0].opts.detached, true)
  assert.deepEqual(calls[1].payload.files, ['f.txt'], 'the newest activity stands for the queued ones')
  assert.equal(calls[1].payload.tool_name, 'write')

  // A hook that can't run is skipped; nothing throws into pi.
  const p2 = fakePi()
  await X.register(p2, { node: '/n', bin: '/b', lounge: true, spawnHook: () => { throw new Error('ENOENT') } })
  await p2.emit('agent_start', {}, ctx)
  await p2.emit('session_shutdown', { reason: 'quit' }, { get cwd () { throw new Error('stale ctx') } })
})

test('extension: the last events still reach autochat when pi exits right after them', { timeout: 30000 }, () => {
  // As in `pi --mode json`: everything happens within milliseconds, then the process has
  // nothing left to do. A hook that records its event stands in for autochat.
  const out = path.join(tmp, 'exit-events.jsonl')
  const hook = path.join(tmp, 'record-hook.mjs')
  fs.writeFileSync(hook, `import fs from 'node:fs'\nlet d = ''\nprocess.stdin.on('data', (c) => { d += c }).on('end', () => { setTimeout(() => { fs.appendFileSync(${JSON.stringify(out)}, JSON.stringify({ event: process.argv.at(-1), payload: JSON.parse(d) }) + '\\n') }, 150) })\n`)
  const script = `
    const { register } = await import(${JSON.stringify(MODULE)})
    const handlers = {}
    const pi = { on: (n, f) => { (handlers[n] ||= []).push(f) }, registerTool () {} }
    await register(pi, { node: process.execPath, bin: ${JSON.stringify(hook)}, lounge: true })
    const ctx = { cwd: '/w', hasUI: false, sessionManager: { getSessionId: () => 'exit-1' } }
    for (const [n, e] of [['session_start', { reason: 'startup' }], ['agent_start', {}], ['tool_call', { toolName: 'bash', input: {} }], ['agent_end', { messages: [] }], ['session_shutdown', { reason: 'quit' }]]) {
      for (const f of handlers[n]) await f(e, ctx)
    }`
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 20000 })
  assert.equal(r.status, 0, r.stderr)
  for (let i = 0; i < 20 && (fs.existsSync(out) ? fs.readFileSync(out, 'utf8').trim().split('\n').length : 0) < 4; i++) spawnSync('sleep', ['0.1'])
  const got = fs.readFileSync(out, 'utf8').trim().split('\n').map(l => JSON.parse(l))
  assert.deepEqual(got.map(g => g.event), ['session_start', 'tool_call', 'agent_end', 'session_shutdown'])
  assert.ok(got.every(g => g.payload.session_id === 'exit-1' && g.payload.mode === 'print'))
})

// A git repo with a GitHub remote, so the agent's card has a repo.
function repo (name) {
  const dir = path.join(tmp, name)
  fs.mkdirSync(dir, { recursive: true })
  const git = (...args) => spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8' })
  git('init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(dir, 'README.md'), '# x\n')
  git('add', '.')
  git('commit', '-q', '-m', 'init')
  git('remote', 'add', 'origin', `https://github.com/example/${name}.git`)
  return dir
}

test('extension: the agent-room tools against a real daemon: presence, status, post, wait, errors, etiquette, /reload', { timeout: 90000 }, async (t) => {
  const home = path.join(tmp, 'd')
  fs.mkdirSync(home, { recursive: true })
  const env = { ...baseEnv, HOME: path.join(tmp, 'dh'), AUTOCHAT_HOME: home, COPILOT_HOME: path.join(tmp, 'copilot'), AUTOCHAT_APP_DIRS: path.join(tmp, 'no-apps'), AUTOCHAT_NO_NOTIFY: '1', AUTOCHAT_NO_FOCUS: '1', AUTOCHAT_AGENT_RESUME_MS: '2000' }
  env.AUTOCHAT_AGENT_NAME = 'pi-room-repo' // named as before #66, which derives names from titles
  // Live paths checked every 100 ms, not 15 s.
  env.AUTOCHAT_AGENT_PATHS_MS = '100'
  process.env.AUTOCHAT_HOME = home
  t.after(() => { process.env.AUTOCHAT_HOME = path.join(tmp, 'ac') })
  const daemon = spawn(process.execPath, [BIN, 'daemon'], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  let daemonErr = ''
  daemon.stderr.on('data', (d) => { daemonErr += d })
  t.after(() => daemon.kill('SIGKILL'))
  let pong = null
  for (let i = 0; i < 100 && !pong; i++) {
    pong = await send({ type: 'ping' }, 300)
    if (!pong) await sleep(100)
  }
  assert.equal(pong?.agentRoom, true)
  const until = async (pred, label) => {
    for (let i = 0; i < 100; i++) { if (pred()) return; await sleep(50) }
    assert.fail(`timed out: ${label}\n${daemonErr}`)
  }

  const cwd = repo('room-repo')
  const p = fakePi()
  await X.register(p, { room: true, env, joinDelayMs: 50 })
  assert.deepEqual([...p.tools.keys()], ['autochat_catch_up', 'autochat_status', 'autochat_post', 'autochat_read', 'autochat_wait', 'autochat_thread'])
  const ctx = ctxFor({ sid: 'pi-room-1', cwd })
  await p.emit('session_start', { reason: 'startup' }, ctx)
  await until(() => /agent pi-room-repo \(pi\) joined/.test(daemonErr), 'pi joins after the delay')
  const call = async (name, args = {}, signal) => {
    const r = await p.tools.get('autochat_' + name).execute('call-1', args, signal, undefined, ctx)
    assert.equal(r.content[0].type, 'text')
    return JSON.parse(r.content[0].text)
  }

  const me = await call('catch_up')
  assert.deepEqual([me.you.name, me.you.harness, me.you.repo, me.you.branch], ['pi-room-repo', 'pi', 'example/room-repo', 'main'])
  const st = await call('status', { summary: 'teaching pi the room', state: 'editing', focus: { components: ['pi'], paths: ['src/x.js'] } })
  assert.deepEqual([st.card.summary, st.card.state, st.card.focus.paths], ['teaching pi the room', 'editing', ['src/x.js']])
  // Live paths, as in `autochat mcp`: a new file in the worktree reaches the card without a status.
  fs.writeFileSync(path.join(cwd, 'notes.md'), 'n\n')
  let live = []
  for (let i = 0; i < 50 && !live.length; i++) { await sleep(100); live = (await call('catch_up')).you.focus.live }
  assert.deepEqual(live, ['notes.md'])
  assert.equal((await call('post', { text: 'hello from pi' })).message.text, 'hello from pi')
  await assert.rejects(p.tools.get('autochat_post').execute('c', { text: 'x', to: ['nobody'] }, undefined, undefined, ctx), /unknown agent: nobody/, 'errors throw, as pi expects')

  // Another agent asks pi something; pi's wait returns it, marked untrusted.
  const { DaemonLink, agentHello } = await import('../src/agent-client.js')
  const other = new DaemonLink({ hello: agentHello({ harness: 'claude', pid: process.pid, cwd, git: { repo: 'example/room-repo', branch: 'b', worktree: 'w' } }) })
  other.start()
  t.after(() => other.close())
  const waiting = call('wait', { timeoutSec: 20 })
  await sleep(200)
  await other.request('post', { text: 'are you on src/x.js?', kind: 'question', to: ['pi-room-repo'] })
  const got = await waiting
  assert.equal(got.messages[0].text, 'are you on src/x.js?')
  assert.equal(got.messages[0].untrusted, true)

  // A wait that pi aborts (Esc) gives up right away.
  const ac = new AbortController()
  const aborted = p.tools.get('autochat_wait').execute('c', { timeoutSec: 30 }, ac.signal, undefined, ctx)
  setTimeout(() => ac.abort(), 100)
  const t0 = Date.now()
  await assert.rejects(aborted, /cancelled/)
  assert.ok(Date.now() - t0 < 5000)

  // The etiquette goes into the system prompt while the tools are on.
  const sp = await p.emit('before_agent_start', { systemPrompt: 'BASE' }, ctx)
  assert.equal(sp.systemPrompt, `BASE\n\n${X.ETIQUETTE}`)
  assert.match(X.ETIQUETTE, /Start: call `autochat_catch_up`, then set `autochat_status` before you edit anything/)
  assert.match(X.ETIQUETTE, /While you work: `autochat_read` before you edit a file/, 'the room\'s read, not pi\'s')
  assert.equal(X.ETIQUETTE.split('\n').length, INSTRUCTIONS.split('\n').length + 1, 'the MCP instructions, with pi\'s tool names')
  p.setActiveTools(['read', 'bash'])
  assert.equal(await p.emit('before_agent_start', { systemPrompt: 'BASE' }, ctx), undefined)

  // /reload: pi shuts this copy of the extension down and loads a new one for the same session.
  await p.emit('session_shutdown', { reason: 'reload' }, ctx)
  await until(() => /agent pi-room-repo \(pi\) away/.test(daemonErr), 'away')
  const again = fakePi()
  await X.register(again, { room: true, env, joinDelayMs: 50 })
  await again.emit('session_start', { reason: 'reload' }, ctx)
  await until(() => /agent pi-room-repo \(pi\) back/.test(daemonErr), 'the same agent is back')
  await again.emit('session_shutdown', { reason: 'quit' }, ctx)
  await until(() => /agent pi-room-repo \(pi\) left/.test(daemonErr), 'quitting leaves')
  assert.equal((daemonErr.match(/agent pi-room-repo \(pi\) away/g) || []).length, 1, 'at once: away only on /reload')
  assert.doesNotMatch(daemonErr, /pi-room-repo-2/, 'never a second pi agent')
})

test('Controller: a pi print run from its recorded events puts you in the lounge until it ends', { timeout: 60000 }, async (t) => {
  const testnet = await createTestnet(3)
  t.after(() => testnet.destroy())
  const c = new Controller({
    identity: ephemeralIdentity(),
    config: { room: 'lc1-pi-' + Math.random().toString(36).slice(2, 12), idleMs: 300, announce: false, countdownSeconds: 30 },
    bootstrap: testnet.bootstrap,
    roomOpts: { graceMs: 1200, heartbeatMs: 300, expireMs: 3000, refreshMs: [300, 800, 1500, 2500], refreshEveryMs: 2000 },
    focus: () => {},
    notify: () => {},
    watchLogs: false
  })
  t.after(() => c.shutdown())
  const deliver = (e) => c.handle(hookMessage(H.sessionEvent(pi, e.event, e.payload, { env: e.env }), e.event))
  const run = fixture('print')
  assert.equal(deliver(run[0]).tracked, false, 'session_start alone tracks nothing')
  deliver(run[1])
  assert.equal(c.phase, 'room')
  assert.deepEqual(c.snapshot().sessions, [{ sid: run[0].payload.session_id, state: 'running', cwd: '/Users/me/code/demo', harness: 'pi' }])
  deliver(run[4])
  deliver(run[5])
  assert.equal(c.sessions.size, 0)
  assert.deepEqual([c.countdown?.reason, c.countdown?.summary], ['end', 'Done with room.'])

  // The TUI never puts you there.
  for (const e of fixture('interactive')) deliver(e)
  assert.equal(c.sessions.size, 0)
})

test('the stub: its settings line round-trips; anything else is not ours', () => {
  const cfg = { node: '/n', bin: '/a/bin/autochat.js', module: '/a/src/harness/pi-extension.js', lounge: true, room: false }
  const src = extensionSource(cfg)
  assert.deepEqual(readExtension(src), cfg)
  assert.match(src, /^\/\/ autochat for pi/)
  assert.match(src, /export default async function autochat \(pi: any\)/)
  assert.equal(readExtension(null), null)
  for (const other of ['', 'export default () => {}', src.replace('// autochat for pi', '// mine'), src.replace(/const AUTOCHAT = .*/, 'const AUTOCHAT = {nope}')]) assert.equal(readExtension(other), undefined)
})
