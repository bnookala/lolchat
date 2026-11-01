# Harness adapters

autochat follows coding agents ("harnesses": Copilot CLI, Claude Code, Codex, opencode, pi, Gemini
CLI, …) through one **adapter** per harness, in `src/harness/<id>.js`. An adapter owns everything
autochat knows about its harness: where it's installed, its hooks, how its hook payloads read, which
of its modes count as working on its own, an optional fallback watcher, terminal focus, and
registering `autochat mcp` for the [agent room](agents.md). The rest of autochat only ever sees
`SessionEvent`s.

```
harness ──hook──▶ autochat hook --harness <id> <event> ──▶ adapter.normalize() + autonomy()
                                                              │ SessionEvent, sent as a hook message
                                                              ▼
                     unix socket (or the spool while the core starts) ──▶ Controller
adapter.observe() ── fallback: sessions without hooks ─────────────────▶ controller.adopt(live, id)
adapter.follow(sid) ── the harness's own session log, for what no hook reports ─▲
process scan (ps) ── which agents run at all: a hint, never a session ──▶ snapshots (detected), doctor
```

The Controller keys sessions by `${harness}:${sid}` and puts you in the lounge while at least one of
them works **autonomously**: without you taking turns. See [the autonomy rule](#autonomy-and-autochat-config-trigger).

## The adapter

`src/harness/index.js` lists the adapters (`ADAPTERS`, in the order setup shows them). Each module
exports one object:

| Member | Required | What it does |
| --- | --- | --- |
| `id`, `name` | yes | `claude`, `Claude Code`. The id is the `--harness` value and the session key prefix. |
| `modes` | yes | Every mode name `autochat config trigger <id>` accepts, including `headless` if the harness has non-interactive runs. |
| `trigger` | yes | The modes that count as autonomous by default. |
| `detect(ctx)` | yes | `{installed, binary, paths}`: is it installed (binary on the path, or its config dir exists), and the config files the adapter touches. Never spawns: [`versionOf(ctx, binary)`](../src/harness/util.js) is there when a version is needed. |
| `normalize(event, payload, env)` | yes | One hook call → a [`SessionEvent`](#sessionevent), or `null` when it names no session. Fills in `mode` and `headless`; leaves `autonomy` to `autonomy()`. Must never throw on odd input. |
| `autonomy(payload, session)` | yes | `'autonomous' \| 'interactive' \| 'unknown'`. `session` is the SessionEvent so far plus `env` and `trigger` (this harness's trigger list, or `'never'`). Most adapters use `defaultAutonomy`: `byTrigger(modesOf(session), session.trigger)`. |
| `planHooks(ctx)`, `unplanHooks(ctx)`, `hookStatus(ctx)` | for hooks | Install, remove, check the hooks. See [Hooks](#hooks). `hookStatus` returns `{installed, file}`, plus `partial`, `valid` (the node and autochat.js it runs exist) and `disabled` when it can tell. |
| `hooksNote` | no | What setup says after installing: when the harness starts running the new hooks. |
| `observe(ctx, emit)` | no | Fallback watcher for sessions that never call the hooks (started before setup, or no hooks at all). Calls `emit(live)` with **every** live session it sees, each time (`[{sid, running, mode, cwd, lastStart, scannedAt}]`), so the Controller can release the ones that are gone. Returns a stop function. `ctx` is `{idleMs, trigger(id), intervalMs}`. |
| `follow(sid)` | no | The harness's own session log, for what no hook reports. An EventEmitter like Copilot's `SessionLog`: `start({since})`, `poll()`, `stop()`, and events `mode`, `task-complete`, `abort`, `shutdown`, `activity`. |
| `continues(session)` | no | After `idle`, true keeps the session in the room a while longer (Copilot: an active autopilot objective). |
| `focus(origin)` | no | Put focus back on the agent's terminal. Default: `focusOrigin` (tmux pane, else the terminal app). |
| `mcp` | yes | `where`, `status`, `plan`, `unplan`: registering `autochat mcp` (`autochat setup --agents`). `jsonServer()` in `mcp-config.js` covers harnesses with a JSON config file. `status` may add `etiquette: {shown, note}` for doctor, where the room's etiquette doesn't simply reach the model as the server's instructions (Copilot CLI, opencode). |
| `doorbell` | no | `{event, skip(payload), pid(env), output(text)}`: the hook event that rings the agent room's [doorbell](#the-doorbell), the tool calls it doesn't ring after, the harness's pid when the hook's environment has it, and the line in the harness's output format. |

`ctx` is `harnessContext()` from `src/harness/util.js`: `env`, `home`, `node`, `bin` (the absolute
paths hooks run), `copilotHome`, `claudeHome` (`$CLAUDE_CONFIG_DIR`), `configHome`
(`$XDG_CONFIG_HOME`), `codexHome`, `which(name)` (honours `AUTOCHAT_HARNESS_PATH`), and `run(cmd,
args)`. Tests pass their own.

## SessionEvent

```js
{ harness, sid, kind, autonomy, mode, headless, cwd, repo, branch, origin, request, summary, reason, stopped, files, at, pid }
```

| Field | Meaning |
| --- | --- |
| `harness`, `sid` | adapter id and the harness's session id (`[A-Za-z0-9_-]{1,128}`) |
| `kind` | see below |
| `autonomy` | `autonomous`, `interactive` or `unknown` |
| `mode` | the harness's own name for its current mode (`autopilot`, `auto`, `acceptEdits`, …), or null |
| `headless` | true for a non-interactive run (`claude -p`, `codex exec`, …), false when someone's there, null when the harness doesn't say |
| `cwd`, `repo`, `branch` | where it works (repo and branch are optional) |
| `origin` | `originFrom(env)`: `{tmux, tmuxPane, termProgram, bundleId}` from the hook's environment, for focus |
| `request` | `{title, message}` for `kind: 'request'` |
| `summary` | what it did, for `complete` (and optionally `idle` and `end`: its last message); what went wrong, for `failed` |
| `reason` | why it ended, for `end`; what kind of error, for `failed` (say `rate_limit`) |
| `stopped` | for `failed`: true when the error ended its turn |
| `files` | paths a tool call edits, when the payload says |
| `at` | when it happened (ms), from harnesses whose events can reach the core out of order (opencode's plugin runs a process per event). The Controller drops one older than the last it saw for that session, finished or not |
| `pid` | the harness process the session lives in, from harnesses that can die without a word (opencode on Ctrl+C). The Controller ends a tracked session (reason `end`) once that process is gone |

| `kind` | Meaning | What the Controller does |
| --- | --- | --- |
| `start` | the session started; nothing to do yet | nothing (it doesn't start tracking) |
| `activity` | it's working: a prompt went in, a tool runs | tracks it while autonomous; `running`. Its attention item is handled |
| `request` | it's blocked on you: an approval or an answer | `needed`: the request card, `!` in the room, a `blocked` attention item |
| `waiting` | it finished its turn and waits at its prompt | done now (`idle`); a `finished` item |
| `idle` | its turn ended; it may carry on by itself | done after `idleMs` without activity, unless `continues()`; then a `finished` item |
| `complete` | it says it's done | done, with `summary`; a `finished` item |
| `failed` | it hit an error: `stopped` when it ended its turn (Claude's `StopFailure`), otherwise it carries on (a refused tool call, `PermissionDenied`) | a `failed` item. `stopped`: done (reason `failed`). Otherwise still `running`, and its activity doesn't clear the item |
| `end` | the session or its process ended | done, with `summary` if it has one; a `finished` item |
| `notice` | a hook fired and nothing changed | refreshes `cwd` and `origin` |

When a tracked session's `activity`, `request`, `idle`, `waiting` or `failed` says
`autonomy: 'interactive'` (you switched modes), it's done right away (reason `mode`), and its
attention item goes: you took over. `unknown` neither starts nor stops anything. The attention
items are the queue in lounge snapshots ([protocol.md](protocol.md#attention-queue)); Copilot's
abort (from its session log) is a `failed` one too.

## Autonomy and `autochat config trigger`

You're in the lounge only while an agent works **without you taking turns**. Chatting with an agent
never counts, however long a turn runs. Approval-bypass modes (`yolo`, `bypassPermissions`,
`acceptEdits`) are about permissions, not about you being away, so they don't count by default.
**Join now** (the menu bar, or `autochat ui --now`) is the manual switch.

The rule (`byTrigger` in `src/harness/event.js`): a session counts as autonomous when one of its
modes, `mode` plus `headless` for non-interactive runs, is in its harness's trigger list. It's
interactive when its mode is known and isn't, and unknown when nothing says.

| Harness | Counts by default |
| --- | --- |
| Copilot CLI | `autopilot` |
| Claude Code | `auto`, `headless` (`claude -p`) |
| Gemini CLI, Codex, opencode, pi | `headless` (`gemini -p`, `codex exec`, `opencode run`, `pi -p`) |

```sh
autochat config trigger                         # every harness's list
autochat config trigger copilot                 # ["autopilot"]
autochat config trigger copilot autopilot,plan  # plan mode counts too
autochat config trigger claude never            # Claude Code never puts you in the lounge
autochat config trigger claude default          # back to the default
```

Overrides live in `config.json` as `trigger: {<id>: [modes] | "never"}`. Hooks read the config on
every call, and so does the core when it decides from a mode alone (session logs, the fallback
observers, hook messages from older versions).

## Hooks

**The hook command** is `'<node>' '<autochat.js>' hook --harness <id> <Event> || true`, with the
absolute paths of node and `bin/autochat.js`, so nvm and `PATH` don't matter. It always exits 0
and prints nothing, except the [doorbell](#the-doorbell)'s line on its harness's doorbell event:
some harnesses block a tool call on a failing hook, or read a hook's stdout as instructions.
`autochat hook <event>` without `--harness` means Copilot: that's what every
install from before adapters runs, and what Copilot's hooks still say.

**Installing** (`planHooks(ctx)`) returns a plan, `{id, action, file, entries, apply}` with action
`add`, `update`, `none` or `manual`. Build it with `planned(compute, ctx)` from `util.js`, so
`apply()` recomputes it from the file as it is when applied (setup may show a plan, then wait on
a prompt). Rules:

- **Merge, never replace.** Users have their own hooks on the same events. Append ours, keep every
  other entry and the file's formatting (`readJson`/`writeJson` keep the indentation and the final
  newline), and write with `writeFileSafely` (atomic, a one-time `<file>.autochat.bak`, symlinks
  written through).
- **Reruns are no-ops**, and a moved install updates our entries in place.
- **Uninstall removes only ours**, recognised by the command (`autochat.js' hook --harness <id>`),
  and leaves the file byte-for-byte as it was before we added them.
- A file autochat can't parse (JSON with comments) gets `action: 'manual'` and the snippet to add.
- **Plugins.** A harness that runs in-process plugins instead of hook commands (opencode) gets a
  plugin of autochat's own that hands each event to the same hook command, so `normalize()` and
  the trigger rule still run in `autochat hook`. A file of our own: setup writes it whole when it
  changed, uninstall deletes it, and one by that name that isn't ours is never replaced. Its
  events are separate processes that can arrive out of order, so it stamps them with `at`.
- Test it: an existing config with other hooks must stay byte-for-byte unchanged apart from our
  entries, through install, rerun and uninstall.

**Commands:**

- `autochat setup` installs the hooks in `DEFAULT_HOOKS` (Copilot), then offers every other
  installed harness that has hooks, one prompt each (in a terminal; otherwise it prints the command).
- `autochat setup --harness claude,codex [--dry-run]` installs exactly those (`all`: every adapter
  with hooks), showing each change first.
- `autochat uninstall` runs every adapter's `unplanHooks()`, then removes the MCP registrations.
- `autochat doctor` shows `hookStatus()` per installed harness, and the trigger lists in effect.
  `hookStatus()` may add `disabledBy` (where the harness's hooks are switched off) and `note`
  (something doctor can't check, such as Codex's hook trust).

## The hook message

On the socket (and in the spool while a core starts) a SessionEvent travels as a one-shot `hook`
message (`hookMessage()`), in the shape every daemon has read, plus the new fields:

```json
{"type":"hook","event":"PreToolUse","sessionId":"5d0c…","harness":"claude","autonomy":"autonomous",
 "mode":"auto","cwd":"/Users/me/code/x","origin":{"tmuxPane":"%3"},"kind":"activity","ts":1730400000000}
```

`sessionId` is the session id, and `idle` travels as `stop`. `at`, when there is one, is when the
event happened (`ts` is when it was sent). Messages without `harness` (or
`autonomy`) are from before adapters: they're Copilot's, and the core decides autonomy from their
`mode`. Lounge snapshots list each session's `harness` (see [protocol.md](protocol.md#state)).

## The doorbell

An agent in the [agent room](agents.md) hears about new messages only when it calls an autochat
tool, and it doesn't call one while it edits: in the P0 trial, agents busy editing read their
messages 13–28 s late (#52). So after the agent's tool calls, its harness's hook (or plugin, or
extension) rings: it sends the daemon one `doorbell` message and puts the line it gets back into
the agent's context, wherever that harness lets a hook add context to a tool call.

```
{"type":"doorbell","harness":"claude","sessionId":"3e439e39-…","pid":28715}
→ {"ok":true,"text":"2 unread from copilot-greeter (overlap on src/greeting.js), use autochat read"}
```

- **Who's asking.** `sessionId` is the harness's session id, from the hook payload. `pid` is the
  harness process when the hook knows it (Claude Code's `CLAUDE_PID`; opencode's plugin and pi's
  extension run inside the harness), else the process that ran the hook: the shell the harness
  runs hooks in, whose parent is the harness. The daemon finds the agent whose `agent-hello` has
  that `sessionId`, else that `harnessPid` (each harness below says which one matches).
- **The daemon decides** what's worth a ring and how often; `text` is `null` when there's
  nothing to say. The hook passes the text on as one line of at most 500 characters, without
  escape sequences, control characters or bidi overrides.
- **Silent unless it's a clear answer.** No daemon, a daemon that doesn't know the message
  (`ok: false`), no text, an empty one, garbage, or no answer within 150 ms: the hook prints
  nothing and exits 0, as it always has.
- **Cheap.** It rides on hooks that already run for every tool call: one more round trip on the
  daemon's socket, at the same time as the lounge's hook message. See [the cost](#what-it-costs).
- **Not while the agent reads the room.** A call to one of autochat's own tools (`read`, `wait`,
  …) never rings. Pausing the lounge (`autochat config launch off`) doesn't stop the doorbell: it's
  the agent room's.

| Harness | How the line gets to the model | Rings on | Checked |
| --- | --- | --- | --- |
| Copilot CLI | `{"additionalContext": …}` from the hook: a user message after the tool's result | `preToolUse` | live, 1.0.102 |
| Claude Code | `hookSpecificOutput.additionalContext`: right after the tool's result | `PostToolUse` | live, 2.1.273 |
| Codex | `hookSpecificOutput.additionalContext`: developer context | `PostToolUse` | Codex's docs |
| opencode | the plugin's `tool.execute.after` appends it to the tool's output | every tool call | live, 1.2.6 |
| pi | the extension's `tool_result` handler appends a text block to the result | every tool call | live, 0.74.0 |
| Gemini CLI | none: no autochat hooks yet | | |

**Checked live** means against the installed binary, in a throwaway `HOME` (and
`COPILOT_HOME`, `CLAUDE_CONFIG_DIR`, XDG dirs, `PI_CODING_AGENT_DIR`), with a local stand-in for
the model API that logs every request in full: first with a probe hook (or plugin, or extension)
that returns a marker, then with autochat's own, installed by `autochat setup`, and
`autochat mcp` as an MCP server, against a stand-in daemon that answers the doorbell. The line
showing up in the next request to the model is what the model reads.

**Installing.** No hook plan changes: each harness's doorbell event already runs for every tool
call. The code that rings is in `autochat hook`, in opencode's plugin and in pi's extension
module, so installed hooks ring as soon as autochat is updated (pi: in its next session, or after
`/reload`), except opencode's plugin, which is a copy: `autochat setup --harness opencode`
rewrites it, and opencode loads it when it next starts.

### What it costs

Measured on an Apple-silicon Mac with node 22, warm, 40 runs each: `autochat hook preToolUse` the
way Copilot CLI runs it (`bash -c "'<node>' '<autochat.js>' hook preToolUse || true"`, with the
payload on stdin), against a stand-in daemon that answers at once:

| | median | p90 |
| --- | --- | --- |
| before the doorbell (`main`), daemon running | 74.5 ms | 78.9 ms |
| before the doorbell (`main`), no daemon | 75.3 ms | 78.6 ms |
| with the doorbell, nothing to say | 74.3 ms | 77.8 ms |
| with the doorbell, a line to print | 74.6 ms | 79.3 ms |
| with the doorbell, no daemon | 74.1 ms | 78.7 ms |
| with the doorbell, a daemon that never answers it | 242.6 ms | 252.0 ms |
| one more hook process (what a `postToolUse` hook for every tool would add for Copilot) | 76.8 ms | 80.9 ms |

The doorbell's round trip overlaps the lounge's hook message, so it doesn't move the median;
almost all of a hook's time is starting node. A daemon that never answers costs the 150 ms
timeout, once per tool call. In-process, as opencode's plugin and pi's extension ring, the round
trip takes 0.11 ms (median of 300; p90 0.18 ms).

## Adding an adapter

1. **Verify the harness first.** Hook names, payload fields and mode names change between
   versions: check them against the installed version (load hooks from a temp settings file;
   never touch the user's real config), and record payloads as fixtures under
   `test/fixtures/<id>/`, with paths scrubbed.
2. Write `src/harness/<id>.js` and add it to `ADAPTERS` in `src/harness/index.js`.
3. `normalize()`: map each hook event to a kind (table above). Requests (permission prompts,
   questions to the user) are `request`; tool calls are `activity`; the end of a turn is `idle`.
4. Autonomy: set `mode` from the payload and `headless` from whatever reliably marks a
   non-interactive run (an env var the harness sets for its hooks, a payload field). If nothing
   does, leave it unknown. Fill in `modes` and `trigger`.
5. Hooks: `planHooks`, `unplanHooks`, `hookStatus`, following the rules above (or a plugin of
   our own that forwards to `autochat hook`, like opencode's).
6. Optional: `observe()` for sessions without hooks, `follow()`, `continues()`, `focus()`, and a
   `doorbell` when the harness lets a hook add context to a tool call (check where the line lands
   against a stand-in for its model API, as [above](#the-doorbell)).
7. Tests in temp homes only (`HOME`, `AUTOCHAT_HOME`, `COPILOT_HOME`, `CLAUDE_CONFIG_DIR`, …): the
   fixtures through `normalize()`, the autonomy rule, and install/rerun/uninstall around a config
   that already has other hooks.
8. Document it here and in the README.

## Harnesses

| Harness | Hooks | Autonomy signal | Fallback observer | MCP |
| --- | --- | --- | --- | --- |
| Copilot CLI | `$COPILOT_HOME/hooks/autochat.json` (a file of our own) | `autopilot`, from `session-state/<id>/events.jsonl` | the session-state scan | `mcp-config.json` |
| Claude Code | `$CLAUDE_CONFIG_DIR/settings.json`, merged ([below](#claude-code)) | `auto` (`permission_mode`); headless: `CLAUDE_CODE_SESSION_ATTENDED=0` | none needed: running sessions pick up new hooks, and `CLAUDE_PID` ends a session whose process is gone | `claude mcp add` |
| Gemini CLI | not yet | | | `~/.gemini/settings.json` |
| opencode | a plugin of our own, `$XDG_CONFIG_HOME/opencode/plugin/autochat.js` ([below](#opencode)) | headless: `opencode run` (the plugin's `process.argv`), or a server's session that denies the question tool (`run --attach`); never the TUI; the agent is the mode | none yet: opencode processes started before setup don't have the plugin | `opencode.json`, and the etiquette file under `instructions` |
| Codex | `$CODEX_HOME/hooks.json`, merged ([below](#codex)); Codex runs them once you trust them (`/hooks`) | `headless`: `codex exec`, from the session's rollout; `bypassPermissions` for approval policy `never` | none yet | `config.toml` |
| pi | `$PI_CODING_AGENT_DIR/extensions/autochat.ts`, an extension of our own ([below](#pi)) | `headless`: print and json mode (`ctx.hasUI` is false) | none: pi reports nothing without the extension | the same extension |

## Copilot CLI

`src/harness/copilot.js`. Its hooks are a file of our own, `$COPILOT_HOME/hooks/autochat.json`, and
the README has what the hooks report and what autochat learned about their payloads.

### Doorbell

**Verified live** against Copilot CLI 1.0.102: `copilot -p` with a custom provider (BYOK:
`COPILOT_PROVIDER_BASE_URL` pointing at a local stand-in for an OpenAI-compatible API), in a
throwaway `HOME` and `COPILOT_HOME` with a copy of the 1.0.102 package: a probe hook first, then
autochat's own hooks (`autochat setup --harness copilot`) and `autochat mcp`, against a stand-in
daemon.

- A command hook that prints `{"additionalContext": "…"}` for **`preToolUse`** gets it to the
  model as a user message right after that tool's result:
  `Additional context from preToolUse hook:\n…`. The docs' table for `preToolUse` output
  doesn't list `additionalContext` (the changelog does, from 1.0.24, and so do the SDK's types).
- For **`postToolUse`**, the same output is appended to the tool's result:
  `Tool "glob" succeeded. Additional guidance from postToolUse hooks:\n…`. That one is documented
  (joined across hooks, 10 KB at most), for MCP tools too.
- The doorbell rings on `preToolUse`, which our hooks already run for every tool. Our
  `postToolUse` only runs for `task_complete` (Copilot honours `postToolUse` matchers since 1.0.63);
  ringing there would take a `postToolUse` hook for every tool, which is one more `autochat hook`
  process per tool call ([the cost](#what-it-costs)), in every Copilot session with autochat's
  hooks, in the room or not. What `preToolUse` gives up: a message that arrives while a long tool
  runs (a test suite, say) rings at the next tool call, one call later than `postToolUse` would.
- It doesn't ring for autochat's own tools (`autochat-read`, …), or for `task_complete`, which ends
  an autopilot run: nothing after it is read.
- **Which agent.** The payload's `sessionId` is the id Copilot gives its MCP servers as
  `COPILOT_AGENT_SESSION_ID` (verified), which `autochat mcp` sends in its hello. `pid` is the
  hook's parent, `bash`, whose parent is the Copilot process, the hello's `harnessPid`.

## Claude Code

`src/harness/claude.js`, verified live against Claude Code 2.1.273, logged in with a claude.ai
subscription. The fixtures in `test/fixtures/claude/` are payloads recorded from those sessions,
with the hooks loaded from a temp file (`--settings <file> --setting-sources project,local`,
`--strict-mcp-config`): `claude -p` in every permission mode, auto mode's classifier refusing a
call, an API error, and sessions in a terminal (driven through a pseudo-terminal). Two are from
an earlier check of the same binary against a local stand-in for the Messages API:
`background.json` (`claude --bg`) and `headless-accept-edits.json`.

**Hooks** go in the user settings, `$CLAUDE_CONFIG_DIR/settings.json` (`~/.claude/settings.json`):
one matcher group of ours per event, appended after the user's own, each running
`… hook --harness claude <Event> || true` with a 10 s timeout. `Notification` only matches
`permission_prompt|idle_prompt|elicitation_dialog`. Claude Code picks up changes to that file in
running sessions too, so there's no fallback observer. It skips hook events it doesn't know and
runs the rest. Hooks don't run under `--bare`, or with `disableAllHooks` (doctor says so). Each
call takes about 80 ms, 50 of them starting node, and a tool call waits for two (`PreToolUse`,
`PostToolUse`).

| Event | Kind | Notes |
| --- | --- | --- |
| `SessionStart` | `start` | `source` (`startup`, `clear`, …), and `model` in a terminal; no `permission_mode` |
| `UserPromptSubmit` | `activity` | |
| `PreToolUse` | `activity`; `request` for `AskUserQuestion` | `files` for Write, Edit, MultiEdit, NotebookEdit |
| `PostToolUse` | `activity` | `files` as above. A tool call that fails sends `PostToolUseFailure` instead, which autochat doesn't need |
| `PermissionRequest` | `request` | fires whenever a dialog would ask, `AskUserQuestion` too. In `claude -p` nobody answers it: the call is denied right away, and the item goes when the agent carries on or the run ends |
| `PermissionDenied` | `failed` | only in auto mode, when its classifier refuses a call; the agent carries on. `reason` `permission_denied`, summary `Auto mode refused Bash: …` |
| `Notification` | `request` (`permission_prompt`, `elicitation_dialog`), `waiting` (`idle_prompt`) | no `permission_mode`. `permission_prompt` comes about 6 s after the PermissionRequest with only "Claude needs your permission", so the request keeps the PermissionRequest's text. `idle_prompt` comes a minute after `Stop` |
| `Stop` | `idle` | `last_assistant_message` becomes the summary |
| `StopFailure` | `failed`, `stopped` | an API error ended the turn. `reason` is its `error` (`rate_limit`, `overloaded`, `model_not_found`, …), the summary the message Claude Code showed. No `permission_mode` |
| `SessionEnd` | `end` | `reason`: `prompt_input_exit` (/exit, Ctrl+C twice), `clear` (/clear: a `SessionStart` with a new session id follows), `other` (the end of `-p`, SIGTERM, SIGHUP), `resume`, `logout` |

Every hook's environment has `CLAUDE_PID`, the Claude Code process, which autochat sends as `pid`:
the session ends once that process is gone, `SessionEnd` or not. `claude -p` stopped by an API
error kills the `StopFailure` hook on its way out and may exit without a `SessionEnd`, and a
killed process sends nothing at all.

**Autonomy.** `permission_mode` is in the payloads of `UserPromptSubmit`, `PreToolUse`,
`PostToolUse`, `PermissionRequest`, `PermissionDenied` and `Stop`. `--permission-mode` takes
`manual`, `acceptEdits`, `plan`, `auto`, `dontAsk` and `bypassPermissions`, and `default` still
works for `manual`. Manual mode arrives as `default`, which autochat calls `manual`; the others
arrive by their names. For headless, Claude Code sets `CLAUDE_CODE_SESSION_ATTENDED` in its
hooks' environment: `0` for `claude -p` and `claude --bg` sessions, `1` in a terminal. A `--bg`
session you attach to still says `0`. `CLAUDE_CODE_ENTRYPOINT` (`sdk-cli` for `-p`, `cli`
otherwise, `--bg` included) is the fallback for versions without it. When neither is there, a
mode that doesn't count by itself leaves the session `unknown`. By default `auto` and `headless`
count: `claude -p`, or auto mode in a terminal, puts you in the lounge, and manual mode in a
terminal doesn't.

### Doorbell

**Verified live** against Claude Code 2.1.273: `claude -p` against the local stand-in for the
Messages API, in a throwaway `HOME` and `CLAUDE_CONFIG_DIR`: a probe hook from a temp `--settings`
file first, then autochat's own hooks (`autochat setup --harness claude`) and `autochat mcp`,
against a stand-in daemon.

- A `PostToolUse` hook that prints
  `{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"…"}}` gets it to the
  model right after the tool's result, as `PostToolUse:<tool> hook additional context: …`.
  `PreToolUse`'s `additionalContext` lands in the same place. Plain text on stdout doesn't reach
  the model.
- The doorbell rings on `PostToolUse`, which our hooks already run for every tool, so it costs one
  round trip. It doesn't ring for autochat's own tools (`mcp__autochat__…`).
- **Which agent.** The payload's `session_id` is the id Claude Code gives its MCP servers as
  `CLAUDE_CODE_SESSION_ID` (verified), which `autochat mcp` sends in its hello. Hooks get
  `CLAUDE_PID`, the Claude Code process (verified), which is also the hello's `harnessPid`: that's
  the doorbell's `pid`.

## pi

`src/harness/pi.js`, verified against pi 0.74.0 (`@earendil-works/pi-coding-agent`). pi has no hooks
and no MCP: it has TypeScript extensions, which it loads with jiti from
`$PI_CODING_AGENT_DIR/extensions/` (`~/.pi/agent/extensions/`), and `pi -e <file>` for one run. So
autochat ships one, `src/harness/pi-extension.js`, and setup writes a small stub that loads it,
`extensions/autochat.ts`, a file of autochat's own:

```ts
const AUTOCHAT = {"node":"/…/node","bin":"/…/bin/autochat.js","module":"/…/src/harness/pi-extension.js","lounge":true,"room":true}
export default async function autochat (pi: any) { … await import(AUTOCHAT.module) … register(pi, AUTOCHAT) }
```

The stub has two switches. `lounge` (`autochat setup --harness pi`, which doctor and uninstall
treat as pi's hooks) forwards pi's lifecycle events; `room` (`autochat setup --agents`) registers the
agent-room tools ([agents.md](agents.md#pi)). Each install turns its switch on and points the stub at
this install; uninstall turns its switch off, and the file goes when both are off. Setup never
touches any other extension, pi's `settings.json`, or an `autochat.ts` that isn't autochat's (it
prints the stub instead). pi loads extensions when a session starts: running sessions pick it up on
`/reload`. Runs started with `--no-extensions` don't load it.

**Events.** The extension sends each of these to `autochat hook --harness pi <event>`, with a JSON
payload on stdin: `hook_event_name`, `session_id` (pi's, a UUID), `cwd`, `mode`, `has_ui`, and per
event `reason`, `tool_name`, `files` or `last_assistant_message`. One hook runs at a time, in order;
activity events queued behind a running hook collapse into the newest. pi never waits for a hook,
except when it shuts a session down: then it waits up to 3 s for the rest.

| pi event | Kind | Notes |
| --- | --- | --- |
| `session_start` | `start` | `reason`: `startup`, `new`, `resume`, `fork`, `reload` |
| `agent_start` | `activity` | once per prompt |
| `tool_call` | `activity` | before each tool runs; `files` for `edit` and `write` |
| `agent_end` | `waiting` in the TUI, `idle` otherwise | the last assistant text becomes the summary |
| `session_shutdown` | `end`; `notice` for `reload` | `reason`: `quit`, `new`, `resume`, `fork`, `reload` |

pi has no permission prompts and no tool that asks the user, so it never reports a `request`.

**Autonomy.** Extensions only see `ctx.hasUI`: false in print mode (`pi -p`, or a prompt on piped
stdin) and json mode (`--mode json`), true in the TUI and in rpc mode (`--mode rpc`). The extension
reports pi's own name for the mode, `print`, `json`, `interactive` or `rpc` (`--mode` tells print
from json and rpc from the TUI), and print and json runs are `headless`. By default only `headless`
counts. An rpc client may or may not have someone at it: `autochat config trigger pi rpc,headless`
counts those too.

**Verified** with `pi -e <stub>` in a throwaway `HOME` and `PI_CODING_AGENT_DIR`, against a local
stand-in for an OpenAI-compatible API (a custom provider in the throwaway `models.json`) and an
`autochat daemon` with its own `AUTOCHAT_HOME`: print, json and rpc runs, the TUI driven through a
pseudo-terminal, `/new` and `/reload`. The payloads are in `test/fixtures/pi/`.

### Doorbell

**Verified live** against pi 0.74.0: `pi -p` against the same stand-in, with a probe extension
first, then autochat's own (`autochat setup --agents`), against a stand-in daemon.

- An extension's `tool_result` handler can replace what a tool returns: returning
  `{content: [...event.content, {type: "text", text: "…"}]}` adds a text block the model reads
  after the tool's output.
- The extension's `room` part rings in-process, with no hook process: after every tool call but
  the agent room's own (`autochat_…`), while its agent is connected to the room. It waits 150 ms at
  most.
- **Which agent.** pi's session id and pi's own pid, the same two that the extension's hello
  carries (`sessionId`, `harnessPid`).
- Running sessions pick up the new code on `/reload`; the stub doesn't change.

## Codex

`src/harness/codex.js`, verified against Codex 0.166.0 on macOS. The fixtures in
`test/fixtures/codex/` are payloads recorded from the real binary by a capture hook next to
autochat's, in a throwaway `HOME` and `CODEX_HOME` with an `autochat daemon` of their own, against a
local stand-in for the Responses API (a custom `model_providers` entry, `wire_api = "responses"`, no
login): `codex exec` (plain, `--approve-for-me`, stopped with Ctrl+C, spawning a subagent) and the
TUI, driven through a pseudo-terminal, with its app-server daemon and with `--no-daemon`.

**Hooks** go in `$CODEX_HOME/hooks.json` (`~/.codex/hooks.json`): one matcher group of ours per
event, appended after the user's own, each running `… hook --harness codex <Event> || true`,
synchronously (`async` hooks may finish out of order, and Codex cancels them when a session ends).
No matcher, so every tool and every start source. The file is `{"description"?, "hooks": {…}}`: any
other top-level key and Codex drops the whole file (`unknown field`), so that's all autochat writes.
Installing rewrites the file in its own indentation (like every JSON config autochat edits);
uninstall puts back the exact bytes it found there (from the one-time backup) when your own hooks
haven't changed since, and otherwise removes only ours. A file of its own goes away again. autochat
never writes hooks into `config.toml` (an inline `[hooks]` there and a `hooks.json` both load, with a
warning to pick one). Codex reads the file when a session starts: running sessions keep the hooks
they started with.

Codex runs a hook as `<your account's shell> -c '<command>'`: the shell from the user database
(`/bin/zsh` on macOS), not `$SHELL`, and not a login shell, so zsh reads only `~/.zshenv`. It runs in
the session's directory, with the JSON on stdin, in Codex's environment (with Codex's own
directories first in `PATH`). The handlers of one event run at the same time. Exit 0 with nothing on
stdout is a success; plain text on stdout fails a `Stop` hook, is ignored after `PostToolUse`, and
becomes context after `UserPromptSubmit`. Hooks get 10 minutes, except `SessionEnd` and
`Interrupt`: 1 s unless they ask for more, and 3 s at most (more is cut to 3 s, with a warning).
autochat's get 10 s, and 3 s for those two. `codex exec` waits for its `SessionEnd` hooks before it
exits, and prints `hook: <Event>` and `hook: <Event> Completed` for each hook on stderr.

**Trust.** Codex runs a hook only once you've trusted its exact definition. The TUI asks as it starts
("Hooks need review": *Review hooks*, *Trust all and continue*, *Continue without trusting*), and
`/hooks` lists them (`t` trusts all). `codex exec` skips untrusted hooks without a word, so trust
them in the TUI once; `--dangerously-bypass-hook-trust` (`codex exec` and the TUI) runs them untrusted,
for that run, with a warning. Setup says so. Codex records trust in `config.toml`, one table per hook,
keyed by file, event and position (group, then handler):

```toml
[hooks.state."/Users/me/.codex/hooks.json:pre_tool_use:1:0"]
trusted_hash = "sha256:…"
```

`trusted_hash` is the sha256 of the hook as Codex normalizes it (the event, the group's matcher where
the event has one, the handler with its timeout and `async` filled in), as JSON with sorted keys. So
reruns change nothing and keep it; a moved install updates our entries where they are, but they need
trusting again ("modified"), and so does an entry of ours that a hook of yours pushed to another
position. `enabled = false` in its table is a hook you turned off in `/hooks`. `autochat doctor`
computes the hashes and says which of autochat's hooks Codex would skip. `hooks = false` under
`[features]` in `config.toml` (or its deprecated old name, `codex_hooks`) turns every hook off,
trusted or not (doctor says so).

| Event | Kind | Notes |
| --- | --- | --- |
| `SessionStart` | `start` | `source`: `startup`, `resume`, `clear`. Comes with the session's first prompt |
| `UserPromptSubmit` | `activity` | |
| `PreToolUse` | `activity`; `request` for `request_user_input` that Codex puts to you ([below](#when-codex-asks-you)) | `tool_name`: `Bash` for commands (`tool_input.command`), `apply_patch` (`tool_input.command` is the patch: `files` from its `*** Add/Update/Delete File:` and `Move to:` lines), `request_user_input` (`questions`, each with `options`), `spawn_agent`, … |
| `PermissionRequest` | `request` when Codex asks you, otherwise `activity` | the command and its `description` (the model's reason); no `tool_use_id`. Approve it and the tool runs (`PostToolUse`); turn it down and the turn is interrupted (`Interrupt`) |
| `PostToolUse` | `activity` | after an approved tool runs or a question is answered, this resolves the request; `tool_response` is text |
| `Stop` | `idle` | `last_assistant_message` becomes the summary |
| `Interrupt` | `waiting`; `end` for `codex exec` | Esc in the TUI (no `Stop` follows), or an approval turned down. Ctrl+C stops `codex exec`, which then exits (`SessionEnd` follows) |
| `SessionEnd` | `end` | `reason` is `other`; no `permission_mode`. [When](#the-tuis-daemon) |

Every payload has `session_id`, `transcript_path` (null with `--ephemeral`), `cwd` and
`hook_event_name`; all but `SessionEnd` have `model` and `permission_mode`, and all but
`SessionStart` and `SessionEnd` have `turn_id`. Codex 0.166.0 has more events, which autochat doesn't
install: `PreModelRequest` and `PostModelRequest` around every model request, `PreCompact`,
`PostCompact`, `SubagentStart` and `SubagentStop`.

### When Codex asks you

Not every `PermissionRequest` or `request_user_input` reaches you:

- `codex exec` never asks. It forces approval policy `never` (unless `--approve-for-me`, which hands
  approvals to its automatic reviewer) and turns `request_user_input` down.
- With the automatic reviewer on in the TUI too (`--approve-for-me`, or
  `approvals_reviewer = "auto_review"`), the reviewer answers approvals.
- `request_user_input` is for Plan mode: in Default mode Codex refuses it right after `PreToolUse`,
  unless `default_mode_request_user_input` is on under `[features]`.

So for those two, autochat looks at the turn's collaboration mode and reviewer in the rollout (the
`turn_context` line Codex writes as the turn starts, read back from the last 8 MB of the file), and
reports `activity` when nobody is asked. When it can't tell, it raises the request.

**Autonomy.** `permission_mode` is in every payload but `SessionEnd`, and Codex computes it from the
approval policy alone: `bypassPermissions` for `never` (`-a never`,
`--dangerously-bypass-approvals-and-sandbox`, and `codex exec`), `default` for `on-request`,
`on-failure` (which runs as `on-request`) and a granular policy. (`untrusted` is no longer accepted.)
That's about approvals, not about whether you're there, so it doesn't count by default
(`autochat config trigger codex bypassPermissions,headless` makes it). Nothing in a payload says
`codex exec`; its session's rollout (`transcript_path`) does. Its first line, written before
`SessionStart` runs, is the `session_meta`:

| Started as | `source` | `originator` |
| --- | --- | --- |
| `codex exec` | `exec` | `codex_exec` |
| `codex`, the TUI (through its app-server daemon, the default) | `vscode` | `codex-tui` |
| `codex --no-daemon` | `cli` | `codex-tui` |
| a subagent | `{"subagent": {"thread_spawn": {"parent_thread_id": …}}}` | its parent's |

`exec` is headless; `cli`, `vscode` (the default for app-server clients, which the TUI is through
its daemon) and `mcp` aren't. A subagent's hooks carry the parent's `session_id`, plus `agent_id`,
`agent_type` and its own rollout, which only says it's a subagent: autochat leaves them `unknown`, so
they keep the parent's session as it is and never start or end one. So is a run without a rollout
(`--ephemeral`). A session resumed the other way (`codex resume` of an exec session,
`codex exec resume` of a TUI one) keeps its first line. By default `headless` counts.

### The TUI's daemon

By default the TUI runs its sessions in a shared app-server daemon, which the first TUI starts (its
socket is under `$CODEX_HOME/app-server-control/`). Hooks run there, so:

- their environment is the daemon's, from the terminal that started it: the `origin` (tmux pane,
  terminal app) of every TUI session after it is that terminal's;
- `/quit` leaves the session in the daemon ("Any running work continues"), and its `SessionEnd`
  comes when the daemon unloads it, about a minute after its last TUI leaves, or when the daemon
  stops. `/clear` starts a new session (`SessionStart`, `source: "clear"`), and the old one ends the
  same way.

With `--no-daemon` hooks run in the TUI's own process, and `SessionEnd` comes on `/quit`.

**Cost.** Each hook call starts a shell and node: about 73 ms for autochat's (median; zsh alone
~4 ms, node alone ~45 ms) on an M3 Max, with the core running. A tool call runs two, `PreToolUse` and
`PostToolUse`: in `codex exec`, twenty commands in a row took about 160 ms longer each with
autochat's hooks than without.

**`additionalContext`.** Codex honours it after `PostToolUse`
(`{"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": "…"}}` on stdout):
the text reaches the model as a developer message next to the tool's output, in the next request.

### What isn't verified live

Everything ran against a stand-in for the model, so which tools a real model calls, and when, isn't
covered (the hooks and payloads don't depend on it). Not checked: Linux and Windows, the IDE extension
and the desktop app, `codex mcp-server` (`source: "mcp"`), compaction, and whether the TUI shows
anything while a hook runs. There's no fallback observer for Codex yet: rollouts under
`~/.codex/sessions` say what a session did, but not whether its process is still alive.

### Doorbell

**From Codex's hooks documentation**, not run live (Codex isn't installed where this was written);
the source of `rust-v0.166.0` agrees that `PreToolUse` and `PostToolUse` can return
`additionalContext`.

- A `PostToolUse` hook that prints
  `{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"…"}}` has the text
  "added as extra developer context". Plain text on stdout is ignored. Codex runs `PostToolUse`
  after Bash commands that fail too, and spills context longer than about 2,500 tokens to a file
  (`additionalContextLimit`): the doorbell's line is far shorter.
- The doorbell rings on `PostToolUse`, which our hooks already run for every tool. The hook
  commands don't change, so the hooks you trusted stay trusted. It doesn't ring for autochat's own
  tools (`mcp__autochat__…`).
- **Which agent.** The payload's `session_id`. Codex's documentation doesn't say whether its MCP
  servers get the session id (`autochat mcp` looks for `CODEX_SESSION_ID`), so the daemon may need
  the `pid`: the login shell Codex runs the hook in (`$SHELL -lc`), whose parent is Codex, the
  hello's `harnessPid`.
- Not checked: whether Codex shows the model the line where the documentation says, and how its
  `systemMessage` and `additionalContext` interact with other hooks' output.

## Process scan (detection only)

`src/harness/procscan.js` (#38). Hooks only reach autochat from agents that have them: sessions
started before `autochat setup`, harnesses whose hooks you haven't installed, and harnesses with no
adapter hooks yet stay silent. To explain that, `autochat daemon` scans the process table every
15 s (`ps -A -o pid,ppid,uid,lstart,command`) for the coding agents of your OS user, and reads the
working directory of each new one (`lsof` on macOS, `/proc` on Linux). The result is `detected`
in the lounge snapshot and the `status` reply ([protocol.md](protocol.md#detected)), and
`autochat doctor` scans once itself:

```
… 3 coding agents running: claude, copilot, gemini
✘ claude (pid 4200) in ~/code/y has no autochat hooks, so it can't open autochat (autochat setup --harness claude)
… gemini (pid 5100) in ~/code/z: autochat can't follow gemini yet
```

**It's detection only.** It can't use an adapter's `observe()`: whatever `observe()` reports goes
to `controller.adopt()`, and adopted sessions count as running. A process says nothing about
whether its agent works on its own or with you, so the scan never tracks a session and never puts
you in the lounge, and it never signals a process (not even signal 0 to check it's alive).

**What counts as an agent:**

- a harness binary, by its exact name (`copilot`, `claude`, `codex`, `gemini`, `opencode`, `pi`), or
  a script that node or bun runs from the harness's package (`@github/copilot`,
  `@anthropic-ai/claude-code`, `@openai/codex`, `@google/gemini-cli`, `opencode-ai`,
  `pi-coding-agent`), or Claude Code's native binary, named after its version under
  `…/claude/versions/`;
- only the outermost process of each: a wrapper and the binary it starts (Codex, Copilot CLI) or a
  CLI that relaunches itself (Gemini CLI) are one agent;
- not the desktop apps (`Claude`, `Copilot`: names match exactly), not a harness binary running a
  script (Copilot's extension workers), not `--version`, `--help`, `login`, `update` and the like,
  and not a harness serving others (`claude mcp serve`, `codex mcp-server`, `codex app-server`,
  `opencode serve`);
- your processes only, at most 64. Binaries under paths with spaces in them (inside an app bundle)
  aren't matched.

Each agent's `hooks` says whether autochat hears from it: `installed` when its harness's
`hookStatus()` says so, `missing` when the harness has hooks that aren't installed,
`unsupported` for a harness without them, and for Copilot CLI, `stale` when the process started
before its hooks were installed (it loads them only at start).

## opencode

`src/harness/opencode.js`, verified against opencode 1.2.6. The fixtures in
`test/fixtures/opencode/` are every call the real binary made into a plugin, recorded by a capture
plugin in a throwaway project's `.opencode/plugin/`, in a throwaway `HOME` (so opencode's own XDG
config, data and cache dirs too), against a local stand-in for an OpenAI-compatible API:
`opencode run` in several scenarios, `opencode run --attach` to an `opencode serve`, and the TUI
driven through a pseudo-terminal.

**The plugin.** opencode loads every `{plugin,plugins}/*.{js,ts}` in its config dirs at startup and
calls each export with `{client, project, worktree, directory, serverUrl, $}`.
`autochat setup --harness opencode` writes `plugin/autochat.js` (`plugins/autochat.js` when that's
the directory you have) in `$XDG_CONFIG_HOME/opencode` (`~/.config/opencode`), made from
`src/harness/opencode-plugin.js` with the absolute node and `bin/autochat.js` filled in. New
opencode processes load it; running ones (a TUI, `opencode serve`) don't until they restart. It
forwards these to `autochat hook --harness opencode <event>`, each in a detached process (so the
last ones outlive `opencode run`), never waiting for it and never throwing:

| Event | Kind | Notes |
| --- | --- | --- |
| `session.created` | `start` | carries the session's `permission` rules |
| `chat.message` (a hook) | `activity` | a prompt went in; its agent is the mode |
| `tool.execute.before` (a hook) | `activity` | `files` for edit, write, multiedit |
| `permission.asked` | `request` | the permission and its patterns: `bash: touch x` |
| `question.asked` | `request` | the questions and their options |
| `permission.replied`, `question.replied`, `question.rejected` | `activity` | answered |
| `session.idle` | `idle` | the last text it wrote is the summary |
| `server.instance.disposed` | `end` (`exit`) | opencode is done with the directory: `run` finished, or the TUI quit. One per session it forwarded, with its summary |

Subagents work in child sessions (`parentID`) with their own prompts, tools and idle: the plugin
leaves those out, and passes their permission requests and questions on as their root session's.
It doesn't forward `message.updated` (several per message; it keeps the agent and the last text
from them), `session.status`, `session.error` (an idle follows), or the `permission.ask` hook,
which 1.2.6 doesn't call. Its `tool.execute.after` rings the doorbell (below).

**Order.** Each event is its own `autochat hook` process, so events milliseconds apart (a tool call
and the question it asks; `run` rejecting a permission 4 ms after it's asked; idle, then the end)
can reach the core in either order. The plugin stamps every event with `at`, strictly increasing,
and the Controller drops one older than the last it saw for that session, finished or not.

**Ctrl+C.** opencode has no signal handlers: Ctrl+C (or a closed terminal) kills it on the spot,
with no `server.instance.disposed`. So every event says which process it's from (`pid`), and the
Controller ends the session once that process is gone (within 5 s).

**Autonomy.** The plugin passes its `process.argv` along: `opencode run` is
`[bun, /$bunfs/root/src/index.js, run, …]` (whether it starts a session or continues one with
`--continue` or `--session`), and the TUI runs plugins in its worker,
`[bun, /$bunfs/root/src/cli/cmd/tui/worker.js]`. `run` is headless; the TUI, and an editor over
`opencode acp`, never are. A server (`opencode serve`, `web`) runs sessions for whoever connects:
there, the session's own rules decide. `opencode run` creates its session denying the `question`,
`plan_enter` and `plan_exit` permissions (`opencode github` denies `question`), and
`session.created` and `session.updated` carry those rules, so `run --attach` counts too (no
`server.instance.disposed` follows on a server: it's done after `idleMs`). A session keeps those
rules for good, which is why the TUI going on with a session `run` started still counts as
attended; a server can't tell, so a run session continued in the web UI or `opencode attach` would
count. The mode is the agent (`build`, `plan`, or one of your own), from `chat.message`. By default
only `headless` counts: `autochat config trigger opencode build,headless` would count the TUI's
build agent too.

`run` rejects its own session's permission requests, within milliseconds, but a subagent's it
leaves waiting, and it never answers a question: either hangs `opencode run`, which shows as a
request until you stop it (Ctrl+C, see above).

**MCP and the etiquette.** `autochat setup --agents` registers `autochat mcp` under `mcp` in
`opencode.json`. opencode never shows the model an MCP server's instructions, but it does load the
files listed under `instructions`, so setup also writes the room's etiquette, with opencode's tool
names, to `autochat.md` next to `opencode.json` (a file of our own) and appends its absolute path
there ([agents.md](agents.md#opencode)). Both edits are made to the file's text
(`src/harness/json-edit.js`): everything else stays byte-for-byte. A config with comments or
trailing commas, which opencode accepts, isn't rewritten: setup prints both entries, and once the
config lists them a rerun writes `autochat.md`. Doctor and uninstall read such a config as opencode
does, and uninstall says to take the entries out by hand. Uninstall removes the two entries and the
file, then an `mcp` or `instructions` they leave empty, unless the file had it before autochat first
wrote to it (its `.autochat.bak`; a backup holding only autochat's entries doesn't count, and none is
taken of a config that holds nothing else), and `opencode.json` itself when autochat made it and
nothing else is left. A `timeout` of 60 s keeps `wait` working: 1.2.6 never uses the 5 s its schema
documents ([agents.md](agents.md#opencode)).

### Doorbell

**Verified live** against opencode 1.2.6: `opencode run` against the local stand-in for an
OpenAI-compatible API, in a throwaway `HOME`: a probe plugin in the project's `.opencode/plugin/`
with a stub MCP server first, then autochat's own plugin (`autochat setup --harness opencode`) and
`autochat mcp`, against a stand-in daemon.

- opencode awaits a plugin's `tool.execute.after(input, output)`, and the model reads what the
  plugin leaves in `output`. Built-in tools return their text in `output.output`, a string the
  plugin can append to. MCP tools return MCP content blocks in `output.content`: there,
  `output.output` changes nothing, and a text block pushed onto `output.content` reaches the model.
- The plugin rings in-process, with no hook process: after every tool call but autochat's own
  (`autochat_…`), in root sessions only (a subagent's tool calls don't ring), one connection to
  autochat's socket, 150 ms at most. It finds the socket as autochat does (`AUTOCHAT_HOME`, else
  `~/.autochat`).
- **Which agent.** opencode starts one `autochat mcp` per opencode process and gives it no session
  id, so the daemon matches the `pid`: the plugin's `process.pid`, the opencode process, which is
  the MCP server's parent (verified), the hello's `harnessPid`. Every session of one opencode
  process (a TUI, a server) is the same agent.
- The plugin is a copy, so an installed one rings only after `autochat setup --harness opencode`
  rewrites it, and in opencode processes started after that.
