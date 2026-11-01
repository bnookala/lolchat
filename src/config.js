import fs from 'node:fs'
import path from 'node:path'
import { home, ensureDir } from './paths.js'
import { DEFAULT_ROOM, parseRoom } from './protocol.js'

export const DEFAULTS = {
  room: DEFAULT_ROOM,
  // auto | app | tmux | ghostty | iterm | terminal | notify | off (see LAUNCH_METHODS)
  launch: 'auto',
  tmuxSplit: 'v',
  idleMs: 45000,
  announce: true,
  // seconds you stay in the room after autopilot ends; 0 = pulled back immediately
  countdownSeconds: 30,
  // focus back on the agent at the end of the countdown: auto (only if one agent was at work) | never | always
  focus: 'auto',
  // set by agents.ack: the human saw "Agents read your messages as input…"
  agentsInterventionAck: false,
  // on | off: after their tool calls, tell agents in the agent room what's waiting for them
  doorbell: 'on'
}

export const FOCUS_MODES = ['auto', 'never', 'always']
export const DOORBELL_MODES = ['on', 'off']

export const configPath = () => path.join(home(), 'config.json')

export function loadConfig () {
  let cfg = {}
  try { cfg = JSON.parse(fs.readFileSync(configPath(), 'utf8')) } catch {}
  const merged = { ...DEFAULTS, ...cfg }
  try { parseRoom(merged.room) } catch { merged.room = DEFAULT_ROOM }
  return merged
}

export function saveConfig (patch) {
  const next = { ...loadConfig(), ...patch }
  ensureDir(home())
  const tmp = configPath() + '.' + process.pid + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
  fs.renameSync(tmp, configPath())
  return next
}
