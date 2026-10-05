# Scoped implementation — 0.8.0

Use this only for implementation already authorized by the human. The contract records scope, not execution permission. Analysis/review requests and choosing the implement orientation do not authorize editing or publishing. No editor locks, OS sandbox, automatic model worker or test-command executor is provided.

## Register the contract

Use normal permitted Git tools to create worktrees if required. Register existing **clean, actual Git worktree roots** of the same repository and HEAD. Do not move a chat, silently create another model session or rewrite permissions. The native chat project must belong to that same repo/base. Normal unregistered chat roots remain frozen.

Add to `collaboration_prepare` alongside `coordination`:

```json
{"implementation":{"strategy":"files","workspaces":{"codex":{"root":"/absolute/repo","paths":["src/client/"]},"claude":{"root":"/absolute/repo","paths":["src/server/","test/server.test.ts"]}},"requiredChecks":["typecheck","tests"]}}
```

`files` requires a shared checkout and disjoint scopes (conservatively case-folded); it is an agreement and deviation detector, not writer authentication. `worktrees` requires distinct, non-nested worktree roots. Overlapping paths in separate worktrees are allowed; integration may conflict. Worktrees isolate files, not agent permissions/access to the other root. The core pins baseCommit, commonGitDir, canonical roots and device/inode. Receivers must advertise `implementation_v1`.

Scopes are **literal**, exact relative files or directory subtrees ending `/`. No absolute paths, traversal, `.git`, NUL or backslash. Ignored untracked files are excluded as Git excludes them; do not claim a whole-filesystem sandbox. Changed tracked files and nonignored additions must fit scope. Symlink/submodule patches and unresolved indexes are refused. Limit: 500 changed files/workspace, regular file <=4 MiB, combined patch <=16000 bytes. Split larger work into smaller candidates. The combined patch uses Git's content/attribute semantics; raw file hashes also fence subsequent changes.

## Edit, capture, test, review

1. Start; send the exact assigned contract/root/paths to Claude with one concrete authorized task. Each agent uses its normal permitted tools. Dirty changes are allowed only on registered roots; process/repo/HEAD changes or changes outside scope block the next managed exchange.
2. Assign a local synthesis task with `collaboration_control`. Capture:
   `collaboration_implementation {runId,operationId:"fresh UUID",work:{action:"capture",taskId:"assigned UUID"}}`.
   Capture produces an immutable `candidate` and authored result manifest. The result UUID/version is reserved for captures; do not replace it using collaboration_report. Capturing attributes files to assigned workspaces, not proven model writers. The human panel can assign this synthesis task and capture with one durable command.
3. Run actual checks using normal tools. Record one receipt per declared required name:
   `work:{action:"check",candidateHash:"64 hex",name:"tests",command:"bun test",exitCode:0,summary:"Actual output, scope and limits"}`.
   Receipts are attributed declarations (`executedByCore:false`). Recording does not run or verify a command. Failures stay visible. The latest receipt for that exact candidate hash/name controls readiness. Changes require recapture and fresh receipts; reused IDs never execute again.
4. Request Claude intent review of **candidate.resultId/version**, giving relevant test output too. The server includes immutable captured patches and manifest. Review the exact material; dirty files later may differ. Agree/revise/disagree remains declared. Only a current-context accepted review from the other participant meets this opt-in readiness gate; self/older/revise/disagree does not. A new capture creates a new result version and requires another review, even with identical content.
5. Read `collaboration_implementation_inspect {runId}` or use work action inspect for a durable active operation. The core checks fresh workspace/hash/context, required declared checks, exact current accepted peer review, and patch integration against base using a private temporary index. It rereads evidence/disk before reporting readiness. No real index, checkout, HEAD/ref or remote is changed; Git may create unreachable blob objects during preparation. Conflicts preserve both source patches/files. Resolution is normal scoped editing followed by recapture/tests/review, not automatic conflict resolution.

## Readiness and handoff

`ready_to_integrate` means the scope/hash/base/patch checks passed and the declared receipts/review exist; it does not verify test execution, truth, rigor or consensus. Inspection is a point-in-time observation, not an editor lock. A context version change, later edit, failed receipt or superseding review invalidates it. Read-only inspection does not recover/steal controller leases; mutations still require the active caller controller.

The authenticated panel's patch download recomputes readiness. MCP inspect returns the prepared patch as private text. Applying/commit/merge/push/deploy remain separate actions through normal tools with the user's corresponding scope. Never treat the existence of a patch as publishing approval. A collaboration may still close incomplete/with_disagreements without readiness; all evidence remains exportable. The old frozen-diff behavior remains for runs without a contract. Reopen updated receivers/MCPs after installation; updating package files does not update live processes.
