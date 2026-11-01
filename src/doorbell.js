import { send } from './ipc.js'
import { sanitize } from './text.js'

// The doorbell (#52). An agent only hears about the agent room when it calls an autochat tool, and
// it doesn't while it edits. So after its tool calls, the harness's hook (or plugin, or extension)
// asks the daemon, in one short round trip, whether anything in the room is waiting for that
// agent, and puts the answer into the agent's context: "2 unread from copilot-x, use autochat
// read". The daemon decides what's worth a ring and how often; this side only asks, and stays
// silent on anything but a clear answer. docs/harnesses.md says how each harness does it.

// The whole ask, connect included: it runs on every tool call.
export const RING_TIMEOUT_MS = 150
// A doorbell is one short line.
export const MAX_DOORBELL = 500

/**
 * The one-shot `doorbell` message: which harness session is asking. `pid` is the harness
 * process when the caller knows it, else the process that ran the hook (a shell whose parent is
 * the harness).
 */
export function doorbellMessage ({ harness, sessionId = null, pid = null }) {
  return {
    type: 'doorbell',
    harness: typeof harness === 'string' ? harness : null,
    sessionId: typeof sessionId === 'string' && sessionId ? sessionId : null,
    pid: Number.isInteger(pid) && pid > 0 ? pid : null
  }
}

/** The daemon's reply as the line to show, or null: ok:false, no text, or an empty one. */
export function doorbellText (reply) {
  if (!reply || typeof reply !== 'object' || reply.ok !== true || typeof reply.text !== 'string') return null
  return sanitize(reply.text, MAX_DOORBELL) || null
}

/**
 * Rings: resolves to the line to show, or null when there's nothing to say, no daemon, an older
 * daemon that doesn't know the message, or no answer in time. Never rejects.
 */
export async function ring (who, { timeoutMs = RING_TIMEOUT_MS } = {}) {
  try {
    return doorbellText(await send(doorbellMessage(who), timeoutMs))
  } catch {
    return null
  }
}
