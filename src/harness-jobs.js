import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Connect agents (#65): the daemon's agent room plans and sets up harnesses with planAgents() and
// setupAgents() from src/harness/index.js, each call in a child process. They block on harness
// CLIs (`claude mcp get autochat` takes 150-350 ms, and up to a minute if it hangs), and neither
// the daemon's event loop nor its exit may wait on them. The daemon hands these to
// `new AgentRoom({harnesses})`; see docs/agent-room/human.md.

const FLAG = '--autochat-harness-job'

/**
 * The room's `harnesses`:
 * - `planAgents()` resolves to planAgents()'s plans as plain data:
 *   `{id, name, action, where, reason, detail}`, where `detail` is describePlan()'s lines for the
 *   plan, without the harness id in front. After `planMs` it fails, and the plan is killed.
 * - `setupAgents({ids})` resolves to `{applied, failed: [{id, error}], plans}`: setupAgents() with
 *   the plans of those harnesses (others are left alone), then `plans`, planned again after it.
 *   It's never cut short: stopping halfway could leave a config half done (updating Claude Code
 *   is `claude mcp remove`, then `add`), and each harness CLI call stops at 60 s anyway.
 */
export function harnessJobs ({ planMs = 15000 } = {}) {
  return {
    planAgents: () => runJob({ op: 'plan' }, planMs),
    setupAgents: ({ ids } = {}) => runJob({ op: 'setup', ids: Array.isArray(ids) ? ids : [] }, 0)
  }
}

function runJob (job, ms) {
  return new Promise((resolve, reject) => {
    // On POSIX, its own process group: a timeout kills the harness CLI it waits on too, and a
    // setup finishes even if the daemon exits first. (Windows has no agents.setup client yet.)
    const child = fork(fileURLToPath(import.meta.url), [FLAG, JSON.stringify(job)], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      execArgv: [],
      detached: process.platform !== 'win32',
      windowsHide: true
    })
    let timer = null
    if (ms) {
      timer = setTimeout(() => {
        reject(new Error(`the harness check timed out after ${ms / 1000} s`))
        try {
          if (process.platform === 'win32') child.kill('SIGKILL')
          else process.kill(-child.pid, 'SIGKILL')
        } catch {}
      }, ms)
    }
    child.once('message', (m) => {
      clearTimeout(timer)
      if (m?.ok) resolve(m.result)
      else reject(new Error(m?.error || 'the harness check failed'))
    })
    // `on`, not `once`: an unhandled second 'error' would take the daemon down.
    child.on('error', (err) => { clearTimeout(timer); reject(err) })
    // After 'message', if there was one: the IPC channel has closed by then.
    child.once('close', (code, signal) => { clearTimeout(timer); reject(new Error(`the harness check exited (${signal || code})`)) })
  })
}

// --- in the child ------------------------------------------------------------------------------

if (process.argv[2] === FLAG && process.send) {
  let msg
  try {
    const H = await import('./harness/index.js')
    msg = { ok: true, result: work(H, JSON.parse(process.argv[3])) }
  } catch (err) {
    msg = { ok: false, error: err?.message || String(err) }
  }
  // A setup carries on after the daemon has gone; then there's no one to tell.
  if (process.connected) process.send(msg, () => process.exit(0))
  else process.exit(0)
}

function work (H, job) {
  const ctx = H.harnessContext()
  const plain = (p) => ({ id: p.id, name: p.name, action: p.action, where: p.where ?? null, reason: p.reason ?? null, detail: detail(H, p, ctx) })
  if (job.op === 'plan') return H.planAgents(ctx).map(plain)
  if (job.op !== 'setup') throw new Error(`unknown harness job: ${job.op}`)
  // setupAgents() reports only the ids that failed; keep each one's error too.
  const errors = new Map()
  const plans = H.planAgents(ctx).filter(p => job.ids.includes(p.id)).map(p => p.apply
    ? { ...p, apply: () => { try { p.apply() } catch (err) { errors.set(p.id, err?.message || String(err)); throw err } } }
    : p)
  const r = H.setupAgents({ ctx, plans, out: () => {} })
  return {
    applied: r.applied,
    failed: r.failed.map(id => ({ id, error: errors.get(id) || 'failed' })),
    plans: H.planAgents(ctx).map(plain)
  }
}

// What `autochat setup --agents` prints for the plan, one line each, without the id label (the
// first line's) and the indent that lines up the rest under it.
function detail (H, p, ctx) {
  const label = String(p.id).padEnd(9)
  return H.describePlan(p, ctx).map((l, i) => i === 0 && l.startsWith(label) ? l.slice(label.length) : l.replace(/^ {9}/, ''))
}
