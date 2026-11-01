import crypto from 'node:crypto'
import { sanitize } from '../text.js'

// Constants, limits, the command error, and the small validators every module uses.
// See docs/agent-room/README.md.

export const AGENT_PROTOCOL = 1
export const TIER = 'local'
export const STATES = ['exploring', 'editing', 'testing', 'blocked', 'done', 'idle']
export const POST_KINDS = ['note', 'question', 'reply', 'proposal', 'decision', 'handoff']

export const LIMITS = {
  maxAgents: 32,
  resumeMs: 10000,
  lingerMs: 10 * 60 * 1000,
  historyMax: 1000,
  historyMs: 24 * 60 * 60 * 1000,
  threadMs: 24 * 60 * 60 * 1000,
  budgetWindowMs: 10 * 60 * 1000,
  mainPosts: 10,
  threadPosts: 40,
  statusGapMs: 5000,
  pathsGapMs: 2000,
  waitDefaultMs: 30000,
  waitMaxMs: 50000,
  readDefault: 50,
  readMax: 100,
  snapshotMessages: 300,
  decisions: 10,
  relevant: 10,
  recent: 20,
  text: 2000,
  summary: 140,
  title: 80,
  outcome: 500,
  nextSteps: 5,
  nextStep: 140,
  component: 40,
  components: 10,
  knownComponents: 20,
  path: 300,
  paths: 200,
  to: 16,
  // The doorbell (inbox.js): at most one ring per agent this often, of at most this many characters.
  doorbellMs: 60 * 1000,
  doorbellText: 500
}

// A command that fails on its arguments: the agent gets `ok:false` with the message (and any
// extra fields, such as retryAfterMs). Anything else thrown is a bug, and is logged.
export class AgentError extends Error {
  constructor (message, extra = {}) {
    super(message)
    Object.assign(this, extra)
  }
}
export const fail = (message, extra) => { throw new AgentError(message, extra) }

export const hex = (bytes) => crypto.randomBytes(bytes).toString('hex')
export const isStr = (v) => typeof v === 'string'
// For error messages about untrusted values: never calls their toString.
export const label = (v) => isStr(v) ? sanitize(v, 40) : typeof v
export const int = (v) => Number.isSafeInteger(v)
export const opt = (v) => v === undefined || v === null
