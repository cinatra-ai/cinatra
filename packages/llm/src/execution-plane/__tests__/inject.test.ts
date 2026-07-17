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
import type { LlmTool } from "../../types";

const SECRET = "test-broker-secret";
const ON = "on";
const session: ExecutionSession = {
  orgId: "org-1",
  userId: "user-1",
  surface: "chat",
};

const inj = (over: Parameters<typeof injectExecutionCapability>[0]) =>
  injectExecutionCapability({ rolloutOverride: ON, brokerSecret: SECRET, ...over });

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
    });
    expect(r.status).toBe("unavailable");
    if (r.status === "unavailable") expect(r.error.kind).toBe("capability_unavailable");
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
    const existing = buildSandboxExecutionTool(carrier);
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

  it("a pre-minted session with SMUGGLED extra fields never seals them into the carrier", () => {
    const smuggled = {
      orgId: "org-1",
      userId: "user-1",
      surface: "chat",
      // Host/secret fields a cast/JS caller could try to attach:
      apiKey: "sk-SECRET",
      hostPath: "/etc/shadow",
    } as unknown as ExecutionSession;
    const r = inj({ tools: undefined, session: smuggled });
    expect(r.status).toBe("injected");
    if (r.status === "injected") {
      const t = r.tools.find(isSandboxExecutionTool)!;
      const body = t.sessionCarrier.split(".")[1];
      const decoded = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
      expect(Object.keys(decoded).sort()).toEqual(
        ["exp", "iat", "orgId", "surface", "userId"].sort(),
      );
      expect(decoded).not.toHaveProperty("apiKey");
      expect(decoded).not.toHaveProperty("hostPath");
    }
  });
});

describe("injected tool contract", () => {
  it("carries the fixed tool name and a broker-verifiable carrier, no raw identity", () => {
    const r = inj({ tools: undefined, session });
    expect(r.status).toBe("injected");
    if (r.status === "injected") {
      const t = r.tools.find(isSandboxExecutionTool)!;
      expect(t.toolName).toBe(SANDBOX_EXECUTE_TOOL_NAME);
      expect(t.toolName).toBe("sandbox_execute");
      // The carrier is opaque (sealed) — the raw orgId/userId are NOT present
      // as plaintext object fields on the tool.
      expect(t).not.toHaveProperty("orgId");
      expect(t).not.toHaveProperty("userId");
      expect(typeof t.sessionCarrier).toBe("string");
      expect(t.sessionCarrier.startsWith("v1.")).toBe(true);
    }
  });
});

describe("tool helpers", () => {
  it("stripSandboxExecutionTools removes every sandbox tool, preserves the rest", () => {
    const carrier = sealExecutionSession(session, { secret: SECRET });
    const tools: LlmTool[] = [
      { type: "web_search" },
      buildSandboxExecutionTool(carrier),
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
