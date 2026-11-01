# Overlap

Code: [`src/agents/overlap.js`](../../src/agents/overlap.js). Tests: `test/agents-overlap.test.js`. P1: #56.
See the [module map](README.md#module-map).

## Protocol

| `cmd` | Args | `result` |
| --- | --- | --- |
| `paths` | `paths` (≤ 200 paths) | `{overlaps:[{agent, on:{issue?, components?, paths?}}]}`, plus `deferred:true, appliesInMs` when it waits |

Two agents overlap when they have the same non-null `repo` (case-insensitive) and any of:

- the same `focus.issue`,
- a shared component, compared normalized ([below](#components)),
- a shared path, from `focus.paths` or `focus.live`: equal, or one is a directory prefix of the
  other on path-segment boundaries (`src` covers `src/room.js`; `src/ro` doesn't).

A new overlapping pair gets one `overlap` message addressed to both (`to: [a, b]`), on the main
stream, such as "copilot-x and claude-web both touch src/room.js" (at most 3 paths are named,
then "(+N more)"). Cards list their current `overlaps`. A pair is notified again only after the
overlap clears and comes back. Overlaps are recomputed when either card changes (`status` or
`paths`). An away agent keeps its overlaps, since it may resume; an agent that left overlaps with
no one, and the other cards drop their overlaps with it.

### Live paths: `paths`

```jsonc
card.focus = {"issue":17,"components":["room"],"paths":["src/room.js"],
              "live":["src/room.js","test/room.test.js"]}
```

- **`paths`** sets the card's `focus.live`: the files the agent's worktree touches right now,
  which its client reads from git, so overlaps show up without waiting for the agent's next
  `status`. `paths` is a list of at most 200 repo-relative paths of ≤ 300 characters, normalized
  like `focus.paths` (no `./`, no trailing `/`, no duplicates); `[]` or `null` clears it. The
  result has your current `overlaps`, as `status`'s does.
- It isn't subject to the 5 s `status` rule, and it doesn't change `updatedAt`. At most one
  `paths` applies every 2 s: one that comes sooner succeeds with `deferred: true` and
  `appliesInMs` (and the `overlaps` from before it), and the latest of those applies when the
  2 s are up.
- A new agent's `focus.live` is `[]`; a resume keeps it.
- `autochat mcp` and autochat's pi extension send `paths` while they're connected: the same files
  `status` adds from git (`git status`, plus what the branch changed since it left the default
  branch). They check every 15 s, and after a tool call when the last check is that old, and send
  only when the files changed (and once after each connect). The timer is there because the
  server sees only its own tool calls, not the agent's edits. See
  [agents.md](../agents.md#the-mcp-server-autochat-mcp).

### Components

Components are compared normalized: lowercase; runs of spaces, `_`, `.` and `-` become one `-`,
with none at either end; and each word (between `-`) longer than 3 letters drops a trailing `s`.
So `Greetings`, `greeting` and `GREETING` match, and so do `agent_room`, `Agent Room` and
`agent.rooms`. Cards keep the strings the agents gave.

`status` results carry **`knownComponents`**: up to 20 components from the other cards of your
repo (including agents that left, while their cards linger), the most recently updated card
first, one spelling per normalized name. Reusing them keeps overlaps by component visible.
