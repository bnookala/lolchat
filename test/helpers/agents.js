import fs from 'node:fs'
import os from 'node:os'
import net from 'node:net'
import path from 'node:path'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

// Shared by test/agents-*.test.js: a temp AUTOCHAT_HOME (set on import, before any src/ module
// loads), a daemon-like host for the agent room on its socket, and line-level clients.

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autochat-agents-'))
process.env.AUTOCHAT_HOME = path.join(tmp, 'ac')
const { serve } = await import('../../src/ipc.js')
const { AgentRoom } = await import('../../src/agents.js')
const { sockPath } = await import('../../src/paths.js')
export { serve }

export const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))
// Fake secrets are assembled at runtime, so the source never contains anything secret-shaped.
export const fake = (...parts) => parts.join('')

// Newline-delimited JSON over the daemon socket; next() waits for (and consumes) a matching line.
export function client () {
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
  let ids = 0
  const c = {
    lines,
    closed,
    send: (m) => sock.write(JSON.stringify(m) + '\n'),
    next: (pred = () => true, ms = 5000, label = 'message') => new Promise((resolve, reject) => {
      const w = { pred, resolve, timer: setTimeout(() => reject(new Error('timed out waiting for ' + label)), ms) }
      waiters.push(w)
      check()
    }),
    // Sends a command and resolves with its reply.
    cmd: (cmd, args = {}) => {
      const id = ++ids
      c.send({ type: 'cmd', id, cmd, ...args })
      return c.next(m => m.type === 'reply' && m.id === id, 5000, `reply to ${cmd}`)
    },
    close: () => sock.end()
  }
  return c
}

export const HELLO = { type: 'agent-hello', v: 1, harness: 'copilot', name: null, pid: 4242, harnessPid: 4200, sessionId: null, cwd: '/w/x', repo: 'owner/repo', branch: 'feat-x', worktree: 'x', resume: null }

// Test agents are named <harness>-<repo name or cwd basename> (the default name before #66, which
// derives names from titles), unless the test passes a `name`: `name: null` gets the default.
export const testName = (h) => `${h.harness}-${(h.repo && h.repo.split('/').pop()) || path.basename(h.cwd || '')}`.toLowerCase().replace(/[^a-z0-9-]+/g, '-')

export async function agent (hello = {}) {
  const c = client()
  c.send({ ...HELLO, ...hello, name: hello.name !== undefined ? hello.name : testName({ ...HELLO, ...hello }) })
  c.welcome = await c.next(m => m.type === 'agent-welcome' || m.type === 'error', 5000, 'welcome')
  c.name = c.welcome.agent?.name
  return c
}

// A daemon-like host: the agent room on the socket, as `autochat daemon` wires it, doorbell
// included (`parentPid` stands in for the process table).
export async function start (t, { parentPid = null, ...opts } = {}) {
  const room = new AgentRoom({ human: 'stormy-newt-59', ...opts })
  const server = await serve((m) => m?.type === 'doorbell' ? room.doorbell(m, { parentPid }) : {}, {
    state: () => ({ type: 'state', v: 1 }),
    command: () => {},
    agents: { connect: (h, p) => room.connect(h, p), state: () => room.snapshot(), command: (m) => room.command(m) }
  })
  room.on('change', () => server.publish('agents'))
  t.after(async () => {
    room.close()
    await new Promise(resolve => server.close(resolve))
  })
  return { room, server }
}

export const ok = (r) => { assert.equal(r.ok, true, r.error); return r.result }
export const texts = (msgs) => msgs.map(m => m.text)
