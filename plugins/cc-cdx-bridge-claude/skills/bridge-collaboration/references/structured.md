# Structured coordination (0.5.0)

Choose `coordination` at preparation when the user needs a barrier, versioned context, pause or persistent recovery. Omit it for the compatible free/guided workflow. Intellectual phases are selectable, not mandatory rounds. The same existing chats continue; no replacement agents or automatic history import.

## Prepare and own a controller

Add `coordination:{initialBarrier:false,leaseSeconds:300}` (both fields have those defaults). Starting acquires a process-verified controller lease. New sends/reports renew it. A competing live controller cannot mutate; a dead process or expired lease leaves `recovery_required`. Status/export remain readable. Cancel remains available without the lease to stop abandoned work. Recovery preserves the original deadline and message budget.

Use `collaboration_control`:

```json
{"runId":"UUID","commandId":"fresh UUID","expectedRevision":0,"control":{"action":"pause"}}
```

Read `coordination.revision` immediately before a control. Command ID + identical content is idempotent even after its revision changes. A different command with stale revision fails; inspect state, do not repeat blindly. Lease ownership belongs to the MCP process, not peer declarations. A controller lease is not a repository edit lock.

Control actions:

- `pause`: stop new sends and buffer authorized replies. Deadline still advances.
- `resume`: revalidate participants/project, resume paused/blocked/recovery state only if uncertain delivery has evidence.
- `recover`: revalidate participants/project, acquire expired/dead lease; end paused unless unresolved intent requires recovery_required. Then explicitly resume. Never replays a task.
- `context`: full new `{objective,constraints,references,priorAnalysis}`; immutable next version; invalidates open tasks. Existing chats keep their history. Barrier runs reject priorAnalysis.
- `phase`: context/independent_analysis/critique/verification/synthesis/final_review, chosen as useful. A closed barrier cannot be skipped.
- `task`: `{taskId,intent,target?}` assigned locally to Codex; later use that taskId in `collaboration_report`. `collaboration_send` assigns its task to Claude.

Structured reports require a matching assigned task/author/current context. Each task accepts one valid report. To revise a result use a new synthesis task and next immutable result version. Reviewing requires the task's exact target. Plain/malformed responses are unclassified, not task completion. An old-context response is recorded as stale and never validates the new context.

## Optional initial exchange barrier

Prepare new/new, no supplied analyses, with `initialBarrier:true`. The initial phase is independent_analysis.

1. Assign Codex a local analyze task and send Claude a distinct analyze task. Provide objective/context, avoiding another agent's analysis in the prompt.
2. Work on Codex analysis. Claude may answer first; its authorized analysis is privately recorded and buffered before native injection. Status/export expose metadata but not its text, report or disagreements.
3. Record Codex's actual analysis using `kind:response`, its assigned taskId and `declaredState:analysis`. Claude must use the same kind/state for its own task. A done/perspective declaration does not open the barrier.
4. Once both analyses of this context are recorded the core opens the barrier. The receiver releases the permitted peer input once. Then choose a useful phase or send another task.

A context change resets this barrier. The guarantee is withholding protocol-recorded initial analyses of this run. It does not erase chat memory, isolate shared files, or detect analysis smuggled into arbitrary prompt text. Do not label it guaranteed intellectual independence.

## Evidence, recovery and closure

Message evidence separately records context/classification, receipt authorization, native input ID/observed consumption and correlated response time. `started/steered` are native acknowledgements. Exact native history can reconcile unknown without another injection. A validated Claude reply proves a correlated response, not an invented transport ACK. Neither proves rigorous reasoning.

If unresolved reserved/submitting/unknown remains, inspect the exact evidence. The plugin cannot safely determine whether Claude consumed a lost unacknowledged delivery. It will not automatically resend. Wait for legitimate evidence or cancel and describe the limitation. Changed participant process/project requires cancelling and preparing a new run; never adopt a similarly named replacement.

`results[].reviewState` is none/self_only/other_agent_current/other_agent_stale. `reviewedByBoth` derives from attributed review rows of the exact version/hash/current context. It does not mean the verdicts agree. `reviews[].current` excludes old result versions/contexts. Closure freezes review coverage and disagreements beside the owner's declared disposition. `validatedConsensus` stays false. No mandatory two-review rule blocks closure.

At the deadline or exhausted budget the core releases reservations and keeps a partial export with tasks and evidence. No final model call is required. The receiver handles expiry, history reconciliation and buffered input release; agents still decide and issue intellectual tasks through normal turns. A UI is not included in this phase.
