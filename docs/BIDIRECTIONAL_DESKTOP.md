# Bidirectional Desktop implementation (0.9.0)

The approved design is [INICIO_BIDIRECCIONAL.md](INICIO_BIDIRECCIONAL.md). This document describes the implemented behavior and distinguishes automated evidence from native model checks. It is a continuation checkpoint, not a claim that every Desktop lifecycle has been verified.

## Runtime and identity

Both plugin roots register the same `desktop_collaboration_*` MCP surface. Codex derives the caller from native turn metadata and its process-verified receiver. Claude resolves the nearest registered Desktop engine ancestor on every call, checks its process start and hook generation, and rejects mismatching metadata, other surfaces and ambiguous bindings. Tool arguments never choose the author. Processes the conversation itself launches (for example its Bash tool) also descend from its engine and authenticate as that same conversation; this does not allow impersonating another conversation.

Claude owns no new inbox socket and the plugin does not modify Claude's session registry. Native Claude UDS remains the destination transport. Codex delivery uses its existing Desktop IPC receiver. Codex receiver admission uses a one-use capability tied to the run, source, destination, context, wire hash and transport attempt. That credential is removed before native model input. Claude receives a public correlation header without a capability; its native ingestion is not observable by this core, and status labels that distinction explicitly. This is a local same-UID trust boundary; it cannot protect against a compromised local account or prove intellectual independence.

Loading the Claude MCP server may advertise its verified process in `desktop-presence/` and write bounded diagnostic records, but does not open or initialize collaboration databases. Collaboration operations initialize additive `desktop_*` tables inside the existing private `collaborations.sqlite`. Legacy tables and `user_version` remain intact; claims prevent old and new protocols from simultaneously reserving a conversation. Existing live 0.8.1 receivers retain their old tools until reloaded; they are not silently replaced or treated as 0.9.0 peers.

The runtime holds a process-verified executor lease, renews it while alive, and fences writes by epoch. Recovery is explicit. A verified initiating chat can cancel a stale run after the peer process or snapshot changed, releasing its claims without adopting the replacement peer; completion still requires current evidence. An unclaimed reservation can become `not-sent`, keeping its budget charge; a claimed uncertain attempt is never automatically repeated. The absolute run deadline and shared message count apply to both directions. `maxMessages:null` removes only the count limit.

## Panel and reception

The server opens the panel privately and returns a credential-free focus URL to the model. Each bootstrap token exchange is single-use. Explicit panel opening mints a fresh private token and forces browser dispatch; existing authenticated tabs remain valid, so reopening does not restart the MCP or change a prepared run. HTTP actions require the authenticated browser session and CSRF check. Audit actors use a separate non-secret `panel_session` identifier; cookie and message capabilities are omitted from tools, state and exports.

A panel session is not cryptographic proof of human presence. An agent that can operate the same desktop could operate an already-open panel. Creation adapters therefore must not read or operate the panel origin, and actions retain explicit attribution. The panel is scoped to its bound native participant and project, never all users' runs.

The UI defaults to English, supports Spanish, serializes refreshes, updates periodically and on focus, and preserves form input during polling. It displays actual initiation direction, attributed messages and reports, tasks, exact review versions, deadlines and uncertainty. It offers pause/resume, explicit recovery, cancellation of unstarted drafts, closure and Markdown export.

A remembered project grant covers managed Claude responses to Codex-origin work. Claude-origin initiation requires the target Codex chat's explicit acceptance or panel consent to the exact run. Consent pins participants and processes, folder identity, context and limits, expires, and cannot override explicit `hold` or `refuse`. Changing context invalidates its prior scope. Consent grants neither editing nor execution rights.

## New conversations

Creation tickets have a separate private database and authorization; the reception grant is never reused as creation permission. An agent request waits for a panel session or a matching revocable creation grant. The UI displays a seven-day creation-and-binding grant with one active ticket and three creations per hour as proposed defaults. These are applied only when the person explicitly selects and confirms the remembered grant. Its scope is restricted to the folder identity, destination provider, adapter and local mode.

Adapters:

- `manual`: the person opens the destination chat and explicitly binds it.
- `assisted_ui`: an authorized executor uses Claude Desktop UI, verifies the requested folder/model/mode and sends the correlation marker in the first prompt. It cannot operate the bridge panel.
- `native_tool_relay`: a live, exact, panel-delegated Codex chat uses its official host `create_thread` tool. Claude itself has no such creation tool; without a live Codex executor the UI offers manual opening.

The server returns an execution plan; it does not fabricate a host-created chat or substitute a CLI model. Creation is claimed once, outcome reports are tied to the executor's process and epoch, and uncertain creation is never retried. Worktree creation is explicitly unsupported by these adapters; use an existing registered worktree with an explicit contract.

A returned chat ID is only a pointer. A Claude host hook receipt plus a verified native registry/process, matching folder/revision and zero prior turns can bind automatically during panel polling. Rejected receipts are preserved; errors remain visible. A conclusive receipt can resolve an uncertain creation without recreating it. Codex receiver start time does not prove native chat freshness, so Codex binding stays explicit in the panel. Bootstrap is single-use.

## Persistent work, coordination and implementation

Runs store versioned context, task identity, attributed reports, immutable result versions and exact review targets. Agents read status after compaction instead of reconstructing from conversation memory. Optional coordination withholds registered initial reports until both analyses are recorded; it neither erases prior history nor hides analysis embedded in an initial task message. That task must contain only the objective.

The optional implementation contract pins a clean Git base, exact participants, disjoint file scopes or separate registered worktrees, and required check names. Capture creates immutable combined candidates; an identical recapture preserves its version. Guard checks run state and context before asynchronous reads and again during writes. Readiness rechecks current files, candidate/context, declared exact-hash checks, another contract participant's current review and a private-index integration preview. A changed file, context, candidate, check or review invalidates readiness. Checks are declarations; the core never executes their command, locks editors, merges or publishes.

Closure records a proposal, disagreements or incomplete work, snapshots the exact result/reviews and derives visible review coverage. Objections do not force consensus or block a proposal. Consensus is always undeclared.

## Acceptance evidence and remaining gates

Measured in real Claude Desktop before the runtime update: two fresh chats had distinct engines and plugin MCP children, caller binding by ancestry plus hook, no native session ID in MCP metadata, and the first-prompt hook preceding caller inspection. The first-prompt turn count was observed as null when the host had not yet written its transcript; the hook was corrected to count zero only for the expected missing transcript in a verified project directory, with regression coverage. Automatic receipt binding has not been tested in real chats with the integrated runtime. See [CLAUDE_SPIKE.md](CLAUDE_SPIKE.md) for exact IDs and observations.

A fresh native Codex test chat verified the 0.9.0 receiver, discovery, persistent status and private panel opening. Automated tests exercise both initiation directions through MCP and isolated native IPC/UDS fixtures, exact receipt and replay checks, authorization scope, lease recovery, creation delegation, candidates, registered-report barriers and closure. Visual testing of an isolated panel verified default English, Spanish switching, live report refresh without reload, run consent and pause/resume.

A real Claude-origin round trip completed on 2026-10-05 at 23:38 UTC: Claude sent the nonce `PILOT2-0F10` to the temporary native Codex chat, Codex replied through its own MCP, and Claude confirmed reading that exact reply. The stored run closed as a proposal with two of four messages used, exact reply correlation, a run-only panel consent and no general reception grant. This is model-response evidence for that run, not core-validated consensus.

The first real attempt exposed a missing consent path for Codex replies; a regression now covers both directions with default reception and no project grant, retaining explicit hold/refuse priority. The same pilot exposed panel reopening and stale-run cancellation problems. Subsequent corrections cover fresh private reopening, preserved browser sessions, cancellation without peer replacement, scoped participant-panel start and waking the exact initiator. Transport credentials are now absent from native input on both routes. These final changes have automated regression coverage; the successful native exchange preceded them and is not evidence that every final UI/lifecycle path was exercised by real models.

The final source and bundled suites each pass 251 tests across 31 files, with zero failures and 1,772 assertions per suite. Type checking and both distribution builds pass. The installed Codex and Claude server bundles match the final checkout. The isolated visual panel verified English by default, Spanish switching, live report refresh, consent and pause/resume. Complete native new-chat adapter tests, compact/clear/end, and a separately initiated Codex-origin run remain release gates. Existing live processes must reload the final distribution; native reception and editing prerequisites stay explicit. Tool snapshot responses currently include full untracked-path lists; summarizing that context noise is a follow-up improvement.

## Resume the native pilot

1. The local 0.9.0 update and pilot were directly authorized and completed in the Claude planning chat. Confirm the remaining lifecycle/new-chat test scope there before those actions; preserve the private identity-spike evidence and installation rollback notes.
2. Build both distributions with `bun run check && bun run build`. Update the already-installed local Claude plugin from the primary checkout; compare its cached server and hook hashes with the build. Reload the test chats. Do not change general reception or execution settings.
3. Use the preserved native Codex test chat **Prueba temporal del puente bidireccional** (its exact ID is in the private implementation handoff). Reload it after a final distribution update. In both apps inspect `desktop_collaboration_discover` and choose exact IDs; a stale capability requires reload, never a replacement identity.
4. From Claude prepare a small run (e.g. 8 messages, 5 minutes), with a random arithmetic nonce and no edits. If the target Codex policy is default, the person consents to that exact run in its panel. Verify the correlated model answer in Codex and a managed reply in Claude; inspect the stored src/dst/context/budget. Repeat in the opposite direction. A socket receipt alone cannot pass.
5. Test a separately authorized new-chat ticket in each direction. Verify the requested host/project/model, single creation outcome, exact receipt or explicit manual binding, and no replay after uncertainty. Do not operate the bridge panel through the creation adapter.
6. On disposable chats only, compact/reload and inspect persistent context; clear should replace the caller session identity and invalidate old bindings; ending a chat should invalidate presence. Preserve existing databases and authorization. Record exact evidence and limits in this document before declaring the native release gate passed.
