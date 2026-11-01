import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// src/harness-jobs.js: Connect agents' planAgents() and setupAgents() from src/harness/index.js,
// each in a child process, against a throwaway HOME. The children get this process's env, set
// here before any job runs. AUTOCHAT_HARNESS_PATH has the only harness binaries they see.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autochat-hj-'))
after(() => fs.rmSync(tmp, { recursive: true, force: true }))
const home = path.join(tmp, 'home')
const bin = path.join(tmp, 'bin')
for (const d of [path.join(home, '.copilot'), path.join(home, '.codex'), bin]) fs.mkdirSync(d, { recursive: true })
Object.assign(process.env, { HOME: home, COPILOT_HOME: path.join(home, '.copilot'), XDG_CONFIG_HOME: path.join(home, '.config'), AUTOCHAT_HARNESS_PATH: bin })
for (const k of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'PI_CODING_AGENT_DIR']) delete process.env[k]
const { harnessJobs } = await import('../src/harness-jobs.js')
const { ADAPTERS } = await import('../src/harness/index.js')
const jobs = harnessJobs()
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))
const posix = process.platform !== 'win32'
// A stand-in `claude` CLI on the harness path, for one test.
const stubClaude = (t, script) => {
  const file = path.join(bin, 'claude')
  fs.writeFileSync(file, '#!/bin/sh\n' + script, { mode: 0o755 })
  t.after(() => fs.rmSync(file, { force: true }))
}

test('planAgents: every harness\'s plan as plain data, with what setup --agents prints as detail', async () => {
  const plans = await jobs.planAgents()
  assert.deepEqual(plans.map(p => p.id), ADAPTERS.map(a => a.id))
  assert.ok(plans.every(p => Object.keys(p).join() === 'id,name,action,where,reason,detail'))
  const by = Object.fromEntries(plans.map(p => [p.id, p]))
  assert.deepEqual([by.copilot.name, by.copilot.action, by.copilot.where], ['Copilot CLI', 'add', '~/.copilot/mcp-config.json'])
  assert.equal(by.copilot.detail[0], 'add to ~/.copilot/mcp-config.json', 'without the id label')
  assert.match(by.copilot.detail[1], /^\+ "autochat": \{"type":"local","command":/, 'nor the indent')
  assert.deepEqual(by.codex.detail.slice(0, 2), ['add to ~/.codex/config.toml', '+ [mcp_servers.autochat]'])
  assert.deepEqual([by.claude.action, by.claude.where, by.claude.detail], ['absent', null, ['not installed']])
})

test('setupAgents: only the listed harnesses, each failure with its error, then planned again', async () => {
  const r = await jobs.setupAgents({ ids: ['copilot', 'claude', 'nope'] })
  assert.deepEqual([r.applied, r.failed], [['copilot'], []], 'claude isn\'t installed and nope isn\'t a harness: nothing to apply')
  const now = Object.fromEntries(r.plans.map(p => [p.id, p.action]))
  assert.deepEqual([now.copilot, now.codex], ['none', 'add'], 'codex wasn\'t listed')
  const config = JSON.parse(fs.readFileSync(path.join(home, '.copilot', 'mcp-config.json'), 'utf8'))
  assert.deepEqual([config.mcpServers.autochat.command, ...config.mcpServers.autochat.args.slice(1)], [process.execPath, 'mcp', '--harness', 'copilot'])
  assert.equal(fs.existsSync(path.join(home, '.codex', 'config.toml')), false)
  if (!posix || process.getuid?.() === 0) return
  fs.chmodSync(path.join(home, '.codex'), 0o555)
  try {
    const bad = await jobs.setupAgents({ ids: ['codex'] })
    assert.deepEqual(bad.applied, [])
    assert.deepEqual(bad.failed.map(f => f.id), ['codex'])
    assert.match(bad.failed[0].error, /EACCES|permission denied/)
  } finally {
    fs.chmodSync(path.join(home, '.codex'), 0o755)
  }
})

test('a slow harness CLI never blocks the event loop', { skip: !posix }, async (t) => {
  // `claude mcp get autochat`, as slow as a cold start, and not registered (exit 1).
  stubClaude(t, 'sleep 0.4\nexit 1\n')
  let ticks = 0
  const timer = setInterval(() => ticks++, 10)
  const started = Date.now()
  const plans = await jobs.planAgents()
  clearInterval(timer)
  assert.ok(Date.now() - started >= 400)
  assert.ok(ticks >= 10, `the main thread kept running (${ticks} ticks)`)
  const claude = plans.find(p => p.id === 'claude')
  assert.deepEqual([claude.action, claude.where], ['add', 'claude mcp (user scope)'])
  assert.match(claude.detail[0], /^run: claude mcp add --scope user autochat -- /)
})

test('a plan that takes too long is killed, with the harness CLI it waits on', { skip: !posix }, async (t) => {
  const mark = path.join(tmp, 'claude-finished')
  stubClaude(t, `sleep 1\ntouch '${mark}'\nexit 1\n`)
  const started = Date.now()
  await assert.rejects(harnessJobs({ planMs: 200 }).planAgents(), /timed out after 0.2 s/)
  assert.ok(Date.now() - started < 1000)
  await sleep(1300)
  assert.equal(fs.existsSync(mark), false, 'claude was killed before it got that far')
})

test('a setup is never cut short', { skip: !posix }, async (t) => {
  // Not registered; `claude mcp add` takes a while.
  stubClaude(t, 'case "$2" in add) sleep 0.5; exit 0 ;; esac\nexit 1\n')
  const r = await harnessJobs({ planMs: 100 }).setupAgents({ ids: ['claude'] })
  assert.deepEqual([r.applied, r.failed], [['claude'], []])
})
