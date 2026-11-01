import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'autochat.js')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autochat-hook-'))
const env = {
  ...process.env,
  COPILOT_HOME: path.join(tmp, 'copilot'),
  AUTOCHAT_HOME: path.join(tmp, 'lc'),
  AUTOCHAT_LAUNCH_RECORD: path.join(tmp, 'launches.jsonl'),
  AUTOCHAT_DEBUG: '1',
  // An installed AutoChat.app must not change which launcher these tests see.
  AUTOCHAT_APP_DIRS: path.join(tmp, 'no-apps'),
  TMUX: '', TMUX_PANE: ''
}
process.env.COPILOT_HOME = env.COPILOT_HOME
process.env.AUTOCHAT_HOME = env.AUTOCHAT_HOME

const writeSession = (sid, mode) => {
  const dir = path.join(env.COPILOT_HOME, 'session-state', sid)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'events.jsonl'), JSON.stringify({ type: 'session.mode_changed', data: { newMode: mode } }) + '\n')
}

const hook = (event, payload, extraEnv = {}) => {
  const r = spawnSync(process.execPath, [BIN, 'hook', event], { input: typeof payload === 'string' ? payload : JSON.stringify(payload), env: { ...env, ...extraEnv }, encoding: 'utf8' })
  return { code: r.status, stdout: r.stdout, result: r.stderr ? JSON.parse(r.stderr.trim().split('\n').pop()) : null }
}

const launches = () => { try { return fs.readFileSync(env.AUTOCHAT_LAUNCH_RECORD, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) } catch { return [] } }

test('hook never fails or prints, even on garbage input', () => {
  for (const input of ['', 'not json', '{"sessionId": "../../etc"}', '[]']) {
    const r = spawnSync(process.execPath, [BIN, 'hook', 'preToolUse'], { input, env: { ...env, AUTOCHAT_DEBUG: '' }, encoding: 'utf8' })
    assert.equal(r.status, 0)
    assert.equal(r.stdout, '')
    assert.equal(r.stderr, '')
  }
})

test('hook launches the UI only for sessions in autopilot', async () => {
  writeSession('s-interactive', 'interactive')
  writeSession('s-auto', 'autopilot')
  let r = hook('postToolUse', { sessionId: 's-interactive', toolName: 'bash', cwd: '/x' })
  assert.equal(r.code, 0)
  assert.equal(r.stdout, '')
  assert.equal(r.result.action, 'ignored')
  assert.equal(launches().length, 0)

  r = hook('agentStop', { sessionId: 's-auto' })
  assert.equal(r.result.action, 'ignored', 'stop events never launch')

  // Inside tmux, so the hook opens a UI on every platform (CI's Linux runners have no terminal or DISPLAY).
  r = hook('postToolUse', { sessionId: 's-auto', toolName: 'bash', cwd: '/x' }, { TMUX: '/x/tmux,1,0', TMUX_PANE: '%1' })
  assert.equal(r.result.action, 'launched')
  assert.equal(r.stdout, '')
  const l = launches()
  assert.equal(l.length, 1)
  assert.ok(l[0].cmd.includes('ui') && l[0].cmd.includes('--auto'))

  // While the first launch is pending, every event (even completions) is queued, never dropped.
  r = hook('preToolUse', { sessionId: 's-auto', toolCalls: [{ name: 'view', args: {} }] })
  assert.equal(r.result.action, 'spooled')
  r = hook('postToolUse', { sessionId: 's-auto', toolName: 'task_complete', toolArgs: { summary: 'quick' } })
  assert.equal(r.result.action, 'spooled')
  assert.equal(launches().length, 1)
  const { readSpool } = await import('../src/hook.js')
  assert.deepEqual(readSpool().map(m => m.kind), ['activity', 'activity', 'complete'], 'spool drains in order')
})

test('notify-only launches nudge once per session', () => {
  const home = path.join(tmp, 'lc-notify')
  spawnSync(process.execPath, [BIN, 'config', 'launch', 'notify'], { env: { ...env, AUTOCHAT_HOME: home } })
  const e = { AUTOCHAT_HOME: home }
  assert.equal(hook('preToolUse', { sessionId: 's-auto', toolCalls: [{ name: 'bash' }] }, e).result.action, 'launched')
  assert.equal(hook('preToolUse', { sessionId: 's-auto', toolCalls: [{ name: 'bash' }] }, e).result.action, 'ignored')
  const run = fs.readdirSync(path.join(home, 'run'))
  assert.equal(run.filter(f => f.startsWith('spool-')).length, 0, 'no spool files pile up')
})

test('hook picks tmux when inside tmux', () => {
  fs.rmSync(path.join(env.AUTOCHAT_HOME, 'run'), { recursive: true, force: true })
  fs.rmSync(env.AUTOCHAT_LAUNCH_RECORD, { force: true })
  const r = hook('userPromptSubmitted', { sessionId: 's-auto', prompt: 'go' }, { TMUX: '/tmp/tmux-1/default,1,0', TMUX_PANE: '%3' })
  assert.equal(r.result.method, 'tmux')
})

test('hook delivers to a running UI and maps requests', async () => {
  const { serve } = await import('../src/ipc.js')
  fs.rmSync(path.join(env.AUTOCHAT_HOME, 'run'), { recursive: true, force: true })
  const got = []
  const server = await serve((m) => { got.push(m); return {} })
  try {
    const run = (event, payload) => new Promise((resolve) => {
      import('node:child_process').then(({ spawn }) => {
        const c = spawn(process.execPath, [BIN, 'hook', event], { env })
        c.stdin.end(JSON.stringify(payload))
        c.on('exit', resolve)
      })
    })
    // Payload shapes below are copied from a real Copilot CLI 1.0.97 autopilot session.
    await run('notification', { sessionId: 's-auto', notificationType: 'permission_prompt', title: 'Permission needed', message: 'Run \x1b[31mrm -rf build\x1b[0m?' })
    await run('preToolUse', { sessionId: 's-auto', cwd: '/w', toolCalls: [{ id: 't1', name: 'ask_user', args: { message: 'What is your favorite color?', requestedSchema: { properties: { favorite_color: { type: 'string', title: 'Favorite Color', enum: ['red', 'blue'] } } } } }] })
    await run('postToolUse', { sessionId: 's-auto', toolName: 'task_complete', toolArgs: { summary: 'All done' } })
    await run('notification', { sessionId: 's-auto', notification_type: 'shell_completed', message: 'x' })
    await run('preToolUse', { sessionId: 's-auto', toolCalls: [{ id: 't2', name: 'task_complete', args: { summary: 'x' } }] })
    const hooks = got.filter(m => m.type === 'hook')
    assert.equal(hooks.length, 5)
    assert.equal(hooks[0].kind, 'request')
    assert.equal(hooks[0].request.message, 'Run rm -rf build?', 'escape sequences stripped')
    assert.equal(hooks[0].mode, 'autopilot')
    assert.equal(hooks[1].kind, 'request')
    assert.equal(hooks[1].request.message, 'What is your favorite color? (Favorite Color: red / blue)')
    assert.equal(hooks[2].kind, 'complete')
    assert.equal(hooks[2].summary, 'All done')
    assert.equal(hooks[3].kind, 'notice')
    assert.equal(hooks[4].kind, 'activity', 'completion is only taken from postToolUse')
    // The doorbell rings on preToolUse, but never after task_complete, which ends the run.
    assert.deepEqual(got.filter(m => m.type === 'doorbell').map(m => [m.harness, m.sessionId]), [['copilot', 's-auto']])
    assert.equal(got.length, 6)
  } finally {
    server.close()
  }
})

test('pickMethod prefers AutoChat.app on macOS; an explicit launch setting still wins', async () => {
  const { pickMethod, appInstalled, APP_BUNDLE_ID } = await import('../src/launcher.js')
  const apps = path.join(tmp, 'apps')
  const app = path.join(apps, 'AutoChat.app')
  fs.mkdirSync(path.join(app, 'Contents'), { recursive: true })
  const e = { AUTOCHAT_APP_DIRS: path.join(tmp, 'nowhere') + path.delimiter + apps, TMUX: '/x/tmux,1,0', TMUX_PANE: '%1' }
  assert.equal(appInstalled(e), null, 'a bundle without Info.plist is not the app')
  fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), '<plist><dict><key>CFBundleIdentifier</key><string>com.example.other</string></dict></plist>')
  assert.equal(appInstalled(e), null, 'some other app named AutoChat.app')
  fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), `<plist><dict><key>CFBundleIdentifier</key><string>${APP_BUNDLE_ID}</string></dict></plist>`)
  assert.equal(appInstalled(e), app)
  assert.equal(pickMethod({ launch: 'auto' }, e, 'darwin'), 'app', 'the app beats tmux and terminals')
  assert.equal(pickMethod({ launch: 'tmux' }, e, 'darwin'), 'tmux', 'explicit config wins')
  assert.equal(pickMethod({ launch: 'auto' }, e, 'linux'), 'tmux', 'macOS only')
  assert.equal(pickMethod({ launch: 'auto' }, { AUTOCHAT_APP_DIRS: path.join(tmp, 'nowhere') }, 'darwin'), 'terminal', 'not installed: terminals as before')

  // Through the hook, auto-detected on macOS.
  if (process.platform === 'darwin') {
    const home = path.join(tmp, 'lc-app-auto')
    const r = hook('userPromptSubmitted', { sessionId: 's-auto', prompt: 'go' }, { AUTOCHAT_HOME: home, AUTOCHAT_APP_DIRS: apps })
    assert.equal(r.result.method, 'app')
  }
  const bad = spawnSync(process.execPath, [BIN, 'config', 'launch', 'nope'], { env: { ...env, AUTOCHAT_HOME: path.join(tmp, 'lc-app-bad') }, encoding: 'utf8' })
  assert.equal(bad.status, 1)
  assert.match(bad.stderr, /auto\|app\|tmux/)
})

test('launch=app wakes AutoChat.app (never a terminal) and spools events until its daemon is up', async () => {
  const home = path.join(tmp, 'lc-app')
  const e = { AUTOCHAT_HOME: home }
  const cfg = spawnSync(process.execPath, [BIN, 'config', 'launch', 'app'], { env: { ...env, ...e }, encoding: 'utf8' })
  assert.equal(cfg.status, 0, cfg.stderr)
  fs.rmSync(env.AUTOCHAT_LAUNCH_RECORD, { force: true })
  let r = hook('userPromptSubmitted', { sessionId: 's-auto', prompt: 'go' }, e)
  assert.deepEqual(r.result, { action: 'launched', method: 'app' })
  assert.deepEqual(launches(), [{ method: 'app', cmd: ['open', '-g', '-b', 'com.bnookala.autochat'] }])

  // A cold app start takes a few seconds: hooks in the meantime queue instead of relaunching.
  r = hook('preToolUse', { sessionId: 's-auto', toolCalls: [{ name: 'bash' }] }, e)
  assert.equal(r.result.action, 'spooled')
  assert.equal(launches().length, 1)

  process.env.AUTOCHAT_HOME = home
  try {
    const { serve } = await import('../src/ipc.js')
    const { readSpool } = await import('../src/hook.js')
    const server = await serve(() => ({}))
    try {
      assert.deepEqual(readSpool().map(m => m.kind), ['activity', 'activity'], 'the daemon drains everything the hooks queued')
      const done = await new Promise((resolve) => {
        import('node:child_process').then(({ spawn }) => {
          const c = spawn(process.execPath, [BIN, 'hook', 'postToolUse'], { env: { ...env, ...e } })
          let err = ''
          c.stderr.on('data', (d) => { err += d })
          c.stdin.end(JSON.stringify({ sessionId: 's-auto', toolName: 'task_complete', toolArgs: { summary: 'ok' } }))
          c.on('exit', () => resolve(JSON.parse(err.trim().split('\n').pop())))
        })
      })
      assert.equal(done.action, 'delivered')
    } finally {
      server.close()
    }
  } finally {
    process.env.AUTOCHAT_HOME = env.AUTOCHAT_HOME
  }
  assert.equal(launches().length, 1)
})

test('setup writes fail-safe hooks for the right events', async () => {
  const { buildHooksConfig } = await import('../src/setup.js')
  const cfg = buildHooksConfig()
  assert.equal(cfg.version, 1)
  assert.deepEqual(Object.keys(cfg.hooks).sort(), ['agentStop', 'notification', 'postToolUse', 'preToolUse', 'sessionEnd', 'userPromptSubmitted'])
  assert.equal(cfg.hooks.preToolUse[0].matcher, undefined, 'preToolUse sees every tool so rooms open immediately')
  assert.equal(cfg.hooks.postToolUse[0].matcher, 'task_complete')
  for (const [, entries] of Object.entries(cfg.hooks)) assert.match(entries[0].bash, /\|\| true$/)
})
