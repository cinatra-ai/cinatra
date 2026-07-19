/**
 * Execution-plane injection PRIMITIVE + policy tests (exec-plane S1,
 * cinatra#1706).
 *
 * `injectExecutionCapability` is the single primitive the four orchestration
 * entry points call. These tests pin the invariants the design requires of it,
 * independent of any entry point:
 *  - fail-closed: no attributable caller ⇒ `no_session` (never a tool);
 *  - `capability_unavailable` (opt-out / broker-secret-missing) is
 *    DISTINGUISHABLE from `no_session`;
 *  - the rollout merge gate defaults OFF (dark) ⇒ pure passthrough;
 *  - technical carve-outs (single-step / structured-output) suppress silently;
 *  - idempotency: a tools array already carrying the tool is returned unchanged
 *    with NO second cue (the exactly-once-cue invariant);
 *  - tool and cue are composed together by ONE call — they cannot diverge.
 */
import { describe, it, expect } from "vitest";
import {
  injectExecutionCapability,
  isExecutionPlaneRolloutEnabled,
  shouldSuppressExecutionForTask,
  ensureToolAwareStepBudget,
  composeExecutionCue,
  buildSandboxExecutionTool,
  hasSandboxExecutionTool,
  isSandboxExecutionTool,
  stripSandboxExecutionTools,
  sealExecutionSession,
  SANDBOX_EXECUTE_TOOL_NAME,
} from "../index";
import type { ExecutionSession } from "../index";
import type { LlmTool, SandboxExecutor } from "../../types";

const SECRET = "test-broker-secret";
const ON = "on";
const session: ExecutionSession = {
  orgId: "org-1",
  userId: "user-1",
  surface: "chat",
};

/** Recording fake executor (S2): captures what crosses the executor seam. */
function makeExecutor(): {
  executor: SandboxExecutor;
  calls: Array<Parameters<SandboxExecutor>[0]>;
} {
  const calls: Array<Parameters<SandboxExecutor>[0]> = [];
  const executor: SandboxExecutor = async (input) => {
    calls.push(input);
    return input.commands.map(() => ({
      stdout: "ok",
      stderr: "",
      outcome: { type: "exit" as const, exitCode: 0 },
    }));
  };
  return { executor, calls };
}

const defaultExecutor = makeExecutor().executor;

const inj = (over: Parameters<typeof injectExecutionCapability>[0]) =>
  injectExecutionCapability({
    rolloutOverride: ON,
    brokerSecret: SECRET,
    executor: defaultExecutor,
    ...over,
  });

describe("rollout merge gate — default OFF", () => {
  it.each(["", "off", "true", "1", "ON", "On", undefined as unknown as string])(
    "stays OFF for %p (only the exact string 'on' enables)",
    (v) => {
      expect(isExecutionPlaneRolloutEnabled(v)).toBe(false);
    },
  );
  it("enables ONLY for the exact string 'on'", () => {
    expect(isExecutionPlaneRolloutEnabled("on")).toBe(true);
  });
  it("rollout OFF ⇒ pure passthrough, exact tools preserved", () => {
    const tools: LlmTool[] = [{ type: "web_search" }];
    const r = injectExecutionCapability({
      tools,
      session,
      rolloutOverride: "off",
      brokerSecret: SECRET,
    });
    expect(r.status).toBe("passthrough");
    if (r.status === "passthrough") {
      expect(r.reason).toBe("rollout_disabled");
      expect(r.tools).toBe(tools); // same reference — byte-identical
    }
  });
});

describe("fail-closed identity", () => {
  it("no session material at all ⇒ no_session (never a tool)", () => {
    const r = inj({ tools: undefined });
    expect(r.status).toBe("unavailable");
    if (r.status === "unavailable") expect(r.error.kind).toBe("no_session");
  });

  it("mint with an empty orgId ⇒ no_session (unidentifiable caller)", () => {
    const r = inj({ tools: undefined, mint: { orgId: "", userId: "u", surface: "chat" } });
    expect(r.status).toBe("unavailable");
    if (r.status === "unavailable") expect(r.error.kind).toBe("no_session");
  });

  it("mint with a full identity ⇒ injected", () => {
    const r = inj({
      tools: undefined,
      mint: { orgId: "o", userId: "u", surface: "agent_run", runId: "r1" },
    });
    expect(r.status).toBe("injected");
  });
});

describe("capability_unavailable is DISTINGUISHABLE from no_session", () => {
  it("identified caller opted-out ⇒ capability_unavailable (not no_session)", () => {
    const r = inj({ tools: undefined, session, availability: "disabled" });
    expect(r.status).toBe("unavailable");
    if (r.status === "unavailable") expect(r.error.kind).toBe("capability_unavailable");
  });

  it("broker secret missing ⇒ capability_unavailable (plane cannot seal)", () => {
    const r = injectExecutionCapability({
      tools: undefined,
      session,
      rolloutOverride: ON,
      brokerSecret: "", // resolves as absent → seal fails → unavailable
      executor: defaultExecutor,
    });
    expect(r.status).toBe("unavailable");
    if (r.status === "unavailable") expect(r.error.kind).toBe("capability_unavailable");
  });

  it("NO executor binding ⇒ capability_unavailable (S2: never a schema into a void)", () => {
    const r = injectExecutionCapability({
      tools: undefined,
      session,
      rolloutOverride: ON,
      brokerSecret: SECRET,
      // executor deliberately absent
    });
    expect(r.status).toBe("unavailable");
    if (r.status === "unavailable") {
      expect(r.error.kind).toBe("capability_unavailable");
      expect(r.error.message).toContain("executor");
    }
  });
});

describe("technical carve-outs (D4) suppress silently — not an error", () => {
  it("structured-output task (outputSchema) suppresses", () => {
    const r = inj({ tools: undefined, session, task: { outputSchema: { type: "object" } } });
    expect(r.status).toBe("passthrough");
    if (r.status === "passthrough") expect(r.reason).toBe("task_suppressed");
  });
  it("explicit single-step task (maxSteps === 1) suppresses", () => {
    const r = inj({ tools: undefined, session, task: { maxSteps: 1 } });
    expect(r.status).toBe("passthrough");
    if (r.status === "passthrough") expect(r.reason).toBe("task_suppressed");
  });
  it("multi-step task does NOT suppress", () => {
    expect(shouldSuppressExecutionForTask({ maxSteps: 4 })).toBe(false);
    const r = inj({ tools: undefined, session, task: { maxSteps: 4 } });
    expect(r.status).toBe("injected");
  });
});

describe("idempotency — tool dedup + exactly-once cue", () => {
  it("a tools array already carrying the sandbox tool ⇒ already_injected, no second cue", () => {
    const carrier = sealExecutionSession(session, { secret: SECRET });
    const existing = buildSandboxExecutionTool({
      sessionCarrier: carrier,
      executor: defaultExecutor,
    });
    const tools: LlmTool[] = [{ type: "web_search" }, existing];
    const r = inj({ tools, session });
    expect(r.status).toBe("passthrough");
    if (r.status === "passthrough") {
      expect(r.reason).toBe("already_injected");
      expect(r.tools).toBe(tools);
      // Exactly ONE sandbox tool — never doubled.
      expect((r.tools ?? []).filter(isSandboxExecutionTool)).toHaveLength(1);
    }
  });

  it("injected path adds EXACTLY ONE sandbox tool and ONE cue", () => {
    const tools: LlmTool[] = [{ type: "web_search" }];
    const r = inj({ tools, session });
    expect(r.status).toBe("injected");
    if (r.status === "injected") {
      expect(r.tools.filter(isSandboxExecutionTool)).toHaveLength(1);
      // The cue is composed by the SAME call that built the tool — they cannot
      // diverge. A re-run over the injected result is a no-op (already_injected).
      expect(r.systemCue).toBe(composeExecutionCue(session));
      const again = inj({ tools: r.tools, session });
      expect(again.status).toBe("passthrough");
    }
  });
});

describe("pre-minted session hardening — no trust by type (codex round)", () => {
  it("an EMPTY pre-minted identity ⇒ no_session (never sealed, never thrown into the call)", () => {
    const bad = { orgId: "", userId: "", surface: "chat" } as unknown as ExecutionSession;
    const r = inj({ tools: undefined, session: bad });
    expect(r.status).toBe("unavailable");
    if (r.status === "unavailable") expect(r.error.kind).toBe("no_session");
  });

  it("a pre-minted session with SMUGGLED extra fields never seals them into the carrier", async () => {
    const smuggled = {
      orgId: "org-1",
      userId: "user-1",
      surface: "chat",
      // Host/secret fields a cast/JS caller could try to attach:
      apiKey: "sk-SECRET",
      hostPath: "/etc/shadow",
    } as unknown as ExecutionSession;
    const rec = makeExecutor();
    const r = inj({ tools: undefined, session: smuggled, executor: rec.executor });
    expect(r.status).toBe("injected");
    if (r.status === "injected") {
      const t = r.tools.find(isSandboxExecutionTool)!;
      // S2: the carrier lives ONLY in the execute closure — observe it at the
      // executor seam (the sole place it may legitimately reappear).
      await t.execute({ commands: ["true"] });
      const carrier = rec.calls[0].sessionCarrier;
      const body = carrier.split(".")[1];
      const decoded = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
      expect(Object.keys(decoded).sort()).toEqual(
        ["exp", "iat", "orgId", "surface", "userId"].sort(),
      );
      expect(decoded).not.toHaveProperty("apiKey");
      expect(decoded).not.toHaveProperty("hostPath");
    }
  });
});

describe("injected tool contract (S2: carrier-in-closure)", () => {
  it("carries the fixed tool name; NO carrier field and no raw identity on the object", async () => {
    const rec = makeExecutor();
    const r = inj({ tools: undefined, session, executor: rec.executor });
    expect(r.status).toBe("injected");
    if (r.status === "injected") {
      const t = r.tools.find(isSandboxExecutionTool)!;
      expect(t.toolName).toBe(SANDBOX_EXECUTE_TOOL_NAME);
      expect(t.toolName).toBe("sandbox_execute");
      // S2 provider-boundary guarantee BY CONSTRUCTION: the tool object that
      // crosses into the adapters has no carrier field and no raw identity —
      // JSON-serializing it leaks nothing session-bound.
      expect(t).not.toHaveProperty("sessionCarrier");
      expect(t).not.toHaveProperty("orgId");
      expect(t).not.toHaveProperty("userId");
      expect(JSON.stringify(t)).not.toContain("org-1");
      expect(JSON.stringify(t)).not.toContain("user-1");
      // The executor receives the sealed carrier on dispatch.
      await t.execute({ commands: ["echo hi"] });
      expect(rec.calls).toHaveLength(1);
      expect(rec.calls[0].sessionCarrier.startsWith("v1.")).toBe(true);
      expect(rec.calls[0].commands).toEqual(["echo hi"]);
    }
  });

  it("merges staged skill snapshots from delivery shell tools into the session (S2 unification)", async () => {
    const rec = makeExecutor();
    const reads: string[] = [];
    const shellTool: LlmTool = {
      type: "shell",
      skills: [{ name: "my-skill", description: "does things", path: "/skills/my-skill" }],
      execute: async () => [],
      stagedSkills: [
        {
          skillId: "skill-1",
          slug: "my-skill",
          description: "does things",
          resolveFiles: async () => [
            { path: "SKILL.md", content: "# body", digest: "d".repeat(64) },
          ],
          onRead: (id) => reads.push(id),
        },
      ],
    };
    const r = inj({ tools: [shellTool], session, executor: rec.executor });
    expect(r.status).toBe("injected");
    if (r.status === "injected") {
      const t = r.tools.find(isSandboxExecutionTool)!;
      expect(t.stagedSkills?.map((s) => s.slug)).toEqual(["my-skill"]);
      // The cue names the staged path (tool and cue composed together).
      expect(r.systemCue).toContain("/skills/my-skill");
      // Dispatch forwards the staged skills to the executor and fires the
      // attributable read signal when a command references the staged path.
      await t.execute({ commands: ["cat /skills/my-skill/SKILL.md"] });
      expect(rec.calls[0].stagedSkills?.map((s) => s.slug)).toEqual(["my-skill"]);
      expect(reads).toEqual(["skill-1"]);
      // A command NOT referencing the path does not fire the signal.
      await t.execute({ commands: ["echo unrelated"] });
      expect(reads).toEqual(["skill-1"]);
    }
  });

  it("threads the resolved L1 environment mount to the executor, never onto the tool object (S3, cinatra#1708)", async () => {
    const rec = makeExecutor();
    const mount = {
      imageRef: "cinatra-sandbox-l1:recipe-key",
      provenance: { imageDigest: "sha256:declared", signature: "sig" },
    };
    const r = inj({ tools: undefined, session, executor: rec.executor, environment: mount });
    expect(r.status).toBe("injected");
    if (r.status === "injected") {
      const t = r.tools.find(isSandboxExecutionTool)!;
      // The mount is captured in the execute closure — never a tool field, so
      // it cannot cross the provider boundary (same guarantee as the carrier).
      expect(t).not.toHaveProperty("environment");
      expect(JSON.stringify(t)).not.toContain("sha256:declared");
      // It reaches the executor on dispatch (→ broker.openJob({ environment })).
      await t.execute({ commands: ["python -c 'import pandas'"] });
      expect(rec.calls[0].environment).toEqual(mount);
    }
  });

  it("omits environment at the executor seam when no declared env is supplied (byte-identical L0 dispatch)", async () => {
    const rec = makeExecutor();
    const r = inj({ tools: undefined, session, executor: rec.executor });
    expect(r.status).toBe("injected");
    if (r.status === "injected") {
      const t = r.tools.find(isSandboxExecutionTool)!;
      await t.execute({ commands: ["echo hi"] });
      expect(rec.calls[0].environment).toBeUndefined();
    }
  });
});

describe("tool helpers", () => {
  it("stripSandboxExecutionTools removes every sandbox tool, preserves the rest", () => {
    const carrier = sealExecutionSession(session, { secret: SECRET });
    const tools: LlmTool[] = [
      { type: "web_search" },
      buildSandboxExecutionTool({ sessionCarrier: carrier, executor: defaultExecutor }),
    ];
    const stripped = stripSandboxExecutionTools(tools)!;
    expect(hasSandboxExecutionTool(stripped)).toBe(false);
    expect(stripped).toHaveLength(1);
    expect(stripped[0]).toEqual({ type: "web_search" });
  });
  it("stripSandboxExecutionTools(undefined) === undefined (byte-identical no-tools)", () => {
    expect(stripSandboxExecutionTools(undefined)).toBeUndefined();
  });
});

describe("ensureToolAwareStepBudget", () => {
  it.each([
    [undefined, 2],
    [1, 2],
    [2, 2],
    [5, 5],
  ])("requested %p → %p (never below 2, never lowers a larger budget)", (req, exp) => {
    expect(ensureToolAwareStepBudget(req as number | undefined)).toBe(exp);
  });
});

describe("composeExecutionCue — no secrets / no host detail", () => {
  it("names the tool, states no-credentials, mentions persistence", () => {
    const cue = composeExecutionCue(session);
    expect(cue).toContain("sandbox_execute");
    expect(cue).toContain("NO credentials");
    expect(cue.toLowerCase()).toContain("persist");
  });
});
