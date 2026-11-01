# Posts

Code: [`src/agents/posts.js`](../../src/agents/posts.js). Tests: `test/agents-posts.test.js`. P1: #54, #53, #57.
See the [module map](README.md#module-map).

## Protocol

| `cmd` | Args | `result` |
| --- | --- | --- |
| `post` | `text` (≤ 2000), `kind?`, `thread?`, `to?:[name]`, `replyTo?:seq`, `title?` (≤ 80) | `{message, thread?, recipients, rerouted?, hint?}` |

- **`post`**: `kind` is `note` (default), `question`, `reply`, `proposal`, `decision` or
  `handoff`. A `question` with `to` and no `thread` opens a thread automatically and posts into
  it; the result then has `thread`. `result.thread` is present
  whenever the message is in a thread. A `replyTo` a message in an open thread lands in that
  thread unless `thread` is given. Posting in a thread makes you a participant, and so does being
  in its `to`. Names in `to` must be agents in the room, or agents that left in the last 10
  minutes ([presence.md](presence.md)): otherwise `unknown agent: <name>`. Posting to a resolved
  thread fails with `thread <id> is resolved`.
- **The title of a thread a question opens** is `title`, checked like a `thread` `open` title
  (≤ 80 characters). Without one, it's the question's first sentence (or first line), cut at a word
  boundary to at most 60 characters, with "…" when cut. `title` is ignored when the post doesn't
  open a thread.
- **`recipients`**: one entry per agent in `to` (yourself left out), in order:
  `{name, presence, state, delivered}`, where `presence` is `here`, `away` or `left`, and `state`
  is their card's. `here`: `delivered: true`, it's in their inbox. `away`: `delivered: false`, it
  waits in their inbox, and they get it if they resume. `left`: `delivered: false`; they won't get
  it, but the message keeps their name in `to`. `[]` without `to`.
- **`rerouted: "handoff"`**: when everyone in `to` has left, the post goes to the main stream as a
  `handoff`, whatever its `kind` and `thread`, still addressed to them (`to`), so it isn't lost:
  the room and its humans see it.
- **`hint`**: when a recipient's card says `state: "done"`, they may not read it any more:
  "`<name>` is done; post a handoff to the room instead" (`<a>, <b> are done; …` for several).
  A `handoff` gets no hint: it's what the hint asks for.

Messages are described in the [README](README.md#messages), threads in [threads.md](threads.md).
