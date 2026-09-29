# Warden

A local control room for CLI coding agents. Launch them, watch them work, and approve what they do.

> **Status: Phase 0 complete.** Both adapters are validated end to end — including the permission approval loop. No UI yet. See [Roadmap](#roadmap).

---

## The problem

Agent CLIs got *very* good at work and very bad at supervision.

`claude agents`, `opencode`, and `codex` all run agents in the background now, and all three give you a way to *launch* them. None give you a way to *watch several at once* in a browser, and none give you a good way to say "yes, do that" when a tool call needs a human.

So you end up with terminal tabs. Six agents means six tabs, and you find out what happened by scrolling up through scrollback. Worse, approval prompts are blocking and modal — one agent asking permission freezes the tab you're looking at.

Warden is a local web app that:

- **launches** agents itself, so it owns the process and the session handle
- **streams** every event from every agent onto one canvas
- **surfaces permission requests** as a real approve/deny queue, with the diff in front of you

It is deliberately not a wrapper around your existing terminal sessions. If you started an agent outside Warden, Warden does not see it. That is the trade: you give up seeing stray sessions, you get full control.

## Why this is technically possible at all

The three CLIs looked equally opaque from the outside. They are not. They differ a lot, and the architecture follows the difference.

| | opencode | Codex | Claude Code |
|---|---|---|---|
| Control surface | HTTP server + SDK | `app-server` JSON-RPC | print mode, no server |
| Event stream | global SSE | JSON-RPC notifications | `agents --json` polling |
| Send follow-up | `session.prompt()` | `thread/resume`, `turn/steer` | `--resume` (unreliable) |
| Approvals | `permission.asked` event + HTTP reply | `execCommandApproval` server request | `PreToolUse` hook |
| Typed codegen | shipped SDK | `app-server generate-ts` | none |

This was reverse-engineered by running the tools, not by reading docs. The findings are in [`docs/spike-findings.md`](docs/spike-findings.md) and several were not in any documentation.

### Findings that would have cost a day each

- **opencode's v2 SDK client silently drops request bodies.** Every write endpoint returns `Expected object, got undefined`. The v1 client works. You end up running two clients for one service.
- **`port: 0` is ignored** by `createOpencodeServer` — `0` is falsy, so it falls back to `4096`. If 4096 is busy it silently picks a random port instead, so you cannot predict your own URL.
- **`session.prompt()` blocks until the turn completes.** In a UI where a human approves tools, the HTTP request hangs forever. `session.promptAsync()` is mandatory, not an optimization.
- **`codex exec` has no approval handshake.** Non-interactive mode has no TTY, so it cannot ask: `read-only` auto-denies and `workspace-write` auto-allows. Any approval UX has to go through `codex app-server`.
- **Codex logs MCP auth errors to stderr on every run**, which is not agent output. Naive log scraping shows phantom errors on a perfectly healthy run.

## Architecture

One adapter interface, two implementations, one global event stream per runtime.

```
┌──────────────┐
│  Browser UI  │  sessions, live canvas, approval queue
└──────┬───────┘
       │  SSE  (one connection, all sessions)
┌──────┴───────┐
│  Warden core │  normalizes runtime events → one event model
└──┬────────┬──┘
   │        │
┌──┴───┐  ┌─┴────────────┐
│opencode│ │codex          │
│serve   │ │app-server     │
│(SDK)   │ │(generate-ts)  │
└────────┘  └───────────────┘
```

Filtering by `sessionID` on a single global stream beats one connection per session. opencode alone emits ~46 `plugin.added` events on startup, so the normalizer drops plugin/catalog noise.

## Quick start

```bash
git clone https://github.com/TheBrunoPetkovic/warden
cd warden
npm install
```

Run the spikes that produced the findings:

```bash
npm run spike:opencode    # full approval loop: prompt → permission.asked → reply → tool → idle
npm run spike:codex       # JSONL event stream + resume
```

Each writes a throwaway sandbox under `spike/` and cleans up after itself.

## Roadmap

| Phase | Goal | State |
|---|---|---|
| 0 | Validate all runtime interfaces | **done** |
| 1 | Vertical slice: launch, stream, reply to one agent | next |
| 2 | Permission console — the actual differentiator | |
| 3 | Cross-runtime view, unified event model | |
| 4 | Claude Code adapter | blocked, not installed |
| 5 | Visual layer: canvas, tool graph, subagent tree, file heatmap | |
| 6 | Orchestration: pipelines, forks, token budgets | |

Phase 5 is last on purpose. The graph is the least differentiated part and the most work. If the stack is right by Phase 1, the graph is just rendering.

## Contributing

Issues and PRs welcome. If you have a CLI agent that is not in the table above, an adapter for it is probably the most useful contribution — the interface is deliberately narrow.

## License

MIT
