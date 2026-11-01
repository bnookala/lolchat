import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import net from 'node:net'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

// The doorbell's harness side (#52), against a fake daemon socket: what the hooks, the opencode
// plugin and the pi extension ask, and what they put in front of the model.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BIN = path.join(ROOT, 'bin', 'autochat.js')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autochat-db-'))
const home = path.join(tmp, 'd')
process.env.AUTOCHAT_HOME = home
process.env.COPILOT_HOME = path.join(tmp, 'copilot')
const env = {
  ...process.env,
  AUTOCHAT_HOME: home,
  COPILOT_HOME: path.join(tmp, 'copilot'),
  AUTOCHAT_LAUNCH_RECORD: path.join(tmp, 'launches.jsonl'),
  AUTOCHAT_APP_DIRS: path.join(tmp, 'no-apps'),
  AUTOCHAT_DEBUG: '',
  TMUX: '',
  TMUX_PANE: '',
  CLAUDE_PID: '',
  COPILOT_AGENT_SESSION_ID: ''
}
const { ring, doorbellMessage, doorbellText, RING_TIMEOUT_MS, MAX_DOORBELL } = await import('../src/doorbell.js')
const { pluginSource } = await import('../src/harness/opencode.js')
const X = await import('../src/harness/pi-extension.js')

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))
const LINE = '2 unread from copilot-greeter (overlap on src/greeting.js), use autochat read'

/**
 * A fake autochat daemon on $AUTOCHAT_HOME/run/ui.sock. One-shot messages get `answer(msg)`: an
 * object (sent as JSON), a string (sent as is), 'hang' (no answer) or 'close' (hang up). An
 * agent-hello gets a welcome, and the connection stays open, as the daemon's agent room does.
 */
async function fakeDaemon (answer = () => ({ ok: true, text: null })) {
  fs.mkdirSync(path.join(home, 'run'), { recursive: true })
  const sock = path.join(home, 'run', 'ui.sock')
  fs.rmSync(sock, { force: true })
  const got = []
  const conns = new Set()
  const d = { got, answer, doorbells: () => got.filter(m => m?.type === 'doorbell') }
  const server = net.createServer((s) => {
    conns.add(s)
    s.on('close', () => conns.delete(s))
    s.on('error', () => {})
    let buf = ''
    s.setEncoding('utf8')
    s.on('data', (chunk) => {
      buf += chunk
      let i
      while ((i = buf.indexOf('\n')) !== -1) {
        let msg = null
        try { msg = JSON.parse(buf.slice(0, i)) } catch {}
        buf = buf.slice(i + 1)
        got.push(msg)
        if (msg?.type === 'agent-hello') { s.write(JSON.stringify({ type: 'agent-welcome', v: 1, resume: 'tok', agent: { name: 'pi-x', display: 'pi-x' } }) + '\n'); continue }
        if (msg?.type === 'cmd') { s.write(JSON.stringify({ type: 'reply', id: msg.id, ok: true, result: {} }) + '\n'); continue }
        const r = msg?.type === 'hook' ? { ok: true, tracked: false } : d.answer(msg)
        if (r === 'hang') return
        if (r === 'close') { s.end(); return }
        s.end((typeof r === 'string' ? r : JSON.stringify(r)) + '\n')
      }
    })
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(sock, resolve) })
  d.close = () => new Promise((resolve) => {
    for (const s of conns) s.destroy()
    server.close(() => resolve())
  })
  return d
}

// `autochat hook …` as the harness runs it: stdout, the result (AUTOCHAT_DEBUG), and how long.
function hook (args, payload, extraEnv = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const c = spawn(process.execPath, [BIN, 'hook', ...args], { env: { ...env, AUTOCHAT_DEBUG: '1', ...extraEnv } })
    let stdout = ''
    let stderr = ''
    c.stdout.on('data', (d) => { stdout += d })
    c.stderr.on('data', (d) => { stderr += d })
    c.stdin.end(typeof payload === 'string' ? payload : JSON.stringify(payload))
    c.on('close', (code) => {
      let result = null
      try { result = JSON.parse(stderr.trim().split('\n').pop()) } catch {}
      resolve({ code, stdout, result, ms: Date.now() - t0 })
    })
  })
}

const setLaunch = (launch) => fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ launch }))

test('the message: harness, session id and pid, nothing odd', () => {
  assert.deepEqual(doorbellMessage({ harness: 'claude', sessionId: 's-1', pid: 4242 }), { type: 'doorbell', harness: 'claude', sessionId: 's-1', pid: 4242 })
  assert.deepEqual(doorbellMessage({ harness: 'pi', sessionId: '', pid: -1 }), { type: 'doorbell', harness: 'pi', sessionId: null, pid: null })
  assert.deepEqual(doorbellMessage({ harness: 7, sessionId: {}, pid: 1.5 }), { type: 'doorbell', harness: null, sessionId: null, pid: null })
})

test('the reply: only ok:true with a non-empty text rings; the text is one clean, short line', () => {
  assert.equal(doorbellText({ ok: true, text: LINE }), LINE)
  for (const r of [null, undefined, 'x', [], {}, { ok: true }, { ok: true, text: null }, { ok: true, text: '' }, { ok: true, text: ' \n\t ' }, { ok: true, text: 5 }, { ok: false, text: LINE }, { ok: false, error: 'unknown message type' }, { ok: 'true', text: LINE }]) {
    assert.equal(doorbellText(r), null, JSON.stringify(r))
  }
  assert.equal(doorbellText({ ok: true, text: '\x1b[31m3 unread\x1b[0m from\nx,\tuse \u202eautochat read' }), '3 unread from x, use autochat read')
  const long = doorbellText({ ok: true, text: 'y'.repeat(5000) })
  assert.equal(Array.from(long).length, MAX_DOORBELL)
})

test('ring: asks once and returns the line; stays silent on refusals, garbage, hang-ups, slow or missing daemons', async (t) => {
  const d = await fakeDaemon(() => ({ ok: true, text: LINE }))
  t.after(() => d.close())
  assert.equal(await ring({ harness: 'claude', sessionId: 's-1', pid: 4242 }), LINE)
  assert.deepEqual(d.got, [{ type: 'doorbell', harness: 'claude', sessionId: 's-1', pid: 4242 }])

  const quiet = [{ ok: true, text: null }, { ok: false }, { ok: false, error: 'unknown message type' }, { ok: true, text: '  ' }, 'not json', 'close']
  for (const answer of quiet) {
    d.answer = () => answer
    assert.equal(await ring({ harness: 'copilot', sessionId: 's-2' }), null, JSON.stringify(answer))
  }

  d.answer = () => 'hang'
  let t0 = Date.now()
  assert.equal(await ring({ harness: 'copilot', sessionId: 's-3' }), null)
  const waited = Date.now() - t0
  assert.ok(waited >= RING_TIMEOUT_MS - 20 && waited < RING_TIMEOUT_MS + 1000, `gave up after ${waited} ms`)

  await d.close()
  t0 = Date.now()
  assert.equal(await ring({ harness: 'copilot', sessionId: 's-4' }), null, 'no daemon')
  assert.ok(Date.now() - t0 < RING_TIMEOUT_MS, 'no daemon answers at once')
})

test('hooks print the line in their harness\'s format, on their doorbell event only', async (t) => {
  fs.rmSync(path.join(home, 'config.json'), { force: true })
  const d = await fakeDaemon(() => ({ ok: true, text: LINE }))
  t.after(() => d.close())

  // Copilot CLI: preToolUse (it runs for every tool), as {"additionalContext": …}.
  let r = await hook(['preToolUse'], { sessionId: 'cp-1', cwd: tmp, toolName: 'bash', toolArgs: { command: 'ls' } })
  assert.equal(r.code, 0)
  assert.equal(r.stdout, JSON.stringify({ additionalContext: LINE }) + '\n')
  assert.equal(r.result.action, 'delivered', 'the lounge still gets its hook message')
  assert.deepEqual(d.doorbells(), [{ type: 'doorbell', harness: 'copilot', sessionId: 'cp-1', pid: process.pid }], 'pid: the process that ran the hook')
  // Older Copilot CLIs batch preToolUse.
  r = await hook(['preToolUse'], { sessionId: 'cp-1', toolCalls: [{ name: 'view', args: {} }] })
  assert.equal(JSON.parse(r.stdout).additionalContext, LINE)
  // Not on postToolUse, not while it reads the room, not after task_complete.
  const before = d.doorbells().length
  for (const [event, payload] of [
    ['postToolUse', { sessionId: 'cp-1', toolName: 'bash', toolResult: { resultType: 'success', textResultForLlm: 'x' } }],
    ['preToolUse', { sessionId: 'cp-1', toolName: 'autochat-read', toolArgs: {} }],
    ['preToolUse', { sessionId: 'cp-1', toolCalls: [{ name: 'view' }, { name: 'autochat-wait' }] }],
    ['preToolUse', { sessionId: 'cp-1', toolName: 'task_complete', toolArgs: { summary: 'done' } }],
    ['userPromptSubmitted', { sessionId: 'cp-1', prompt: 'go' }]
  ]) {
    r = await hook([event], payload)
    assert.equal(r.code, 0)
    assert.equal(r.stdout, '', `${event} ${JSON.stringify(payload)}`)
  }
  assert.equal(d.doorbells().length, before)

  // Claude Code: PostToolUse, as hookSpecificOutput.additionalContext; its pid from CLAUDE_PID.
  const claude = { session_id: 'cl-1', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: tmp, permission_mode: 'default' }
  r = await hook(['--harness', 'claude', 'PostToolUse'], claude, { CLAUDE_PID: '4242' })
  assert.deepEqual(JSON.parse(r.stdout), { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: LINE } })
  assert.deepEqual(d.doorbells().at(-1), { type: 'doorbell', harness: 'claude', sessionId: 'cl-1', pid: 4242 })
  r = await hook(['--harness', 'claude', 'PostToolUse'], claude, { CLAUDE_PID: 'nope' })
  assert.equal(d.doorbells().at(-1).pid, process.pid, 'no usable CLAUDE_PID: the parent')
  for (const [event, payload] of [['PostToolUse', { ...claude, tool_name: 'mcp__autochat__read' }], ['PreToolUse', { ...claude, hook_event_name: 'PreToolUse' }], ['Stop', { ...claude, hook_event_name: 'Stop' }]]) {
    r = await hook(['--harness', 'claude', event], payload)
    assert.equal(r.stdout, '', `${event} ${payload.tool_name}`)
  }

  // Codex: PostToolUse, in the same shape.
  const codex = { session_id: 'cx-1', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: tmp, permission_mode: 'default', transcript_path: null }
  r = await hook(['--harness', 'codex', 'PostToolUse'], codex)
  assert.deepEqual(JSON.parse(r.stdout), { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: LINE } })
  assert.deepEqual(d.doorbells().at(-1), { type: 'doorbell', harness: 'codex', sessionId: 'cx-1', pid: process.pid })
  r = await hook(['--harness', 'codex', 'PostToolUse'], { ...codex, tool_name: 'mcp__autochat__wait' })
  assert.equal(r.stdout, '')

  // Harnesses whose hooks can't add context ring nothing; neither does a payload without a session.
  const n = d.doorbells().length
  r = await hook(['--harness', 'gemini', 'AfterTool'], { session_id: 'g-1' })
  assert.equal(r.stdout, '')
  r = await hook(['preToolUse'], { toolName: 'bash' })
  assert.equal(r.stdout, '')
  assert.equal(d.doorbells().length, n)
})

test('hooks stay silent and quick without a clear answer; the doorbell rings while the lounge is paused', async (t) => {
  const payload = { sessionId: 'cp-2', cwd: tmp, toolName: 'bash', toolArgs: {} }
  // No daemon at all.
  fs.rmSync(path.join(home, 'run'), { recursive: true, force: true })
  setLaunch('off')
  let r = await hook(['preToolUse'], payload)
  assert.deepEqual([r.code, r.stdout, r.result.action], [0, '', 'disabled'])

  const d = await fakeDaemon(() => ({ ok: true, text: null }))
  t.after(() => d.close())
  const quiet = [{ ok: true, text: null }, { ok: false }, { ok: false, error: 'unknown message type' }, { ok: true, text: '' }, 'garbage', 'close', 'hang']
  for (const answer of quiet) {
    d.answer = () => answer
    r = await hook(['preToolUse'], payload)
    assert.deepEqual([r.code, r.stdout], [0, ''], JSON.stringify(answer))
    assert.ok(r.ms < 2500, `${JSON.stringify(answer)}: ${r.ms} ms`)
  }
  // launch off pauses the lounge, not the agent room: it rings, and sends no hook message.
  d.answer = () => ({ ok: true, text: LINE })
  const hooks = d.got.filter(m => m?.type === 'hook').length
  r = await hook(['preToolUse'], payload)
  assert.equal(JSON.parse(r.stdout).additionalContext, LINE)
  assert.equal(r.result.action, 'disabled')
  assert.equal(d.got.filter(m => m?.type === 'hook').length, hooks)
  fs.rmSync(path.join(home, 'config.json'), { force: true })
})

// --- opencode -----------------------------------------------------------------------------------

let copies = 0
async function loadPlugin () {
  const file = path.join(tmp, `plugin-${++copies}.mjs`)
  fs.writeFileSync(file, pluginSource({ node: path.join(tmp, 'no-such-node'), bin: path.join(tmp, 'no-such-autochat.js') }))
  return (await import(pathToFileURL(file).href)).AutochatPlugin
}

test('opencode plugin: tool.execute.after adds the line to built-in and MCP tool results, never to the room\'s own or a subagent\'s', async (t) => {
  const d = await fakeDaemon(() => ({ ok: true, text: LINE }))
  t.after(() => d.close())
  const hooks = await (await loadPlugin())({ directory: tmp })

  // Built-in tools return their text in output.output; MCP tools, content blocks.
  const builtin = { title: 'proj', output: '/w/README.md', metadata: { count: 1 } }
  await hooks['tool.execute.after']({ tool: 'glob', sessionID: 'ses_root', callID: 'c1', args: {} }, builtin)
  assert.equal(builtin.output, `/w/README.md\n\n${LINE}`)
  assert.deepEqual(d.doorbells(), [{ type: 'doorbell', harness: 'opencode', sessionId: 'ses_root', pid: process.pid }])
  const mcp = { content: [{ type: 'text', text: 'pong' }] }
  await hooks['tool.execute.after']({ tool: 'stub_ping', sessionID: 'ses_root', callID: 'c2' }, mcp)
  assert.deepEqual(mcp.content, [{ type: 'text', text: 'pong' }, { type: 'text', text: LINE }])

  // Not while it reads the room, not in a subagent's session, not when there's nothing to say.
  const n = d.doorbells().length
  const room = { output: '{"messages":[]}' }
  await hooks['tool.execute.after']({ tool: 'autochat_read', sessionID: 'ses_root' }, room)
  assert.equal(room.output, '{"messages":[]}')
  await hooks.event({ event: { type: 'session.created', properties: { info: { id: 'ses_child', parentID: 'ses_root' } } } })
  const child = { output: 'x' }
  await hooks['tool.execute.after']({ tool: 'read', sessionID: 'ses_child' }, child)
  assert.equal(child.output, 'x')
  assert.equal(d.doorbells().length, n)
  for (const answer of [{ ok: true, text: null }, { ok: false, error: 'unknown message type' }, 'hang', 'close', '{"ok":true,"text":"\\u001b[31m"}']) {
    d.answer = () => answer
    const out = { output: 'x' }
    const t0 = Date.now()
    await hooks['tool.execute.after']({ tool: 'read', sessionID: 'ses_root' }, out)
    assert.equal(out.output, 'x', JSON.stringify(answer))
    assert.ok(Date.now() - t0 < 1500)
  }
  d.answer = () => ({ ok: true, text: '\x1b[31m3 unread\x1b[0m\nfrom x\u202e' })
  const clean = { output: 'x' }
  await hooks['tool.execute.after']({ tool: 'read', sessionID: 'ses_root' }, clean)
  assert.equal(clean.output, 'x\n\n3 unread from x', 'one line, no escape sequences')

  // Odd calls never throw; no daemon leaves results alone.
  await hooks['tool.execute.after']()
  await hooks['tool.execute.after'](null, null)
  await hooks['tool.execute.after']({ tool: 'read', sessionID: 'ses_root' }, { title: 'no output' })
  await d.close()
  const none = { output: 'x' }
  await hooks['tool.execute.after']({ tool: 'read', sessionID: 'ses_root' }, none)
  assert.equal(none.output, 'x')
})

// --- pi -----------------------------------------------------------------------------------------

function fakePi () {
  const handlers = new Map()
  const tools = new Map()
  return {
    tools,
    on: (name, fn) => handlers.set(name, [...(handlers.get(name) || []), fn]),
    registerTool: (def) => tools.set(def.name, def),
    getActiveTools: () => [...tools.keys()],
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

test('pi extension: tool_result gets the line while the agent is in the room, but not for the room\'s own tools', async (t) => {
  const d = await fakeDaemon(() => ({ ok: true, text: LINE }))
  t.after(() => d.close())
  const ctx = { cwd: tmp, hasUI: false, sessionManager: { getSessionId: () => 'pi-sess-db' } }
  const result = (toolName) => ({ toolName, toolCallId: 'c1', input: {}, content: [{ type: 'text', text: '# proj' }], details: undefined, isError: false })

  const p = fakePi()
  const { room } = await X.register(p, { room: true, env, joinDelayMs: 10 })
  assert.equal(await p.emit('tool_result', result('read'), ctx), undefined, 'not in the room yet: no ring')
  assert.equal(d.doorbells().length, 0)
  await p.emit('session_start', { reason: 'startup' }, ctx)
  for (let i = 0; i < 100 && !room.link?.connected; i++) await sleep(20)
  assert.equal(room.link.connected, true)

  const out = await p.emit('tool_result', result('read'), ctx)
  assert.deepEqual(out, { content: [{ type: 'text', text: '# proj' }, { type: 'text', text: LINE }] })
  assert.deepEqual(d.doorbells(), [{ type: 'doorbell', harness: 'pi', sessionId: 'pi-sess-db', pid: process.pid }])
  assert.equal(await p.emit('tool_result', result('autochat_read'), ctx), undefined)
  assert.equal(d.doorbells().length, 1, 'the room\'s own tools never ring')
  d.answer = () => ({ ok: true, text: null })
  assert.equal(await p.emit('tool_result', result('bash'), ctx), undefined)
  d.answer = () => 'hang'
  const t0 = Date.now()
  assert.equal(await p.emit('tool_result', result('bash'), ctx), undefined)
  assert.ok(Date.now() - t0 < 1500)
  assert.equal(await p.emit('tool_result', { toolName: 'read' }, ctx), undefined, 'no content: nothing to add to')
  await p.emit('session_shutdown', { reason: 'quit' }, ctx)
  for (let i = 0; i < 100 && room.link.connected; i++) await sleep(20)
  d.answer = () => ({ ok: true, text: LINE })
  const rang = d.doorbells().length
  assert.equal(await p.emit('tool_result', result('read'), ctx), undefined, 'left the room: no ring')
  assert.equal(d.doorbells().length, rang)
})

test('cleanup', () => {
  fs.rmSync(tmp, { recursive: true, force: true })
})
