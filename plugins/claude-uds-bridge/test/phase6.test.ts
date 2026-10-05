import { test, expect } from "bun:test";
import {
  mkdtempSync,
  realpathSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { git, inspectProject } from "../src/project";
import {
  normalizeImplementation,
  captureImplementation,
  previewIntegration,
  type ImplementationInput,
  type Candidate,
} from "../src/implementation";
import { RunStore, contextSchema, limitsSchema } from "../src/runs";
import { type Participant } from "../src/participants";
import { type Peer } from "../src/claude";
import {
  routineCatalog,
  routineSchema,
  guide,
  normalizeRoutine,
  formatWork,
  type Task,
} from "../src/routines";
import { formatManaged } from "../src/managed-message";
import { nativeFixture, until } from "./collaboration-fixture";
import { startPanel } from "../src/panel";
const pluginRoot = join(import.meta.dir, "..");
export async function gitOK(root: string, args: string[]) {
  const r = await git(root, args);
  if (r.code !== 0) throw new Error(r.error);
  return r.output;
}
export async function repo() {
  const root = realpathSync(mkdtempSync("/tmp/phase6-"));
  await gitOK(root, ["init", "-q"]);
  await gitOK(root, ["config", "user.email", "fixture@example.invalid"]);
  await gitOK(root, ["config", "user.name", "Fixture"]);
  writeFileSync(join(root, ".gitignore"), "*\n!*.txt\n!.gitignore\n");
  writeFileSync(join(root, "codex.txt"), "codex base\n");
  writeFileSync(join(root, "claude.txt"), "claude base\n");
  await gitOK(root, ["add", ".gitignore", "codex.txt", "claude.txt"]);
  await gitOK(root, ["commit", "-qm", "base"]);
  return root;
}
const input = (root: string): ImplementationInput => ({
  strategy: "files",
  workspaces: {
    codex: { root, paths: ["codex.txt", "new.txt"] },
    claude: { root, paths: ["claude.txt"] },
  },
  requiredChecks: ["tests"],
});
async function participants(root: string) {
  const project = await inspectProject(root);
  return ["codex", "claude"].map((provider, i) => ({
    sessionId: randomUUID(),
    name: provider,
    provider: provider as "codex" | "claude",
    surface: i ? "claude-desktop" : "codex-claude-uds-bridge",
    pid: i + 1,
    procStart: String(i),
    socketPath: "/tmp/" + i + ".sock",
    version: i ? "2.1.286" : "stream-11",
    status: "idle",
    project,
  })) satisfies Participant[];
}
async function fixture() {
  const root = await repo(),
    state = mkdtempSync("/tmp/phase6-state-"),
    ps = await participants(root),
    plan = await normalizeImplementation(input(root), ps),
    store = new RunStore(state),
    owner = ps[0]!.sessionId,
    peer = ps[1]!.sessionId;
  const id = store.prepare(
    owner,
    randomUUID(),
    contextSchema.parse({ objective: "Implement scoped changes" }),
    limitsSchema.parse({ maxMessages: 50, maxSeconds: 1800 }),
    ps,
    {},
    undefined,
    { initialBarrier: false, leaseSeconds: 300 },
    plan,
  );
  store.start(id, owner);
  const peerRecord: Peer = {
    sessionId: peer,
    pid: 2,
    procStart: "1",
    messagingSocketPath: "/tmp/1.sock",
    entrypoint: "claude-desktop",
    cwd: root,
    name: "Claude",
    status: "idle",
    peerProtocol: 1,
    peerFeatures: [],
  };
  const status = () => store.status(id, owner);
  const local = (
    intent: Task["intent"] = "synthesize",
    target?: Task["target"],
  ) => {
    const task: Task = {
      taskId: randomUUID(),
      intent,
      ...(target ? { target } : {}),
    };
    store.control(id, owner, randomUUID(), status().coordination!.revision, {
      action: "task",
      task,
    });
    return task;
  };
  const capture = async () => {
    const task = local();
    return (await store.implementationAction(id, owner, randomUUID(), {
      action: "capture",
      taskId: task.taskId,
    })) as { candidate: Candidate };
  };
  const check = (c: Candidate, exitCode = 0) =>
    store.implementationAction(id, owner, randomUUID(), {
      action: "check",
      candidateHash: c.contentHash,
      name: "tests",
      command: "bun test (fixture declaration)",
      exitCode,
      summary: "Declared result; not executed by core",
    });
  const review = (
    c: Candidate,
    verdict: "agree" | "disagree" | "revise" = "agree",
  ) => {
    const task: Task = {
        taskId: randomUUID(),
        intent: "review",
        target: { resultId: c.resultId, version: c.version },
      },
      out = randomUUID(),
      transport = randomUUID();
    store.reserveOutgoing(
      id,
      owner,
      out,
      peer,
      "Review candidate",
      undefined,
      task,
    );
    store.claimOutgoing(id, owner, out, transport);
    store.transportStatus(transport, "socket-written");
    const incoming = randomUUID();
    expect(
      store.admitIncoming(
        owner,
        peerRecord,
        incoming,
        formatManaged(
          {
            runId: id,
            messageId: randomUUID(),
            contextVersion: status().contextVersion,
            replyTo: out,
          },
          formatWork(
            {
              kind: "review",
              taskId: task.taskId,
              resultId: c.resultId,
              version: c.version,
              verdict,
              disagreements: verdict === "agree" ? [] : ["Open issue"],
            },
            "Fixture review",
          ),
        ),
      ).admitted,
    ).toBe(true);
    store.authorizeIncoming(incoming);
    store.claimIncoming(incoming);
    store.transportStatus(incoming, "delivered");
  };
  return {
    root,
    state,
    store,
    ps,
    plan,
    id,
    owner,
    status,
    local,
    capture,
    check,
    review,
    close() {
      store.close();
      rmSync(root, { recursive: true, force: true });
      rmSync(state, { recursive: true, force: true });
    },
  };
}
test("nine presets share schema and guidance without implicit write or mandatory rounds", () => {
  expect(routineCatalog).toHaveLength(9);
  for (const p of routineCatalog) {
    const r = normalizeRoutine({ mode: p.id }, {});
    expect(routineSchema.parse({ mode: p.id }).mode).toBe(p.id);
    expect(guide(r).guidance.length).toBeGreaterThan(10);
    expect(r.independence).toBe("not_guaranteed");
  }
  expect(() => routineSchema.parse({ mode: "unknown" })).toThrow();
});
test("clean base, explicit roots, disjoint scopes and safe paths are mandatory", async () => {
  const root = await repo();
  try {
    const ps = await participants(root);
    expect((await normalizeImplementation(input(root), ps)).isolation).toBe(
      "agreement_only",
    );
    for (const path of [
      "../bad",
      "/tmp/bad",
      ".git/config",
      "a/../b",
      "a\\b",
      "",
    ]) {
      const bad = input(root);
      bad.workspaces.codex.paths = [path];
      await expect(normalizeImplementation(bad, ps)).rejects.toThrow();
    }
    const overlap = input(root);
    overlap.workspaces.claude.paths = ["codex.txt"];
    await expect(normalizeImplementation(overlap, ps)).rejects.toThrow(
      "overlap",
    );
    const subtree = input(root);
    subtree.workspaces.codex.paths = ["src/"];
    subtree.workspaces.claude.paths = ["src/code.txt"];
    await expect(normalizeImplementation(subtree, ps)).rejects.toThrow(
      "overlap",
    );
    writeFileSync(join(root, "codex.txt"), "dirty");
    await expect(normalizeImplementation(input(root), ps)).rejects.toThrow(
      "clean",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("edits, additions and deletions integrate without changing index, HEAD or source files", async () => {
  const x = await fixture();
  try {
    const before = await gitOK(x.root, ["rev-parse", "HEAD"]),
      index = readFileSync(join(x.root, ".git/index"));
    writeFileSync(join(x.root, "codex.txt"), "codex edited\n");
    writeFileSync(join(x.root, "new.txt"), "new contents\n");
    rmSync(join(x.root, "claude.txt"));
    const { candidate: c } = await x.capture();
    expect(c.snapshots[0]!.files.map((f) => f.path)).toEqual([
      "codex.txt",
      "new.txt",
    ]);
    expect(c.snapshots[1]!.files[0]!.hash).toBeNull();
    const preview = await previewIntegration(x.plan, c, x.state);
    expect(preview.clean).toBe(true);
    expect(preview.patch).toContain("new contents");
    expect(preview.patch).toContain("deleted file mode");
    expect(await gitOK(x.root, ["rev-parse", "HEAD"])).toBe(before);
    expect(readFileSync(join(x.root, ".git/index"))).toEqual(index);
    expect(readFileSync(join(x.root, "codex.txt"), "utf8")).toBe(
      "codex edited\n",
    );
    expect(x.status().implementation!.publishesChanges).toBe(false);
  } finally {
    x.close();
  }
});
test("checks and exact other-agent review gate readiness; disk changes, failed checks and stale reviews revoke it", async () => {
  const x = await fixture();
  try {
    writeFileSync(join(x.root, "codex.txt"), "edited\n");
    const { candidate: c } = await x.capture();
    expect((await x.store.inspectImplementation(x.id, x.owner)).ready).toBe(
      false,
    );
    await x.check(c);
    const self = x.local("review", {
      resultId: c.resultId,
      version: c.version,
    });
    x.store.recordReport(
      x.id,
      x.owner,
      randomUUID(),
      {
        kind: "review",
        taskId: self.taskId,
        resultId: c.resultId,
        version: c.version,
        verdict: "agree",
        disagreements: [],
      },
      "Self review",
    );
    expect((await x.store.inspectImplementation(x.id, x.owner)).ready).toBe(
      false,
    );
    x.review(c);
    expect((await x.store.inspectImplementation(x.id, x.owner)).ready).toBe(
      true,
    );
    await x.check(c, 1);
    expect((await x.store.inspectImplementation(x.id, x.owner)).ready).toBe(
      false,
    );
    await x.check(c);
    writeFileSync(join(x.root, "codex.txt"), "later\n");
    expect((await x.store.inspectImplementation(x.id, x.owner)).ready).toBe(
      false,
    );
    expect(
      x.store.implementationMaterial(x.id, c.resultId, c.version)?.snapshots[0]!
        .patch,
    ).toContain("edited");
    const { candidate: v2 } = await x.capture();
    expect(v2.resultId).toBe(c.resultId);
    expect(v2.version).toBe(2);
    await x.check(v2);
    expect((await x.store.inspectImplementation(x.id, x.owner)).ready).toBe(
      false,
    );
    x.review(v2, "disagree");
    expect((await x.store.inspectImplementation(x.id, x.owner)).ready).toBe(
      false,
    );
    x.review(v2);
    expect((await x.store.inspectImplementation(x.id, x.owner)).ready).toBe(
      true,
    );
    expect(x.status().reviews[0]!.current).toBe(false);
  } finally {
    x.close();
  }
});
test("untracked contents and context invalidate candidates; old receipts cannot be relabeled", async () => {
  const x = await fixture();
  try {
    writeFileSync(join(x.root, "new.txt"), "one\n");
    const { candidate: c } = await x.capture();
    await x.check(c);
    x.review(c);
    expect((await x.store.inspectImplementation(x.id, x.owner)).ready).toBe(
      true,
    );
    writeFileSync(join(x.root, "new.txt"), "two\n");
    expect(
      (await x.store.inspectImplementation(x.id, x.owner)).reasons,
    ).toContain("Workspace or context changed after capture");
    const { candidate: v2 } = await x.capture();
    await expect(x.check(c)).rejects.toThrow("current exact");
    await x.check(v2);
    x.review(v2);
    x.store.control(
      x.id,
      x.owner,
      randomUUID(),
      x.status().coordination!.revision,
      {
        action: "context",
        context: contextSchema.parse({ objective: "New context" }),
      },
    );
    expect((await x.store.inspectImplementation(x.id, x.owner)).ready).toBe(
      false,
    );
  } finally {
    x.close();
  }
});
test("replay, caller, pause and terminal state fence candidate operations", async () => {
  const x = await fixture();
  try {
    writeFileSync(join(x.root, "codex.txt"), "edit\n");
    const task = x.local(),
      op = randomUUID(),
      action = { action: "capture" as const, taskId: task.taskId };
    const one = (await x.store.implementationAction(
      x.id,
      x.owner,
      op,
      action,
    )) as { candidate: Candidate };
    expect(
      (
        (await x.store.implementationAction(x.id, x.owner, op, action)) as {
          reused: boolean;
        }
      ).reused,
    ).toBe(true);
    expect(x.status().implementation!.candidate!.version).toBe(1);
    await expect(
      x.store.implementationAction(x.id, x.owner, op, { action: "inspect" }),
    ).rejects.toThrow("different");
    await expect(
      x.store.inspectImplementation(x.id, randomUUID()),
    ).rejects.toThrow("initiating");
    x.store.control(
      x.id,
      x.owner,
      randomUUID(),
      x.status().coordination!.revision,
      { action: "pause" },
    );
    await expect(x.check(one.candidate)).rejects.toThrow("paused");
    x.store.stop(x.id, x.owner, "cancelled", "End fixture");
    await expect(x.check(one.candidate)).rejects.toThrow();
    expect(
      (
        (await x.store.implementationAction(x.id, x.owner, op, action)) as {
          reused: boolean;
        }
      ).reused,
    ).toBe(true);
  } finally {
    x.close();
  }
});
test("out-of-scope, dangling symlink and size limits cannot enter captured material", async () => {
  const x = await fixture();
  try {
    writeFileSync(join(x.root, "outside.txt"), "outside");
    await expect(captureImplementation(x.plan, 1)).rejects.toThrow("scope");
    rmSync(join(x.root, "outside.txt"));
    symlinkSync("/nonexistent-fixture-path", join(x.root, "new.txt"));
    await expect(captureImplementation(x.plan, 1)).rejects.toThrow("Symlink");
    rmSync(join(x.root, "new.txt"));
    writeFileSync(join(x.root, "new.txt"), "x".repeat(17000));
    await expect(captureImplementation(x.plan, 1)).rejects.toThrow("16000");
    writeFileSync(join(x.root, "new.txt"), "x".repeat(4 * 1024 * 1024 + 1));
    await expect(captureImplementation(x.plan, 1)).rejects.toThrow("4 MiB");
  } finally {
    x.close();
  }
});
test("real worktrees combine clean patches and report conflicts while preserving files and indexes", async () => {
  const root = await repo(),
    state = mkdtempSync("/tmp/phase6-index-"),
    a = join(state, "a"),
    b = join(state, "b");
  try {
    await gitOK(root, ["worktree", "add", "--detach", a, "HEAD"]);
    await gitOK(root, ["worktree", "add", "--detach", b, "HEAD"]);
    const ps = await participants(root);
    const raw: ImplementationInput = {
      strategy: "worktrees",
      workspaces: {
        codex: { root: a, paths: ["codex.txt"] },
        claude: { root: b, paths: ["claude.txt"] },
      },
      requiredChecks: ["tests"],
    };
    const plan = await normalizeImplementation(raw, ps);
    expect(plan.isolation).toBe("git_worktrees");
    writeFileSync(join(a, "codex.txt"), "a changed\n");
    writeFileSync(join(b, "claude.txt"), "b changed\n");
    expect(readFileSync(join(root, "codex.txt"), "utf8")).toBe("codex base\n");
    let snap = await captureImplementation(plan, 1);
    const c = { ...snap, resultId: randomUUID(), version: 1, createdAt: 1 };
    const indexPath = (
        await gitOK(a, [
          "rev-parse",
          "--path-format=absolute",
          "--git-path",
          "index",
        ])
      ).trim(),
      before = readFileSync(indexPath);
    expect((await previewIntegration(plan, c, state)).clean).toBe(true);
    expect(readFileSync(indexPath)).toEqual(before);
    await gitOK(a, ["restore", "codex.txt"]);
    await gitOK(b, ["restore", "claude.txt"]);
    raw.workspaces.claude.paths = ["codex.txt"];
    const conflictPlan = await normalizeImplementation(raw, ps);
    writeFileSync(join(a, "codex.txt"), "conflict a\n");
    writeFileSync(join(b, "codex.txt"), "conflict b\n");
    snap = await captureImplementation(conflictPlan, 1);
    const beforeConflict = readFileSync(indexPath);
    expect(
      (
        await previewIntegration(
          conflictPlan,
          { ...snap, resultId: randomUUID(), version: 1, createdAt: 1 },
          state,
        )
      ).clean,
    ).toBe(false);
    expect(readFileSync(join(a, "codex.txt"), "utf8")).toBe("conflict a\n");
    expect(readFileSync(join(b, "codex.txt"), "utf8")).toBe("conflict b\n");
    expect(readFileSync(indexPath)).toEqual(beforeConflict);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});
test("workspace identity and frozen HEAD remain mandatory after writes", async () => {
  const x = await fixture();
  try {
    writeFileSync(join(x.root, "codex.txt"), "change");
    await gitOK(x.root, ["add", "codex.txt"]);
    await gitOK(x.root, ["commit", "-qm", "new head"]);
    await expect(captureImplementation(x.plan, 1)).rejects.toThrow(
      "frozen HEAD",
    );
  } finally {
    x.close();
  }
});
test("MCP/panel share every preset; opt-in permits scoped transport and ordinary runs freeze diffs", async () => {
  const root = await repo(),
    x = await nativeFixture(false, { root }),
    c = await x.connect();
  try {
    await x.call(c, "status", {});
    for (const p of routineCatalog)
      expect(
        (await x.call(c, "collaboration_guide", { routine: { mode: p.id } }))
          .error,
      ).toBeFalsy();
    const panel = startPanel({
      configDir: x.config,
      stateDir: x.state,
      ipcPath: x.desktop.path,
      codexHome: root,
      pluginRoot,
      ownerThread: x.desktop.threadId,
    });
    try {
      const token = new URL(panel.url).hash.slice(7);
      const response = await fetch(panel.origin + "/api/v1/session", {
          method: "POST",
          headers: { Origin: panel.origin, "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        }),
        cookie = response.headers.get("set-cookie")!.split(";")[0]!;
      expect(
        (
          await (
            await fetch(panel.origin + "/api/v1/presets", {
              headers: { Cookie: cookie },
            })
          ).json()
        ).length,
      ).toBe(9);
      const args = {
        requestId: randomUUID(),
        peerId: x.peerId,
        context: { objective: "Fixture scoped collaboration" },
        limits: { maxMessages: 20, maxSeconds: 120 },
        coordination: { initialBarrier: false, leaseSeconds: 300 },
        implementation: input(root),
      };
      const prepared = await x.call(c, "collaboration_prepare", args);
      expect(prepared.error).toBeFalsy();
      const id = prepared.data.id;
      expect(
        (
          await x.call(c, "collaboration_start", {
            runId: id,
            supervised: true,
          })
        ).error,
      ).toBeFalsy();
      writeFileSync(join(root, "codex.txt"), "permitted edit\n");
      expect(
        (
          await x.call(c, "collaboration_send", {
            runId: id,
            messageId: randomUUID(),
            task: { taskId: randomUUID(), intent: "discuss" },
            text: "Inspect permitted change",
          })
        ).error,
      ).toBeFalsy();
      await until(() => x.frames.length > 0);
      const frame = x.frames[0]!;
      expect(frame.type).toBe("user");
      if (frame.type === "user")
        expect(frame.message.content).toContain("Implementation contract");
      await x.call(c, "collaboration_cancel", { runId: id });
      await gitOK(root, ["restore", "codex.txt"]);
      const plain = await x.call(c, "collaboration_prepare", {
        ...args,
        requestId: randomUUID(),
        implementation: undefined,
      });
      expect(plain.error).toBeFalsy();
      await x.call(c, "collaboration_start", {
        runId: plain.data.id,
        supervised: true,
      });
      writeFileSync(join(root, "codex.txt"), "ordinary edit");
      expect(
        (
          await x.call(c, "collaboration_send", {
            runId: plain.data.id,
            messageId: randomUUID(),
            task: { taskId: randomUUID(), intent: "discuss" },
            text: "Should block",
          })
        ).error,
      ).toBe(true);
      expect(x.frames.length).toBe(1);
    } finally {
      await panel.close();
    }
  } finally {
    await c.close();
    await x.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);
test("durable panel capture/check and MCP review produce a revalidated patch; stale download is refused", async () => {
  const root = await repo(),
    x = await nativeFixture(false, { root }),
    c = await x.connect(),
    p = startPanel({
      configDir: x.config,
      stateDir: x.state,
      ipcPath: x.desktop.path,
      codexHome: root,
      pluginRoot,
      ownerThread: x.desktop.threadId,
    });
  try {
    await x.call(c, "status", {});
    const auth = await fetch(p.origin + "/api/v1/session", {
      method: "POST",
      headers: { Origin: p.origin, "Content-Type": "application/json" },
      body: JSON.stringify({ token: new URL(p.url).hash.slice(7) }),
    });
    const { csrf } = (await auth.json()) as { csrf: string },
      cookie = auth.headers.get("set-cookie")!.split(";")[0]!;
    const request = (path: string, body?: unknown) =>
      fetch(p.origin + "/api/v1/" + path, {
        method: body ? "POST" : "GET",
        headers: {
          Cookie: cookie,
          ...(body
            ? {
                Origin: p.origin,
                "Content-Type": "application/json",
                "X-CSRF-Token": csrf,
              }
            : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    const created = await x.call(c, "collaboration_prepare", {
      requestId: randomUUID(),
      peerId: x.peerId,
      context: { objective: "Panel integration fixture" },
      limits: { maxMessages: 20, maxSeconds: 120 },
      coordination: { initialBarrier: false, leaseSeconds: 300 },
      implementation: input(root),
    });
    expect(created.error).toBeFalsy();
    const id = created.data.id;
    await x.call(c, "collaboration_start", { runId: id, supervised: true });
    writeFileSync(join(root, "codex.txt"), "UI candidate\n");
    const apply = async (work: Record<string, unknown>) => {
      const state = (await x.call(c, "collaboration_status", { runId: id }))
          .data,
        commandId = randomUUID();
      expect(
        (
          await request("commands", {
            commandId,
            ownerThread: x.desktop.threadId,
            project: root,
            command: {
              action: "implementation",
              runId: id,
              expectedRevision: state.coordination.revision,
              work,
            },
          })
        ).status,
      ).toBe(202);
      const result = await x.call(c, "collaboration_panel_command", {
        commandId,
      });
      if (result.error) throw new Error(result.data);
      expect(result.error).toBeFalsy();
      expect(
        (await x.call(c, "collaboration_panel_command", { commandId })).data
          .reused,
      ).toBe(true);
      return result.data.implementation;
    };
    const captured = await apply({ action: "capture", taskId: randomUUID() }),
      candidate = captured.candidate;
    expect(candidate.version).toBe(1);
    expect((await request("runs/" + id + "/patch")).status).toBe(409);
    await apply({
      action: "check",
      candidateHash: candidate.contentHash,
      name: "tests",
      command: "fixture check",
      exitCode: 0,
      summary: "Declared fixture success",
    });
    const outgoing = randomUUID(),
      task = {
        taskId: randomUUID(),
        intent: "review",
        target: { resultId: candidate.resultId, version: 1 },
      };
    expect(
      (
        await x.call(c, "collaboration_send", {
          runId: id,
          messageId: outgoing,
          task,
          text: "Review exact candidate",
        })
      ).error,
    ).toBeFalsy();
    await until(() => x.frames.some((f) => f.type === "user"));
    const frame = x.frames.find((f) => f.type === "user")!;
    if (frame.type === "user")
      expect(frame.message.content).toContain("UI candidate");
    await x.respond(
      id,
      outgoing,
      {
        kind: "review",
        taskId: task.taskId,
        resultId: candidate.resultId,
        version: 1,
        verdict: "agree",
        disagreements: [],
      },
      "Fixture agrees",
    );
    await until(() =>
      x.desktop.submissions.some(
        (s) => s.method === "thread-follower-start-turn",
      ),
    );
    await until(
      () => x.bridge.runs.status(id, x.desktop.threadId).reviews.length === 1,
    );
    const inspection = await apply({ action: "inspect" });
    expect(inspection.ready).toBe(true);
    const response = await request("runs/" + id + "/patch");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("UI candidate");
    writeFileSync(join(root, "codex.txt"), "Changed after approval\n");
    expect((await request("runs/" + id + "/patch")).status).toBe(409);
    expect((await request("runs/" + id + "/implementation")).status).toBe(200);
    expect(
      (await x.call(c, "collaboration_implementation_inspect", { runId: id }))
        .data.ready,
    ).toBe(false);
  } finally {
    await p.close();
    await c.close();
    await x.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);
test("unsupported receiver cannot enable writing and lease loss prevents candidate/check mutation", async () => {
  const root = await repo(),
    x = await nativeFixture(false, { root }),
    c = await x.connect();
  try {
    await x.call(c, "status", {});
    const { Database } = await import("bun:sqlite");
    const db = new Database(join(x.state, x.desktop.threadId + ".sqlite"));
    db.run(
      "DELETE FROM receiver_capabilities WHERE capability='implementation_v1'",
    );
    db.close();
    expect(
      (
        await x.call(c, "collaboration_prepare", {
          requestId: randomUUID(),
          peerId: x.peerId,
          context: { objective: "Old receiver" },
          coordination: {},
          implementation: input(root),
        })
      ).error,
    ).toBe(true);
  } finally {
    await c.close();
    await x.close();
    rmSync(root, { recursive: true, force: true });
  }
  const f = await fixture();
  try {
    writeFileSync(join(f.root, "codex.txt"), "lease test");
    const { candidate } = await f.capture();
    const { Database } = await import("bun:sqlite");
    const db = new Database(join(f.state, "collaborations.sqlite"));
    db.run("UPDATE controller_processes SET proc_start='dead process'");
    db.close();
    await expect(f.check(candidate)).rejects.toThrow();
    expect(f.status().state).toBe("recovery_required");
  } finally {
    f.close();
  }
}, 15000);
test("candidate result IDs cannot be replaced by unrelated reports", async () => {
  const f = await fixture();
  try {
    writeFileSync(join(f.root, "codex.txt"), "immutable");
    const { candidate } = await f.capture(),
      task = f.local();
    expect(() =>
      f.store.recordReport(
        f.id,
        f.owner,
        randomUUID(),
        {
          kind: "result",
          taskId: task.taskId,
          resultId: candidate.resultId,
          version: 2,
          title: "Not captured",
          disagreements: [],
        },
        "unrelated text",
      ),
    ).toThrow("captured");
    expect(f.status().implementation!.candidate!.version).toBe(1);
  } finally {
    f.close();
  }
});
test("renames cannot hide a deleted source outside scope and pathspec metacharacters stay literal", async () => {
  const root = await repo();
  try {
    writeFileSync(join(root, "outside.txt"), "source\n");
    await gitOK(root, ["add", "outside.txt"]);
    await gitOK(root, ["commit", "-qm", "source"]);
    const plan = await normalizeImplementation(
      input(root),
      await participants(root),
    );
    rmSync(join(root, "outside.txt"));
    writeFileSync(join(root, "new.txt"), "source\n");
    await expect(captureImplementation(plan, 1)).rejects.toThrow("scope");
    await gitOK(root, ["restore", "outside.txt"]);
    rmSync(join(root, "new.txt"));
    const raw = input(root);
    raw.workspaces.codex.paths = ["codex*.txt"];
    const literal = await normalizeImplementation(
      raw,
      await participants(root),
    );
    writeFileSync(join(root, "codex.txt"), "not literal");
    await expect(captureImplementation(literal, 1)).rejects.toThrow("scope");
    await gitOK(root, ["restore", "codex.txt"]);
    writeFileSync(join(root, "codex*.txt"), "literal file\n");
    const captured = await captureImplementation(literal, 1);
    expect(captured.snapshots[0]!.files[0]!.path).toBe("codex*.txt");
    expect(captured.snapshots[0]!.patch).toContain("literal file");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("scope deletions reject symlinks and Git links; initial roots reject symlinks and foreign repos", async () => {
  const root = await repo(),
    other = await repo(),
    link = root + "-link";
  try {
    symlinkSync(other, link);
    const raw = input(root);
    raw.workspaces.codex.root = link;
    await expect(
      normalizeImplementation(raw, await participants(root)),
    ).rejects.toThrow("symlink");
    raw.workspaces.codex.root = other;
    await expect(
      normalizeImplementation(raw, await participants(root)),
    ).rejects.toThrow("repository");
    rmSync(join(root, "codex.txt"));
    symlinkSync("claude.txt", join(root, "codex.txt"));
    await gitOK(root, ["add", "codex.txt"]);
    await gitOK(root, ["commit", "-qm", "symlink base"]);
    const plan = await normalizeImplementation(
      input(root),
      await participants(root),
    );
    rmSync(join(root, "codex.txt"));
    await expect(captureImplementation(plan, 1)).rejects.toThrow(
      "Symlink/submodule",
    );
    await gitOK(root, ["restore", "codex.txt"]);
    await gitOK(root, [
      "update-index",
      "--add",
      "--cacheinfo",
      "160000," + plan.baseCommit + ",linked",
    ]);
    await gitOK(root, ["commit", "-qm", "gitlink base"]);
    mkdirSync(join(root, "linked"));
    const scopes = input(root);
    scopes.workspaces.codex.paths = ["linked"];
    const gitlink = await normalizeImplementation(
      scopes,
      await participants(root),
    );
    await gitOK(root, ["rm", "--cached", "linked"]);
    await expect(captureImplementation(gitlink, 1)).rejects.toThrow(
      "Symlink/submodule",
    );
  } finally {
    rmSync(link, { force: true });
    rmSync(root, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});
