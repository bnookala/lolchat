// autochat's opencode plugin: tells autochat what your opencode sessions do, so it can put you in
// the lounge while one works on its own (https://github.com/bnookala/autochat). Written by
// `autochat setup --harness opencode`, removed by `autochat uninstall`; edits here get replaced.
//
// It forwards a session's start, prompts, tool calls, permission requests and questions (and
// their answers), idle, and the end of the opencode process to `autochat hook --harness opencode
// <event>`, which decides what they mean. Each says which process it's from: opencode dies
// without a word on Ctrl+C. Subagents' sessions only pass on their requests, as
// their parent's. It never throws, and does nothing when autochat isn't there.
//
// The doorbell: after each tool call (but the agent room's own), it asks autochat whether anything
// in the agent room is waiting for this opencode, and adds autochat's one line to what the tool
// returns. That's the only time it waits for autochat, for 150 ms at most.
import { spawn } from 'node:child_process'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

// The node and autochat.js the hook runs: `autochat setup` fills these in.
const NODE = 'node'
const BIN = 'autochat.js'

const RING_MS = 150
const MAX_RING = 500
const ROOM_TOOL = 'autochat_'

const brief = (s, n) => typeof s === 'string' ? s.slice(0, n) : undefined
const strings = (o, n) => Object.fromEntries(Object.entries(o && typeof o === 'object' ? o : {}).filter(([, v]) => typeof v === 'string').map(([k, v]) => [k, v.slice(0, n)]))

// autochat's socket, as src/paths.js finds it.
function sockPath () {
  const env = process.env
  const home = (env.AUTOCHAT_HOME !== undefined ? env.AUTOCHAT_HOME : env.LOLCHAT_HOME) || path.join(os.homedir(), '.autochat')
  if (process.platform === 'win32') return '\\\\.\\pipe\\autochat-' + crypto.createHash('sha256').update(home).digest('hex').slice(0, 12)
  return path.join(home, 'run', 'ui.sock')
}

// One line of plain text, as src/text.js sanitize() makes it: no escape sequences, control
// characters or bidi overrides.
const oneLine = (s) => s
  .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)?/g, '')
  .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
  .replace(/\x1b[PX^_][^\x1b]*(\x1b\\)?/g, '')
  .replace(/\x1b./g, '')
  .replace(/[\r\n\t\u2028\u2029]+/g, ' ')
  .replace(/[\x00-\x1f\x7f-\x9f]/g, '')
  .replace(/[\u202a-\u202e\u2066-\u2069\u200e\u200f]/g, '')
  .trim()
  .slice(0, MAX_RING)

// Asks autochat's doorbell: its line, or null for nothing to say, no autochat, or no answer in time.
// Not exported: opencode calls every export of a plugin file as a plugin.
function ring (sessionId, { timeoutMs = RING_MS, sock = sockPath() } = {}) {
  return new Promise((resolve) => {
    let done = false
    let conn = null
    let buf = ''
    const finish = (text) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try { conn?.destroy() } catch {}
      resolve(text || null)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    try {
      conn = net.connect(sock)
      conn.setEncoding('utf8')
      conn.on('connect', () => conn.write(JSON.stringify({ type: 'doorbell', harness: 'opencode', sessionId, pid: process.pid }) + '\n'))
      conn.on('data', (d) => {
        buf += d
        const i = buf.indexOf('\n')
        if (i === -1) { if (buf.length > 65536) finish(null); return }
        let reply = null
        try { reply = JSON.parse(buf.slice(0, i)) } catch {}
        finish(reply && reply.ok === true && typeof reply.text === 'string' ? oneLine(reply.text) : null)
      })
      conn.on('error', () => finish(null))
      conn.on('close', () => finish(null))
    } catch {
      finish(null)
    }
  })
}

export const AutochatPlugin = async ({ directory } = {}) => {
  // How this opencode runs (`run …`, the TUI's worker, `serve`, …).
  const argv = process.argv.slice(1, 21).map(a => String(a).slice(0, 200))
  // Each event goes out in a process of its own, so they can arrive out of order: `at` says when
  // it happened (strictly increasing), and the core drops stale ones.
  let clock = 0
  const sessions = new Map()
  const entry = (id) => {
    if (!sessions.has(id)) sessions.set(id, {})
    return sessions.get(id)
  }
  const root = (id) => {
    for (let i = 0; i < 16 && sessions.get(id)?.parent; i++) id = sessions.get(id).parent
    return id
  }
  const send = (event, sessionID, extra = {}) => {
    try {
      if (typeof sessionID !== 'string') return
      const s = entry(sessionID)
      s.active = true
      clock = Math.max(Date.now(), clock + 1)
      const payload = { event, sessionID, at: clock, pid: process.pid, session: s.info, agent: s.agent, argv, directory, ...extra }
      const child = spawn(NODE, [BIN, 'hook', '--harness', 'opencode', event], { stdio: ['pipe', 'ignore', 'ignore'], detached: true, windowsHide: true })
      child.on('error', () => {})
      child.stdin.on('error', () => {})
      child.stdin.end(JSON.stringify(payload))
      child.unref()
    } catch {}
  }
  const learn = (info) => {
    if (!info || typeof info.id !== 'string') return
    const s = entry(info.id)
    s.parent = info.parentID
    s.info = { id: info.id, parentID: info.parentID, directory: brief(info.directory, 1000), permission: Array.isArray(info.permission) ? info.permission.slice(0, 50) : undefined }
  }
  const isRoot = (id) => typeof id === 'string' && !sessions.get(id)?.parent

  return {
    event: async ({ event } = {}) => {
      try {
        const p = event?.properties || {}
        switch (event?.type) {
          case 'session.created':
            learn(p.info)
            if (isRoot(p.info?.id)) send('session.created', p.info.id)
            break
          case 'session.updated':
            learn(p.info)
            break
          case 'message.updated':
            if (p.info?.role === 'assistant' && typeof p.info.agent === 'string') entry(p.info.sessionID).agent = p.info.agent
            break
          case 'message.part.updated':
            // The last thing it said, for when it goes idle.
            if (p.part?.type === 'text' && p.part.time?.end && !p.part.synthetic) entry(p.part.sessionID).text = brief(p.part.text, 4000)
            break
          case 'permission.asked':
            send(event.type, root(p.sessionID), { properties: { id: p.id, permission: p.permission, patterns: Array.isArray(p.patterns) ? p.patterns.slice(0, 20) : undefined } })
            break
          case 'question.asked':
            send(event.type, root(p.sessionID), { properties: { id: p.id, questions: Array.isArray(p.questions) ? p.questions.slice(0, 10) : undefined } })
            break
          case 'permission.replied':
          case 'question.replied':
          case 'question.rejected':
            send(event.type, root(p.sessionID), { properties: { requestID: p.requestID, reply: p.reply } })
            break
          case 'session.idle':
            if (isRoot(p.sessionID)) send(event.type, p.sessionID, { summary: sessions.get(p.sessionID)?.text })
            break
          case 'server.instance.disposed':
            // opencode is done with this directory: `opencode run` finished, or the TUI quit.
            for (const [id, s] of sessions) if (s.active && !s.parent) send(event.type, id, { summary: s.text })
            break
        }
      } catch {}
    },
    'chat.message': async (input, output) => {
      try {
        const id = input?.sessionID
        if (typeof id !== 'string') return
        const agent = output?.message?.agent || input.agent
        if (typeof agent === 'string') entry(id).agent = agent
        if (isRoot(id)) send('chat.message', id)
      } catch {}
    },
    'tool.execute.before': async (input, output) => {
      try {
        if (isRoot(input?.sessionID)) send('tool.execute.before', input.sessionID, { properties: { tool: input.tool, args: strings(output?.args, 300) } })
      } catch {}
    },
    // The doorbell. Built-in tools return text in output.output; MCP tools, content blocks.
    'tool.execute.after': async (input, output) => {
      try {
        if (!isRoot(input?.sessionID) || typeof input.tool !== 'string' || input.tool.startsWith(ROOM_TOOL) || !output || typeof output !== 'object') return
        if (typeof output.output !== 'string' && !Array.isArray(output.content)) return
        const text = await ring(input.sessionID)
        if (!text) return
        if (typeof output.output === 'string') output.output = `${output.output}\n\n${text}`
        else output.content.push({ type: 'text', text })
      } catch {}
    }
  }
}
