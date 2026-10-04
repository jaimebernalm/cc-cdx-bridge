# Claude UDS Bridge

This folder holds the plugin itself. For what it does, how to install it, and how to work on it, read the [repository README](../../README.md).

Fork version 0.5.0 adds optional structured coordination (`coordination` at prepare): context versions, assigned tasks, an initial analysis exchange barrier, pause/resume, controller leases and explicit recovery. The bundled skill keeps free collaboration and optional research/review guidance. The barrier withholds this run’s analyses until both are recorded; existing chat memory remains. Reception settings still apply. Reload tools and receiver for `structured_runs_v1`. No shared UI or background intellectual-task generation is included. See [phase 3](../../docs/FASE_3.md).

Implementation and continuity records: [FASE_1.md](../../docs/FASE_1.md) and [FASE_2.md](../../docs/FASE_2.md). The SQLite migration from schema 1 to 2 preserves old runs; their absent routine/report metadata remains absent rather than inferred.

Examples after loading the skill:

- “Work with the Claude Desktop conversation in this project to find a better approach.” (`free`)
- “Research these alternatives together and check the evidence.” (`research`)
- “Review this plan with Claude; retain any disagreement.” (`review`)
- “Continue from these two analyses rather than starting again.” (explicit priorAnalysis, existing/existing)

`collaboration_prepare` accepts optional `routine: {mode, starts: {codex, claude}}`. Starts infer from explicit priorAnalysis when omitted. `collaboration_send` accepts optional `{taskId,intent,target?}`. `collaboration_guide` is read-only. `collaboration_report` records this caller's own authored result/review; Claude's reports are captured from delivered structured messages. `collaboration_finish` can identify the result/version and declared disposition. See the skill's [API reference](skills/bridge-collaboration/references/api.md).

State/export redact incoming content that has not been permitted and delivered. Transport states are observations; report verdicts and closure summaries are agent declarations, never a core-verified agreement.

[PROTOCOL-COVERAGE.md](PROTOCOL-COVERAGE.md) compares this implementation against Claude Code's documented cross-session messaging, case by case.
