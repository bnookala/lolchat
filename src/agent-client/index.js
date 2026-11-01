// The client side of the daemon's agent protocol (docs/agent-room/README.md): who an agent is
// (its hello), a persistent connection to the daemon, and the six agent-room tools as calls on
// it. `autochat mcp` (src/mcp.js) serves these tools over MCP; the pi extension
// (src/harness/pi-extension.js) registers them as pi tools. Only the local unix socket: it never
// opens a network connection and never holds keys.
//
//   binding.js       which harness runs us, git facts, the hello, auto paths, live paths
//   client.js        the daemon connection (DaemonLink) and waking AutoChat.app
//   instructions.js  the etiquette
//   tools/<tool>.js  one tool each: its definition and its call; tools/index.js has TOOLS and Tools

export { HARNESSES, matchHarness, psTable, parseRemote, gitInfo, agentHello, bindSession, changedPaths } from './binding.js'
export { AGENT_PATHS_MS, parseStatusV2, livePaths, syncLivePaths } from './binding.js'
export { NOT_RUNNING, DaemonLink, wakeApp } from './client.js'
export { instructions, INSTRUCTIONS } from './instructions.js'
export { TOOLS, Tools } from './tools/index.js'
