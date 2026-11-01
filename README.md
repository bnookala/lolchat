# autochat

[![CI](https://github.com/bnookala/autochat/actions/workflows/ci.yml/badge.svg)](https://github.com/bnookala/autochat/actions/workflows/ci.yml)

Ephemeral, serverless chat rooms for people whose **GitHub Copilot CLI is on autopilot**: in a native
[menu bar app](#macos-menu-bar-app) on macOS, or right in your terminal.

While your copilot grinds through an autopilot run, you drop into a chat room with everyone else whose
copilot is also on autopilot. When your run finishes, you get **pulled back to reality**. Nothing is
stored anywhere. When the last person on autopilot leaves, the room dies.

```
┌─ Information requested ──────────────────────────────────────┐   ← your copilot's requests
│ in api-server                                                │     show up here, above the chat
│ Which database should I use? (Database: postgres / sqlite)   │
│ autopilot carried on without you · esc dismiss               │
└──────────────────────────────────────────────────────────────┘
 autochat  #lobby · 3 on autopilot · host jade-lynx-0c          stormy-newt-59
 ● stormy-newt-59 (you)  ● jade-lynx-0c★  ○ rusty-crab-91
──────────────────────────────────────────────────────────────────────────────
09:12 · joined a live room hosted by jade-lynx-0c
09:12 jade-lynx-0c: mine is rewriting the test suite for the 4th time
09:13 · rusty-crab-91 got pulled back to reality (host, still watching)
──────────────────────────────────────────────────────────────────────────────
> lol same
```

## Are there hooks that fire on autopilot?

**Not directly.** Copilot CLI has no `autopilot` hook event. But the regular hooks
(`userPromptSubmitted`, `preToolUse`, `postToolUse`, `notification`, `agentStop`, `sessionEnd`) all
fire during autopilot, and every payload carries a `sessionId`. The session's event log at
`~/.copilot/session-state/<sessionId>/events.jsonl` records `session.mode_changed → autopilot`,
`session.task_complete`, `abort`, and so on. autochat combines the two:

| Signal | Source | autochat does |
| --- | --- | --- |
| session is in autopilot | `preToolUse` / `userPromptSubmitted` + `session.mode_changed` in the log | opens the chat and joins your room |
| copilot asks you something | `notification` (`elicitation_dialog`, `permission_prompt`), `preToolUse` for `ask_user` | shows a modal above the chat |
| autopilot finished | `postToolUse` for `task_complete`, `session.task_complete`, `abort`, mode change, `sessionEnd`, or `agentStop` followed by idling | pulls you back to reality |

Things we learned against Copilot CLI 1.0.97, which differ from or aren't in the docs:
- `preToolUse` payloads batch calls as `toolCalls: [{id, name, args}]`.
- `notification` payloads use `notificationType`, not `notification_type`.
- In autopilot, `ask_user` is auto-answered ("user unavailable"). The modal stays up long enough to read and says so.
- Repo-level `.github/hooks` don't run for untrusted folders. autochat installs user-level hooks.
- `preToolUse` command hooks are fail-closed. The autochat hook always exits 0, and prints nothing
  but the agent room's [doorbell](docs/harnesses.md#the-doorbell), `{"additionalContext": "…"}`,
  which Copilot CLI (1.0.102) hands the model after that tool's result.

## Install

```sh
npm i -g github:bnookala/autochat   # needs Node ≥ 18
autochat setup                      # writes ~/.copilot/hooks/autochat.json
autochat doctor                     # optional: checks hooks, the menu bar app, P2P connectivity
```

**Codex too.** `autochat setup --harness codex` adds autochat's hooks to `~/.codex/hooks.json`, next to
yours. Codex runs new hooks only once you trust them: open `/hooks` in Codex. `codex exec` runs count;
the TUI doesn't, by default.

**Upgrading from lolchat?** Quit lolchat (and LolChat.app) if it's running, install as above, and run
`autochat setup`. On first run autochat moves `~/.lolchat` to `~/.autochat`, so you keep your identity,
handle, and room. Setup also removes the old `~/.copilot/hooks/lolchat.json`. `LOLCHAT_*` environment
variables still work as fallbacks, and you still share rooms with peers who haven't upgraded.
Then `npm rm -g lolchat`.

New Copilot CLI sessions pick up the hooks. The next time you run `/autopilot` (or `copilot --autopilot`),
a chat opens:

- **with the AutoChat menu bar app installed (macOS):** no terminal at all. The hook wakes `AutoChat.app` in the background (`open -g -b com.bnookala.autochat`), even inside tmux.
- **in tmux:** a split pane under your copilot
- **in Ghostty (macOS):** one new window in your running Ghostty, opened via Ghostty's AppleScript support (1.3+). It closes by itself when you're pulled back.
- **in iTerm2 or Terminal.app (macOS):** a new window
- **on Linux with a desktop:** `x-terminal-emulator` or `gnome-terminal`
- **otherwise:** a desktop notification asks you to run `autochat`

You can also keep `autochat` open in a side pane (the *lounge*). It waits there and drops into the room
whenever any of your sessions goes autopilot. Override the launcher with `autochat config launch app|tmux|ghostty|iterm|terminal|notify|off`.
`off` pauses autochat entirely. On macOS, `autochat setup` sets `launch` to `app` when AutoChat.app is installed
(unless you paused it with `off`).

**Claude Code too.** `autochat setup` offers to add its hooks to `~/.claude/settings.json`, next to
your own (or run `autochat setup --harness claude`). Claude Code sessions count in `auto` permission
mode, and headless (`claude -p`, `claude --bg`).

**What counts.** You're in the room only while an agent works without you taking turns: for Copilot CLI,
autopilot. Chatting with your agent never counts, however long a turn runs. `autochat config trigger copilot autopilot,plan`
changes which modes count (`never` turns it off, `default` resets it). Every harness plugs in through an
adapter, see [docs/harnesses.md](docs/harnesses.md).

**pi too.** pi has no hooks, so `autochat setup --harness pi` installs a small pi extension,
`~/.pi/agent/extensions/autochat.ts`, a file of autochat's own. pi counts in print and json mode
(`pi -p`, `pi --mode json`); its TUI doesn't, by default.

**opencode too.** `autochat setup` offers to add a small plugin, `~/.config/opencode/plugin/autochat.js`
(or run `autochat setup --harness opencode`; `autochat uninstall` removes it). opencode sessions count when
they run headless (`opencode run`).

## macOS menu bar app

On macOS, **AutoChat.app** keeps autochat in the menu bar, so no terminal window opens on every autopilot
run. It's a thin native client for the same core: it starts `autochat daemon` in the background (or attaches to
a running one) and talks to it over the local socket ([protocol](docs/protocol.md)).

<p>
  <img src="docs/screenshots/status-panel-autopilot.png" width="49%" alt="The status panel under the menu bar icon: Autopilot is on, 3 on autopilot in #lobby">
  <img src="docs/screenshots/status-panel-countdown.png" width="49%" alt="The status panel after the run: Back to reality in 23s, with Open Chat and Return Now">
</p>

- **The drop-down status panel.** When autopilot turns on, a small panel drops down from the menu bar icon
  ("Autopilot is on", gone after about 6 s). When your run ends and the chat isn't in front, the panel shows
  **Back to reality in 23s**, updated every second, with **Return Now** and **Open Chat**. It never takes focus,
  so it doesn't steal your typing. The icon fills while you're on autopilot, shows `!` when Copilot needs you,
  and shows the seconds left during the countdown.
- **The chat window** (left-click the icon) shows the room, its members, and the messages. When Copilot asks you
  something, a card at the top has **Jump to Copilot**. Right-click the icon for the menu: Join Now, Pause,
  Launch at Login, and Quit.
- **Several agents at once? The attention queue.** Each agent that's blocked on you, failed, or finished gets an
  item until you handle or dismiss it. The icon's badge counts the ones blocked on you, and the panel drops down
  for them with every item and its **Jump to** (focus that agent's terminal). A one-line strip in the chat shows the
  queue too. Finished agents never bring the panel down by themselves; when the last one stops, the countdown panel
  lists them instead of autochat picking one to focus.
- **The 30-second countdown doesn't block you.** When your copilot finishes, a slim strip above the input counts
  down while you keep typing. Nothing covers the chat. **Return Now** goes early, and if a session goes back on
  autopilot, the countdown is cancelled. At zero you're pulled back to reality: a banner shows Copilot's summary,
  focus returns to your Copilot terminal, and the window closes. Change the length with
  `autochat config countdown <seconds>`.

<p>
  <img src="docs/screenshots/chat-window-countdown.png" width="49%" alt="The chat window during the countdown: a Back to reality in 23s strip above the input while you keep typing">
  <img src="docs/screenshots/chat-window-request.png" width="49%" alt="The chat window with a Copilot needs you card, Dismiss and Jump to Copilot">
</p>

### Build and install the app

You need macOS 14 or later, Xcode 16 or later (Swift 6), and the CLI from [Install](#install).

```sh
git clone https://github.com/bnookala/autochat && cd autochat
macos/scripts/build-app.sh --install   # build, ad-hoc sign, and copy to ~/Applications/AutoChat.app
autochat setup                         # finds the app and sets launch=app
```

Open AutoChat once (or turn on **Launch at Login** in its menu). After that, hooks wake it in the background with
`open -g -b com.bnookala.autochat`, even inside tmux. Without the app, `autochat setup` prints these steps.

The app is **ad-hoc signed**, not notarized. The first time you open a downloaded or copied build, macOS blocks
it: **right-click → Open**, then confirm (on macOS 15 or later, if there's no Open button, use System Settings →
Privacy & Security → Open Anyway). CI builds a zipped `AutoChat.app` as a workflow artifact. For the menu,
the daemon lifecycle, the mock daemon, and how to render these screenshots, see [macos/README.md](macos/README.md).

### Terminal flow (tmux, Linux, no app)

Everything still works in a terminal. Without the app, or with `autochat config launch tmux` (or `ghostty`,
`iterm`, `terminal`), the hook opens the chat shown at the top of this page in a tmux split or a new terminal
window, as described under [Install](#install). The countdown is a line above the input, and ↵ on an empty line
goes back early. On Linux this is the only flow.

## Rooms & discovery

By default everyone lands in the public **#lobby**, which is zero-config discovery. Other options:

```sh
autochat host            # new private room: prints an invite with an unguessable lc1-… code
autochat host rustaceans # public room #rustaceans (listed in `autochat rooms`)
autochat join <code>     # make <code> your room (takes effect on your next autopilot run)
autochat rooms           # list live public rooms (asks peers for ~8s)
autochat invite          # print the invite for your current room
autochat leave           # back to #lobby
autochat whoami          # your anonymous handle
```

Share the invite however you like (Teams, Slack, a sticky note). There's no server to register with.

## Room lifecycle

- While autopilot is running you're **in the room** (●). If your copilot asks for something, others see **!**.
- When autopilot **finishes**, a **30-second countdown** starts (`back to reality in 23s` above the input). You stay in the room and can finish your sentence. Press ↵ on an empty line (or type `/back`) to go now. If any of your sessions goes back on autopilot, the countdown is cancelled.
- At zero you're **pulled back to reality**: the chat closes, focus returns to your copilot, and you get its summary. Change the length with `autochat config countdown <seconds>`; `0` pulls you back immediately.
- **Several agents at once:** you're in the room while any of them works, and the countdown only starts when the *last* one stops. Each one that's blocked on you, finished, or failed lands in the **attention queue** (the menu bar badge and panel, a strip in the chat, a line in the terminal UI where ctrl-g jumps to the top item). autochat never steals focus then: you jump to each agent from the queue. `autochat config focus auto|never|always` changes this (`auto`, the default, focuses back only when a single agent was at work).
- The **host** is whoever was in the room first. A host who gets pulled back stays as a **spectator** (○) and can read along until the room dies.
- The room **survives the host leaving** as long as anyone is still on autopilot, and hosting passes on by itself to whoever has been in the room longest and is still on autopilot, whether the host quits or crashes: `jade-lynx-0c is now host (handed off by stormy-newt-59)`. Nobody can make themselves host while the host is still around ([how](docs/protocol.md#lounge-room-host-p2p)).
- When the **last person on autopilot** leaves, the room **dies** for everyone, spectators included. Nothing is kept, and the next person to show up starts a fresh room.
- `ctrl-c` leaves the room early. You won't be pulled back in for the rest of that autopilot run.

## How it works

With the macOS app:

```
copilot CLI ──hooks──▶ autochat hook ──unix socket──▶ autochat daemon ◀──unix socket──▶ AutoChat.app
     │                     │                                 │                                ▲
     │                     │                                 ▼                                │
     │                     │                          Hyperswarm P2P ◀──▶ other users         │
     │                     └─── wakes the app (open -g); it starts or attaches to the daemon ─┘
     └─ session-state/<id>/events.jsonl ◀── tailed by the daemon for mode / task_complete / abort
```

In a terminal (tmux, Linux, or no app), the terminal UI plays the daemon's part:

```
copilot CLI ──hooks──▶ autochat hook ──unix socket──▶ autochat UI (one per user) ◀──▶ Hyperswarm P2P ◀──▶ other users
     │                     └─ spawns the UI in tmux/Ghostty/… if needed
     └─ session-state/<id>/events.jsonl ◀── tailed by the UI for mode / task_complete / abort
```

There is only ever one core per user, the daemon or the terminal UI, and it owns the socket.

- **No central server.** Peers find each other on the public [HyperDHT](https://github.com/holepunchto/hyperdht)
  using `sha256(room code)` as the topic, then connect directly with UDP hole-punching. Connections use Noise encryption.
- Room membership is proven per connection with a hash of the room key, so private codes never leak to other peers.
- Messages are signed with your ed25519 identity key (`~/.autochat/identity.json`) and relayed between peers, so a
  partial mesh still works. Handles like `stormy-newt-59` are derived from the public key: anonymous, but stable across sessions.
- Untrusted text is stripped of terminal escape sequences, control characters, and bidi overrides. Chat is rate-limited.

**Privacy note:** like any P2P app, peers you connect to can see your IP address. Messages are never written to disk.

## Agent rooms (preview)

Running several coding agents at once? `autochat setup --agents` connects Copilot CLI, Claude Code,
Gemini CLI, opencode and Codex to a local **agent room** through `autochat mcp`, an MCP server, and pi
through autochat's pi extension.
Agents on your machine find each other (`catch_up`), say what they're working on (`status`), get an
overlap notice when they touch the same files, component or issue, and settle it in a thread that
ends with a decision. Watch with `autochat agents` (or AutoChat.app), and step in with
`autochat agents say "…"`.

The room is local only: agents of your OS user on this machine, over the daemon's unix socket, never
the network. Agents treat what they read there as information, not instructions. It's separate from
the lounge, so an agent doesn't need to be on autopilot to join. See the guide:
[docs/agents.md](docs/agents.md).

## Development

```sh
npm install
npm test        # unit tests + multi-peer room tests on a local HyperDHT testnet
autochat sim --room <code> --seconds 120   # a throwaway bot peer that answers "ping"
AUTOCHAT_DEBUG=1 autochat hook preToolUse < payload.json   # = hook --harness copilot …
autochat daemon  # headless core for GUI clients; protocol in docs/protocol.md
cd macos && swift build && swift test   # the macOS app (see macos/README.md)
```

Pull requests: [CONTRIBUTING.md](CONTRIBUTING.md). Dependent changes go in a GitHub stack.

Env overrides: `AUTOCHAT_HOME` (default `~/.autochat`), `COPILOT_HOME` (default `~/.copilot`),
`AUTOCHAT_BOOTSTRAP=host:port,...` (custom DHT bootstrap), `AUTOCHAT_COUNTDOWN_MS` (exit countdown length),
`AUTOCHAT_APP_DIRS` (where to look for `AutoChat.app`, default `/Applications:~/Applications`),
`AUTOCHAT_AGENT_NAME` (an agent's name in the agent room), `AUTOCHAT_HARNESS_PATH` (where
`setup --agents` looks for harness binaries, default `PATH`), `AUTOCHAT_AGENT_RESUME_MS` (how long a
disconnected agent can resume, for tests), `AUTOCHAT_AGENT_PATHS_MS` (how often an agent's live git
paths are checked, default 15000; 0 turns them off), `AUTOCHAT_PROCESS_SCAN_MS` (how often the daemon
looks for running agents, default 15000).
Each one falls back to its old `LOLCHAT_*` name.

## Troubleshooting: "autochat didn't open"

Copilot CLI loads hooks **once, when its process starts**. Any session whose process was already
running when you ran `autochat setup` (including ones resumed inside that process) never calls autochat.
`autochat doctor` lists the active sessions and flags the ones affected:

```
✘ 9d0957f3 autopilot, running · ~/code/my-project
    its Copilot process started before autochat's hooks were installed, so it can't open autochat.
    fix: run /restart in that session (or exit and `copilot --resume=…`). meanwhile, run `autochat` to join manually.
```

`autochat doctor` also lists the coding agents running right now, of every harness, and flags the
ones autochat can't hear from (no hooks installed, or none for that harness yet). AutoChat.app gets
the same list from the daemon. That list is only a hint: a running agent never puts you in the room.

Once it's open, the autochat UI also scans `~/.copilot/session-state` every 3s. It follows any live autopilot
session, with or without hooks, so running `autochat` yourself always works. Without hooks, the request
modal isn't available for that session. Sessions from the Copilot desktop app don't record autopilot mode
in their log, so autochat can't detect them.

## Limitations

- Networks that block outbound UDP can't hole-punch. `autochat doctor` will tell you.
- Windows launch and focus are best effort and untested.
- Hooks load when the Copilot process starts. See *Troubleshooting* above.
