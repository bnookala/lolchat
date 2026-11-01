import fs from 'node:fs'
import path from 'node:path'
import { isValidSessionId } from '../paths.js'
import { sanitize } from '../protocol.js'
import { focusOrigin } from '../launcher.js'
import { instructions } from '../agent-client.js'
import { readText, readJson, writeFileSafely, planned, tilde, exists, isDir, isObj, same, shq } from './util.js'
import { SERVER, detectBy, argsFor, commandValid } from './mcp-config.js'
import { jsonSet, jsonDelete, jsonPush, jsonPull, parseJsonc } from './json-edit.js'
import { byTrigger, modesOf, originFrom } from './event.js'

// opencode. Hooks: a plugin of our own, $XDG_CONFIG_HOME/opencode/plugin/autochat.js
// (~/.config/opencode/plugin/), made from opencode-plugin.js: it forwards events to
// `autochat hook --harness opencode <event>`, so normalize() and the trigger rule stay here. MCP
// servers go in ~/.config/opencode/opencode.json(c), with the room's etiquette in a file of our own
// next to it, ~/.config/opencode/autochat.md, listed under `instructions` (see below).
//
// Verified against opencode 1.2.6 (test/fixtures/opencode/, recorded from the real binary):
// - It loads every {plugin,plugins}/*.{js,ts} in its config dirs at startup and calls each export
//   with {client, project, worktree, directory, serverUrl, $}. The `event` hook gets every bus
//   event without being awaited; chat.message and tool.execute.before are awaited.
// - tool.execute.after is awaited too, and the model reads what it leaves in `output`: a string in
//   output.output for built-in tools, MCP content blocks in output.content for MCP tools. The
//   plugin's doorbell appends its line there.
// - `opencode run` creates its session denying the question, plan_enter and plan_exit permissions
//   (`opencode github` denies question): session.created/updated carry those rules, which is
//   what marks a headless session, `run --attach` included. A session that run continues
//   (--continue, --session) only shows it in process.argv: [bun, /$bunfs/root/src/index.js, run,
//   …]. The TUI runs plugins in its worker: [bun, /$bunfs/root/src/cli/cmd/tui/worker.js].
// - run rejects its session's permission requests within milliseconds (permission.replied, reply
//   reject), but never a subagent's, and never answers a question: those hang it.
// - opencode has no signal handlers: Ctrl+C kills it without server.instance.disposed, so the
//   plugin sends its pid and the Controller ends the session once that process is gone.
// - Subagents work in child sessions (parentID) with their own prompts, tools and idle.
// - Processes the plugin spawns with detached: true outlive `opencode run`, so its last events
//   (session.idle, server.instance.disposed) get through.

export const PLUGIN = 'autochat.js'
const DIRS = ['plugin', 'plugins']
const TEMPLATE = new URL('./opencode-plugin.js', import.meta.url)
const MARKER = "autochat's opencode plugin"
const EDIT_TOOLS = new Set(['edit', 'write', 'multiedit'])

// --- hooks: the plugin --------------------------------------------------------------------------------

export const configDir = (ctx) => path.join(ctx.configHome, 'opencode')
const candidates = (ctx) => DIRS.map(d => path.join(configDir(ctx), d, PLUGIN))
const isOurs = (text) => typeof text === 'string' && text.includes(MARKER)

/** The plugin, with the node and autochat.js its hook runs. */
export function pluginSource (ctx) {
  return fs.readFileSync(TEMPLATE, 'utf8')
    .replace(/^const NODE = .*$/m, () => `const NODE = ${JSON.stringify(ctx.node)}`)
    .replace(/^const BIN = .*$/m, () => `const BIN = ${JSON.stringify(ctx.bin)}`)
}

// The node and autochat.js an installed plugin runs.
function embedded (text) {
  const get = (name) => { try { return JSON.parse((new RegExp(`^const ${name} = (.*)$`, 'm').exec(text) || [])[1]) } catch { return null } }
  return [get('NODE'), get('BIN')].filter(p => typeof p === 'string')
}

/**
 * Where our plugin is, or goes: plugin/ (which every opencode reads), or plugins/ when that's the
 * directory the user has.
 */
export function pluginFile (ctx) {
  const [singular, plural] = candidates(ctx)
  const ours = [singular, plural].find(f => isOurs(readText(f)))
  if (ours) return ours
  return !isDir(path.dirname(singular)) && isDir(path.dirname(plural)) ? plural : singular
}

// A file of our own: written whole, atomically, through a symlink if it is one. No backup.
function writeOwn (file, text) {
  let target = file
  try { target = fs.realpathSync(file) } catch {}
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const tmp = `${target}.autochat-${process.pid}.tmp`
  fs.writeFileSync(tmp, text, { mode: 0o644 })
  fs.renameSync(tmp, target)
}

function computeHooks (ctx) {
  const file = pluginFile(ctx)
  const want = pluginSource(ctx)
  const have = readText(file)
  if (have === want) return { id: 'opencode', action: 'none', file }
  if (have !== null && !isOurs(have)) return { id: 'opencode', action: 'manual', file, reason: `${tilde(file, ctx)} is a plugin of someone else's, so autochat won't replace it`, snippet: want }
  return {
    id: 'opencode',
    action: have === null ? 'add' : 'update',
    file,
    entries: [`a plugin that runs ${shq(ctx.node)} ${shq(ctx.bin)} hook --harness opencode <event>`],
    write: () => writeOwn(file, want)
  }
}

// Only our plugin goes; the directories it's in, and everything else in them, stay.
function uncomputeHooks (ctx) {
  const files = candidates(ctx).filter(f => isOurs(readText(f)))
  if (!files.length) return { id: 'opencode', action: 'none', file: pluginFile(ctx) }
  return {
    id: 'opencode',
    action: 'remove',
    file: files[0],
    entries: files.map(f => tilde(f, ctx)),
    write: () => { for (const f of files) fs.rmSync(f, { force: true }) }
  }
}

function hookStatus (ctx) {
  const file = pluginFile(ctx)
  const text = readText(file)
  const installed = isOurs(text)
  const paths = installed ? embedded(text) : []
  // valid: the node and autochat.js the plugin runs still exist.
  return { installed, file, valid: !installed || (paths.length === 2 && paths.every(exists)) }
}

// --- events -----------------------------------------------------------------------------------------

const str = (v) => typeof v === 'string' ? v : ''

/**
 * The opencode command a plugin runs under, from its process.argv (without the executable): the
 * first argument that isn't an option (`run`, `serve`, `github`, …), or 'tui' for the TUI's worker
 * and for opencode with no command or a path to open. null when the payload doesn't say.
 */
export function command (argv) {
  if (!Array.isArray(argv) || typeof argv[0] !== 'string') return null
  if (/[/\\]tui[/\\]worker\.[cm]?[jt]s$/.test(argv[0])) return 'tui'
  for (let i = 1; i < argv.length; i++) {
    const a = String(argv[i])
    if (a === '--log-level') { i++; continue }
    if (!a.startsWith('-')) return /^[a-z][a-z-]*$/.test(a) ? a : 'tui'
  }
  return 'tui'
}

/**
 * Nobody attends the session: this is `opencode run` (or `opencode github`), or a server running a
 * session that denies the question tool, as theirs do (`run --attach`). Someone's at the TUI, or
 * in an editor over ACP, even in a session that run created: it keeps those rules for good. null
 * when the payload doesn't say.
 */
export function headless (p) {
  const cmd = command(p?.argv)
  if (cmd === 'run' || cmd === 'github') return true
  if (cmd === 'tui' || cmd === 'acp') return false
  const rules = Array.isArray(p?.session?.permission) ? p.session.permission : []
  if (rules.some(r => isObj(r) && r.permission === 'question' && r.pattern === '*' && r.action === 'deny')) return true
  return cmd === null ? null : false
}

function describePermission (p) {
  const patterns = Array.isArray(p.patterns) ? p.patterns.filter(x => typeof x === 'string') : []
  const what = str(p.permission) || 'a tool'
  return sanitize(patterns.length ? `${what}: ${patterns.join(', ')}` : what, 600)
}

function describeQuestions (questions) {
  const qs = Array.isArray(questions) ? questions.filter(isObj) : []
  return sanitize(qs.map((q) => {
    const choices = Array.isArray(q.options) ? q.options.map(o => isObj(o) ? str(o.label) : str(o)).filter(Boolean) : []
    return str(q.question) + (choices.length ? ` [${choices.join(' / ')}]` : '')
  }).filter(Boolean).join(' · '), 600)
}

function editedFiles (tool, args, cwd) {
  if (!EDIT_TOOLS.has(tool) || !isObj(args) || !str(args.filePath)) return undefined
  return [sanitize(cwd ? path.resolve(cwd, args.filePath) : args.filePath, 300)]
}

/** What the plugin forwards (`{event, sessionID, session, agent, argv, directory, …}`) as a SessionEvent. */
export function normalize (event, p, env) {
  if (!isObj(p) || !isValidSessionId(p.sessionID)) return null
  const name = str(p.event) || event
  const props = isObj(p.properties) ? p.properties : {}
  const cwd = str(p.session?.directory) || str(p.directory)
  const ev = {
    harness: 'opencode',
    sid: p.sessionID,
    kind: 'notice',
    // The agent is opencode's mode: build, plan, or one of your own.
    mode: str(p.agent) || null,
    headless: headless(p),
    cwd: cwd ? sanitize(cwd, 300) : undefined,
    origin: originFrom(env),
    // When it happened: the plugin's events can reach the core out of order.
    at: Number.isFinite(p.at) && p.at > 0 ? p.at : undefined,
    // The opencode process: Ctrl+C kills it without a word.
    pid: Number.isInteger(p.pid) && p.pid > 0 ? p.pid : undefined
  }
  switch (name) {
    case 'session.created':
      ev.kind = 'start'
      break
    case 'chat.message':
      ev.kind = 'activity'
      break
    case 'tool.execute.before':
      ev.kind = 'activity'
      ev.files = editedFiles(props.tool, props.args, cwd)
      break
    case 'permission.asked':
      ev.kind = 'request'
      ev.request = { title: 'Permission needed', message: describePermission(props) }
      break
    case 'question.asked':
      ev.kind = 'request'
      ev.request = { title: 'opencode has a question for you', message: describeQuestions(props.questions) }
      break
    case 'permission.replied':
    case 'question.replied':
    case 'question.rejected':
      ev.kind = 'activity'
      break
    case 'session.idle':
      ev.kind = 'idle'
      if (str(p.summary)) ev.summary = sanitize(p.summary, 2000)
      break
    case 'server.instance.disposed':
      ev.kind = 'end'
      ev.reason = 'exit'
      if (str(p.summary)) ev.summary = sanitize(p.summary, 2000)
      break
  }
  if (!ev.files) delete ev.files
  if (!ev.at) delete ev.at
  if (!ev.pid) delete ev.pid
  return ev
}

// The agent in the trigger list, or headless. When the payload doesn't say whether anyone's
// there, an agent that doesn't count by itself leaves it unknown.
function autonomy (payload, session) {
  const a = byTrigger(modesOf(session), session.trigger)
  const headlessCounts = Array.isArray(session.trigger) && session.trigger.includes('headless')
  return a === 'interactive' && session.headless === null && headlessCounts ? 'unknown' : a
}

// --- MCP registration and the etiquette ---------------------------------------------------------------

// opencode's config schema says MCP requests time out after 5 s by default, but 1.2.6 never uses
// that: without `timeout`, connecting and listing tools time out after 30 s, and tool calls after
// the MCP SDK's 60 s. `timeout` sets all of them. `wait` blocks for up to 50 s, so anything under
// that would cut it short; 60 s is the SDK's default, written out.
const OPENCODE_TIMEOUT_MS = 60000
const SCHEMA = 'https://opencode.ai/config.json'

// opencode 1.2.6 never passes MCP server instructions on to the model: it never asks the server
// for them. It does put the files its config lists under `instructions` into the system prompt
// ("Instructions from: <path>"), the global config's and the project's alike. So setup --agents
// writes the room's etiquette, with opencode's names for the tools (autochat_catch_up, …), to a
// file of its own next to opencode.json, and lists it there by its absolute path: opencode globs an
// absolute entry's file name in its directory, and resolves a relative one from the project.
export const ETIQUETTE = 'autochat.md'
const ETIQUETTE_HEAD = "<!-- autochat's etiquette for opencode"
export const etiquetteFile = (ctx) => path.join(configDir(ctx), ETIQUETTE)
const isEtiquette = (text) => typeof text === 'string' && text.startsWith(ETIQUETTE_HEAD)

/** The etiquette file: the instructions `autochat mcp` serves, with opencode's tool names. */
export function etiquetteSource () {
  return `${ETIQUETTE_HEAD}: \`autochat setup --agents\` writes this file, and \`autochat uninstall\` removes it. -->
## autochat agent room
${instructions((tool) => `${SERVER}_${tool}`)}
`
}

// An `instructions` entry that names our file (opencode expands a leading `~/`).
function lists (entry, file, ctx) {
  if (typeof entry !== 'string') return false
  const p = entry.startsWith('~/') ? path.join(ctx.home, entry.slice(2)) : entry
  return path.isAbsolute(p) && path.resolve(p) === path.resolve(file)
}

// MCP servers go in ~/.config/opencode/opencode.json(c), keyed by name under `mcp`: what opencode
// 1.x reads, and newer versions still accept.
function configFile (ctx) {
  const dir = configDir(ctx)
  const jsonc = path.join(dir, 'opencode.jsonc')
  return !exists(path.join(dir, 'opencode.json')) && exists(jsonc) ? jsonc : path.join(dir, 'opencode.json')
}
const serverEntry = (ctx) => ({ type: 'local', command: [ctx.node, ...argsFor('opencode', ctx)], enabled: true, timeout: OPENCODE_TIMEOUT_MS })

// readJson(), plus `config`: what opencode reads in the file, which may have comments and trailing
// commas that autochat won't rewrite (undefined when it isn't even that).
function readConfig (file) {
  const r = readJson(file)
  if (r.root !== undefined) return { ...r, config: r.root }
  try {
    const config = parseJsonc(r.text)
    return { ...r, config: isObj(config) ? config : undefined }
  } catch {
    return { ...r, config: undefined }
  }
}

// An entry that's autochat's alone: our server under `mcp`, our file in `instructions`, or the
// $schema autochat writes into a config it makes. A config of nothing else is one autochat made.
function autochats (key, value, notes, ctx) {
  if (key === '$schema') return value === SCHEMA
  if (key === 'mcp') return isObj(value) && Object.keys(value).length > 0 && Object.keys(value).every(k => k === SERVER)
  if (key === 'instructions') return Array.isArray(value) && value.length > 0 && value.every(e => lists(e, notes, ctx))
  return false
}
const autochatMade = (root, notes, ctx) => isObj(root) && (isObj(root.mcp) || Array.isArray(root.instructions)) && Object.entries(root).every(([k, v]) => autochats(k, v, notes, ctx))

// opencode.json is edited as text (json-edit.js), so everything but our two entries stays
// byte-for-byte: the server under `mcp`, and the etiquette file at the end of `instructions`.
function computeMcp (ctx) {
  const file = configFile(ctx)
  const notes = etiquetteFile(ctx)
  const { text, root, config } = readConfig(file)
  const want = serverEntry(ctx)
  const etiquette = etiquetteSource()
  const had = readText(notes)
  const manual = (reason, after) => ({ id: 'opencode', action: 'manual', file, reason, snippet: { mcp: { [SERVER]: want }, instructions: [notes] }, ...(after && { after }) })
  if (had !== null && !isEtiquette(had)) return manual(`${tilde(notes, ctx)} isn't autochat's, so autochat won't overwrite it (move it aside and rerun)`)
  if (config?.mcp !== undefined && !isObj(config.mcp)) return manual(`"mcp" in ${tilde(file, ctx)} isn't an object`)
  if (config?.instructions !== undefined && !Array.isArray(config.instructions)) return manual(`"instructions" in ${tilde(file, ctx)} isn't a list`)
  const have = config?.mcp?.[SERVER]
  // Settings the user added to our entry stay.
  const merged = isObj(have) ? { ...have, ...want } : want
  const registered = isObj(have) && same(merged, have)
  const listed = !!config?.instructions?.some(e => lists(e, notes, ctx))
  const current = had === etiquette
  if (registered && listed && current) return { id: 'opencode', action: 'none', file }
  // A config with comments isn't rewritten. Once the user has added both entries to it, the
  // etiquette file is all that's left to write.
  if (root === undefined && !(registered && listed)) return manual(`${tilde(file, ctx)} isn't plain JSON (comments?), so autochat won't rewrite it`, `Then rerun autochat setup --agents, which writes ${tilde(notes, ctx)}.`)
  let next = text
  if (root === null) {
    next = JSON.stringify({ $schema: SCHEMA, mcp: { [SERVER]: want }, instructions: [notes] }, null, 2) + '\n'
  } else if (root) {
    if (!registered) next = jsonSet(next, ['mcp', SERVER], merged)
    if (!listed) next = jsonPush(next, ['instructions'], notes)
  }
  const entry = [
    !registered && `"${SERVER}": ${JSON.stringify(want)}`,
    !listed && `"instructions": [${config?.instructions?.length ? '…, ' : ''}${JSON.stringify(tilde(notes, ctx))}]`,
    !current && `${tilde(notes, ctx)}: the agent-room etiquette (opencode doesn't show MCP server instructions to the model)`
  ].filter(Boolean).join('\n')
  return {
    id: 'opencode',
    action: have !== undefined || listed || had !== null ? 'update' : 'add',
    file,
    entry,
    write: () => {
      // The file first: opencode may read the config at any moment.
      if (!current) writeOwn(notes, etiquette)
      // The backup keeps the user's config: one autochat made has nothing of theirs.
      if (next !== text) writeFileSafely(file, next, { backup: !autochatMade(root, notes, ctx) })
    }
  }
}

// Our two entries go, and the etiquette file if it's ours. So does an `mcp` or `instructions` they
// leave empty, unless the file had it before autochat first wrote to it (its .autochat.bak), and so
// does opencode.json itself when autochat made it and nothing else is left.
function uncomputeMcp (ctx) {
  const file = configFile(ctx)
  const notes = etiquetteFile(ctx)
  const { text, root, config } = readConfig(file)
  const ours = isEtiquette(readText(notes))
  const backup = readJson(file + '.autochat.bak')
  // A backup holding nothing but autochat's entries was taken after autochat made the file.
  const userHad = (key) => isObj(backup.root) && Object.hasOwn(backup.root, key) && !autochats(key, backup.root[key], notes, ctx)
  const prune = (keys) => !userHad(keys[0])
  let next = text
  if (root) {
    if (isObj(root.mcp) && Object.hasOwn(root.mcp, SERVER)) next = jsonDelete(next, ['mcp', SERVER], { prune })
    const entries = Array.isArray(root.instructions) ? root.instructions : []
    for (let i = entries.length - 1; i >= 0; i--) if (lists(entries[i], notes, ctx)) next = jsonPull(next, ['instructions'], i, { prune })
  }
  const edited = next !== text
  // Our entries in a config with comments: the user added them, and takes them out.
  const byHand = root === undefined && (config?.mcp?.[SERVER] !== undefined || !!config?.instructions?.some?.(e => lists(e, notes, ctx)))
  const note = byHand ? `${tilde(file, ctx)} isn't plain JSON, so take autochat's entries out of it yourself` : undefined
  if (!edited && !ours) return note ? { id: 'opencode', action: 'manual', file, reason: note } : { id: 'opencode', action: 'none', file }
  const made = backup.text === null || autochatMade(backup.root, notes, ctx)
  const leftover = edited && made && Object.entries(JSON.parse(next)).every(([k, v]) => k === '$schema' && v === SCHEMA)
  return {
    id: 'opencode',
    action: 'remove',
    file: edited ? file : notes,
    what: edited && ours ? "the autochat MCP server and autochat's etiquette" : ours ? "autochat's etiquette" : undefined,
    also: edited && ours ? [notes] : [],
    ...(note && { note }),
    write: () => {
      if (leftover) fs.rmSync(file, { force: true })
      // No backup now: one taken here would hold our entries, not what the file had before them.
      else if (edited) writeFileSafely(file, next, { backup: false })
      if (ours) fs.rmSync(notes, { force: true })
    }
  }
}

// How the etiquette reaches the model, for doctor.
function etiquetteStatus (ctx, config) {
  const notes = etiquetteFile(ctx)
  const text = readText(notes)
  const where = tilde(notes, ctx)
  if (!config.instructions?.some?.(e => lists(e, notes, ctx))) {
    return { shown: false, note: 'opencode doesn\'t show MCP server instructions to the model, and autochat\'s etiquette isn\'t listed under "instructions", so opencode agents get the tool descriptions alone (run autochat setup --agents)' }
  }
  if (text === null) return { shown: false, file: notes, note: `${where} is listed under "instructions", but missing (run autochat setup --agents)` }
  if (!isEtiquette(text)) return { shown: false, file: notes, note: `${where} is listed under "instructions", but isn't autochat's etiquette (move it aside, then run autochat setup --agents)` }
  if (text !== etiquetteSource()) return { shown: false, file: notes, note: `${where} holds an older etiquette (run autochat setup --agents)` }
  return { shown: true, file: notes, note: `the etiquette reaches the model from ${where}, listed under "instructions" (opencode doesn't show MCP server instructions)` }
}

const mcp = {
  file: configFile,
  where: (ctx) => tilde(configFile(ctx), ctx),
  status (ctx) {
    const { config } = readConfig(configFile(ctx))
    const have = isObj(config?.mcp) ? config.mcp[SERVER] : null
    if (!isObj(have)) return { registered: false }
    const [command, ...args] = Array.isArray(have.command) ? have.command : [have.command]
    return { registered: true, valid: commandValid(command, args), command: [command, ...args].join(' '), etiquette: etiquetteStatus(ctx, config) }
  },
  plan: (ctx) => planned(computeMcp, ctx),
  unplan: (ctx) => planned(uncomputeMcp, ctx)
}

export default {
  id: 'opencode',
  name: 'opencode',
  modes: ['build', 'plan', 'headless'],
  trigger: ['headless'],
  detect: (ctx) => ({ ...detectBy('opencode', mcp.file)(ctx), paths: { config: mcp.file(ctx), plugin: pluginFile(ctx), etiquette: etiquetteFile(ctx) } }),
  hooksNote: "New opencode processes load the plugin; ones already running (a TUI, opencode serve) don't until they restart.",
  planHooks: (ctx) => planned(computeHooks, ctx),
  unplanHooks: (ctx) => planned(uncomputeHooks, ctx),
  hookStatus,
  normalize,
  autonomy,
  focus: focusOrigin,
  mcp
}
