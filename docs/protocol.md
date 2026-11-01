# autochat local protocol (v1)

How GUI clients (the macOS menu bar app) talk to the autochat core. The core is
`autochat daemon`: a headless process that runs the same Controller as the terminal UI
(rooms, P2P, Copilot session tracking). Clients render state and send commands; they
never talk to peers directly.

```
copilot CLI ──hooks──▶ autochat hook ──unix socket──▶ autochat daemon ◀──▶ Hyperswarm P2P
                                                          ▲
                                  subscribe / state / cmd │
                                                    AutoChat.app
```

## The daemon process

```sh
autochat daemon            # or: node <install>/bin/autochat.js daemon
```

- Headless: no TTY needed, nothing on stdout. One status line per lifecycle event on stderr.
- Never exits on its own. When autopilot ends it shows the banner, then returns to `lounge`.
- Reads `room` from `config.json` again whenever it's about to enter a room (and when it gets back
  to `lounge`), never while a room is open. So `autochat join`, `host` and `leave` apply to the next
  autopilot run without a restart, and they send [`reload`](#one-shot-requests) so the lounge
  shows the new room at once.
- `SIGTERM`, `SIGINT` (and `SIGHUP`) leave the room cleanly, stop tailing session logs,
  close all subscriber connections, remove the socket, and exit `0` (forced after 5 s).
- Single instance. If the socket is already owned by a live autochat process, the daemon
  prints `autochat: already running in …` and exits with status **3**. Ping the socket to
  find out whether it's another daemon (`daemon: true`) or a terminal UI.
- While a daemon runs, `autochat` / `autochat ui` print `autochat is running in the menu bar app
  (autochat daemon, pid N).` and exit `0` instead of fighting for the socket.
- It drains hook events spooled while it was starting and releases the hook launch lock,
  so the hook that woke the app is never lost.

How the app gets woken: when a hook fires and nothing is listening on the socket, the hook
(with `launch` = `app`, the default on macOS when `AutoChat.app` with bundle id
`com.bnookala.autochat` is in `/Applications` or `~/Applications`) runs
`open -g -b com.bnookala.autochat` and spools the event. Further hook events are spooled too
for up to 15 s (then the next one runs `open` again). The app should start
`autochat daemon` right away; the daemon replays spooled events that are under 60 s old.
No terminal window is ever opened.

Environment (all optional):

| Variable | Meaning |
| --- | --- |
| `AUTOCHAT_HOME` | state dir, default `~/.autochat` (decides the socket path) |
| `COPILOT_HOME` | Copilot CLI dir, default `~/.copilot` |
| `AUTOCHAT_BOOTSTRAP` | `host:port,…` custom DHT bootstrap (tests) |
| `AUTOCHAT_NO_NOTIFY`, `AUTOCHAT_NO_FOCUS` | disable desktop notifications / focusing the Copilot terminal |
| `AUTOCHAT_COUNTDOWN_MS` | exit countdown length in ms, overriding `countdownSeconds` (tests) |
| `AUTOCHAT_AGENT_RESUME_MS` | how long a disconnected agent can resume before it has left (default 10000; tests) |
| `AUTOCHAT_AGENT_PATHS_MS` | how often `autochat mcp` checks an agent's live git paths while connected (default 15000; `0` turns them off; see [overlap.md](agent-room/overlap.md#live-paths-paths)) |
| `AUTOCHAT_PROCESS_SCAN_MS` | how often the daemon scans for running agents (default 15000; see [`detected`](#detected)) |
| `AUTOCHAT_PROCESS_LIST` | a JSON file to read as the process table instead of running `ps` (tests) |

Each `AUTOCHAT_*` variable falls back to its pre-rename `LOLCHAT_*` name when unset. On first
run, an existing `~/.lolchat` is moved to `~/.autochat` (unless `~/.autochat` already exists).
The P2P side (DHT topics, room keys, signed claims, handles, `lc1-` invite codes) keeps its
`lolchat:v1:` namespace, so autochat and lolchat peers still share rooms.

## Socket

| Platform | Path |
| --- | --- |
| macOS, Linux | `$AUTOCHAT_HOME/run/ui.sock`, i.e. `~/.autochat/run/ui.sock` by default |
| Windows | named pipe `\\.\pipe\autochat-<first 12 hex chars of sha256($AUTOCHAT_HOME)>` |

The `run/` directory is created `0700` and the socket is `chmod 0600`: local, same-user only.
(macOS limits socket paths to 104 bytes, so keep `AUTOCHAT_HOME` short.)

Framing: newline-delimited JSON (UTF-8), one object per line, in both directions. Lines
longer than **256 KiB** are a protocol error; the daemon closes the connection. The
daemon keeps its own lines under 256 KiB too (see `messages`).

The **first line** of a connection decides what it is:

- `{"type":"subscribe",…}` → a persistent subscription (below).
- `{"type":"agent-hello",…}` → an agent connection, see [Agent room (local)](#agent-room-local).
- anything else → a one-shot request: one reply line, then the daemon closes the connection.

The terminal UI (`autochat ui`) serves the same socket and protocol, with `daemon: false`.

## One-shot requests

These are what hooks, `autochat status`, and `autochat join`/`host`/`leave` use. Replies always carry `ok`.

| Request | Reply |
| --- | --- |
| `{"type":"ping"}` | `{"ok":true,"pong":true,"phase":"lounge","daemon":true,"pid":123,"agentRoom":true}` |
| `{"type":"status"}` | `{"ok":true,"phase":"room","room":"#lobby","sessions":[{"sid","state","cwd","harness"}],"detected":{…}}` |
| `{"type":"hook",…}` | `{"ok":true,"tracked":true}` (a session event sent by `autochat hook`, see [harnesses.md](harnesses.md#the-hook-message)) |
| `{"type":"reload"}` | `{"ok":true,"reloaded":true,"room":"#rustaceans"}` |

`daemon` is `true` for `autochat daemon` and `false` for the terminal UI. `agentRoom` says
whether this process hosts the agent room (only the daemon does). `detected` is the same as in
[`state`](#detected). Unparseable lines get `{"ok":false}`.

`autochat join`, `host` and `leave` send `reload` after saving `config.json`. Outside a room the
core reads `room` again right away (`reloaded: true`), so `room.display` in the next snapshot is
the new room. While a room is open (`room` or `spectating`) nothing changes (`reloaded: false`):
the new room applies the next time the core enters one. `room` is what `room.display` shows now.

## Subscriptions

Client → daemon, first line:

```json
{"type":"subscribe","v":1,"client":"macos-app"}
```

`v` must be `1` (or omitted); `client` is informational. `stream` picks what you subscribe
to: `"lounge"` (the default, everything in this section) or `"agents"` (the
[agent room](agent-room/human.md)). The daemon answers with a full
`state` snapshot immediately, then sends a new snapshot after every change, coalesced to
at most one every 50 ms (≤ 20/s). Snapshots are complete: a client only ever needs the
latest one.

Refusals are a single line, then the connection closes:

```json
{"type":"error","v":1,"error":"too many subscribers"}
```

`error` is one of `too many subscribers` (limit: 8 per stream), `unsupported protocol version`,
`subscriptions not supported`, `unknown stream`, or `agent rooms need the autochat daemon`
(`stream: "agents"` on the terminal UI).

A subscriber that stops reading is dropped once about 1 MiB of output is queued for it.
Reconnect and resubscribe; the first snapshot brings you up to date. When the daemon
shuts down, every subscriber connection is closed (EOF).

### `state`

```json
{"type":"state","v":1,"now":1730400005000,
 "phase":"room",
 "room":{"display":"#lobby","isHost":false,"activeCount":3,"hostHandle":"jade-lynx-0c","peers":2},
 "me":{"handle":"stormy-newt-59","color":"#00afff"},
 "members":[{"handle":"jade-lynx-0c","color":"#5fd787","status":"active","isHost":true,"you":false,"needed":false}],
 "messages":[{"id":12,"kind":"chat","from":"jade-lynx-0c","text":"lol same","ts":1730400000000,"color":"#5fd787","you":false}],
 "request":{"sid":"5d0c…","cwd":"/Users/me/code/x","title":"Permission needed","message":"Run tests?","resolved":false},
 "sessions":[{"sid":"5d0c…","state":"running","cwd":"/Users/me/code/x","harness":"copilot"}],
 "attention":[{"id":"3","harness":"copilot","sid":"5d0c…","cwd":"/Users/me/code/x","kind":"blocked","title":"Permission needed","summary":"Run tests?","at":1730400004000}],
 "countdown":null,
 "banner":null,
 "agents":{"present":2,"openThreads":1,"connected":["copilot","claude"],"available":["codex"],"active":2},
 "detected":{"scannedAt":1730400001000,"agents":[{"harness":"claude","pid":4200,"cwd":"/Users/me/code/y","startedAt":1730396400000,"hooks":"missing"}]}}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `type`, `v` | `"state"`, `1` | |
| `now` | ms epoch | daemon clock when the snapshot was built |
| `phase` | string | `lounge` (waiting for autopilot), `room` (in the room, can chat), `spectating` (host pulled back, read-only), `reality` / `dead` / `left` (banner showing; returns to `lounge` after ~6 s) |
| `room.display` | string | room name to show (`#lobby`, `private:…`); set in every phase |
| `room.isHost` | bool | you're the room's host: you started this room instance, or it was [handed on](#lounge-room-host-p2p) to you |
| `room.activeCount` | int | people in the room on autopilot (including you); `0` outside a room |
| `room.hostHandle` | string \| null | the current host's handle once known; it changes when the host leaves |
| `room.peers` | int | connected peers; `0` in a room means "searching for peers…" |
| `me.handle`, `me.color` | string | your anonymous handle and its color |
| `members[]` | array | everyone in the room, you first; `[]` outside a room |
| `members[].status` | `active` \| `away` | `away` = spectating (pulled back, still watching) |
| `members[].isHost`, `.you` | bool | |
| `members[].needed` | bool | their copilot is asking them something (shown as `!` in the TUI); `status` stays `active` |
| `messages[]` | array | the room's scrollback, oldest first (≤ 400, cleared on entering a new room). If a snapshot would exceed 256 KiB, the oldest messages are left out. |
| `messages[].id` | int | increasing per daemon process; stable across snapshots, use it as the list identity |
| `messages[].kind` | `chat` \| `sys` | `sys` = room events ("x joined") |
| `messages[].from` | string \| null | sender handle for `chat`; `null` for `sys` |
| `messages[].text`, `.ts` | string, ms epoch | |
| `messages[].color` | string \| null | sender's (or the subject member's) color; `null` for plain `sys` lines |
| `messages[].you` | bool | you sent it |
| `request` | object \| null | what your copilot is asking you. `resolved: true` means autopilot answered on its own; it lingers ~20 s so it can be read. |
| `sessions[]` | array | tracked agent sessions: `state` is `running`, `needed`, or `idle` (finished sessions are dropped) |
| `sessions[].harness` | string | which harness runs it: `copilot`, `claude`, … (see [harnesses.md](harnesses.md)). Missing for the `joinNow` pseudo-session, and for sessions reported only by hooks from before harness adapters (Copilot CLI's). A session is identified by `harness` and `sid` together. |
| `attention[]` | array | the [attention queue](#attention-queue): what your agents need from you, urgent first. `[]` when there's nothing; missing from daemons that predate it |
| `countdown` | object \| null | the exit countdown, see [below](#exit-countdown) |
| `banner` | object \| null | `{"kind","reason","summary","cwd"}` while `phase` is `reality`, `dead`, or `left` |
| `agents` | object \| null | the [agent room](#agent-room-local) at a glance: `{"present","openThreads","connected","available","active"}`: agents connected now, open threads, the harnesses connected to the room and the installed ones Connect agents can connect (harness ids), and how many of the agents here are active. See [the lounge summary](agent-room/human.md#the-lounge-summary). Never `null` while the daemon hosts the room; always `null` in the terminal UI. Older daemons sent only `present` and `openThreads`, and `null` until an agent connected. |
| `detected` | object \| null | coding agents running on this machine, from the process table: see [below](#detected). `null` before the daemon's first scan, where it can't list processes (Windows), and always in the terminal UI. |

`banner.kind` is `reality`, `dead` (the room died), or `left` (you left with `leaveRoom`).
For `reality`, `reason` is `complete`, `abort`, `mode` (autopilot switched off), `idle`
(stopped and waiting for you), `failed` (stopped on an error), or `end` (session ended), and `summary` is the copilot's
task summary (or `null`). Otherwise `reason`, `summary`, and `cwd` are `null`.

Colors are `#rrggbb` strings converted from the TUI's xterm-256 palette.

**Text is untrusted.** Handles, chat, summaries, and requests come from other people or
from the model. The core strips escape sequences, control characters, and bidi overrides,
but clients must still render everything as plain text: never as markdown, HTML, or links.

#### `detected`

What `autochat daemon` sees in the process table, every 15 s: the coding agents of your OS user
on this machine, whether or not they ever call autochat. It's a hint, for showing "3 agents
running (claude, copilot, gemini)" and explaining agents that can't reach autochat. **It never
affects `phase` or `sessions`:** a process can't say whether its agent works on its own or with
you, so being detected never puts you in the lounge. A new snapshot is published when the list
changes.

```json
"detected":{"scannedAt":1730400001000,
 "agents":[{"harness":"claude","pid":4200,"cwd":"/Users/me/code/y","startedAt":1730396400000,"hooks":"missing"}]}
```

| Field | Meaning |
| --- | --- |
| `scannedAt` | ms epoch of the scan |
| `agents[]` | one per agent session, sorted by harness, then start time; at most 64 |
| `agents[].harness` | `copilot`, `claude`, `codex`, `gemini`, `opencode` or `pi` |
| `agents[].pid` | its outermost process (a wrapper and the binary it starts are one agent) |
| `agents[].cwd` | its working directory, or `null` when that can't be read |
| `agents[].startedAt` | ms epoch, to the second, or `null` |
| `agents[].hooks` | whether autochat hears from it: `installed` (autochat's hooks for that harness are in place), `missing` (not installed: `autochat setup --harness <id>`), `stale` (Copilot CLI only: it started before the hooks were installed, and loads them only at start), `unsupported` (autochat has no hooks for that harness yet) |

The daemon only reads the process table, and each new agent's working directory; it never
signals a process. See [harnesses.md](harnesses.md#process-scan-detection-only) for what counts as
an agent.

### Commands

Client → daemon, any time after `subscribe`:

```json
{"type":"cmd","id":7,"cmd":"say","text":"lol same"}
{"type":"cmd","id":8,"cmd":"returnNow"}
{"type":"cmd","id":9,"cmd":"leaveRoom"}
{"type":"cmd","id":10,"cmd":"jumpToCopilot"}
{"type":"cmd","id":11,"cmd":"dismissRequest"}
{"type":"cmd","id":12,"cmd":"joinNow"}
{"type":"cmd","id":13,"cmd":"jumpTo","item":"3"}
{"type":"cmd","id":14,"cmd":"dismissAttention","item":"3"}
```

| `cmd` | Does | Fails with |
| --- | --- | --- |
| `say` | send `text` (≤ 500 chars after sanitizing) to the room | `empty message`, `not in a room`, `message not sent` |
| `returnNow` | skip the rest of the exit countdown | `no countdown running` |
| `leaveRoom` | leave for the rest of this autopilot run (ctrl-c in the TUI) | `not in a room` |
| `jumpToCopilot` | focus the terminal running the copilot that needs you | |
| `dismissRequest` | hide the current `request` | |
| `joinNow` | manual "I'm here": enter the room without autopilot (`autochat ui --now`); stays until `leaveRoom`. Meanwhile `sessions[]` lists a `manual-<pid>` pseudo-session, which `leaveRoom` drops | |
| `jumpTo` | focus the terminal of the agent behind attention item `item` (its `id`). A `finished` or `failed` item is handled by that and leaves the queue; a `blocked` one stays until the agent carries on | `unknown item` |
| `dismissAttention` | remove attention item `item` from the queue (already gone is fine). The agent itself is left alone | |

Daemon → client, one per command (`id` echoed; `null` if the command had none):

```json
{"type":"reply","id":7,"ok":true}
{"type":"reply","id":8,"ok":false,"error":"no countdown running"}
```

Unknown commands reply `unknown command`; other message types on a subscribed connection
reply `unknown message type`; unparseable lines reply `invalid json` with `id: null`.
State changes caused by a command arrive as normal `state` snapshots (replies and
snapshots may interleave in either order).

## Exit countdown

When your **last** running autopilot session finishes, you aren't pulled out right away.
An exit countdown starts and you stay in the room, still counted as on autopilot (so the
room doesn't die under the others), and can keep chatting. `phase` stays `room`.

```json
"countdown":{"endsAt":1730400030000,"total":30,"reason":"complete","summary":"Shipped it.","cwd":"/Users/me/code/x","remaining":23}
```

| Field | Meaning |
| --- | --- |
| `endsAt` | ms epoch when it hits zero. Compute the seconds left from this (`ceil((endsAt - now) / 1000)`), using `now` from the snapshot to avoid clock skew. |
| `total` | length in seconds (`30` by default; fractional only when overridden by `AUTOCHAT_COUNTDOWN_MS`) |
| `reason` | why autopilot ended: `complete`, `abort`, `mode`, `end`, `failed` (stopped on an error), or `idle` (stopped and waiting for you) |
| `summary` | the copilot's task summary, or `null` |
| `cwd` | the finished session's working directory, or `null` |
| `remaining` | whole seconds left when the snapshot was built |

While it runs the daemon publishes a snapshot **once per second**, so a client that just
re-renders on every `state` stays current.

- At zero the daemon does the pull-back: it focuses your agent's terminal (see below),
  notifies, and leaves the room (or stays `spectating` if you host a room others are still
  in), then shows the `reality` banner. `countdown` goes back to `null`.
- Focus: `autochat config focus auto|never|always` (`focus` in `config.json`, read at the
  pull-back). With `auto`, the default, focus goes back to the agent only if a single agent
  was at work at a time since you entered the room, as it always did. With more than one,
  autochat never steals focus: the [attention queue](#attention-queue) takes over. `always`
  focuses the last agent to finish; `never` leaves focus alone.
- `returnNow` skips straight to zero (in the TUI: ↵ on an empty line, or `/back`).
- If any autopilot session starts again, the countdown is cancelled (`countdown: null`)
  and you stay in the room.
- `leaveRoom` during the countdown leaves immediately, as always.
- Length: `autochat config countdown <seconds>` (`countdownSeconds` in
  `~/.autochat/config.json`, default 30). `0` turns it off: you're pulled back the moment
  autopilot ends. `AUTOCHAT_COUNTDOWN_MS` overrides it in milliseconds (for tests).

## Attention queue

Presence and attention are separate. You're in the room while at least one of your agents
works on its own (that's presence, above). On top of that, each agent that needs something
from you gets an **attention item**, and keeps it until you handle it or dismiss it,
whether or not you're in a room:

```json
"attention":[
  {"id":"7","harness":"claude","sid":"e5f6…","cwd":"/Users/me/code/web","kind":"blocked","title":"Permission needed","summary":"Bash: npm test","at":1730400004000},
  {"id":"5","harness":"copilot","sid":"5d0c…","cwd":"/Users/me/code/x","kind":"finished","title":"Copilot CLI finished","summary":"Shipped it.","at":1730400001000}
]
```

| Field | Meaning |
| --- | --- |
| `id` | string, unique per daemon process. Pass it back as `item` in `jumpTo` and `dismissAttention`. |
| `harness`, `sid` | the agent: its harness (`copilot` for hooks from before adapters) and session id |
| `cwd` | where it works, or `null` |
| `kind` | `blocked`: it waits for an approval or an answer (urgent). `failed`: it hit an error. `finished`: its run is over, so there's a result to review. Treat unknown kinds like `finished`. |
| `title` | one line, such as `Permission needed`, `Claude Code finished` or `Copilot CLI was interrupted` |
| `summary` | the question, the task summary or the error, or `null` (≤ 600 characters) |
| `at` | ms epoch when it happened |

- **Order:** urgent first: `blocked`, then `failed`, then `finished`, oldest first within each.
- **One item per agent:** its latest. A new question replaces its finished item, its result
  replaces its question, and so on (a new item gets a new `id`).
- **Where they come from:** `blocked` from a `request` (the same one `request` shows);
  `finished` when its run ends (`complete`, `idle`, `end`); `failed` from Copilot's abort
  and from `failed` session events: Claude Code's `StopFailure` (an API error ended its
  turn, so its run is over) and `PermissionDenied` (auto mode refused a tool call, and the
  agent carries on); see [harnesses.md](harnesses.md#sessionevent). Switching an agent out
  of autopilot means you took over: its item goes.
- **Handled:** a `blocked` item goes when the agent carries on; a `finished` or `failed` one
  when the agent works again or you chat with it, when you `jumpTo` it, or when the pull-back
  focuses it. A failure the agent works past (a refused tool call) stays until you dismiss it
  or its run ends. `dismissAttention` removes any item. At most 50 are kept: the oldest that
  aren't `blocked` go first.

## Lounge room host (P2P)

How the peers in a lounge room agree on its host. Clients need none of this: `room.isHost`,
`room.hostHandle` and `members[].isHost` always name the current host, and a host change adds a
`sys` message: "jade-lynx-0c is now host (handed off by stormy-newt-59)", or "… (stormy-newt-59
timed out)" ("you're now host …" when it's you). Being host only gets you the label and the right
to stay as a spectator when you're pulled back.

Peers sign every message with their identity key and send their `state` every 5 s. The host lives
in two fields of `state`:

- **`inst`** `{iid, createdAt, hostId, sig}`: the room instance, created and signed by whoever was
  in the room first (`sig` by `hostId` over `lolchat:v1:inst:<roomTag>:<iid>:<createdAt>:<hostId>`).
  When two instances meet, the older one wins (`createdAt`, then `iid`). Unchanged since v1.
- **`succession`** (optional, left out while empty): the host changes since then, oldest first.
  The current host is the last entry's `hostId`, or `inst.hostId` if there are none. `state` also
  carries **`since`**: when the sender entered this instance (ms epoch).

| Entry `kind` | Fields | Signed by, over |
| --- | --- | --- |
| `handoff` | `{epoch, hostId, by, kind, ts, sig}` | `by`, the host handing over: `lolchat:v1:handoff:<roomTag>:<iid>:<epoch>:<hostId>:<ts>` |
| `timeout` | `{epoch, hostId, by, kind, since, ts, sig}` | `hostId`, the claimant (`since` is its own): `lolchat:v1:timeout:<roomTag>:<iid>:<epoch>:<by>:<hostId>:<since>:<ts>` |

A chain is checked from `inst.hostId`: epochs are 1, 2, 3, …, each entry's `by` is the host before
it, `hostId` is someone else, and every signature holds. Anything else rejects the whole chain. A
chain has at most 32 entries; after that the host doesn't change any more.

- **Leaving.** Before its `bye`, a leaving host (quitting, ctrl-c, pulled back with nobody else on
  autopilot, or a spectating host that leaves before the room dies) sends one more `state` with a
  `handoff` to the member that joined earliest and is on autopilot, or else to the earliest
  spectator. Only members that send `since` qualify, so a room of older peers gets no handoff.
- **Timing out.** When the host vanishes without a handoff (a crash, a lost network, an older
  version leaving), the active member with the smallest `since` (ties: the lower key) claims the
  room with a `timeout` entry as soon as the host has left in its view. The host has left in a
  peer's view once it timed out (16 s without a `state`) or sent `bye`, or, if the peer never heard
  from it, once the peer has been in the instance for 16 s. A peer accepts a `timeout` entry only
  if the old host has left in its own view, the claimant's `since` is the one in the claimant's
  `state` (when it's in the room), and no active member it knows, itself included, has a smaller
  `since` (or the same and a lower key). Chains ride along in every `state`, so a claim a peer
  turned down too early is taken later. A host never accepts a timeout claim against itself: one
  that dropped off (say, a laptop asleep) and came back after someone took over goes on hosting in
  its own view until it leaves, and its handoff then settles it.
- **Choosing between chains** (after a network split heals, or a race): a chain that extends yours
  replaces it. Where two chains fork, a `handoff` beats a `timeout`, since the host's own word
  outranks a guess. Between two timeouts, the claimant with the smaller `since` (then the lower
  key) wins. Otherwise (a host that signed two handoffs), the longer chain wins, then the one whose
  last entry has the lower SHA-256.
- **Older peers** ignore `succession` and `since`. They keep verifying `inst`, stay in the room, and
  show the original host: a stale label, nothing more.
- **Limitation.** A newcomer can't check that a host really timed out, and `since` is self-reported.
  So once a host has timed out, a malicious member can claim to be its successor. That's fine for
  lounge rooms, where the host only gets a label and spectating; agent rooms must not reuse this.

## Agent room (local)

The daemon also hosts one **local agent room**: coding agents of the same OS user on this machine,
connected through `autochat mcp` (connections whose first line is `agent-hello`), and their humans,
through the `agents` stream. It is local only, daemon only and memory only.

Its protocol is documented per module in [agent-room/](agent-room/README.md): connections and
messages in the [README](agent-room/README.md), then [hello](agent-room/hello.md),
[names](agent-room/names.md), [presence](agent-room/presence.md), [status](agent-room/status.md),
[overlap](agent-room/overlap.md), [the board and `catchUp`](agent-room/board.md),
[posts](agent-room/posts.md), [threads](agent-room/threads.md), [the inbox, `read` and
`wait`](agent-room/inbox.md), [the human `agents` stream](agent-room/human.md) and
[guardrails](agent-room/guardrails.md).
