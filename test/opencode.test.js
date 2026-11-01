import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import cp, { spawnSync } from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { Writable } from 'node:stream'
import { EventEmitter } from 'node:events'
import { fileURLToPath, pathToFileURL } from 'node:url'
import createTestnet from 'hyperdht/testnet.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BIN = path.join(ROOT, 'bin', 'autochat.js')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autochat-opencode-'))
process.env.AUTOCHAT_HOME = path.join(tmp, 'ac')
process.env.COPILOT_HOME = path.join(tmp, 'copilot')
// The plugin's hook processes inherit this environment: none of them may open a real terminal.
process.env.AUTOCHAT_LAUNCH_RECORD = path.join(tmp, 'launches.jsonl')
process.env.AUTOCHAT_APP_DIRS = path.join(tmp, 'no-apps')
const H = await import('../src/harness/index.js')
const O = await import('../src/harness/opencode.js')
const { hookMessage } = await import('../src/harness/event.js')
const { Controller } = await import('../src/controller.js')
const { ephemeralIdentity } = await import('../src/identity.js')

// Recorded from the real opencode 1.2.6 (see each file's `how`): every call it made into a plugin.
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'opencode', name + '.json'), 'utf8'))
const opencode = H.adapter('opencode')
const pick = (evs, k) => evs.map(e => e[k] ?? null)
const hookArgs = (bin, events) => events.map(e => [bin, 'hook', '--harness', 'opencode', e])

let copies = 0
// A copy of the plugin to load here (node wants .mjs for ES modules outside a module package).
async function loadPlugin (source) {
  const file = path.join(tmp, `plugin-${++copies}.mjs`)
  fs.writeFileSync(file, source)
  return (await import(pathToFileURL(file).href)).AutochatPlugin
}

// Feeds a fixture's calls to the plugin, the way opencode made them, in its own process.argv.
async function replay (fx, AutochatPlugin) {
  const argv = process.argv
  process.argv = fx.argv
  let hooks
  try { hooks = await AutochatPlugin({ directory: fx.directory }) } finally { process.argv = argv }
  for (const c of fx.calls) {
    if (c.event) await hooks.event({ event: c.event })
    else await hooks[c.hook]?.(c.input, c.output)
  }
}

// What the plugin hands `autochat hook` for a fixture (a name, or one changed for the test), in
// order: each spawn's command and stdin. The spawns are faked; the CLI test runs real ones.
async function forwarded (fx, ctx = { node: '/n/node', bin: '/a/bin/autochat.js' }) {
  const sent = []
  const real = cp.spawn
  cp.spawn = (cmd, args, opts) => {
    const child = new EventEmitter()
    const chunks = []
    child.stdin = new Writable({ write (chunk, enc, cb) { chunks.push(chunk); cb() } })
    child.stdin.on('finish', () => sent.push({ cmd, args, opts, payload: JSON.parse(Buffer.concat(chunks).toString('utf8')) }))
    child.unref = () => {}
    return child
  }
  syncBuiltinESMExports()
  try {
    await replay(typeof fx === 'string' ? fixture(fx) : fx, await loadPlugin(O.pluginSource(ctx)))
    await new Promise(resolve => setImmediate(resolve))
  } finally {
    cp.spawn = real
    syncBuiltinESMExports()
  }
  return sent
}
const sessionEvents = (sent, config = {}) => sent.map(s => H.sessionEvent(opencode, s.args[4], s.payload, { env: {}, config }))

test('fixtures: opencode run is headless throughout; idle and the end carry its last message', async () => {
  const sent = await forwarded('run')
  assert.deepEqual(sent.map(s => s.args), hookArgs('/a/bin/autochat.js', ['session.created', 'chat.message', 'tool.execute.before', 'session.idle', 'server.instance.disposed']))
  assert.ok(sent.every(s => s.cmd === '/n/node' && s.opts.detached === true && s.opts.stdio.join() === 'pipe,ignore,ignore'), 'detached, so the last ones outlive opencode run')
  const at = sent.map(s => s.payload.at)
  assert.ok(at.every((t, i) => !i || t > at[i - 1]), 'at increases strictly')
  assert.deepEqual(sent[0].payload.argv, ['/$bunfs/root/src/index.js', 'run', 'SCENARIO:glob list the files'])
  assert.ok(sent.every(s => s.payload.pid === process.pid), 'the opencode process: Ctrl+C kills it without a word')

  const evs = sessionEvents(sent)
  assert.deepEqual(pick(evs, 'kind'), ['start', 'activity', 'activity', 'idle', 'end'])
  assert.deepEqual(pick(evs, 'autonomy'), Array(5).fill('autonomous'))
  assert.deepEqual(pick(evs, 'mode'), [null, 'build', 'build', 'build', 'build'], 'the agent, from chat.message')
  assert.ok(evs.every(e => e.harness === 'opencode' && e.sid === 'ses_e6a1f692dffeqhcmzhmJZQOKx0' && e.headless === true && e.cwd === '/Users/me/code/demo'))
  assert.deepEqual(pick(evs, 'at'), at)
  assert.deepEqual(pick(evs, 'pid'), Array(5).fill(process.pid))
  assert.equal(evs[3].summary, 'Done with glob.')
  assert.deepEqual([evs[4].reason, evs[4].summary], ['exit', 'Done with glob.'])

  // `autochat config trigger opencode never`, or a list without headless.
  assert.ok(sessionEvents(sent, { trigger: { opencode: 'never' } }).every(e => e.autonomy === 'interactive'))
  assert.ok(sessionEvents(sent, { trigger: { opencode: ['plan'] } }).slice(1).every(e => e.autonomy === 'interactive'))
})

test('fixtures: run rejects permission requests and hangs on questions; both are requests', async () => {
  const perm = sessionEvents(await forwarded('run-permission'))
  assert.deepEqual(pick(perm, 'kind'), ['start', 'activity', 'activity', 'request', 'activity', 'idle', 'end'])
  assert.ok(perm.every(e => e.autonomy === 'autonomous'))
  assert.deepEqual(perm[3].request, { title: 'Permission needed', message: 'bash: touch perm-test.txt' })
  assert.equal(perm[5].summary, undefined, 'a rejected permission ends the turn without a word')

  const q = sessionEvents(await forwarded('run-question'))
  assert.deepEqual(pick(q, 'kind'), ['start', 'activity', 'activity', 'request'])
  assert.deepEqual(q[3].request, { title: 'opencode has a question for you', message: 'Which color should the button be? [Red / Blue]' })
  assert.equal(q[3].autonomy, 'autonomous')
})

test('fixtures: a subagent works in a child session, which only its parent stands for', async () => {
  const sent = await forwarded('run-subagent')
  assert.deepEqual(sent.map(s => s.args[4]), ['session.created', 'chat.message', 'tool.execute.before', 'session.idle', 'server.instance.disposed'])
  const evs = sessionEvents(sent)
  assert.ok(evs.every(e => e.sid === 'ses_e6a18c39effewQXXvGy78dmIC6' && e.autonomy === 'autonomous'), 'the child (ses_…Qz5Vww) never shows up')
  assert.equal(sent[2].payload.properties.tool, 'task')
  assert.equal(evs[3].summary, 'Done with task.')
})

test('fixtures: the agent is the mode; run --continue is headless from its command line alone', async () => {
  const plan = sessionEvents(await forwarded('run-agent-plan'))
  assert.deepEqual(pick(plan, 'mode'), [null, 'plan', 'plan', 'plan', 'plan'])
  assert.ok(plan.every(e => e.autonomy === 'autonomous'))

  const sent = await forwarded('run-continue')
  assert.deepEqual(sent.map(s => s.args[4]), ['chat.message', 'tool.execute.before', 'session.idle', 'server.instance.disposed'], 'no session.created: it continues one')
  assert.equal(sent[0].payload.session, undefined, 'opencode tells plugins about the session only after the prompt')
  const evs = sessionEvents(sent)
  assert.deepEqual(pick(evs, 'headless'), [true, true, true, true])
  assert.deepEqual(pick(evs, 'autonomy'), Array(4).fill('autonomous'))
})

test('fixtures: run --attach works in a server, where only its session\'s rules say nobody is there', async () => {
  const sent = await forwarded('run-attach')
  assert.equal(O.command(sent[0].payload.argv), 'serve')
  assert.deepEqual(sent.map(s => s.args[4]), ['session.created', 'chat.message', 'tool.execute.before', 'session.idle'], 'the server stays up: no end')
  const evs = sessionEvents(sent)
  assert.deepEqual(pick(evs, 'headless'), [true, true, true, true])
  assert.deepEqual(pick(evs, 'autonomy'), Array(4).fill('autonomous'))
  assert.equal(evs[3].summary, 'Done with glob.')
})

test('fixtures: in the TUI it is interactive; permission and question requests and their answers map', async () => {
  const perm = await forwarded('tui-permission')
  assert.deepEqual(perm[0].payload.argv, ['/$bunfs/root/src/cli/cmd/tui/worker.js'], 'the TUI runs plugins in its worker')
  const evs = sessionEvents(perm)
  assert.deepEqual(pick(evs, 'kind'), ['start', 'activity', 'activity', 'request', 'activity', 'idle', 'end'])
  assert.deepEqual(pick(evs, 'autonomy'), ['unknown', 'interactive', 'interactive', 'interactive', 'interactive', 'interactive', 'interactive'])
  assert.deepEqual(pick(evs, 'headless'), Array(7).fill(false))
  assert.deepEqual(evs[3].request, { title: 'Permission needed', message: 'bash: touch perm-test.txt' })
  assert.equal(evs[4].autonomy, 'interactive')

  const q = sessionEvents(await forwarded('tui-question'))
  assert.deepEqual(pick(q, 'kind'), ['start', 'activity', 'idle', 'activity', 'activity', 'request', 'activity', 'idle', 'end'])
  assert.deepEqual(q[5].request, { title: 'opencode has a question for you', message: 'Which color should the button be? [Red / Blue]' })
  assert.deepEqual(pick(q, 'summary').filter(Boolean), ['Unknown scenario permtouch.', 'Done with ask.', 'Done with ask.'])

  // `autochat config trigger opencode build,headless`: the build agent counts in the TUI too.
  const counted = sessionEvents(perm, { trigger: { opencode: ['build', 'headless'] } })
  assert.deepEqual(pick(counted, 'autonomy'), ['unknown', ...Array(6).fill('autonomous')])

  // `opencode -c` in the TUI, on a session opencode run created: it keeps run's rules for good,
  // and someone is there all the same.
  const rules = fixture('run').calls[0].event.properties.info.permission
  const continued = fixture('tui-permission')
  for (const c of continued.calls) if (/^session\.(created|updated)$/.test(c.event?.type)) c.event.properties.info.permission = rules
  const evs2 = sessionEvents(await forwarded(continued))
  assert.ok(evs2.every(e => e.headless === false), 'the TUI is attended')
  assert.deepEqual(pick(evs2, 'autonomy'), pick(evs, 'autonomy'))
})

test('headless: the session denies the question tool, or this opencode is `run`; the command from argv', () => {
  assert.equal(O.command(['/$bunfs/root/src/index.js', 'run', 'fix it']), 'run')
  assert.equal(O.command(['/$bunfs/root/src/index.js', '--log-level', 'DEBUG', '--print-logs', 'run']), 'run')
  assert.equal(O.command(['/$bunfs/root/src/index.js', 'serve', '--port', '4096']), 'serve')
  assert.equal(O.command(['/$bunfs/root/src/index.js', 'github', 'run']), 'github')
  assert.equal(O.command(['/$bunfs/root/src/cli/cmd/tui/worker.js']), 'tui')
  assert.equal(O.command(['/$bunfs/root/src/index.js']), 'tui')
  assert.equal(O.command(['/$bunfs/root/src/index.js', '/Users/me/code/demo']), 'tui', 'opencode <dir> is the TUI')
  for (const bad of [undefined, null, 'run', [], [7]]) assert.equal(O.command(bad), null)

  const deny = { session: { permission: [{ permission: 'question', pattern: '*', action: 'deny' }] } }
  assert.equal(O.headless({ ...deny, argv: ['/$bunfs/root/src/index.js', 'serve'] }), true, 'run --attach: its session, on a server')
  assert.equal(O.headless({ ...deny, argv: ['/$bunfs/root/src/cli/cmd/tui/worker.js'] }), false, 'the TUI on a session run created')
  assert.equal(O.headless({ ...deny, argv: ['/$bunfs/root/src/index.js', 'acp'] }), false, 'an editor, over ACP')
  assert.equal(O.headless(deny), true, 'no command line: the rules say')
  assert.equal(O.headless({ argv: ['/$bunfs/root/src/index.js', 'serve'] }), false)
  assert.equal(O.headless({ argv: ['/$bunfs/root/src/index.js', 'github', 'run'] }), true)
  assert.equal(O.headless({ session: { permission: [{ permission: 'question', pattern: '*', action: 'allow' }] }, argv: ['x/tui/worker.js'] }), false)
  assert.equal(O.headless({}), null)

  // Nothing says whether anyone's there: an agent that doesn't count leaves it unknown.
  const p = { event: 'chat.message', sessionID: 'ses_1', agent: 'build' }
  assert.equal(H.sessionEvent(opencode, 'chat.message', p, { env: {} }).autonomy, 'unknown')
  assert.equal(H.sessionEvent(opencode, 'chat.message', p, { env: {}, config: { trigger: { opencode: ['build'] } } }).autonomy, 'autonomous')
})

test('normalize: odd payloads, unknown events, edited files, focus origin', () => {
  for (const bad of [null, [], 'x', {}, { sessionID: '../x' }, { sessionID: 7 }]) assert.equal(opencode.normalize('chat.message', bad, {}), null)
  const base = { sessionID: 'ses_1', directory: '/w', argv: ['/$bunfs/root/src/index.js', 'run'] }
  assert.equal(opencode.normalize('session.compacted', base, {}).kind, 'notice')
  assert.equal(opencode.normalize('x', { ...base, event: 'session.idle' }, {}).kind, 'idle', 'the payload names the event')
  const edit = (tool, filePath) => opencode.normalize('tool.execute.before', { ...base, properties: { tool, args: { filePath } } }, {}).files
  assert.deepEqual(edit('edit', '/w/a.js'), ['/w/a.js'])
  assert.deepEqual(edit('write', 'b.js'), ['/w/b.js'], 'relative to where it works')
  assert.equal(edit('read', '/w/a.js'), undefined)
  assert.equal(opencode.normalize('permission.asked', { ...base, properties: {} }, {}).request.message, 'a tool')
  const ev = opencode.normalize('chat.message', { ...base, at: 'soon', session: { directory: '/s' } }, { TMUX: '/t,1,0', TMUX_PANE: '%2' })
  assert.equal(ev.at, undefined)
  assert.equal(ev.cwd, '/s', "the session's directory first")
  assert.deepEqual(ev.origin, { tmux: '/t,1,0', tmuxPane: '%2', termProgram: undefined, bundleId: undefined })
})

test('the plugin never throws or rejects, and a missing node or autochat fails quietly', async () => {
  const AutochatPlugin = await loadPlugin(O.pluginSource({ node: path.join(tmp, 'no-such-node'), bin: path.join(tmp, 'no-such-autochat.js') }))
  const hooks = await AutochatPlugin()
  const odd = [undefined, null, {}, { type: 'session.created' }, { type: 'session.created', properties: { info: null } }, { type: 'session.idle', properties: { sessionID: 5 } },
    { type: 'permission.asked', properties: null }, { type: 'question.asked', properties: { sessionID: 's1', questions: 'x' } }, { type: 'message.part.updated', properties: { part: { type: 'text', time: { end: 1 }, sessionID: 's1', text: 7 } } },
    { type: 'session.created', properties: { info: { id: 's1', parentID: 's1' } } }, { type: 'server.instance.disposed' }]
  for (const event of odd) await hooks.event({ event })
  await hooks.event()
  await hooks['chat.message']()
  await hooks['chat.message']({ sessionID: 's2' }, null)
  await hooks['tool.execute.before'](null, null)
  await hooks['tool.execute.before']({ sessionID: 's2', tool: 'write' }, { args: { filePath: '/w/a', content: 'x'.repeat(100000) } })
  await hooks.event({ event: { type: 'server.instance.disposed', properties: {} } })
  // The spawns fail asynchronously (ENOENT): still nothing thrown.
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.deepEqual(Object.keys(hooks).sort(), ['chat.message', 'event', 'tool.execute.after', 'tool.execute.before'])
})

// --- install, rerun, uninstall ---------------------------------------------------------------------

// A user's ~/.config/opencode, with their own config, plugins and the dependencies opencode installs.
const USER_FILES = {
  'opencode.json': '{\n  "$schema": "https://opencode.ai/config.json",\n  "model": "github-copilot/claude-sonnet-4",\n  "plugin": ["opencode-wakatime"]\n}\n',
  'package.json': '{\n  "dependencies": {\n    "@opencode-ai/plugin": "1.2.6"\n  }\n}',
  '.gitignore': 'node_modules\npackage.json\nbun.lock\n.gitignore',
  'node_modules/@opencode-ai/plugin/package.json': '{"name":"@opencode-ai/plugin","version":"1.2.6"}\n',
  'agent/review.md': '---\ndescription: Reviews the diff\n---\nReview it.\n',
  'plugin/notify.js': 'export const Notify = async () => ({ event: async () => {} })\n'
}
function user (name, { files = USER_FILES, env = {} } = {}) {
  const home = path.join(tmp, name)
  const dir = path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'opencode')
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true })
    fs.writeFileSync(path.join(dir, f), text)
  }
  const node = path.join(home, 'node')
  const bin = path.join(home, 'autochat', 'bin', 'autochat.js')
  fs.mkdirSync(path.dirname(bin), { recursive: true })
  fs.writeFileSync(node, '')
  fs.writeFileSync(bin, '')
  const ctx = H.harnessContext({ env: { HOME: home, PATH: '', ...env }, node, bin })
  return { home, dir, ctx, node, bin }
}
// Every file under a directory, and its bytes.
function snapshot (dir) {
  const out = {}
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else out[path.relative(dir, p)] = fs.readFileSync(p, 'utf8')
    }
  }
  walk(dir)
  return out
}

test('setup adds plugin/autochat.js and nothing else; rerun is a no-op; uninstall leaves the directory byte-for-byte as it was', () => {
  const u = user('install')
  const before = snapshot(u.dir)
  const plan = opencode.planHooks(u.ctx)
  assert.deepEqual([plan.action, plan.file], ['add', path.join(u.dir, 'plugin', 'autochat.js')])
  assert.deepEqual(plan.entries, [`a plugin that runs '${u.node}' '${u.bin}' hook --harness opencode <event>`])
  assert.deepEqual(opencode.hookStatus(u.ctx), { installed: false, file: plan.file, valid: true })
  plan.apply()

  const after = snapshot(u.dir)
  assert.deepEqual(Object.keys(after).sort(), [...Object.keys(before), path.join('plugin', 'autochat.js')].sort())
  for (const f of Object.keys(before)) assert.equal(after[f], before[f], `${f} unchanged`)
  const source = after[path.join('plugin', 'autochat.js')]
  assert.equal(source, O.pluginSource(u.ctx))
  assert.ok(source.includes(`const NODE = ${JSON.stringify(u.node)}\nconst BIN = ${JSON.stringify(u.bin)}\n`))
  assert.equal(fs.readdirSync(path.join(u.dir, 'plugin')).filter(f => /autochat\.js\.autochat/.test(f)).length, 0, 'no backup or temp file left behind')
  assert.deepEqual(opencode.hookStatus(u.ctx), { installed: true, file: plan.file, valid: true })

  const mtime = fs.statSync(plan.file).mtimeMs
  assert.equal(opencode.planHooks(u.ctx).action, 'none')
  const lines = []
  assert.equal(H.setupHooks({ ids: ['opencode'], ctx: u.ctx, out: (l) => lines.push(l) }).applied.length, 0)
  assert.match(lines.join('\n'), /opencode hooks already installed \(~\/\.config\/opencode\/plugin\/autochat\.js\)\nNothing to change\./)
  assert.equal(fs.statSync(plan.file).mtimeMs, mtime, 'rerunning writes nothing')

  // A moved install: our plugin is rewritten in place.
  const moved = H.harnessContext({ env: { HOME: u.home, PATH: '' }, node: u.node, bin: path.join(u.home, 'new', 'bin', 'autochat.js') })
  const up = opencode.planHooks(moved)
  assert.deepEqual([up.action, up.file], ['update', plan.file])
  up.apply()
  assert.deepEqual(opencode.hookStatus(moved), { installed: true, file: plan.file, valid: false }, "the autochat.js it runs doesn't exist")

  const un = opencode.unplanHooks(u.ctx)
  assert.deepEqual([un.action, un.file], ['remove', plan.file])
  un.apply()
  assert.deepEqual(snapshot(u.dir), before, 'only ours went')
  assert.equal(opencode.unplanHooks(u.ctx).action, 'none')
})

test('plugins/ when that is the directory the user has; never someone else\'s autochat.js; XDG_CONFIG_HOME', () => {
  const plural = user('plural', { files: { 'plugins/notify.js': USER_FILES['plugin/notify.js'] } })
  const plan = opencode.planHooks(plural.ctx)
  assert.equal(plan.file, path.join(plural.dir, 'plugins', 'autochat.js'))
  plan.apply()
  assert.equal(fs.existsSync(path.join(plural.dir, 'plugin')), false, 'no second plugin directory')
  assert.equal(opencode.planHooks(plural.ctx).action, 'none')
  opencode.unplanHooks(plural.ctx).apply()
  assert.deepEqual(snapshot(plural.dir), { [path.join('plugins', 'notify.js')]: USER_FILES['plugin/notify.js'] })

  // A plugin of the user's own that happens to be called autochat.js: shown, never replaced.
  const theirs = 'export const Mine = async () => ({})\n'
  const taken = user('taken', { files: { 'plugin/autochat.js': theirs } })
  const manual = opencode.planHooks(taken.ctx)
  assert.equal(manual.action, 'manual')
  assert.equal(manual.apply, undefined)
  assert.match(H.describeHookPlan(manual, taken.ctx).join('\n'), /plugin\/autochat\.js is a plugin of someone else's, so autochat won't replace it\. Add this yourself:\n\s+\/\/ autochat's opencode plugin/)
  assert.equal(opencode.unplanHooks(taken.ctx).action, 'none')
  assert.equal(opencode.hookStatus(taken.ctx).installed, false)
  assert.equal(fs.readFileSync(path.join(taken.dir, 'plugin', 'autochat.js'), 'utf8'), theirs)

  // XDG_CONFIG_HOME moves ~/.config, as it does for opencode; no config dir yet.
  const xdg = user('xdg', { files: {}, env: { XDG_CONFIG_HOME: path.join(tmp, 'xdg-config') } })
  assert.equal(opencode.planHooks(xdg.ctx).file, path.join(tmp, 'xdg-config', 'opencode', 'plugin', 'autochat.js'))
  opencode.planHooks(xdg.ctx).apply()
  assert.equal(opencode.hookStatus(xdg.ctx).installed, true)
  assert.equal(opencode.detect(xdg.ctx).installed, true, 'its config dir exists now')
  assert.equal(opencode.detect(xdg.ctx).paths.plugin, path.join(tmp, 'xdg-config', 'opencode', 'plugin', 'autochat.js'))
})

test('a symlinked config directory (dotfiles) stays a symlink; uninstall is still byte-for-byte', () => {
  const home = path.join(tmp, 'dotfiles-user')
  const target = path.join(home, 'dotfiles', 'opencode')
  fs.mkdirSync(path.join(target, 'plugin'), { recursive: true })
  fs.writeFileSync(path.join(target, 'opencode.json'), USER_FILES['opencode.json'])
  fs.mkdirSync(path.join(home, '.config'), { recursive: true })
  fs.symlinkSync(path.resolve(target), path.join(home, '.config', 'opencode'))
  const ctx = H.harnessContext({ env: { HOME: home, PATH: '' }, node: process.execPath, bin: BIN })
  const before = snapshot(target)
  opencode.planHooks(ctx).apply()
  assert.ok(fs.lstatSync(path.join(home, '.config', 'opencode')).isSymbolicLink())
  assert.ok(fs.existsSync(path.join(target, 'plugin', 'autochat.js')), 'written through the link')
  opencode.unplanHooks(ctx).apply()
  assert.deepEqual(snapshot(target), before)
})

// --- the CLI, with the real plugin and real hook processes --------------------------------------------

// The parent env minus anything that points at a real home or harness.
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(AUTOCHAT|LOLCHAT)_|^(HOME|COPILOT_HOME|XDG_CONFIG_HOME|CODEX_HOME|CLAUDE_CONFIG_DIR|TMUX|TMUX_PANE|TERM_PROGRAM|__CFBundleIdentifier)$/.test(k)))

test('CLI: setup offers opencode; setup --harness opencode installs the plugin, whose hooks deliver SessionEvents; uninstall removes only it', { timeout: 60000 }, async () => {
  const home = path.join(tmp, 'cli')
  const bins = path.join(tmp, 'cli-bin')
  fs.mkdirSync(bins, { recursive: true })
  fs.writeFileSync(path.join(bins, 'opencode'), '#!/bin/sh\nexit 1\n')
  fs.chmodSync(path.join(bins, 'opencode'), 0o755)
  const dir = path.join(home, '.config', 'opencode')
  for (const f of ['opencode.json', 'plugin/notify.js']) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true })
    fs.writeFileSync(path.join(dir, f), USER_FILES[f])
  }
  const before = snapshot(dir)
  const env = { ...baseEnv, HOME: home, AUTOCHAT_HOME: process.env.AUTOCHAT_HOME, COPILOT_HOME: path.join(home, '.copilot'), AUTOCHAT_HARNESS_PATH: bins, AUTOCHAT_APP_DIRS: path.join(tmp, 'no-apps'), AUTOCHAT_LAUNCH_RECORD: path.join(tmp, 'cli-launches.jsonl') }
  const cli = (...args) => spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8' })

  const plain = cli('setup')
  assert.equal(plain.status, 0, plain.stderr)
  assert.match(plain.stdout, /Also found opencode\. To go to the lounge from it too: autochat setup --harness opencode/)
  assert.deepEqual(snapshot(dir), before, 'plain setup without a terminal never touches it')

  const dry = cli('setup', '--harness', 'opencode', '--dry-run')
  assert.equal(dry.status, 0, dry.stderr)
  assert.match(dry.stdout, /opencode add hooks to ~\/\.config\/opencode\/plugin\/autochat\.js\n {11}\+ a plugin that runs '.+' '.+autochat\.js' hook --harness opencode <event>\n/)
  assert.match(dry.stdout, /Dry run: nothing changed\./)
  const real = cli('setup', '--harness', 'opencode')
  assert.equal(real.status, 0, real.stderr)
  assert.match(real.stdout, /✔ opencode hooks installed\nNew opencode processes load the plugin; ones already running \(a TUI, opencode serve\) don't until they restart\.\n/)
  assert.match(cli('setup', '--harness', 'opencode').stdout, /opencode hooks already installed \(~\/\.config\/opencode\/plugin\/autochat\.js\)\nNothing to change\./)

  // The installed plugin, fed a recorded `opencode run`: its hooks run `autochat hook --harness
  // opencode`, for real, and reach a running core over the socket.
  const { serve } = await import('../src/ipc.js')
  const got = []
  const server = await serve((m) => { got.push(m); return {} })
  try {
    await replay(fixture('run-permission'), await loadPlugin(fs.readFileSync(path.join(dir, 'plugin', 'autochat.js'), 'utf8')))
    for (let i = 0; i < 200 && got.length < 7; i++) await new Promise(resolve => setTimeout(resolve, 50))
  } finally {
    server.close()
  }
  // Each in its own process, so they may land in any order: `at` says which came first.
  got.sort((a, b) => a.at - b.at)
  assert.deepEqual(got.map(m => [m.type, m.harness, m.event, m.kind, m.autonomy]), [
    ['hook', 'opencode', 'session.created', 'start', 'autonomous'],
    ['hook', 'opencode', 'chat.message', 'activity', 'autonomous'],
    ['hook', 'opencode', 'tool.execute.before', 'activity', 'autonomous'],
    ['hook', 'opencode', 'permission.asked', 'request', 'autonomous'],
    ['hook', 'opencode', 'permission.replied', 'activity', 'autonomous'],
    ['hook', 'opencode', 'session.idle', 'stop', 'autonomous'],
    ['hook', 'opencode', 'server.instance.disposed', 'end', 'autonomous']
  ])
  assert.deepEqual(got.map(m => m.mode), [null, 'build', 'build', 'build', 'build', 'build', 'build'])
  assert.ok(got.every(m => m.sessionId === 'ses_e6a1c3184ffeK26qpMwHOC2n08' && m.headless === true && m.cwd === '/Users/me/code/demo'))
  assert.equal(got[3].request.message, 'bash: touch perm-test.txt')

  // What doctor shows.
  const ctx = H.harnessContext({ env, node: process.execPath, bin: BIN })
  assert.deepEqual(H.hooksStatus(ctx).find(h => h.id === 'opencode'), { id: 'opencode', name: 'opencode', installed: true, hooks: { installed: true, file: path.join(dir, 'plugin', 'autochat.js'), valid: true } })

  const un = cli('uninstall')
  assert.equal(un.status, 0, un.stderr)
  assert.match(un.stdout, /^hooks removed\.\nremoved autochat's hooks from opencode \(~\/\.config\/opencode\/plugin\/autochat\.js\)\n$/)
  assert.deepEqual(snapshot(dir), before)
})

test('autochat hook --harness opencode: a headless run opens autochat; the TUI never does', () => {
  const env = { ...baseEnv, HOME: path.join(tmp, 'hook-home'), AUTOCHAT_HOME: path.join(tmp, 'hook-ac'), AUTOCHAT_LAUNCH_RECORD: path.join(tmp, 'hook-launches.jsonl'), AUTOCHAT_APP_DIRS: path.join(tmp, 'no-apps'), AUTOCHAT_DEBUG: '1', TMUX: '/x/tmux,1,0', TMUX_PANE: '%1' }
  const hook = (event, payload) => {
    const r = spawnSync(process.execPath, [BIN, 'hook', '--harness', 'opencode', event], { input: JSON.stringify(payload), env, encoding: 'utf8' })
    assert.equal(r.stdout, '')
    return JSON.parse(r.stderr.trim().split('\n').pop()).action
  }
  const tui = { sessionID: 'ses_tui', agent: 'build', argv: ['/$bunfs/root/src/cli/cmd/tui/worker.js'], directory: '/w' }
  assert.equal(hook('chat.message', { ...tui, event: 'chat.message' }), 'ignored')
  assert.equal(hook('permission.asked', { ...tui, event: 'permission.asked', properties: { permission: 'bash', patterns: ['ls'] } }), 'ignored')
  const run = { sessionID: 'ses_run', agent: 'build', argv: ['/$bunfs/root/src/index.js', 'run', 'x'], directory: '/w', at: 1793516097200 }
  assert.equal(hook('session.created', { ...run, event: 'session.created' }), 'ignored', 'starting is not working')
  assert.equal(hook('chat.message', { ...run, event: 'chat.message' }), 'launched')
  const spool = path.join(env.AUTOCHAT_HOME, 'run')
  const msg = JSON.parse(fs.readFileSync(path.join(spool, fs.readdirSync(spool).find(f => f.startsWith('spool-'))), 'utf8'))
  assert.deepEqual([msg.harness, msg.sessionId, msg.kind, msg.mode, msg.headless, msg.autonomy, msg.at], ['opencode', 'ses_run', 'activity', 'build', true, 'autonomous', 1793516097200])
})

// --- the Controller -----------------------------------------------------------------------------------

function controller (testnet, opts = {}) {
  return new Controller({
    identity: ephemeralIdentity(),
    config: { room: 'lc1-opencode-' + Math.random().toString(36).slice(2, 12), idleMs: 300, announce: false, countdownSeconds: 30 },
    bootstrap: testnet.bootstrap,
    roomOpts: { graceMs: 1200, heartbeatMs: 300, expireMs: 3000, refreshMs: [300, 800, 1500, 2500], refreshEveryMs: 2000 },
    focus: () => {},
    notify: () => {},
    requestLingerMs: 500,
    watchLogs: false,
    ...opts
  })
}

test('Controller: an opencode run in the room, whatever order its hooks land in', { timeout: 60000 }, async (t) => {
  const testnet = await createTestnet(3)
  t.after(() => testnet.destroy())
  const c = controller(testnet)
  t.after(() => c.shutdown())
  const messages = async (name) => (await forwarded(name)).map(s => hookMessage(H.sessionEvent(opencode, s.args[4], s.payload, { env: {} }), s.args[4]))

  // In order: the run puts you in the room, and its end starts the countdown with its last words.
  const run = await messages('run')
  for (const m of run.slice(0, 3)) c.handle(m)
  assert.equal(c.phase, 'room')
  assert.deepEqual(c.snapshot().sessions, [{ sid: 'ses_e6a1f692dffeqhcmzhmJZQOKx0', state: 'running', cwd: '/Users/me/code/demo', harness: 'opencode' }])
  // The end overtook the idle: the summary still comes through, and the stale idle changes nothing.
  c.handle(run[4])
  assert.deepEqual([c.countdown?.reason, c.countdown?.summary], ['end', 'Done with glob.'])
  assert.equal(c.handle(run[3]).tracked, false)
  // So does an activity from before the end: it doesn't bring the finished session back.
  assert.equal(c.handle(run[2]).tracked, false)
  assert.equal(c.sessions.size, 0)

  // The question that hangs opencode run: the tool's activity lands after the request, and the
  // request stays open.
  const q = await messages('run-question')
  c.handle(q[1])
  c.handle(q[3])
  c.handle(q[2])
  assert.deepEqual([c.currentRequest().title, c.currentRequest().message, c.currentRequest().resolved], ['opencode has a question for you', 'Which color should the button be? [Red / Blue]', false])
  assert.equal(c.sessions.get('opencode:ses_e6a1c2e2bffe50L5wB94P1KEFI').state, 'needed')

  // Rejected within milliseconds: the reply may overtake the request; it stays answered.
  const p = await messages('run-permission')
  c.handle(p[1])
  c.handle(p[4])
  c.handle(p[3])
  const s = c.sessions.get('opencode:ses_e6a1c3184ffeK26qpMwHOC2n08')
  assert.equal(s.state, 'running')
  assert.equal(s.request, null)
})

test('Controller: Ctrl+C kills opencode run without a word; the session ends once its process is gone', { timeout: 60000 }, async (t) => {
  const testnet = await createTestnet(3)
  t.after(() => testnet.destroy())
  const c = controller(testnet, { pidCheckMs: 50 })
  t.after(() => c.shutdown())
  // A stand-in for the opencode process, and the question that hangs its run.
  const opencodeProcess = cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  t.after(() => opencodeProcess.kill())
  const q = (await forwarded('run-question')).map(s => ({ ...s, payload: { ...s.payload, pid: opencodeProcess.pid } }))
  for (const s of q.slice(1)) c.handle(hookMessage(H.sessionEvent(opencode, s.args[4], s.payload, { env: {} }), s.args[4]))
  const key = 'opencode:ses_e6a1c2e2bffe50L5wB94P1KEFI'
  assert.equal(c.sessions.get(key).state, 'needed')
  await new Promise(resolve => setTimeout(resolve, 200))
  assert.equal(c.sessions.get(key).state, 'needed', 'still there while its process lives')

  opencodeProcess.kill('SIGINT')
  await new Promise(resolve => opencodeProcess.once('exit', resolve))
  for (let i = 0; i < 40 && c.sessions.has(key); i++) await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(c.sessions.has(key), false)
  assert.equal(c.countdown?.reason, 'end')
  assert.equal(c.currentRequest(), null)
})
