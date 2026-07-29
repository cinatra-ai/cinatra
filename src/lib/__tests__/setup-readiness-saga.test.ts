/**
 * THE SETUP READINESS SAGA — ordering, path-skipping, failure and compensation
 * (cinatra#2093, epic #2086 S6).
 *
 * These drive the saga through recording ports so every ARM of the control flow
 * is provable, including the ones a live run cannot be made to take on demand
 * (a rejected probe, a throwing strict sync, a commit that silently does not
 * land). The DB-bound half — real Postgres, real S5 consent ledger and strict
 * reconcile, Anthropic stubbed only at the HTTP boundary — is the separate
 * integration walk; this file owns the logic.
 *
 * The properties that matter most and are easiest to regress:
 *   - the OpenAI path performs NO Anthropic egress (no consent, no sync, no
 *     probe) — asserted by recording the calls, not by inspecting comments;
 *   - a failed probe NEVER leaves a receipt behind;
 *   - the disposable probe skill is reclaimed on BOTH the success and the
 *     failure path;
 *   - the `function-tools` MCP mode gets the fix-forward prompt the AC names.
 */
import { describe, it, expect, vi } from "vitest";

import {
  runSetupReadinessSaga,
  type SetupReadinessPorts,
  type SetupReadinessReceipt,
} from "@/lib/setup-readiness-saga";

vi.mock("@/lib/database", () => ({
  readConnectorConfigFromDatabase: vi.fn(() => null),
  writeConnectorConfigToDatabase: vi.fn(),
  readDefaultLlmProviderFromDatabase: vi.fn(() => "openai"),
  writeDefaultLlmProviderToDatabase: vi.fn(),
  // The saga's pre-flight eligibility guard. Derived from defaultCapable in
  // production; here both openai and anthropic are eligible (the un-fencing).
  isGlobalDefaultLlmProviderEligible: vi.fn((p: string) =>
    ["openai", "anthropic", "gemini"].includes(p),
  ),
  readSkillCatalogFromDatabase: vi.fn(() => ({ skills: [] })),
}));

type Recorder = {
  calls: string[];
  ports: SetupReadinessPorts;
  receipts: SetupReadinessReceipt[];
  stored: { value: string };
  disposed: number;
};

function makePorts(over: Partial<SetupReadinessPorts> & { initialProvider?: string } = {}): Recorder {
  const calls: string[] = [];
  const receipts: SetupReadinessReceipt[] = [];
  const stored = { value: over.initialProvider ?? "openai" };
  const state = { disposed: 0 };

  const base: SetupReadinessPorts = {
    async validateCredential(provider) {
      calls.push(`validateCredential:${provider}`);
      return { ok: true };
    },
    async isSurfaceReady(provider) {
      calls.push(`isSurfaceReady:${provider}`);
      return true;
    },
    grantBulkConsent(grantedBy) {
      calls.push(`grantBulkConsent:${grantedBy ?? "null"}`);
    },
    async runStrictInitialSync() {
      calls.push("runStrictInitialSync");
      return { uploadedSkillIds: [{ skillId: "skill_uploaded_1", version: "v1" }] };
    },
    async probeNativeSkills({ skillId, version }) {
      calls.push(`probeNativeSkills:${skillId}@${version}`);
      return { accepted: true, mode: "container-skills" };
    },
    async createDisposableProbeSkill() {
      calls.push("createDisposableProbeSkill");
      return {
        skillId: "skill_disposable",
        version: "vprobe",
        dispose: async () => {
          calls.push("disposeProbeSkill");
          state.disposed++;
        },
      };
    },
    async commitDefaultProvider(provider) {
      calls.push(`commitDefaultProvider:${provider}`);
      stored.value = provider;
    },
    async restoreDefaultProvider(provider) {
      calls.push(`restoreDefaultProvider:${provider}`);
      stored.value = provider;
    },
    readStoredDefaultProvider: () => stored.value,
    computeFingerprint: (p) => `fp-${p}`,
    writeReceipt(receipt) {
      calls.push("writeReceipt");
      receipts.push(receipt);
    },
    clearReceipt() {
      calls.push("clearReceipt");
    },
    now: () => new Date("2026-07-29T10:00:00.000Z"),
  };

  const { initialProvider: _drop, ...portOverrides } = over;
  const ports: SetupReadinessPorts = { ...base, ...portOverrides };
  return {
    calls,
    ports,
    receipts,
    stored,
    get disposed() {
      return state.disposed;
    },
  } as Recorder;
}

describe("setup readiness saga — the OpenAI path (no Anthropic egress)", () => {
  it("completes on credential validation + surface readiness and commits", async () => {
    const r = makePorts();
    const result = await runSetupReadinessSaga({
      provider: "openai",
      actorUserId: "u1",
      ports: r.ports,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.receipt.provider).toBe("openai");
      expect(result.receipt.fingerprint).toBe("fp-openai");
      // No upload happened, so nothing to attest to.
      expect(result.receipt.probe).toBeUndefined();
      expect(result.receipt.syncedSkillCount).toBeUndefined();
    }
    expect(r.stored.value).toBe("openai");
  });

  it("performs NO Anthropic egress: no bulk consent, no sync, no probe", async () => {
    const r = makePorts();
    await runSetupReadinessSaga({ provider: "openai", actorUserId: "u1", ports: r.ports });

    expect(r.calls).not.toContain("grantBulkConsent:u1");
    expect(r.calls).not.toContain("runStrictInitialSync");
    expect(r.calls).not.toContain("createDisposableProbeSkill");
    expect(r.calls.some((c) => c.startsWith("probeNativeSkills"))).toBe(false);
  });

  it("surfaces the matcher constraint only when the choice makes it apply", async () => {
    const openai = await runSetupReadinessSaga({
      provider: "openai",
      actorUserId: null,
      ports: makePorts().ports,
    });
    expect(openai.ok && openai.matcherConstraint).toBeNull();

    const anthropic = await runSetupReadinessSaga({
      provider: "anthropic",
      actorUserId: null,
      ports: makePorts().ports,
    });
    expect(anthropic.ok && anthropic.matcherConstraint).toContain("Skill auto-matching requires OpenAI");
  });
});

describe("setup readiness saga — the Anthropic path", () => {
  it("runs the five steps in order: validate -> consent -> strict sync -> probe -> commit", async () => {
    const r = makePorts();
    const result = await runSetupReadinessSaga({
      provider: "anthropic",
      actorUserId: "admin-1",
      ports: r.ports,
    });

    expect(result.ok).toBe(true);
    expect(r.calls).toEqual([
      "validateCredential:anthropic",
      "isSurfaceReady:anthropic",
      "grantBulkConsent:admin-1",
      "runStrictInitialSync",
      "probeNativeSkills:skill_uploaded_1@v1",
      "commitDefaultProvider:anthropic",
      "writeReceipt",
    ]);
  });

  it("probes with an ACTUALLY-UPLOADED revision id, not a fabricated one", async () => {
    const r = makePorts({
      runStrictInitialSync: async () => ({
        uploadedSkillIds: [{ skillId: "skill_real_abc", version: "rev-7" }],
      }),
    });
    await runSetupReadinessSaga({ provider: "anthropic", actorUserId: null, ports: r.ports });
    // BOTH halves of the container.skills reference — an id alone could resolve
    // a different revision than the one the sync just uploaded.
    expect(r.calls).toContain("probeNativeSkills:skill_real_abc@rev-7");
    expect(r.calls).not.toContain("createDisposableProbeSkill");
  });

  it("records probe + sync evidence on the receipt", async () => {
    const r = makePorts({
      runStrictInitialSync: async () => ({
        uploadedSkillIds: [
          { skillId: "a", version: "v1" },
          { skillId: "b", version: "v1" },
          { skillId: "c", version: "v1" },
        ],
      }),
    });
    const result = await runSetupReadinessSaga({
      provider: "anthropic",
      actorUserId: null,
      ports: r.ports,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.receipt.syncedSkillCount).toBe(3);
      expect(result.receipt.probe).toEqual({
        accepted: true,
        mode: "container-skills",
        skillId: "a",
        version: "v1",
        disposable: false,
      });
    }
  });

  it("falls back to a DISPOSABLE probe skill when the synced set is legitimately empty, and reclaims it", async () => {
    const r = makePorts({ runStrictInitialSync: async () => ({ uploadedSkillIds: [] }) });
    const result = await runSetupReadinessSaga({
      provider: "anthropic",
      actorUserId: null,
      ports: r.ports,
    });

    expect(result.ok).toBe(true);
    expect(r.calls).toContain("createDisposableProbeSkill");
    expect(r.calls).toContain("probeNativeSkills:skill_disposable@vprobe");
    expect(r.calls).toContain("disposeProbeSkill");
    if (result.ok) expect(result.receipt.probe?.disposable).toBe(true);
  });
});

describe("setup readiness saga — failure + compensation", () => {
  it("a rejected credential stops BEFORE any consent or upload", async () => {
    const r = makePorts({
      validateCredential: async () => ({ ok: false, message: "invalid api key" }),
    });
    const result = await runSetupReadinessSaga({
      provider: "anthropic",
      actorUserId: null,
      ports: r.ports,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.step).toBe("credential-validation");
      expect(result.failure.message).toContain("invalid api key");
    }
    expect(r.calls).not.toContain("grantBulkConsent:null");
    expect(r.calls).not.toContain("runStrictInitialSync");
  });

  it("a THROWING strict sync fails the saga with an actionable message and no receipt", async () => {
    const r = makePorts({
      runStrictInitialSync: async () => {
        throw new Error("skill bundle exceeds the 30MB upload boundary");
      },
    });
    const result = await runSetupReadinessSaga({
      provider: "anthropic",
      actorUserId: null,
      ports: r.ports,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.step).toBe("initial-sync");
      expect(result.failure.message).toContain("30MB");
      expect(result.failure.fixForward).toBeTruthy();
    }
    expect(r.receipts).toEqual([]);
    expect(r.calls).toContain("clearReceipt");
    expect(r.calls).not.toContain("commitDefaultProvider:anthropic");
  });

  it("a function-tools MCP mode fails the probe with the FIX-FORWARD prompt (the AC by name)", async () => {
    const r = makePorts({
      probeNativeSkills: async () => ({
        accepted: false,
        mode: "function-tools",
        reason: "container.skills is not supported in function-tools mode",
      }),
    });
    const result = await runSetupReadinessSaga({
      provider: "anthropic",
      actorUserId: null,
      ports: r.ports,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.step).toBe("native-skills-probe");
      expect(result.failure.message).toContain("container.skills");
      expect(result.failure.fixForward).toContain("'native'");
    }
    // The decisive property: setup did NOT complete, so nothing reads as ready.
    expect(r.receipts).toEqual([]);
    expect(r.calls).not.toContain("commitDefaultProvider:anthropic");
  });

  it("a THROWN probe is inconclusive and therefore FAILS (fail-closed)", async () => {
    const r = makePorts({
      probeNativeSkills: async () => {
        throw new Error("network unreachable");
      },
    });
    const result = await runSetupReadinessSaga({
      provider: "anthropic",
      actorUserId: null,
      ports: r.ports,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.step).toBe("native-skills-probe");
    expect(r.receipts).toEqual([]);
  });

  it("the disposable probe skill is reclaimed even when the probe REJECTS", async () => {
    const r = makePorts({
      runStrictInitialSync: async () => ({ uploadedSkillIds: [] }),
      probeNativeSkills: async () => ({ accepted: false, mode: "function-tools" }),
    });
    await runSetupReadinessSaga({ provider: "anthropic", actorUserId: null, ports: r.ports });
    expect(r.calls).toContain("disposeProbeSkill");
  });

  it("the disposable probe skill is reclaimed even when the probe THROWS", async () => {
    const r = makePorts({
      runStrictInitialSync: async () => ({ uploadedSkillIds: [] }),
      probeNativeSkills: async () => {
        throw new Error("boom");
      },
    });
    await runSetupReadinessSaga({ provider: "anthropic", actorUserId: null, ports: r.ports });
    expect(r.calls).toContain("disposeProbeSkill");
  });

  it("a failed dispose does not turn a passing setup into a failure", async () => {
    const r = makePorts({
      runStrictInitialSync: async () => ({ uploadedSkillIds: [] }),
      createDisposableProbeSkill: async () => ({
        skillId: "skill_disposable",
        version: "vprobe",
        dispose: async () => {
          throw new Error("delete failed");
        },
      }),
    });
    const result = await runSetupReadinessSaga({
      provider: "anthropic",
      actorUserId: null,
      ports: r.ports,
    });
    // The probe SUCCEEDED; failing to clean up remote litter is a warning, not
    // a reason to refuse a working configuration.
    expect(result.ok).toBe(true);
  });

  it("onFailure:'rollback' restores the previously stored provider", async () => {
    const r = makePorts({
      initialProvider: "openai",
      probeNativeSkills: async () => ({ accepted: false, mode: "function-tools" }),
    });
    const result = await runSetupReadinessSaga({
      provider: "anthropic",
      actorUserId: null,
      onFailure: "rollback",
      ports: r.ports,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.compensation).toBe("rolled-back");
    expect(r.calls).toContain("restoreDefaultProvider:openai");
    expect(r.stored.value).toBe("openai");
  });

  it("the default compensation is 'setup-incomplete' — the wizard keeps prompting", async () => {
    const r = makePorts({
      probeNativeSkills: async () => ({ accepted: false }),
    });
    const result = await runSetupReadinessSaga({
      provider: "anthropic",
      actorUserId: null,
      ports: r.ports,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.compensation).toBe("setup-incomplete");
    expect(r.calls).not.toContain("restoreDefaultProvider:openai");
  });

  it("a commit that silently does not land is caught (the chokepoint PRESERVES rather than throws)", async () => {
    const r = makePorts({
      // Mimic the write-refusal chokepoint: no throw, prior value preserved.
      commitDefaultProvider: async () => {},
    });
    const result = await runSetupReadinessSaga({
      provider: "anthropic",
      actorUserId: null,
      ports: r.ports,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.step).toBe("commit");
      expect(result.failure.message).toContain("still");
    }
    expect(r.receipts).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// CODEX ROUND-1 ADOPTED FINDINGS — regression locks.
// Each of these was a real defect found in review; without a test they would
// reappear the next time this file is touched.
// ---------------------------------------------------------------------------

describe("setup readiness saga — codex round-1 regressions", () => {
  it("#1 the ASYNC commit is awaited BEFORE the post-commit verification", async () => {
    // The audited mutation completes a strict audit insert before writing. A
    // sync port forced the caller to smuggle the promise out, so verification
    // read the PRE-commit value and a provider switch always 'failed'.
    const r = makePorts({
      initialProvider: "openai",
      commitDefaultProvider: async (p) => {
        await new Promise((resolve) => setTimeout(resolve, 5)); // the audit insert
        r.stored.value = p;
      },
    });
    const result = await runSetupReadinessSaga({
      provider: "anthropic",
      actorUserId: null,
      ports: r.ports,
    });
    expect(result.ok).toBe(true);
    expect(r.stored.value).toBe("anthropic");
  });

  it("#1 a THROWING commit fails the saga and leaves no receipt", async () => {
    const r = makePorts({
      commitDefaultProvider: async () => {
        throw new Error("audit write failed");
      },
    });
    const result = await runSetupReadinessSaga({
      provider: "anthropic",
      actorUserId: null,
      ports: r.ports,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.step).toBe("commit");
    expect(r.receipts).toEqual([]);
  });

  it("#2 a RECEIPT-WRITE failure restores the prior provider even under leave-incomplete", async () => {
    // Otherwise the provider stays committed with no evidence — reading forever
    // as 'a provider was chosen but never verified'.
    const r = makePorts({
      initialProvider: "openai",
      writeReceipt: () => {
        throw new Error("disk full");
      },
    });
    const result = await runSetupReadinessSaga({
      provider: "anthropic",
      actorUserId: null,
      onFailure: "leave-incomplete",
      ports: r.ports,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.compensation).toBe("rolled-back");
    expect(r.calls).toContain("restoreDefaultProvider:openai");
    expect(r.stored.value).toBe("openai");
  });

  it("#2 a failing clearReceipt does NOT mask the original failure", async () => {
    const r = makePorts({
      probeNativeSkills: async () => ({ accepted: false, mode: "function-tools" }),
      clearReceipt: () => {
        throw new Error("clear failed");
      },
    });
    const result = await runSetupReadinessSaga({
      provider: "anthropic",
      actorUserId: null,
      ports: r.ports,
    });
    // The reported step is the PROBE, not the bookkeeping that also failed.
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.step).toBe("native-skills-probe");
  });

  it("#9 a configuration change DURING the run is refused rather than stamped verified", async () => {
    // The fingerprint is captured before the proof and re-compared at commit.
    let calls = 0;
    const r = makePorts({
      computeFingerprint: () => {
        calls += 1;
        return calls === 1 ? "fp-before" : "fp-after-rotation";
      },
    });
    const result = await runSetupReadinessSaga({
      provider: "anthropic",
      actorUserId: null,
      ports: r.ports,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.step).toBe("commit");
      expect(result.failure.message).toContain("changed while setup was verifying");
    }
    expect(r.receipts).toEqual([]);
  });

  it("#10 a provider error carrying a credential is REDACTED before it becomes durable state", async () => {
    const r = makePorts({
      probeNativeSkills: async () => ({
        accepted: false,
        mode: "unknown",
        reason: "rejected for key sk-ant-abcdefghijklmnopqrstuvwxyz012345",
      }),
    });
    const result = await runSetupReadinessSaga({
      provider: "anthropic",
      actorUserId: null,
      ports: r.ports,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.message).not.toContain("abcdefghijklmnopqrstuvwxyz012345");
      expect(result.failure.message).toContain("sk-ant-[redacted]");
    }
  });

  it("#10 an unbounded provider error is bounded", async () => {
    const r = makePorts({
      runStrictInitialSync: async () => {
        throw new Error("x".repeat(5000));
      },
    });
    const result = await runSetupReadinessSaga({
      provider: "anthropic",
      actorUserId: null,
      ports: r.ports,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.message.length).toBeLessThan(600);
  });
});
