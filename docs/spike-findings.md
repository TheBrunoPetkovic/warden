# Warden — Phase 0 spike findings

Machine-verified against local installs. `opencode 1.18.32` / SDK `1.18.33`, `codex-cli 0.144.1`, Node 24.18.0.

## opencode adapter — GO

Full approval loop proven: `promptAsync` -> `permission.asked` -> `POST /session/{id}/permissions/{permissionID}` -> `permission.replied` -> tool completes -> `session.idle`.

### Client split is mandatory

Two clients, two jobs. The v2 client has a **request-body serialization bug** (bodies silently dropped), so it is only usable for endpoints that take no body.

| Use | Client | Call |
|---|---|---|
| session create | v1 | `client.session.create({ directory })` |
| list / messages | v1 | `client.session.list({})` |
| send prompt (blocking) | v1 | `client.session.prompt({ sessionID, parts })` |
| send prompt (non-blocking) | v1 | `client.session.promptAsync({ sessionID, parts })` |
| pending permissions | v1 | `client.permission.list({})` |
| global event stream | v2 | `client.event.subscribe()` |

v1 `create` returns `{ data: { id, slug, projectID, directory, cost, tokens, time } }` — cost and tokens per session are free for the dashboard.

v2 `list` returns `{ data: { data: [...] } }` — **double nesting**, unlike v1's `{ data: [...] }`.

### Port allocation

`createOpencodeServer({ port: 0 })` **ignores 0** (falsy -> falls back to 4096). If 4096 is taken the SDK silently picks a random port, which makes the URL unpredictable. Warden must allocate a free port itself and pass it explicitly.

4096 is commonly held by the user's own opencode TUI server. Never assume it.

### Always spawn via the SDK, never raw `opencode serve`

The TUI starts its own server. Reusing it couples Warden to the user's interactive session and makes ownership ambiguous — cannot shut it down, `process.exit` leaks the child. `createOpencodeServer({ hostname, port, signal })` + `AbortController` gives clean lifecycle.

### One global SSE stream, not per-session

`client.event.subscribe()` emits everything; filter by `properties.sessionID`. `client.v2.session.events({ sessionID })` returns **an empty stream** — do not use it. A single connection serves all sessions, which is what the multi-session dashboard needs.

Observed event types: `session.updated`, `session.status` (`busy` / `idle` / `retry`), `session.idle`, `session.diff`, `message.updated`, `message.part.updated`, `message.part.delta`, `permission.asked`, `permission.replied`, `server.heartbeat`, `server.connected`, plus plugin/catalog noise to filter.

`message.part.updated` carries the tool lifecycle: `part.type === "tool"`, `part.tool`, `part.state.status` (`running` / `completed` / `error`).
`message.updated` carries `info.tokens` and `info.cost` — live spend tracking.
`message.part.delta` gives token-level streaming.
`session.diff` is emitted on change — feed the permission console.

### `prompt` blocks; use `promptAsync`

`session.prompt()` resolves only when the turn finishes. With a human in the approval loop the request hangs indefinitely (observed: >120 s). Any UI that waits on a human must use `promptAsync`, which returns `{"data": null}` immediately.

### Permission API — call the HTTP endpoint directly

```
POST {base}/session/{sessionID}/permissions/{permissionID}
body: {"response": "once" | "always" | "reject"}
-> 200, body "true"
```

`client.permission.reply({ requestID, body: { reply } })` is a **different** endpoint (`/permission/{requestID}/reply`). `client.permission.respond({ sessionID, permissionID, body: { response } })` is the right shape but drops the body via the SDK bug. Direct `fetch` is what ships.

Payload is UI-ready:
```json
{ "id": "per_...", "sessionID": "ses_...", "permission": "bash",
  "patterns": ["echo WARDEN_PERM_PROBE"],
  "metadata": { "command": "echo WARDEN_PERM_PROBE" },
  "always": ["echo *"],
  "tool": { "messageID": "msg_...", "callID": "call_..." } }
```
`always` carries a pre-generated allow pattern — the "always allow" button can ship it without guessing.

### Forcing permissions

Permissions are agent-level, not session-level. `session.create` accepts only `parentID` / `title`. To exercise the approval path, write `opencode.json` into the project dir:
```json
{ "permission": { "edit": "ask", "bash": "ask" } }
```
Keys: `edit`, `bash` (string or pattern map), `webfetch`, `doom_loop`, `external_directory`. Values: `ask` | `allow` | `deny`.

### Other useful surface (unverified)

`session.children` (subagent tree), `session.diff`, `session.todo`, `session.fork`, `session.compact`, `v2.session.wait`, `v2.session.active`, `pty.*` (WebSocket PTY), `ExperimentalSessionBackground`. Each needs a test before it goes in the adapter.

## Codex adapter — use `app-server`, not `exec`

`codex exec` is fine for one-shot work but has **no approval handshake**: non-interactive mode has no TTY, so it cannot ask. `read-only` auto-denies (the agent just reports the failure) and `workspace-write` auto-allows. No approval event is ever emitted.

`codex app-server` is a full JSON-RPC server with officially generated TypeScript bindings. This is the Codex equivalent of opencode's server and gives full parity.

### Transport and codegen

```
codex app-server --listen stdio://      # default; also unix://, unix://PATH, ws://IP:PORT
codex app-server generate-ts --out DIR          # official TS bindings
codex app-server generate-json-schema --out DIR
```

`generate-ts` emits ~90 typed files (`ExecCommandApprovalParams`, `ApplyPatchApprovalParams`, `ThreadId`, `ReviewDecision`, ...). Regenerate on upgrade rather than hand-writing a client.

### Methods that matter

Client→server: `initialize`, `thread/start`, `thread/resume`, `thread/list`, `thread/read`, `thread/fork`, `thread/rollback`, `turn/start`, `turn/interrupt`, `turn/steer`, `thread/approveGuardianDeniedAction`, `thread/compact/start`, `fs/*`, `model/list`, `permissionProfile/list`, `getAuthStatus`.

`turn/steer` injects guidance into a turn already in flight — worth having in the UI.

Server→client (Warden must answer these): `execCommandApproval`, `item/commandExecution/requestApproval`, `applyPatchApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval`, `item/tool/requestUserInput`, `item/tool/call`, `mcpServer/elicitation/request`, `attestation/generate`, `account/chatgptAuthTokens/refresh`.

### Approval payloads

`ExecCommandApprovalParams` = `{ conversationId, callId, approvalId, command: string[], cwd, reason, parsedCmd }`

`ApplyPatchApprovalParams` = `{ conversationId, callId, fileChanges, reason, grantRoot }` — `fileChanges` is the **diff to preview before approving**, which is the permission-console feature.

Both answered with `{ decision: ReviewDecision }` where
`ReviewDecision = "approved" | "approved_for_session" | "denied" | "timed_out" | "abort" | { approved_execpolicy_amendment: ... } | { network_policy_amendment: ... }`.

### `codex exec --json` (no approvals, still useful)

Clean JSONL on stdout:
```
thread.started   { thread_id: <uuid> }        <- resume handle
turn.started
item.started     { id, type, command, status: "in_progress" }
item.completed   { id, type, command, aggregated_output, exit_code, status }
turn.completed   { usage: { input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens } }
```
Item types seen: `agent_message`, `command_execution`.

`codex exec resume <thread_id> "follow-up"` works and the agent recalls prior context — verified, it correctly reported output from the earlier turn. This is the clean "send a message to an existing session" that Claude Code lacks.

Two operational notes: codex logs `ERROR rmcp::transport::worker: Auth(AuthorizationRequired)` to **stderr** on every run (MCP transport, unrelated to the run — must not be parsed as agent output), and it prints `Reading additional input from stdin...` when stdin is a pipe, so pass stdin explicitly.

Useful flags: `-C/--cd`, `-s/--sandbox read-only|workspace-write|danger-full-access`, `--json`, `--skip-git-repo-check`, `--output-last-message FILE`, `--ephemeral`, `-c key=value`.

### Still untested for Codex

- live `app-server` handshake end to end (only codegen inspected so far)
- approval round trip over the real transport
- `turn/steer` behavior
- `thread/list` / `thread/resume` shape

## Not yet tested

- `session.children` subagent tree
- session resume / fork round-trip
- reconnect + `after` sequence replay (the `history` endpoint shape)
- multi-session fan-out on one global stream
- question/answer flow (`question.reply` / `question.reject`)
- Claude Code adapter (not installed on this machine)
- live codex app-server approval round trip
