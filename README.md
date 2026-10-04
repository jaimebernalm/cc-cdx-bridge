# CC–CDX Bridge

Fork maintained at [jaimebernalm/cc-cdx-bridge](https://github.com/jaimebernalm/cc-cdx-bridge), based on [Leon Kohli's Claude UDS Bridge](https://github.com/LeonKohli/claude-uds-bridge). Version 0.4.1 incorporates upstream 0.2.0 protocol fixes: encoded socket addresses, native alternate socket names, priorities, receipt reasons and explicit attachment refusal. It preserves the Desktop transport and exact managed conversation bindings. Version 0.4.0 added guided free/research/review collaboration from chat, new/existing/mixed analysis starts, authored result versions and exact-version reviews. It preserves private logs, budgets and reception settings. An independent-analysis barrier, autonomous supervisor and shared UI remain planned. See [phase 0](docs/FASE_0.md), [phase 1](docs/FASE_1.md), [phase 2](docs/FASE_2.md) and the [compatibility and reception decision](docs/COMPATIBILIDAD.md).

A Codex plugin that lets Codex tasks and Claude Code sessions message each other on one machine.

Claude Code can already list its other sessions and send one of them a message by name. This plugin registers your Codex task in the same local registry, so Claude finds the task with `ListAgents` and writes to it with `SendMessage`. No handshake, no tool call first. From the Codex side, a bundled MCP server lists the live agents and sends to one of them.

The bridge transports messages over Unix domain sockets in a private per-user directory. Once a message reaches an agent, the app processes it using that agent's configured model provider. Local transport does not mean local model inference.

## Requirements

- The Codex desktop app, running. Delivery goes through a task's IPC connection, so a CLI-only Codex has no inbox. This is the real platform constraint: the bridge runs wherever that app does.
- macOS or Linux. The transport uses POSIX sockets, and CI runs the suite on both. Windows named pipes are not implemented.
- Claude Code 2.1.224 or later, the first release with [cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging).
- Bun (tested: 1.4.2). The launcher checks the app's `PATH`, `~/.bun/bin`, `/opt/homebrew/bin`, `/usr/local/bin` and `/usr/bin`. The MCP is optional so a missing bridge runtime is not declared a required dependency of an ordinary chat; the actual host fallback remains part of the manual lifecycle check.

## Install

For this development version, install the local checkout; these changes have not yet been published to the fork's remote branch:

```bash
codex plugin marketplace add /absolute/path/to/cc-cdx-bridge
codex plugin add claude-uds-bridge@jaimebernalm
```

Codex ignores plugin hooks until you trust them. Open the plugin in Codex, review the two hooks, and confirm both. A task becomes reachable only when its `SessionStart` hook runs.

Open a new Codex task after confirming. Tasks that were already open keep running without the hooks.

After publishing this version, the equivalent Git marketplace installation is:

```bash
codex plugin marketplace add jaimebernalm/cc-cdx-bridge
codex plugin add claude-uds-bridge@jaimebernalm
```

## Check that it works

From the existing Codex Desktop chat in the project:

```bash
cd plugins/claude-uds-bridge
bun run doctor --project ../..
```

The doctor is read-only: it sends no model prompts, creates no receiver, and changes no settings. It validates native Codex owner/capabilities, stream 11, the exact folder, process identities, distribution files and Claude Desktop engine versions. It lists other surfaces without substituting a CLI/VS Code session. Reception and hook trust remain explicitly unknown when the host does not expose them. Exit 2 means a missing prerequisite; exit 3 means transport prerequisites are present but reception/trust still require validation. Exit 1 is a command error; a missing Bun launcher exits 127. A healthy socket alone is not a successful round trip.

When this plugin's tools are loaded, ask Codex to use `attach_current` for the current folder. It takes the chat identity from MCP caller metadata and reuses a live receiver. For supervised activation from the existing Desktop chat, the distribution also provides:

```bash
bun run attach --project ../..
```

This uses the chat's `CODEX_THREAD_ID` (or an explicit `--thread UUID`) and checks the native project. It does not clear history, send a message or change permission settings. Installing a plugin does not automatically load tools into an already-open chat; manual CLI attachment is not proof that trusted lifecycle hooks ran.

In the Codex task, ask for the bridge status. Codex calls the `status` tool and reports a `replyAddress`. A `null` address means there is no active receiver: run `doctor`, check hook trust and use the explicit existing-chat activation when appropriate.

In Claude Code, run `/list-agents`. The Codex task appears under a name built from its working directory, such as `codex-ccurio-c6`. Ask Claude to message it, and the text arrives in the Codex task.

## How a message arrives

An incoming message steers the Codex task's active turn, or starts a new turn when the task is idle. A running tool keeps going and is never interrupted. This matches Claude Code's own [delivery between tool calls](https://code.claude.com/docs/en/cross-session-messaging#message-delivery).

Peer text is marked as external input. It grants no user permission, and the receiving agent's own permissions still apply.

## Naming

Claude's `ListAgents` shows the model only the name of each agent, and `SendMessage` addresses by that name alone. The bridge therefore follows Claude Code's own default of `<directory>-<suffix>` and prefixes it with `codex-`. Codex builds a task folder from the opening prompt, so a long folder name keeps its first and last part, where the distinguishing words sit. When a live peer already holds the name, the bridge lengthens the suffix. The same name travels in the message envelope as `from-name`, so a reply reaches the task that sent it.

In the other direction, `send_message` addresses by `sessionId` rather than by name, and an ambiguous registration is refused instead of guessed.

## Controlling what arrives

The receive setting belongs to one Codex task. On a permission-mode mismatch the bridge opens a native dialog, including between turns. Held text reaches the model only after you release it.

| Setting | Behavior |
| --- | --- |
| `default` | Accept a matching permission mode, hold a differing one. Without a sender mode, accept only `prompting`. |
| `accept` | Receive messages and release the held ones. |
| `hold` | Hold without expiry until an accepting setting applies or the session ends. |
| `refuse` | Drop messages and discard idle subscriptions. |

A message held by the mode comparison expires after five minutes by default. The `inbox` tool offers `60s`, `5m`, `10m`, and `never`. The sender receives Claude's status notices, including `held`, `delivered`, `denied`, and `expired`.

`inbox` only reviews incoming messages held by Codex. An outgoing message held by Claude remains visible in `status`, but changing Codex's receive policy or approving its inbox cannot release Claude's hold.

## MCP tools

| Tool | Use |
| --- | --- |
| `list_sessions` | List local agents with ID, name, kind, working directory, status, and start time, most recently started first. |
| `send_message` | Send text to one agent by `sessionId`. Set `notify_when_idle` for one notice when that agent next goes idle. |
| `status` | Show the receiver and recent transport outcomes. |
| `inbox` | Set the receive policy, set the hold expiry, or review the oldest held message. |
| `doctor` | Diagnose the caller's exact project without modifying state, sending prompts or inferring unknown Claude reception policy. |
| `attach_current` | Activate the existing caller chat's receiver, or reuse it, after native identity/project validation. |

## Managed collaborations (phase 1)

Use `collaboration_discover` to select one exact Claude Desktop Code ID, then `collaboration_prepare` with a fresh `requestId`, objective/context and budgets. `collaboration_start` with `supervised: true` revalidates both participants and reserves them without sending model work. The default limits are 24 managed messages and 30 minutes. Only the initiating Codex chat can control or export that run.

`collaboration_send` records and sends one message with a fresh `messageId`. Optional `replyTo` links it to an admitted incoming message. Its envelope tells Claude how to return a correlated response using native `SendMessage`; identity comes from the verified peer process, never the envelope's claims. Replies count toward the shared budget. Reusing the same message ID/content returns its recorded attempt without resending. Raw sending to a reserved participant cannot bypass management.

`collaboration_status` reconstructs the log, `collaboration_cancel` stops new admissions, `collaboration_finish` records explicit closure, and `collaboration_export` returns Markdown/JSON without writing or publishing files. Cancellation cannot withdraw work already admitted or delivered. A hold, refusal or uncertain outcome blocks further managed tasks; completing a run does not certify agreement between agents.

State lives privately at `$CODEX_HOME/plugin-state/claude-uds-bridge/collaborations.sqlite`. Preparation pins process, canonical worktree/common repository, HEAD, branch and staged/unstaged diff fingerprints. Comparing different revisions requires an explicit comparison policy and fixed Git base. Untracked paths are listed, but their contents are not snapshotted; references do not trigger automatic file/history imports.

New receivers advertise `managed_runs_v1`. After upgrading, reload the plugin and its receiver (normally by restarting Codex); an already running older receiver is deliberately rejected by preparation. This phase supplies a supervised API and log. It does not resolve Claude's inbound settings, automatically schedule a debate, guarantee independent analysis or implement the UI.

The source and bundled suites each pass 61 tests (509 assertions), including duplicate names, concurrent controllers, cancellation before writes/held deliveries and MCP restart recovery. Actual Desktop discovery verified the upgrade gate without sending model messages; a new real managed conversation remains pending reception and reload.

## Transport limits

- A serialized message may reach 1,048,576 characters. The sender refuses anything larger before writing.
- The sender refuses a message once a burst of 30 to one agent is exhausted. The budget grows by one message every two seconds.
- At most 100 messages stay held, and at most 50 accepted messages wait for Codex to take them up.
- `socket-written`, `started`, and `steered` report transport progress, not a model reply.
- Idle subscriptions fire once and last at most twelve hours.
- The bridge does not lock files. Agree on file ownership before two agents edit one repository.
- Delivery uses the internal Codex desktop IPC interface. An incompatible app version makes delivery fail as `unknown`.

[`plugins/claude-uds-bridge/PROTOCOL-COVERAGE.md`](plugins/claude-uds-bridge/PROTOCOL-COVERAGE.md) compares the implementation against Claude's documented behavior case by case, including the cases it does not cover.

## Development

### Real desktop smoke test

From a Codex Desktop chat in this repository, open a local **Code** session in
Claude Desktop using the same folder and send its first prompt. Authorize that
session to answer one bridge check without modifying files. Then run:

```bash
cd plugins/claude-uds-bridge
bun install --frozen-lockfile --ignore-scripts
bun run smoke:desktop --list
bun run smoke:desktop
```

The test uses `CODEX_THREAD_ID` from the desktop chat, or `--thread UUID`.
If several Claude Desktop sessions use the folder, select one with `--peer UUID`.
It refuses VS Code/terminal peers, another project, and competing Codex receivers.
It registers a temporary receiver for the existing Codex chat, sends one random
arithmetic challenge, and requires Claude to reply through its native `SendMessage`.
Success requires the exact reply, accepted native Codex delivery, and confirmation
that Codex consumed that input. A socket write or idle notice alone cannot pass.

The default timeout is 180 seconds (`--timeout 15` through `--timeout 600`).
Permission settings stay unchanged; held/refused messages fail with a diagnostic
and are never automatically resent. Results and transport state are private local
files under `.local/desktop-smoke/<run>/`, excluded from Git. The receiver withdraws
when the test finishes or receives SIGINT/SIGTERM. This opt-in test does not install
the plugin or prove hook trust, new-chat activation, reconnection, or debate rounds.

If the user explicitly authorizes this test's reply despite a permission-mode
mismatch, `--approve-test-reply` releases only the selected session's exact
challenge answer in Codex. It does not change the general inbox policy or execution
permissions. Claude's inbound controls are separate: a held outbound message still
fails. Any temporary Claude inbound setting must be approved and restored separately.
Claude only honors project/local `crossSessionInbound` values when they make
reception stricter. A project-local `accept` cannot enable a held connection;
enabling reception requires a session `--settings` override or the user setting.
Do not widen the setting to every session without the user's explicit approval.

Verified on macOS on 2026-10-03: an existing Codex Desktop chat sent a random
arithmetic challenge to a local Claude Desktop Code session (engine 2.1.286).
Claude replied through native `SendMessage`; Codex accepted the steering input
and confirmed consumption. The challenge was 73 + 82 and the returned answer was
155 with the matching run nonce. The test used Bun 1.4.2. A temporary user-level
Claude inbound `accept` setting was explicitly authorized and restored afterward;
only the exact test reply was approved in Codex. Execution permissions were unchanged.
This proves one real round trip, not unattended debate or plugin lifecycle setup.

A subsequent phase-0 check verified automatic receiver startup in an authorized temporary Codex chat and removal of its registry entry, socket and active state when archived. A new single challenge sent with unchanged reception settings was held by Claude and later expired without a model reply. Unattended collaboration with that pair remains blocked by reception. The check also exposed and fixed outgoing holds being incorrectly treated as local incoming approvals; the source and bundled suites each pass 49 tests. Installed bundles match the checkout; already running plugin processes need a reload to use updated code.

```bash
cd plugins/claude-uds-bridge
bun install --frozen-lockfile
bun run check
bun test
bun run build
```

The plugin runs the bundled `dist/server.js` and `dist/hook.js`, so run `bun run build` after changing anything under `src/`. Dependencies are bundled, and no `node_modules` is needed at runtime.

`bun run verify:installation` is an opt-in Codex CLI check: it installs into a fresh private home under `.local/phase0/`, compares cached distribution files and runs the installed CLI with a reduced app-style PATH. It does not copy authentication, trust hooks, send messages or edit Claude settings. The bundled CLI can also run via `/bin/sh scripts/run-bun.sh dist/cli.js doctor --project /absolute/project`.

The Claude transport follows the [socket protocol documented by PeterSR](https://github.com/PeterSR/claude-code-socket-transport/tree/480bd83c0bf1c63161c5afdb0976bbff849c926b). Delivery into Codex uses `thread-follower-steer-turn` and `thread-follower-start-turn` on the existing task and confirms through the returned turn ID.

## License

MIT. See [LICENSE](LICENSE).

Original work: Leon Kohli. The transport client type, MCP server key, peer entrypoint and state directory remain `claude-uds-bridge` for compatibility. The fork uses marketplace `jaimebernalm`; do not enable both distributions for the same chat. Installing this fork does not automatically remove the upstream plugin or migrate its trust decision.
