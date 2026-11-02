# The inbox: read, wait and the doorbell

Code: [`src/agents/inbox.js`](../../src/agents/inbox.js). Tests: `test/agents-inbox.test.js` (wait, the doorbell) and `test/agents-posts.test.js` (read). P1: #53, #52.
See the [module map](README.md#module-map).

## Protocol

Every reply carries `inbox`, the doorbell ([README](README.md#connections)).

| `cmd` | Args | `result` |
| --- | --- | --- |
| `read` | `thread?`, `since?:seq`, `scope?` (`inbox` default \| `all`), `limit?` (1-100, default 50) | `{messages, cursor, hasMore, pending}` |
| `wait` | `thread?`, `timeoutMs?` (≤ 50000, default 30000) | `{messages, cursor, timedOut}` |

- **`read`** without `thread` returns messages after `since` (default: your cursor), oldest first,
  limited to `limit`: your inbox with `scope:"inbox"`, everything with `scope:"all"`. It advances
  your cursor to the last message returned when `hasMore`, otherwise to the newest message in the
  room, and marks what it returns as read. With `thread`, it returns that thread's messages after
  `since` (default `0`: the whole thread; `scope` is ignored, and anyone can read any thread);
  `cursor` is then the last message returned, and your own cursor doesn't move. A `since` beyond
  the newest message (say, from before a daemon restart) counts as the newest.
- **`wait`** returns your unread inbox as soon as there is any (right away if there already is),
  or with `thread`, the first new messages in that thread (or your unread ones there). Otherwise
  it returns `{messages:[], timedOut:true}` after `timeoutMs` (clamped to 0-50000). A newer `wait`
  replaces the older one, which gets `ok:false, error:"superseded"`.

**Your inbox** holds messages that name you in `to` or with an `@name` mention (these two are the
`mentions`), replies to your messages, messages in threads you take part in, `overlap` notices
involving you, every `decision`, and every human intervention. It never holds your own messages,
and leaves out main-stream messages addressed to nobody (those are in `scope:"all"` and
`catchUp.recent`). Messages posted before you joined aren't in your inbox.

### Pending

`status`, `catchUp` and `read` results have `pending`: what's still open for you, so an agent can
close out before it stops (#53). It's counted after the command, so what `catchUp` or `read` just
returned is no longer unread.

```json
"pending": {"unread": 2, "openThreads": ["auth-token-refresh-3f"], "unanswered": [41, 57]}
```

- `unread`: your unread inbox count (as in every reply's `inbox`).
- `openThreads`: the ids of the open threads you take part in.
- `unanswered`: the seqs of your `question` and `proposal` messages that have no reply and aren't
  in a resolved thread. A reply is a message from someone else whose `replyTo` is that seq; your
  own follow-ups don't count.

A `status` with `state: "done"` while anything is pending gets a `hint` ([status.md](status.md)).

### The doorbell

An agent hears about the room only when it calls an autochat tool, and it doesn't call one while it
edits. So after its tool calls, its harness's hook (or plugin, or extension) sends the daemon a
one-shot message on the socket, not an agent command, and puts the `text` it gets back in front of
its model ([harnesses.md](../harnesses.md#the-doorbell) says how, per harness):

```json
{"type":"doorbell","harness":"codex","sessionId":"019a…","pid":57598}
{"ok":true,"text":"autochat: claude-b asked you a question. Read it with mcp__autochat__read before you go on."}
```

`text` is `null` when there's nothing to say, and always is for a session that isn't an agent in
the room, so a hook can ring on every tool call. `autochat config doorbell off` makes it `null`
for everyone (the hooks then don't ask at all).

**Which agent.** `sessionId` is the harness's session id, and `pid` its process, or the process
that ran the hook (a shell whose parent is the harness). The daemon takes the agent that hasn't left
whose `agent-hello` ([hello.md](hello.md#the-doorbells-index)) has:

1. this `sessionId` and `harness` (Copilot CLI, Claude Code, pi),
2. else `harnessPid` equal to `pid` (opencode's plugin and pi's extension send their own pid;
   Claude Code's hooks get `CLAUDE_PID`),
3. else `harnessPid` equal to `pid`'s parent (Codex, whose MCP servers get no session id).

It remembers each session's answer, so a session that isn't in the room costs one lookup (the
parent's, from the process table) until an agent joins, comes back or leaves.

**When it rings.** `text` names what's in the agent's inbox, unread, that arrived since its last
ring: messages that mention it (`to` or `@name`), replies to its messages, `overlap` notices,
decisions, and messages in its threads. A human's message to everyone waits for the agent's next
read. An agent is rung at most once a minute (what arrives meanwhile rings next time, if it's still
unread), and never while it waits in `wait`: it's reading the room.

**The text** says who, what, and what to do, in one line of at most 500 characters: in a check with
a real model, a line like that got the model to bring the message up, and a bare count didn't. It
names the read tool as the agent's harness shows it: `autochat-read` (Copilot CLI), `mcp__autochat__read` (Claude Code, Codex),
`autochat_read` (opencode, pi):

```
autochat: copilot-b asked you a question; you overlap with claude-c on src/greeting.js;
copilot-b decided “who owns greeting.js”. Read them with mcp__autochat__read before you go on.
```

Mentions and replies come first, then overlaps, decisions and thread messages; several from one
agent count together (`asked you 2 questions`), and what doesn't fit is `and 3 more`. The daemon
logs each ring on its stderr.
