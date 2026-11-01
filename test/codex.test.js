import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import createTestnet from 'hyperdht/testnet.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BIN = path.join(ROOT, 'bin', 'autochat.js')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autochat-codex-'))
process.env.AUTOCHAT_HOME = path.join(tmp, 'ac')
process.env.COPILOT_HOME = path.join(tmp, 'copilot')
const H = await import('../src/harness/index.js')
const { headless, sessionSource, turnContext, trustHash, hooksFile, HOOK_EVENTS } = await import('../src/harness/codex.js')
const { hookMessage } = await import('../src/harness/event.js')
const { Controller } = await import('../src/controller.js')
const { ephemeralIdentity } = await import('../src/identity.js')

const codex = H.adapter('codex')
const CODEX_HOME = path.join(tmp, 'codex-home')

// Recorded from Codex 0.166.0 (see each file's `how` and `note`). Each session's rollout is
// written under a temp CODEX_HOME as Codex wrote it, in brief: its session_meta first line, then
// per turn a turn_context line (the turn's collaboration mode and approvals reviewer) and other
// lines that name the turn.
function fixture (name) {
  const f = JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'codex', name + '.json'), 'utf8'))
  const real = (p) => p.replace('$CODEX_HOME', CODEX_HOME)
  for (const [p, meta] of Object.entries(f.rollouts)) {
    const file = real(p)
    const id = /([0-9a-f-]{36})\.jsonl$/.exec(file)[1]
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const at = '2026-11-01T16:50:00.000Z'
    const lines = [{ timestamp: at, type: 'session_meta', payload: { session_id: id, id, timestamp: at, cwd: '/Users/me/code/demo', originator: meta.originator, cli_version: meta.cli_version, source: meta.source, thread_source: meta.thread_source } }]
    for (const [turn, t] of Object.entries(meta.turns)) {
      lines.push({ timestamp: at, type: 'event_msg', payload: { type: 'task_started', turn_id: turn, collaboration_mode_kind: t.mode } })
      lines.push({ timestamp: at, type: 'turn_context', payload: { turn_id: turn, cwd: '/Users/me/code/demo', approval_policy: t.approval_policy, approvals_reviewer: t.reviewer, model: 'gpt-5.5', collaboration_mode: { mode: t.mode, settings: { model: 'gpt-5.5' } } } })
      lines.push({ timestamp: at, type: 'event_msg', payload: { type: 'token_count', turn_id: turn } })
    }
    fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n')
  }
  return f.events.map(e => ({ ...e, payload: e.payload.transcript_path ? { ...e.payload, transcript_path: real(e.payload.transcript_path) } : e.payload }))
}
const replay = (events, config = {}, env = {}) => events.map(e => H.sessionEvent(codex, e.event, e.payload, { env: { CODEX_HOME, ...env, ...e.env }, config }))
const pick = (evs, k) => evs.map(e => e[k] ?? null)

// Every field Codex 0.166.0 sends, per event (a subagent's also have agent_id and agent_type).
const COMMON = ['cwd', 'hook_event_name', 'model', 'permission_mode', 'session_id', 'transcript_path']
const FIELDS = {
  SessionStart: [...COMMON, 'source'],
  UserPromptSubmit: [...COMMON, 'prompt', 'turn_id'],
  PreToolUse: [...COMMON, 'tool_input', 'tool_name', 'tool_use_id', 'turn_id'],
  PermissionRequest: [...COMMON, 'tool_input', 'tool_name', 'turn_id'],
  PostToolUse: [...COMMON, 'tool_input', 'tool_name', 'tool_response', 'tool_use_id', 'turn_id'],
  Stop: [...COMMON, 'last_assistant_message', 'stop_hook_active', 'turn_id'],
  Interrupt: [...COMMON, 'turn_id'],
  SessionEnd: ['cwd', 'hook_event_name', 'reason', 'session_id', 'transcript_path']
}
const FIXTURES = ['exec', 'exec-subagent', 'exec-approve-for-me', 'exec-interrupt', 'tui', 'tui-never', 'tui-auto-review']

test('fixtures: every field Codex sends, for each event we install', () => {
  for (const name of FIXTURES) {
    for (const e of fixture(name)) {
      assert.equal(e.payload.hook_event_name, e.event)
      const extra = e.payload.agent_id ? ['agent_id', 'agent_type'] : []
      assert.deepEqual(Object.keys(e.payload).sort(), [...FIELDS[e.event], ...extra].sort(), `${name} ${e.event}`)
      if ('permission_mode' in e.payload) assert.ok(['default', 'bypassPermissions'].includes(e.payload.permission_mode))
    }
  }
  assert.deepEqual(Object.keys(FIELDS).sort(), [...HOOK_EVENTS].sort(), 'every event we install')
})

test('fixtures: codex exec is headless and autonomous throughout; edits name their files', () => {
  const evs = replay(fixture('exec'))
  assert.deepEqual(pick(evs, 'kind'), ['start', ...Array(7).fill('activity'), 'idle', 'end'])
  assert.deepEqual(pick(evs, 'autonomy'), Array(10).fill('autonomous'), 'the rollout says source: exec')
  assert.deepEqual(pick(evs, 'mode'), [...Array(9).fill('bypassPermissions'), null], 'SessionEnd has no permission_mode')
  assert.ok(evs.every(e => e.harness === 'codex' && e.sid === evs[0].sid && e.headless === true && e.cwd === '/Users/me/code/demo'))
  assert.deepEqual(pick(evs, 'files'), [null, null, null, null, ['notes/hello.txt'], ['notes/hello.txt'], ['notes/hello.txt'], ['notes/hello.txt'], null, null], 'apply_patch: the files in the patch; Bash names none')
  assert.match(evs[8].summary, /^Done with work: /)
  assert.equal(evs[9].reason, 'other')
  assert.ok(replay(fixture('exec'), { trigger: { codex: 'never' } }).every(e => e.autonomy === 'interactive'))

  // Ctrl+C: Codex reports the interrupt, then the end of the session, and codex exec exits.
  const stopped = replay(fixture('exec-interrupt'))
  assert.deepEqual(pick(stopped, 'kind'), ['start', 'activity', 'activity', 'end', 'end'])
  assert.deepEqual(pick(stopped, 'reason'), [null, null, null, 'interrupt', 'other'])
  assert.deepEqual(pick(stopped, 'autonomy'), Array(5).fill('autonomous'))
})

test('fixtures: codex exec never asks you: approvals go to its automatic reviewer', () => {
  // --approve-for-me keeps the approval policy (permission_mode default) and hands approvals to
  // the reviewer, which turns this one down: nobody is asked.
  const evs = replay(fixture('exec-approve-for-me'))
  assert.deepEqual(pick(evs, 'kind'), ['start', 'activity', 'activity', 'activity', 'idle', 'end'])
  assert.deepEqual(pick(evs, 'mode'), [...Array(5).fill('default'), null])
  assert.deepEqual(pick(evs, 'autonomy'), Array(6).fill('autonomous'), 'headless counts')
  assert.ok(evs.every(e => !e.request))

  // So it is with request_user_input, which codex exec turns down too.
  const ask = { ...fixture('tui')[11], payload: { ...fixture('exec')[2].payload, tool_name: 'request_user_input', tool_input: fixture('tui')[11].payload.tool_input } }
  assert.equal(replay([ask])[0].kind, 'activity')
})

test('fixtures: the TUI is interactive; approvals and Plan-mode questions are put to you, Default-mode ones refused', () => {
  const evs = replay(fixture('tui'))
  assert.deepEqual(pick(evs, 'kind'), [
    'start', 'activity', 'activity', 'activity', 'idle',
    'activity', 'activity', 'request', 'activity', 'idle',
    'activity', 'activity', 'idle',
    'activity', 'request', 'activity', 'activity', 'activity', 'idle',
    'activity', 'activity', 'waiting', 'end'
  ])
  assert.deepEqual(pick(evs, 'autonomy'), [...Array(22).fill('interactive'), 'unknown'], 'source: vscode (the TUI through its daemon), default approvals; SessionEnd has no permission_mode')
  assert.ok(evs.every(e => e.headless === false))
  assert.deepEqual(evs[7].request, { title: 'Permission needed', message: 'Bash: echo needs approval (Just checking approvals)' })
  assert.equal(evs[11].request, undefined, 'Default mode: Codex refuses request_user_input right after PreToolUse')
  assert.deepEqual(evs[14].request, { title: 'Codex has a question for you', message: 'Which color should the button be? [Red (Recommended) / Blue]' })
  assert.match(evs[18].summary, /^Done with askshell: /)

  // default_mode_request_user_input lets Default mode ask too.
  const home = path.join(tmp, 'codex-ask')
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(path.join(home, 'config.toml'), 'model = "gpt-5.5"\n\n[features]\ndefault_mode_request_user_input = true\n')
  assert.equal(replay(fixture('tui'), {}, { CODEX_HOME: home })[11].kind, 'request')

  // With the automatic reviewer on, approvals aren't put to you either.
  const auto = replay(fixture('tui-auto-review'))
  assert.deepEqual(pick(auto, 'kind'), ['start', 'activity', 'activity', 'activity', 'idle', 'activity', 'activity', 'activity', 'idle', 'end'])
  assert.ok(auto.every(e => !e.request))

  // --no-daemon -a never: source cli; an approval-bypass mode, so it only counts when you say so.
  const never = replay(fixture('tui-never'))
  assert.deepEqual(pick(never, 'autonomy'), [...Array(7).fill('interactive'), 'unknown'])
  assert.deepEqual(pick(never, 'headless'), Array(8).fill(false))
  assert.deepEqual(pick(replay(fixture('tui-never'), { trigger: { codex: ['bypassPermissions', 'headless'] } }), 'autonomy'), [...Array(7).fill('autonomous'), 'unknown'], 'autochat config trigger codex bypassPermissions,headless')
  assert.deepEqual(H.parseTrigger('codex', 'bypassPermissions,headless'), ['bypassPermissions', 'headless'])
  assert.throws(() => H.parseTrigger('codex', 'never-ask'), /codex modes: default, acceptEdits, plan, dontAsk, bypassPermissions, headless/)
})

test('fixtures: a subagent\'s hooks point at its own rollout, which says only that it\'s a subagent: unknown', () => {
  const events = fixture('exec-subagent')
  const evs = replay(events)
  assert.deepEqual(pick(evs, 'kind'), ['start', 'activity', 'activity', 'activity', 'activity', 'activity', 'activity', 'activity', 'activity', 'idle', 'end'])
  const sub = events.map(e => !!e.payload.agent_id)
  assert.deepEqual(sub, [false, false, false, false, true, false, true, true, false, false, false])
  assert.deepEqual(pick(evs, 'autonomy'), sub.map(s => s ? 'unknown' : 'autonomous'))
  assert.deepEqual(pick(evs, 'headless'), sub.map(s => s ? null : true))
  assert.ok(evs.every(e => e.sid === evs[0].sid), 'one session: the parent\'s')
  assert.equal(sessionSource(events[6].payload.transcript_path).source.subagent.thread_spawn.parent_thread_id, evs[0].sid)
})

test('the turn\'s settings: the latest turn_context for that turn, from the end of the rollout', () => {
  const dir = path.join(tmp, 'turns')
  fs.mkdirSync(dir, { recursive: true })
  const file = (name, lines) => { const f = path.join(dir, name); fs.writeFileSync(f, lines.map(l => typeof l === 'string' ? l : JSON.stringify(l)).join('\n') + '\n'); return f }
  const meta = { timestamp: 't', type: 'session_meta', payload: { id: 's', source: 'cli' } }
  const ctxLine = (turn, mode, reviewer, pad = 0) => ({ timestamp: 't', ordinal: 1, type: 'turn_context', payload: { turn_id: turn, approval_policy: 'on-request', approvals_reviewer: reviewer, collaboration_mode: { mode }, user_instructions: 'x'.repeat(pad) } })
  const item = (turn, pad = 0) => ({ timestamp: 't', type: 'event_msg', payload: { type: 'item_completed', turn_id: turn, text: 'y'.repeat(pad) } })
  const f = file('a.jsonl', [meta, ctxLine('t1', 'default', 'user'), item('t1'), ctxLine('t2', 'plan', 'auto_review', 12000), item('t2'), item('t2'), item('t1')])
  assert.deepEqual(turnContext(f, 't2'), { mode: 'plan', reviewer: 'auto_review' })
  assert.deepEqual(turnContext(f, 't1'), { mode: 'default', reviewer: 'user' })
  assert.equal(turnContext(f, 't3'), null)
  assert.equal(turnContext(file('b.jsonl', [meta, item('t1'), '{"type":"turn_context","payload":{"turn_id":"t1",broken']), 't1'), null)
  // A turn that started more than 8 MB from the end of the rollout: unknown.
  const long = file('c.jsonl', [meta, ctxLine('t1', 'plan', 'user'), ...Array(9).fill(0).map(() => item('t1', 1024 * 1024))])
  assert.equal(turnContext(long, 't1'), null)
  for (const [p, t] of [[null, 't1'], ['rel.jsonl', 't1'], [path.join(dir, 'missing.jsonl'), 't1'], [f, null], [f, '"x'], [f, '']]) assert.equal(turnContext(p, t), null)

  // Unknown: put to you, as before.
  const p = { session_id: 's-1', hook_event_name: 'PermissionRequest', permission_mode: 'default', tool_name: 'Bash', tool_input: { command: 'ls' }, transcript_path: path.join(dir, 'missing.jsonl'), turn_id: 't1' }
  assert.equal(codex.normalize('PermissionRequest', p, { CODEX_HOME }).kind, 'request')
  assert.equal(codex.normalize('PermissionRequest', { ...p, transcript_path: f, turn_id: 't2' }, { CODEX_HOME }).kind, 'activity', 'the automatic reviewer answers it')
  assert.equal(codex.normalize('PreToolUse', { ...p, hook_event_name: 'PreToolUse', tool_name: 'request_user_input', tool_input: { questions: [] }, transcript_path: f, turn_id: 't2' }, { CODEX_HOME }).kind, 'request', 'Plan mode')
  assert.equal(codex.normalize('PreToolUse', { ...p, hook_event_name: 'PreToolUse', tool_name: 'request_user_input', tool_input: { questions: [] }, transcript_path: f, turn_id: 't1' }, { CODEX_HOME }).kind, 'activity', 'Default mode')
  const odd = path.join(dir, 'odd-home')
  fs.mkdirSync(path.join(odd, 'config.toml'), { recursive: true })
  assert.equal(codex.normalize('PreToolUse', { ...p, hook_event_name: 'PreToolUse', tool_name: 'request_user_input', tool_input: { questions: [] }, transcript_path: f, turn_id: 't1' }, { CODEX_HOME: odd }).kind, 'activity', 'a config.toml it can\'t read: never throws')
})

test('the headless signal: rollouts old and new, long, missing or odd', () => {
  const dir = path.join(tmp, 'rollouts')
  fs.mkdirSync(dir, { recursive: true })
  const file = (name, text) => { const f = path.join(dir, name); fs.writeFileSync(f, text); return f }
  const meta = (payload) => JSON.stringify({ timestamp: 't', type: 'session_meta', payload }) + '\n'
  assert.equal(headless(file('exec.jsonl', meta({ id: 'x', originator: 'codex_exec', source: 'exec' }))), true)
  assert.equal(headless(file('tui.jsonl', meta({ id: 'x', originator: 'codex-tui', source: 'vscode' }))), false, 'the TUI through its app-server daemon')
  assert.equal(headless(file('cli.jsonl', meta({ id: 'x', originator: 'codex-tui', source: 'cli' }))), false, 'the TUI with --no-daemon')
  assert.equal(headless(file('mcp.jsonl', meta({ id: 'x', source: 'mcp' }))), false, 'codex mcp-server: another agent drives it')
  assert.equal(headless(file('old-exec.jsonl', meta({ id: 'x', originator: 'codex_exec' }))), true, 'before source: the originator')
  assert.equal(headless(file('old-cli.jsonl', meta({ id: 'x', originator: 'codex_cli_rs' }))), false)
  assert.equal(headless(file('sub.jsonl', meta({ id: 'x', originator: 'codex_exec', source: { subagent: { thread_spawn: { parent_thread_id: 'p', depth: 1 } } } }))), null)
  assert.equal(headless(file('custom.jsonl', meta({ id: 'x', source: { custom: 'my-app' } }))), null)
  assert.equal(headless(file('unknown.jsonl', meta({ id: 'x', source: 'unknown' }))), null)
  // A session_meta line longer than what's read (huge base instructions): its first fields do.
  const big = { session_id: 'x', id: 'x', timestamp: 't', cwd: '/w', originator: 'codex_exec', cli_version: '0.166.0', source: 'exec', base_instructions: { text: 'x'.repeat(200 * 1024) } }
  assert.equal(headless(file('long.jsonl', meta(big))), true)
  assert.equal(headless(file('long-sub.jsonl', meta({ ...big, source: { subagent: 'x' } }))), null)
  assert.deepEqual(sessionSource(file('long2.jsonl', meta({ ...big, source: 'vscode', originator: 'codex-tui' }))), { source: 'vscode', originator: 'codex-tui' })
  assert.equal(headless(file('other.jsonl', '{"timestamp":"t","type":"turn_context","payload":{"source":"exec"}}\n')), null)
  assert.equal(headless(file('garbage.jsonl', 'not json\n')), null)
  assert.equal(headless(file('empty.jsonl', '')), null)
  for (const p of [null, undefined, 3, '', 'relative.jsonl', path.join(dir, 'missing.jsonl'), dir]) assert.equal(headless(p), null)

  // With no rollout (codex exec --ephemeral: transcript_path is null) bypassPermissions alone
  // leaves it unknown.
  const p = { session_id: 's-1', hook_event_name: 'PreToolUse', permission_mode: 'bypassPermissions', tool_name: 'Bash', tool_input: { command: 'ls' }, transcript_path: null }
  assert.equal(H.sessionEvent(codex, 'PreToolUse', p, { env: {} }).autonomy, 'unknown')
  assert.equal(H.sessionEvent(codex, 'PreToolUse', p, { env: {}, config: { trigger: { codex: ['bypassPermissions'] } } }).autonomy, 'autonomous')
  for (const bad of [null, [], 'x', {}, { session_id: '../x' }]) assert.equal(codex.normalize('Stop', bad, {}), null)
  assert.equal(codex.normalize('Stop', { session_id: 's-1' }, {}).kind, 'idle', 'the event from the command line when the payload has none')
  assert.equal(codex.normalize('PreCompact', { session_id: 's-1', hook_event_name: 'PreCompact', trigger: 'auto' }, {}).kind, 'notice')
  assert.equal(codex.normalize('PermissionRequest', { session_id: 's-1', hook_event_name: 'PermissionRequest', tool_name: 'mcp__fs__write', tool_input: { path: 'x' } }, {}).request.message, 'mcp__fs__write')
  assert.equal(codex.normalize('PermissionRequest', { session_id: 's-1', hook_event_name: 'PermissionRequest', tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Delete File: old.js\n*** End Patch' } }, {}).request.message, 'apply_patch: old.js')
})

// --- install, rerun, uninstall ------------------------------------------------------------------

// A user's ~/.codex/hooks.json with hooks of their own on some of the same events (as the
// documentation shows them: two spaces, a description, a final newline).
const USER_HOOKS = {
  description: 'My hooks.',
  hooks: {
    SessionStart: [{ matcher: 'startup|resume', hooks: [{ type: 'command', command: 'python3 ~/.codex/hooks/session_start.py', statusMessage: 'Loading session notes' }] }],
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/usr/bin/python3 "$(git rev-parse --show-toplevel)/.codex/hooks/pre_tool_use_policy.py"', statusMessage: 'Checking Bash command' }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'python3 ~/.codex/hooks/stop_continue.py', timeout: 30 }] }],
    PostCompact: [{ matcher: 'manual|auto', hooks: [{ type: 'mcp_tool', server: 'notes', tool: 'save' }] }]
  }
}
const userText = JSON.stringify(USER_HOOKS, null, 2) + '\n'
const USER_TOML = '# my codex config\nmodel = "gpt-5.1-codex"\n\n[features]\nweb_search = true\n'
const ours = (h) => /autochat\.js' hook --harness codex /.test(h.command)
const withoutOurs = (cfg) => {
  const c = structuredClone(cfg)
  for (const [e, list] of Object.entries(c.hooks || {})) {
    c.hooks[e] = list.map(g => ({ ...g, hooks: g.hooks.filter(h => !ours(h)) })).filter(g => g.hooks.length)
    if (!c.hooks[e].length) delete c.hooks[e]
  }
  if (c.hooks && !Object.keys(c.hooks).length) delete c.hooks
  return c
}
function user (name, hooks = userText, toml = USER_TOML) {
  const home = path.join(tmp, name)
  const codexHome = path.join(home, '.codex')
  fs.mkdirSync(codexHome, { recursive: true })
  if (hooks !== null) fs.writeFileSync(path.join(codexHome, 'hooks.json'), hooks)
  if (toml !== null) fs.writeFileSync(path.join(codexHome, 'config.toml'), toml)
  const node = path.join(home, 'node')
  const bin = path.join(home, 'autochat', 'bin', 'autochat.js')
  fs.mkdirSync(path.dirname(bin), { recursive: true })
  fs.writeFileSync(node, '')
  fs.writeFileSync(bin, '')
  const ctx = H.harnessContext({ env: { HOME: home, PATH: '' }, node, bin })
  const file = path.join(codexHome, 'hooks.json')
  return { home, codexHome, file, ctx, node, bin, read: () => fs.readFileSync(file, 'utf8'), toml: () => fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8') }
}

test('install merges into hooks.json next to the user\'s hooks; rerun is a no-op; uninstall is byte-for-byte', () => {
  const u = user('merge')
  assert.equal(hooksFile(u.ctx), u.file)
  const plan = codex.planHooks(u.ctx)
  assert.deepEqual([plan.action, plan.file, plan.entries.length], ['add', u.file, 8])
  assert.match(plan.entries.find(e => e.startsWith('Interrupt')), /^Interrupt: '.*node' '.*autochat\.js' hook --harness codex Interrupt \|\| true$/)
  plan.apply()

  const cfg = JSON.parse(u.read())
  assert.equal(JSON.stringify(withoutOurs(cfg)), JSON.stringify(USER_HOOKS), 'every other hook and the description unchanged, in order')
  assert.deepEqual(Object.keys(cfg), ['description', 'hooks'], 'nothing else at the top: Codex rejects unknown keys')
  assert.deepEqual(Object.keys(cfg.hooks), ['SessionStart', 'PreToolUse', 'Stop', 'PostCompact', 'UserPromptSubmit', 'PermissionRequest', 'PostToolUse', 'Interrupt', 'SessionEnd'])
  assert.deepEqual(cfg.hooks.PreToolUse[0], USER_HOOKS.hooks.PreToolUse[0], 'theirs first, ours appended')
  assert.deepEqual(cfg.hooks.PreToolUse[1], { hooks: [{ type: 'command', command: `'${u.node}' '${u.bin}' hook --harness codex PreToolUse || true`, timeout: 10 }] }, 'no matcher: every tool')
  assert.equal(cfg.hooks.SessionEnd[0].hooks[0].timeout, 3, 'SessionEnd and Interrupt: 3 s, their maximum')
  assert.equal(cfg.hooks.Interrupt[0].hooks[0].timeout, 3)
  assert.ok(Object.values(cfg.hooks).flat().flatMap(g => g.hooks).filter(ours).every(h => Object.keys(h).join() === 'type,command,timeout'), 'synchronous, no status message')
  assert.equal(fs.readFileSync(u.file + '.autochat.bak', 'utf8'), userText, 'one-time backup')
  assert.equal(u.toml(), USER_TOML, 'config.toml untouched')
  assert.deepEqual(codex.hookStatus(u.ctx), { installed: true, partial: false, valid: true, disabled: false, file: u.file, trusted: false, note: "Codex skips autochat's hooks until you trust them (new, or changed since you did): open /hooks in Codex and trust them" })

  const mtime = fs.statSync(u.file).mtimeMs
  assert.equal(codex.planHooks(u.ctx).action, 'none')
  assert.equal(H.setupHooks({ ids: ['codex'], ctx: u.ctx, out: () => {} }).applied.length, 0)
  assert.equal(fs.statSync(u.file).mtimeMs, mtime, 'rerunning writes nothing, so Codex keeps trusting them')

  const un = codex.unplanHooks(u.ctx)
  assert.equal(un.action, 'remove')
  un.apply()
  assert.equal(u.read(), userText, 'uninstall leaves the file exactly as it was')
  assert.equal(codex.unplanHooks(u.ctx).action, 'none')
  assert.equal(fs.readFileSync(u.file + '.autochat.bak', 'utf8'), userText, 'the backup is never overwritten')
})

test('a moved install updates in place; ours inside a user group; a file of our own; not JSON; CODEX_HOME; hooks turned off', () => {
  const u = user('moved')
  codex.planHooks(u.ctx).apply()
  const moved = H.harnessContext({ env: { HOME: u.home, PATH: '' }, node: u.node, bin: path.join(u.home, 'new', 'bin', 'autochat.js') })
  const before = JSON.parse(u.read())
  const up = codex.planHooks(moved)
  assert.equal(up.action, 'update')
  up.apply()
  const after = JSON.parse(u.read())
  for (const e of Object.keys(after.hooks)) {
    const mine = after.hooks[e].flatMap(g => g.hooks).filter(ours)
    if (!before.hooks[e].flatMap(g => g.hooks).some(ours)) continue
    assert.equal(mine.length, 1, `${e}: one copy`)
    assert.match(mine[0].command, /new\/bin\/autochat\.js' hook --harness codex/)
    assert.equal(after.hooks[e].findIndex(g => g.hooks.some(ours)), before.hooks[e].findIndex(g => g.hooks.some(ours)), `${e}: same position (Codex keys trust by it)`)
  }
  assert.equal(codex.hookStatus(moved).valid, false, "the new path doesn't exist on disk")

  // The user moved our Stop handler into their own group: updated there; uninstall leaves theirs.
  const cfg = JSON.parse(u.read())
  cfg.hooks.Stop[0].hooks.push(cfg.hooks.Stop.pop().hooks[0])
  delete cfg.hooks.SessionEnd
  fs.writeFileSync(u.file, JSON.stringify(cfg, null, 2) + '\n')
  assert.equal(codex.hookStatus(u.ctx).partial, true)
  codex.planHooks(u.ctx).apply()
  const fixed = JSON.parse(u.read())
  assert.equal(fixed.hooks.Stop.length, 1)
  assert.deepEqual(fixed.hooks.Stop[0].hooks.map(h => ours(h) ? 'ours' : h.command), ['python3 ~/.codex/hooks/stop_continue.py', 'ours'])
  codex.unplanHooks(u.ctx).apply()
  assert.deepEqual(JSON.parse(u.read()).hooks.Stop, USER_HOOKS.hooks.Stop)

  // No hooks.json yet: one of our own, gone again on uninstall.
  const fresh = user('fresh', null)
  codex.planHooks(fresh.ctx).apply()
  assert.deepEqual(Object.keys(JSON.parse(fresh.read())), ['hooks'])
  assert.ok(fresh.read().startsWith('{\n  "hooks": {\n'), 'two spaces')
  codex.unplanHooks(fresh.ctx).apply()
  assert.equal(fs.existsSync(fresh.file), false)
  assert.deepEqual(fs.readdirSync(fresh.codexHome).sort(), ['config.toml'])

  // Not plain JSON, or `hooks` isn't an object: shown, never rewritten.
  for (const [name, text, reason] of [['jsonc', '{\n  // mine\n  "hooks": {}\n}\n', /isn't plain JSON, so autochat won't rewrite it/], ['list', '{"hooks": []}\n', /"hooks" in ~\/\.codex\/hooks\.json isn't an object/], ['event', '{"hooks": {"Stop": {}}}\n', /"hooks\.Stop" .* isn't a list/]]) {
    const v = user(name, text)
    const manual = codex.planHooks(v.ctx)
    assert.equal(manual.action, 'manual', name)
    assert.equal(manual.apply, undefined)
    assert.match(H.describeHookPlan(manual, v.ctx).join('\n'), reason)
    assert.equal(codex.unplanHooks(v.ctx).action, 'none')
    assert.equal(v.read(), text)
  }
  assert.match(H.describeHookPlan(codex.planHooks(user('jsonc2', '{,}').ctx), u.ctx).join('\n'), /Add this yourself:\n\s+\{\n\s+"hooks": \{\n\s+"SessionStart": \[/)

  // CODEX_HOME moves it; `hooks = false` under [features] turns every hook off.
  const dir = path.join(tmp, 'codex-dir')
  const ctx = H.harnessContext({ env: { HOME: u.home, CODEX_HOME: dir, PATH: '' }, node: u.node, bin: u.bin })
  assert.equal(codex.planHooks(ctx).file, path.join(dir, 'hooks.json'))
  codex.planHooks(ctx).apply()
  assert.equal(codex.hookStatus(ctx).disabled, false)
  fs.writeFileSync(path.join(dir, 'config.toml'), 'model = "x"\n\n[features]\nweb_search = true\nhooks = false # for now\n\n[mcp_servers.x]\ncommand = "y"\n')
  assert.deepEqual([codex.hookStatus(ctx).disabled, codex.hookStatus(ctx).disabledBy], [true, `hooks = false under [features] in ${path.join(dir, 'config.toml')}`])
  fs.writeFileSync(path.join(dir, 'config.toml'), '[features]\ncodex_hooks = false\n')
  assert.equal(codex.hookStatus(ctx).disabled, true, 'its old name')
  fs.writeFileSync(path.join(dir, 'config.toml'), '[profiles.x.features]\nhooks = false\n[features]\nhooks = true\n')
  assert.equal(codex.hookStatus(ctx).disabled, false, 'only in a profile')
})

test('uninstall puts back the exact bytes autochat found, whatever their layout; edits made since are kept', () => {
  const layouts = {
    'one-line': '{"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "notify.sh", "timeout": 30.0}]}]}}',
    'crlf-inline': '{\r\n    "description": "caf\\u00e9",\r\n    "hooks": {\r\n        "PreToolUse": [ { "matcher": "Bash", "hooks": [ { "type": "command", "command": "check.sh" } ] } ],\r\n        "Stop": []\r\n    }\r\n}\r\n',
    'empty-hooks': '{"hooks":{}}\n',
    'empty-file': ''
  }
  for (const [name, text] of Object.entries(layouts)) {
    const u = user('layout-' + name, text)
    codex.planHooks(u.ctx).apply()
    assert.equal(codex.hookStatus(u.ctx).installed, true, name)
    codex.unplanHooks(u.ctx).apply()
    assert.equal(u.read(), text, `${name}: byte-for-byte`)
  }

  // Their own hooks changed meanwhile: theirs are kept as they are now, ours go.
  const u = user('layout-edited', layouts['one-line'])
  codex.planHooks(u.ctx).apply()
  const cfg = JSON.parse(u.read())
  cfg.hooks.Stop[0].hooks[0].command = 'notify.sh --loud'
  fs.writeFileSync(u.file, JSON.stringify(cfg, null, 2) + '\n')
  codex.unplanHooks(u.ctx).apply()
  assert.deepEqual(JSON.parse(u.read()), { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'notify.sh --loud', timeout: 30 }] }] } })
})

// What Codex 0.166.0 recorded in config.toml when these hooks were trusted in /hooks: the
// trusted_hash of each (event, group, handler). Not tied to the file's path, only to the hook.
const PINNED = {
  hooks: {
    PreToolUse: [
      { matcher: 'Bash', hooks: [{ type: 'command', command: '/usr/bin/python3 check.py', statusMessage: 'Checking Bash command' }] },
      { hooks: [{ type: 'command', command: "'/usr/local/bin/node' '/Users/me/autochat/bin/autochat.js' hook --harness codex PreToolUse || true", timeout: 10 }] }
    ],
    SessionStart: [{ matcher: 'startup|resume', hooks: [{ type: 'command', command: 'python3 ~/.codex/hooks/session_start.py', statusMessage: 'Loading session notes' }] }],
    UserPromptSubmit: [{ matcher: 'ignored', hooks: [{ type: 'command', command: 'true', timeout: 5 }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'python3 ~/.codex/hooks/stop_continue.py', timeout: 30 }, { type: 'command', command: "'/usr/local/bin/node' '/Users/me/autochat/bin/autochat.js' hook --harness codex Stop || true", timeout: 10 }] }],
    SessionEnd: [
      { hooks: [{ type: 'command', command: "'/usr/local/bin/node' '/Users/me/autochat/bin/autochat.js' hook --harness codex SessionEnd || true", timeout: 3 }] },
      { hooks: [{ type: 'command', command: 'notify.sh' }] }
    ],
    Interrupt: [{ hooks: [{ type: 'command', command: 'notify.sh', timeout: 10, async: true }] }]
  },
  trusted: {
    'pre_tool_use:0:0': 'sha256:d96f6550581c470eb9f5c513c5a176cbd9ce33b1b2111ce1c6942b87ae991203',
    'pre_tool_use:1:0': 'sha256:260659ce5a55e6e1adc9e4492eeaa9632562f91276dc27ff47ed304f1fb0d401',
    'session_start:0:0': 'sha256:7de812a5f023480e524fe84fd7bbb230848d22692aaffd225a9bc1c128c95908',
    'user_prompt_submit:0:0': 'sha256:e730d6c05679736eaccc5349f8aa92ec34ebd81c0a29da55459ab65ebced4952',
    'stop:0:0': 'sha256:1df791caeb6022d4b0530e181f340c61c717718e27eb9a0e04484956e9e8003d',
    'stop:0:1': 'sha256:cda6f4f4d5e31c81ddfd708fda1b57e0cf7a6169c9e3bdb2871a096e80317c75',
    'session_end:0:0': 'sha256:0816c389ce9c25676e305b50723249cc849d84d6455ae8b5a8d1c58c0845a16c',
    'session_end:1:0': 'sha256:d421704a69966612491301331592b21f7f885495c50450d27d382f3cb09fee5f',
    'interrupt:0:0': 'sha256:a921db09c53a6feb77da2d4fbd32bb37197da8ee0b777f6600853b8c1d826661'
  }
}
const snakeCase = (e) => e.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase()

test('trust: the hash Codex records for a hook; doctor says which of ours Codex would skip', () => {
  const got = {}
  for (const [event, groups] of Object.entries(PINNED.hooks)) groups.forEach((g, gi) => g.hooks.forEach((h, hi) => { got[`${snakeCase(event)}:${gi}:${hi}`] = trustHash(event, g, h) }))
  assert.deepEqual(got, PINNED.trusted, 'matcher (where the event has one), statusMessage, timeout and async as Codex fills them in')

  // Codex writes one [hooks.state."<hooks.json>:<event>:<group>:<handler>"] table per hook it trusts.
  const u = user('trust', null, '# mine\nmodel = "gpt-5.5"\n')
  codex.planHooks(u.ctx).apply()
  const cfg = JSON.parse(u.read())
  const records = (edit = (k, v) => v) => Object.entries(cfg.hooks).map(([e, groups]) => {
    const key = `${u.file}:${snakeCase(e)}:0:0`
    return `[hooks.state."${key}"]\ntrusted_hash = "${edit(e, trustHash(e, groups[0], groups[0].hooks[0]))}"\n`
  }).join('\n')
  const trustAll = (edit) => fs.writeFileSync(path.join(u.codexHome, 'config.toml'), '# mine\nmodel = "gpt-5.5"\n\n[hooks.state]\n\n' + records(edit))
  assert.equal(codex.hookStatus(u.ctx).trusted, false)
  trustAll()
  const ok = codex.hookStatus(u.ctx)
  assert.equal(ok.trusted, true)
  assert.equal(ok.note, undefined, 'nothing to say')

  // One changed since (say, a moved install), and one turned off in /hooks.
  trustAll((e, h) => e === 'Stop' ? 'sha256:00' : h)
  assert.deepEqual([codex.hookStatus(u.ctx).trusted, codex.hookStatus(u.ctx).note], [false, "Codex skips 1 of autochat's hooks until you trust them (new, or changed since you did): open /hooks in Codex and trust them"])
  trustAll()
  fs.appendFileSync(path.join(u.codexHome, 'config.toml'), `\n[hooks.state."${u.file}:interrupt:0:0"]\nenabled = false\n`)
  assert.deepEqual([codex.hookStatus(u.ctx).trusted, codex.hookStatus(u.ctx).note], [false, "1 of autochat's hooks is turned off in /hooks in Codex"])

  // Same hook, somewhere else in the file: Codex keys trust by position, so it's new there.
  trustAll()
  cfg.hooks.Stop.unshift({ hooks: [{ type: 'command', command: 'notify.sh', timeout: 30 }] })
  fs.writeFileSync(u.file, JSON.stringify(cfg, null, 2) + '\n')
  assert.match(codex.hookStatus(u.ctx).note, /^Codex skips 1 of autochat's hooks until you trust them/)

  // The way a user might write it: inline under [hooks.state].
  cfg.hooks.Stop.shift()
  fs.writeFileSync(u.file, JSON.stringify(cfg, null, 2) + '\n')
  const inline = Object.entries(cfg.hooks).map(([e, groups]) => `"${u.file}:${snakeCase(e)}:0:0" = { trusted_hash = "${trustHash(e, groups[0], groups[0].hooks[0])}" }`).join('\n')
  fs.writeFileSync(path.join(u.codexHome, 'config.toml'), `[hooks.state]\n${inline}\n\n[[hooks.Stop]]\nhooks = [{ type = "command", command = "x", enabled = false }]\n`)
  assert.equal(codex.hookStatus(u.ctx).trusted, true)
})

test('hooks (hooks.json) and the agent room (config.toml) are separate, and uninstall removes both', () => {
  const u = user('both')
  codex.planHooks(u.ctx).apply()
  assert.deepEqual(H.setupAgents({ ctx: u.ctx, out: () => {} }).applied, ['codex'])
  assert.match(u.toml(), /^# my codex config\nmodel = "gpt-5\.1-codex"\n\n\[features\]\nweb_search = true\n\n\[mcp_servers\.autochat\]\n/)
  assert.equal(codex.hookStatus(u.ctx).installed, true)
  assert.deepEqual(H.removeHooks({ ctx: u.ctx, out: () => {} }), ['codex'])
  assert.equal(u.read(), userText)
  assert.equal(H.agentsStatus(u.ctx).find(h => h.id === 'codex').registered, true, 'the room stays')
  assert.deepEqual(H.removeAgents({ ctx: u.ctx, out: () => {} }), ['codex'])
  assert.equal(u.toml(), USER_TOML)
})

// The parent env minus anything that points at a real home or harness.
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(AUTOCHAT|LOLCHAT|CODEX|CLAUDE)_|^(HOME|COPILOT_HOME|XDG_CONFIG_HOME|CODEX_HOME|CLAUDE_CONFIG_DIR|PI_CODING_AGENT_DIR|TMUX|TMUX_PANE|TERM_PROGRAM|__CFBundleIdentifier)$/.test(k)))

test('CLI: setup offers Codex, setup --harness codex installs it and says to trust them, the hook delivers SessionEvents, uninstall', async () => {
  const u = user('cli')
  const bins = path.join(tmp, 'cli-bin')
  fs.mkdirSync(bins, { recursive: true })
  fs.writeFileSync(path.join(bins, 'codex'), '#!/bin/sh\nexit 1\n')
  fs.chmodSync(path.join(bins, 'codex'), 0o755)
  const env = { ...baseEnv, HOME: u.home, AUTOCHAT_HOME: path.join(tmp, 'cli-ac'), COPILOT_HOME: path.join(u.home, '.copilot'), AUTOCHAT_HARNESS_PATH: bins, AUTOCHAT_APP_DIRS: path.join(tmp, 'no-apps'), AUTOCHAT_LAUNCH_RECORD: path.join(tmp, 'cli-launches.jsonl') }
  const cli = (...args) => spawnSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8' })

  const plain = cli('setup')
  assert.equal(plain.status, 0, plain.stderr)
  assert.match(plain.stdout, /Also found Codex\. To go to the lounge from it too: autochat setup --harness codex/)
  assert.equal(u.read(), userText, 'plain setup without a terminal never touches it')

  const dry = cli('setup', '--harness', 'codex', '--dry-run')
  assert.match(dry.stdout, /codex {4}add hooks to ~\/\.codex\/hooks\.json\n {11}\+ SessionStart: '/)
  assert.equal(u.read(), userText)
  const real = cli('setup', '--harness', 'codex')
  assert.equal(real.status, 0, real.stderr)
  assert.match(real.stdout, /✔ codex hooks installed\nCodex skips new or changed hooks until you trust them \(codex exec without a word\): open \/hooks in Codex and trust autochat's\./)
  assert.match(cli('setup', '--harness', 'codex').stdout, /codex {4}hooks already installed \(~\/\.codex\/hooks\.json\)\nNothing to change\./)

  // Recorded payloads through `autochat hook --harness codex`, to a running core.
  const { serve } = await import('../src/ipc.js')
  process.env.AUTOCHAT_HOME = env.AUTOCHAT_HOME
  const got = []
  const server = await serve((m) => { got.push(m); return {} })
  try {
    for (const e of fixture('exec').slice(1, 5)) {
      await new Promise((resolve) => {
        const c = spawn(process.execPath, [BIN, 'hook', '--harness', 'codex', e.event], { env: { ...env, ...e.env, TMUX: '/t,1,0', TMUX_PANE: '%7' } })
        c.stdin.end(JSON.stringify(e.payload))
        c.on('exit', resolve)
      })
    }
  } finally {
    server.close()
    process.env.AUTOCHAT_HOME = path.join(tmp, 'ac')
  }
  const hooks = got.filter(m => m.type === 'hook')
  assert.deepEqual(hooks.map(m => [m.type, m.harness, m.event, m.kind, m.mode, m.headless, m.autonomy]), [
    ['hook', 'codex', 'UserPromptSubmit', 'activity', 'bypassPermissions', true, 'autonomous'],
    ['hook', 'codex', 'PreToolUse', 'activity', 'bypassPermissions', true, 'autonomous'],
    ['hook', 'codex', 'PostToolUse', 'activity', 'bypassPermissions', true, 'autonomous'],
    ['hook', 'codex', 'PreToolUse', 'activity', 'bypassPermissions', true, 'autonomous']
  ])
  assert.equal(hooks[0].sessionId, '01a19818-19fe-7e70-bbd3-a8c36a86ae8c')
  assert.deepEqual(hooks[0].origin, { tmux: '/t,1,0', tmuxPane: '%7' })
  assert.deepEqual(hooks[3].files, ['notes/hello.txt'])
  // PostToolUse also rings the agent room's doorbell; this core has nothing to say, so nothing prints.
  assert.deepEqual(got.filter(m => m.type === 'doorbell'), [{ type: 'doorbell', harness: 'codex', sessionId: '01a19818-19fe-7e70-bbd3-a8c36a86ae8c', pid: process.pid }])

  const un = cli('uninstall')
  assert.equal(un.status, 0, un.stderr)
  assert.match(un.stdout, /^hooks removed\.\nremoved autochat's hooks from Codex \(~\/\.codex\/hooks\.json\)\n$/)
  assert.equal(u.read(), userText)
})

test('Controller: a codex exec run puts you in the lounge until it ends; the TUI asks you, and never does', { timeout: 60000 }, async (t) => {
  const testnet = await createTestnet(3)
  t.after(() => testnet.destroy())
  const c = new Controller({
    identity: ephemeralIdentity(),
    config: { room: 'lc1-codex-' + Math.random().toString(36).slice(2, 12), idleMs: 300, announce: false, countdownSeconds: 30 },
    bootstrap: testnet.bootstrap,
    roomOpts: { graceMs: 1200, heartbeatMs: 300, expireMs: 3000, refreshMs: [300, 800, 1500, 2500], refreshEveryMs: 2000 },
    focus: () => {},
    notify: () => {},
    watchLogs: false
  })
  t.after(() => c.shutdown())
  const send = (e, config) => c.handle(hookMessage(H.sessionEvent(codex, e.event, e.payload, { env: { CODEX_HOME, ...e.env }, config }), e.event))
  const state = (events) => c.sessions.get(`codex:${events[0].payload.session_id}`)?.state ?? null

  const run = fixture('exec')
  assert.equal(send(run[0]).tracked, false, 'SessionStart alone tracks nothing')
  send(run[1])
  assert.equal(c.phase, 'room')
  const sid = run[0].payload.session_id
  assert.deepEqual(c.snapshot().sessions, [{ sid, state: 'running', cwd: '/Users/me/code/demo', harness: 'codex' }])
  for (const e of run.slice(2, 9)) send(e)
  send(run[9])
  assert.equal(c.sessions.size, 0)
  assert.equal(c.countdown?.reason, 'end')
  assert.match(c.countdown?.summary, /^Done with work: /)

  // A subagent's calls neither end the run nor start one.
  const sub = fixture('exec-subagent')
  for (const e of sub.slice(0, 4)) send(e)
  assert.equal(state(sub), 'running')
  for (const e of sub.slice(4, 9)) send(e)
  assert.equal(state(sub), 'running', 'unknown keeps it as it is')
  send(sub[10])
  assert.equal(state(sub), null)

  // codex exec --approve-for-me: its automatic reviewer answers, so no request card.
  const auto = fixture('exec-approve-for-me')
  for (const e of auto.slice(0, 4)) send(e)
  assert.equal(state(auto), 'running')
  assert.equal(c.currentRequest(), null)
  send(auto[5])

  // Ctrl+C on codex exec: it ends then and there, it isn't waiting for you.
  const stopped = fixture('exec-interrupt')
  for (const e of stopped.slice(0, 4)) send(e)
  assert.equal(state(stopped), null)
  assert.equal(c.countdown?.reason, 'end')

  // The TUI with `autochat config trigger codex default`: an approval is a request card, and so
  // is a question in Plan mode, but not one Codex refuses (Default mode); an interrupt means
  // you're back.
  const tui = fixture('tui')
  const counts = { trigger: { codex: ['default'] } }
  for (const e of tui.slice(5, 8)) send(e, counts)
  assert.deepEqual([c.currentRequest().title, c.currentRequest().message], ['Permission needed', 'Bash: echo needs approval (Just checking approvals)'])
  send(tui[8], counts)
  assert.equal(c.currentRequest().resolved, true, 'approved: the tool ran')
  for (const e of tui.slice(10, 12)) send(e, counts)
  assert.equal(state(tui), 'running', 'Default mode: Codex refuses the question')
  for (const e of tui.slice(13, 15)) send(e, counts)
  assert.equal(state(tui), 'needed')
  assert.deepEqual([c.currentRequest().title, c.currentRequest().message], ['Codex has a question for you', 'Which color should the button be? [Red (Recommended) / Blue]'])
  send(tui[15], counts)
  assert.equal(state(tui), 'running', 'answered')
  for (const e of tui.slice(19, 22)) send(e, counts)
  assert.equal(state(tui), null, 'Interrupt: you stopped it, it waits for you')
  for (const e of tui) send(e)
  assert.equal(c.sessions.size, 0, 'by default the TUI never counts')
})
