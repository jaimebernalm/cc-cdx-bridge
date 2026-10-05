# Guided collaboration API

All controls are bound to the current Codex caller. Use the plugin MCP tools; no CLI or API credentials are needed for the routine. UUIDs must be fresh except intentional reads of an identical idempotent operation.

## Prepare and send

`collaboration_prepare` accepts:

```json
{
  "requestId": "UUID",
  "peerId": "exact Claude Desktop session UUID",
  "context": {"objective": "Goal", "constraints": [], "references": [], "priorAnalysis": {"codex": "Actual earlier analysis", "claude": "Actual earlier analysis"}},
  "routine": {"mode": "free", "starts": {"codex": "existing", "claude": "existing"}},
  "limits": {"maxMessages": 24, "maxSeconds": 1800}
}
```

`routine` is optional: mode defaults to `free`; starts infer existing only from nonempty explicit priorAnalysis. Explicit existing requires text; explicit new rejects conflicting prior text. Do not include both earlier analyses for a declared new/new start. For different worktrees/revisions, `revisionPolicy:"compare"` needs a fixed local `comparisonBase`; default `same` requires matching tracked state.

`collaboration_start`: `{runId, supervised:true}`. Busy Claude requires explicit `allowBusyPeer:true` choice; otherwise wait.

`collaboration_send`: `{runId,messageId,text,replyTo?,task?}`. A task is `{taskId,intent:"analyze"|"discuss"|"synthesize"|"review",target?:{resultId,version}}`. Review requires target. The server includes the exact draft and hash. Repeating a message ID must preserve text, replyTo and task; it never resends. `replyTo` for outgoing must identify a delivered incoming message in this run.

## Reports

`collaboration_report`: `{runId,reportId,report,text}` records only this caller's own report. Three report shapes:

```json
{"kind":"response","declaredState":"analysis","disagreements":[]}
{"kind":"result","resultId":"UUID","version":1,"title":"Proposal","disagreements":[]}
{"kind":"review","resultId":"UUID","version":1,"verdict":"revise","disagreements":["A retained uncertainty"]}
```

Optional `taskId` associates a report with work. The body in `text` contains the actual analysis/draft/review. Response declaredState may be `analysis`, `perspective`, `needs_input`, `blocked` or `done`; review verdict may be `agree`, `revise` or `disagree`. These are agent declarations, not run transitions or verified consensus. Do not include author: the core derives it from the caller/transport.

For a native Claude response, the server supplies a copyable first and second line:

```text
CC_CDX_RUN_V1 {"runId":"UUID","messageId":"fresh UUID","contextVersion":1,"replyTo":"outgoing message UUID"}
CC_CDX_WORK_V1 {"kind":"response","taskId":"requested task UUID","declaredState":"analysis","disagreements":[]}
Actual answer
```

Claude sends that full text via its native `SendMessage` to the indicated Codex peer name. For structured result/review, replace the second JSON with the appropriate report plus the matching `taskId`. A review must reference exactly the result/version requested by the review task. The returned messageId is one-use; later responses need a fresh UUID. Plain managed replies remain supported. Legacy runs reject invalid work envelopes. Structured runs retain unclassified readable responses without completing tasks; stale/duplicate/late responses are recorded without delivery. Reports materialize only after permission to receive. Initial-barrier reports remain private until opening, and paused peer reports remain hidden until resumed. Held/denied content remains hidden from status/export.

## Inspect and finish

- `collaboration_guide`: optional routine/priorAnalysis; guidance only, no sends or state mutation.
- `collaboration_status`: optional runId; list or details including tasks, reports, results, reviews, disagreement attribution and closure. `current:false` on a review means a newer result version or context invalidates that review. Author identity and target hash are verified metadata; substantive verdicts remain declarations.
- `collaboration_finish`: `{runId,reason,closure?:{result?:{resultId,version},summary,disposition:"proposal"|"with_disagreements"|"incomplete"}}`. Closure references a stored result in this run. It does not certify consensus.
- `collaboration_cancel`: `{runId,reason?}`. Stops new admissions, releases participants; work already delivered cannot be withdrawn.
- `collaboration_export`: `{runId,format:"markdown"|"json"}`. Returns text; no automatic write/publication. Transcript includes verified author IDs and private paths, so review before sharing.

When a process/project revision changes, close/cancel and prepare again; don't follow a replacement conversation by similar name. When the core reports uncertain delivery, read state and request the human's needed decision rather than sending a duplicate task. Runs without coordination keep frozen context version 1. For versioned tasks/context, leases and recovery see [structured.md](structured.md).

## Phase 4 panel

`collaboration_panel {}` returns a private authenticated loopback URL for the caller-owned panel. `collaboration_panel_command {commandId}` reads/applies only that persisted human action using real caller metadata. See [panel.md](panel.md) for notification handling, lease/idempotency and reload limitations. No arbitrary ownerThread is accepted by either MCP operation.

## Phase 6 implementation

Prepare accepts optional `implementation` with structured coordination. `collaboration_implementation {runId, operationId, work}` captures a candidate, records a declared check receipt or inspects integration, subject to active state/controller fencing. `collaboration_implementation_inspect {runId}` recomputes readiness read-only, including after closure. See [implementation.md](implementation.md) for exact shapes, limits and workflow. The routine catalog now also includes diagnose, architecture, product, test_design, compare and implement. Ordinary runs retain frozen-diff checks; only registered implementation roots may vary their scoped worktree content.
