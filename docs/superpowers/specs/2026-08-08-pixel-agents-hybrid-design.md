# Hybrid Agent Orchestration Surface — Design

Date: 2026-08-08
Status: Approved (design), implementation in progress
Fork of: `pixel-agents-hq/pixel-agents` @ v1.4.0

## Goal

Turn pixel-agents from an agent _viewer_ into an orchestration surface for a
mixed fleet of Claude Code and Codex agents, driven by the existing `bizops`
control plane. Agents are managed like employees: they have persistent
identities, desks they return to, and states you can read at a glance.

## Decisions

Four decisions were settled during brainstorming. Each closes off alternatives
that would otherwise resurface during implementation.

| Decision                    | Choice                                                 | Rejected                                   |
| --------------------------- | ------------------------------------------------------ | ------------------------------------------ |
| Where authority lives       | `bizops` is the brain; the office is the face          | office as hub; observability-only          |
| Relationship to upstream    | Our own copy (fork), upstream the Codex provider later | upstream-first; sidecar-only; vendor+patch |
| What a character represents | A roster employee, persistent across sessions          | a session (upstream's model)               |
| What the office can do      | Start an agent; answer a stuck one                     | stop/pause; message a running agent        |

`bizops` holds the registry, scheduler, runner, and ledger. It already exists and
is not rewritten by this work. The office becomes a rendering and input surface
over it.

## Architecture

One process. `bizops` embeds the forked office server as a library rather than
running it as a separate service.

```
┌──────────────────── bizops (single process) ─────────────────────┐
│                                                                  │
│  registry · scheduler · runner            (existing)             │
│  ledger: agents, runs, events, cost, escalations   (existing)    │
│                          │                                       │
│                          ▼                                       │
│                  office runtime          (from fork)             │
│                  AgentStateStore, seats, characters              │
└──────────────────────────┬───────────────────────────────────────┘
                           │  WebSocket
                      browser: the office
```

Rejecting two processes is deliberate. With `bizops` as the authority, a
separate office server would hold a second copy of "what is running" that can
drift from the ledger. A single process makes the ledger the only copy.

### Three event sources, one runtime

| Source                   | Mechanism                                       | Notes                              |
| ------------------------ | ----------------------------------------------- | ---------------------------------- |
| bizops-launched agents   | direct in-process calls                         | The managed fleet. No network hop. |
| Hand-started Claude Code | existing hook script → `POST /api/hooks/claude` | Already works upstream. Free.      |
| Codex sessions           | tail `~/.codex/sessions/**/rollout-*.jsonl`     | New. Does not exist upstream.      |

The office never learns which source an agent came from. It renders
`AgentEvent`s; the provider layer is the only place that knows CLI specifics.

## Identity: employees, not sessions

Upstream binds one character to one session — the character disappears when the
session ends. That cannot express an idle employee, and "who is free right now"
is the central question when managing a fleet.

Seats are therefore driven by the `bizops` roster (`src/ledger/agents.ts`), not
by live sessions.

Desk states:

| State   | Meaning                                     |
| ------- | ------------------------------------------- |
| Idle    | roster entry with no active run — available |
| Working | active run; animation driven by live events |
| Stuck   | open escalation, awaiting a human decision  |
| Off     | disabled in the roster                      |

Idle employees are visible by default.

### Walk-ins

Claude or Codex sessions started outside `bizops` have no roster entry. They are
seated in a separate area, visually distinct, and removed when their session
ends. They are observable but not controllable (see Controls).

### Deduplication

If `bizops` ever launches Codex via the Codex CLI, two independent sources
observe the same agent: `bizops` (which started it) and the rollout-log watcher
(which sees any Codex session). Without deduplication this renders one employee
as two characters, one of them a phantom.

Codex's `conversationId` appears in both `~/.codex/process_manager/chat_processes.json`
and in the rollout files, and is the dedup key. Deduplication happens before an
event reaches a seat.

## Controls

### Start an agent

The office sends intent; `bizops` decides mechanism.

```
office  →  { employeeId, task, cwd }
bizops  →  roster lookup determines Claude vs Codex
        →  write run row
        →  launch
        →  events flow back
```

The office never launches a process and never knows which CLI backs an
employee. This is what allows a third harness to be added without touching the
UI.

### Answer a stuck agent

`bizops` already has `src/ledger/escalations.ts` and its test suite. This work
adds a face and a return path.

```
agent requests a privileged action
  → bizops parks the run, writes an escalation, marks the desk Stuck
  → office shows a bubble; click reveals the request
  → Approve / Deny
  → bizops resolves the parked call; the run continues
  → ledger records the decision, the decider, and the time
```

**Timeout is mandatory.** A parked run waits indefinitely by default, and a
stuck character looks calm — the failure is silent. Escalations auto-deny after
a configurable interval, recorded as a timeout rather than a human decision.

### Limits accepted for v1

Hand-started Claude sessions cannot be answered from the office. The hook script
is fire-and-forget: it posts and exits, with no channel back. Making it
two-way would require the hook to block until a human clicks, which hangs the
Claude session whenever the office is not running. Walk-in bubbles are therefore
informational.

Full control over the managed fleet; observation only for walk-ins.

## Upstream constraint discovered during exploration

The upstream `CLAUDE.md` states that adding a CLI integration is "one
subdirectory ... zero changes to the runtime." That is not true as of v1.4.0.
The interface is multi-provider; the runtime is not:

- `server/src/hookEventHandler.ts` — `handleEvent(_providerId, event)` ignores
  the provider id and always uses a single injected provider.
- `server/src/fileWatcher.ts:571` — `let hookProvider: HookProvider | null` is a
  module-level singleton.
- `server/src/agentRuntime.ts` — accepts exactly one `HookProvider`.

Only `httpServer.ts` genuinely routes by `providerId`.

Consequence: the Codex provider alone yields Claude _or_ Codex, not both.
Multi-provider runtime support is separate, larger, and the part most worth
contributing upstream.

### Session directory shape

`scanGlobalProjectDirs` walks `root/<dir>/*.jsonl` — exactly two levels. Claude
matches (`~/.claude/projects/<hash>/*.jsonl`). Codex nests four levels
(`~/.codex/sessions/2026/08/05/rollout-*.jsonl`).

Rather than change the scanner, `getAllSessionRoots()` returns Codex _month_
directories (`~/.codex/sessions/2026/08`), whose immediate children are day
directories containing the rollout files. The existing scanner then works
unmodified. Roots are recomputed per call, so month boundaries need no special
handling.

## Codex event mapping

Rollout records carry `type` at the top level and a `payload.type` beneath it.

| Codex record                             | `AgentEvent`                                        |
| ---------------------------------------- | --------------------------------------------------- |
| `session_meta`                           | `sessionStart` (with `cwd` from the payload)        |
| `event_msg: task_started`                | turn begins                                         |
| `response_item: custom_tool_call`        | `toolStart`                                         |
| `response_item: custom_tool_call_output` | `toolEnd`                                           |
| `event_msg: patch_apply_end`             | `toolEnd` for an edit — drives the typing animation |
| `event_msg: agent_message`               | assistant text                                      |
| `event_msg: task_complete`               | `turnEnd`                                           |
| `event_msg: token_count`                 | context usage                                       |

`token_count` is a bonus: Codex reports token usage natively, feeding both the
context gauge and the `bizops` cost ledger.

Codex has no hooks API, so `installHooks` / `uninstallHooks` are no-ops and
`areHooksInstalled()` returns `false`. Detection is file-fallback only. One pure
function normalizes a rollout record; both `parseTranscriptLine` and
`normalizeHookEvent` delegate to it, so a future push-based source needs no
second mapping.

## Error handling

The ledger is the source of truth; the office is a projection. Anything on
screen is rebuildable by re-reading the ledger.

| Failure                   | Behavior                                                                               |
| ------------------------- | -------------------------------------------------------------------------------------- |
| Office closed             | No effect on agents. State redraws from the ledger on reconnect.                       |
| bizops crashes mid-run    | Runs marked interrupted (status already exists). Resumable via existing resume wiring. |
| Malformed rollout line    | Skipped; the watcher continues. Partial writes are normal when tailing.                |
| Duplicate observation     | Deduped on `conversationId` before reaching a seat.                                    |
| Stale server registration | Existing upstream behavior: hook POST times out against a dead port.                   |
| Unanswered escalation     | Auto-denied after timeout, recorded as a timeout.                                      |

**Event ordering.** Log files are read in chunks, so a `task_complete` can be
parsed before the tool call preceding it. Events are treated as timestamped
observations, not commands; desk state is computed from the newest known
observation. Treating them as commands produces characters that twitch and
misreport.

## Testing

Follows the existing conventions: Vitest, TDD, 80% coverage minimum.

1. **Event translation** — pure functions mapping rollout records to
   `AgentEvent`. Table-driven, no I/O. Most of the risk lives here.
2. **Identity and dedup** — roster employee vs walk-in vs already-seen.
3. **Replay** — point the watcher at a captured log; assert final desk state.
4. **End-to-end** — one Playwright test using the existing standalone fixture.

Fixtures come from real recordings already on disk: 103 rollout logs under
`~/.codex/sessions/` and 21 under `~/.codex/archived_sessions/`. These are real
sessions with real edge cases, not hand-authored guesses. Fixtures are copied
into the repo and scrubbed of file paths and prompt text before commit.

Layer 3 doubles as a replay mode: feed a recorded day through the office at
speed. Test harness and demo from one code path.

## Build order

1. **Codex provider** — pure mapping plus file fallback. No runtime changes.
   Unblocked today. Upstreamable.
2. **Multi-provider runtime** — provider-aware `hookEventHandler`, `fileWatcher`,
   and `AgentRuntime`. Required for Claude and Codex simultaneously.
   Upstreamable, and the larger job.
3. **Roster-driven seats** — employees, idle desks, walk-in area.
4. **bizops integration** — embed the office runtime; wire the two controls.

Steps 1 and 2 are independent of `bizops` and can proceed while it is
inaccessible.

## Open items

- **`~/Documents` is unreadable** to the development environment (macOS TCC
  denies directory access). `bizops` lives there, so steps 3 and 4 are blocked
  until Full Disk Access is granted or the repository is relocated.
- **No fork remote yet.** The working copy has `upstream` pointing at the
  original repository; no fork has been created under the user's account.
- **Unrelated security issue:** `~/.claude/settings.json` contains a GitHub
  personal access token in plaintext, with `autoUploadSessions` enabled. Rotate
  the token and move it out of the settings file.
