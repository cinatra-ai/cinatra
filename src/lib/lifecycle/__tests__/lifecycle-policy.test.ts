/**
 * cinatra#2038 (epic #2037 S0) — the policy LATTICE matrix (AC-1) + separation of
 * duties. Pure, DB-free.
 *
 * AC-1: bounds beat defaults; manifest skip takes effect where org is silent and
 * NEVER on external-effect classes; per-run elevation cannot weaken `required`;
 * unevaluable → fail-closed on external effects.
 */
import { describe, it, expect } from "vitest";

import {
  coreDefault,
  evaluatePolicy,
  isExternalEffectClass,
  lifecycleOriginKind,
  type EvaluatePolicyInput,
  type OrgPolicyRule,
} from "../lifecycle-policy";
import { evaluateSeparationOfDuties } from "../lifecycle-separation-of-duties";

const SILENT: OrgPolicyRule = { bound: "silent" };

function base(over: Partial<EvaluatePolicyInput> = {}): EvaluatePolicyInput {
  return {
    checkpoint: "review",
    artifactType: "document",
    destinationClass: "none",
    originKind: "agent_produced",
    humanPresent: true,
    orgRule: SILENT,
    ...over,
  };
}

describe("origin-kind mapping", () => {
  it("maps physical ArtifactOriginKind onto the lattice axis", () => {
    expect(lifecycleOriginKind("agent_generated")).toBe("agent_produced");
    expect(lifecycleOriginKind("upload")).toBe("user_provided");
    expect(lifecycleOriginKind("email_attachment")).toBe("user_provided");
    expect(lifecycleOriginKind("external_link")).toBe("user_provided");
    expect(lifecycleOriginKind("live_generator")).toBe("intermediate");
  });
});

describe("core defaults (normative)", () => {
  it("recommendation: ON for human-present, OFF for headless", () => {
    expect(coreDefault({ checkpoint: "recommendation", destinationClass: "none", originKind: "agent_produced", humanPresent: true })).toBe("fire");
    expect(coreDefault({ checkpoint: "recommendation", destinationClass: "none", originKind: "agent_produced", humanPresent: false })).toBe("skip");
  });
  it("review: ON for agent-produced durable + any external effect; OFF for intermediate + human-provided local", () => {
    expect(coreDefault({ checkpoint: "review", destinationClass: "none", originKind: "agent_produced", humanPresent: true })).toBe("fire");
    expect(coreDefault({ checkpoint: "review", destinationClass: "external_publish", originKind: "user_provided", humanPresent: true })).toBe("fire");
    expect(coreDefault({ checkpoint: "review", destinationClass: "none", originKind: "intermediate", humanPresent: true })).toBe("skip");
    expect(coreDefault({ checkpoint: "review", destinationClass: "none", originKind: "user_provided", humanPresent: true })).toBe("skip");
  });
  it("verification: ON on remote apply + when changes_requested; else indeterminate", () => {
    expect(coreDefault({ checkpoint: "verification", destinationClass: "external_publish", originKind: "agent_produced", humanPresent: true })).toBe("fire");
    expect(coreDefault({ checkpoint: "verification", destinationClass: "none", originKind: "agent_produced", humanPresent: true, changesRequestedOccurred: true })).toBe("fire");
    expect(coreDefault({ checkpoint: "verification", destinationClass: "none", originKind: "agent_produced", humanPresent: true })).toBe("indeterminate");
  });
});

describe("AC-1: bounds beat defaults", () => {
  it("org 'required' fires a checkpoint whose default would SKIP", () => {
    // review default for intermediate = skip; org requires → fires.
    const d = evaluatePolicy(base({ originKind: "intermediate", orgRule: { bound: "required" } }));
    expect(d.outcome).toBe("required");
    expect(d.fired).toBe(true);
    expect(d.decidedBy).toBe("org-bound");
  });
  it("org 'forbidden' bars a checkpoint whose default would FIRE", () => {
    // review default for agent_produced = fire; org forbids → barred.
    const d = evaluatePolicy(base({ orgRule: { bound: "forbidden" } }));
    expect(d.outcome).toBe("forbidden");
    expect(d.fired).toBe(false);
    expect(d.decidedBy).toBe("org-bound");
  });
});

describe("AC-1: manifest skip only where org is silent AND non-external", () => {
  it("a manifest skip takes effect where the org is silent + class is non-external", () => {
    const d = evaluatePolicy(base({ manifest: { requestedSkips: ["review"] } }));
    expect(d.outcome).toBe("skip");
    expect(d.decidedBy).toBe("manifest");
  });
  it("a manifest skip is IGNORED on an external-effect class (fails closed → still fires)", () => {
    const d = evaluatePolicy(
      base({ destinationClass: "external_publish", originKind: "user_provided", manifest: { requestedSkips: ["review"] } }),
    );
    expect(isExternalEffectClass("external_publish")).toBe(true);
    expect(d.outcome).toBe("fire");
    expect(d.decidedBy).toBe("core-default");
  });
  it("a manifest skip can NEVER skip an org-'required' gate", () => {
    const d = evaluatePolicy(base({ orgRule: { bound: "required" }, manifest: { requestedSkips: ["review"] } }));
    expect(d.outcome).toBe("required");
    expect(d.fired).toBe(true);
  });
});

describe("AC-1: per-run elevation elevates only (cannot weaken required)", () => {
  it("elevation forces a skipped checkpoint ON", () => {
    // human-provided local review default = skip; elevation forces it on.
    const d = evaluatePolicy(base({ originKind: "user_provided", elevation: { forceOn: ["review"] } }));
    expect(d.outcome).toBe("fire");
    expect(d.decidedBy).toBe("elevation");
  });
  it("elevation is a no-op on an org-'required' gate (stays required — never weakened)", () => {
    const d = evaluatePolicy(base({ orgRule: { bound: "required" }, elevation: { forceOn: ["review"] } }));
    expect(d.outcome).toBe("required");
    expect(d.fired).toBe(true);
  });
  it("there is no run choice that skips a fired gate (elevation has no requestOff)", () => {
    // A default-fire checkpoint stays fired regardless of any run input — the
    // RunElevation type admits only forceOn.
    const d = evaluatePolicy(base({ elevation: { forceOn: [] } }));
    expect(d.fired).toBe(true);
  });
});

describe("AC-1: unevaluable policy fails closed on external effects", () => {
  it("verification indeterminate on an EXTERNAL-effect class → policy_unresolved (blocked)", () => {
    const d = evaluatePolicy(
      base({ checkpoint: "verification", destinationClass: "visibility_promotion", originKind: "agent_produced" }),
    );
    expect(d.outcome).toBe("policy_unresolved");
    expect(d.fired).toBe(false);
    expect(d.decidedBy).toBe("fail-closed");
  });
  it("verification indeterminate on a NON-external class → proceed ungated (skip)", () => {
    const d = evaluatePolicy(base({ checkpoint: "verification", destinationClass: "none", originKind: "agent_produced" }));
    expect(d.outcome).toBe("skip");
    expect(d.decidedBy).toBe("core-default");
  });
  it("an elevation CANNOT resolve an unevaluable external effect (stays blocked)", () => {
    const d = evaluatePolicy(
      base({ checkpoint: "verification", destinationClass: "external_publish", originKind: "agent_produced", changesRequestedOccurred: false, elevation: { forceOn: ["verification"] } }),
    );
    // external_publish makes verification default 'fire' (remote apply), so this
    // is NOT the unevaluable path — assert the unevaluable path with a
    // non-apply external class instead:
    expect(["fire", "required"]).toContain(d.outcome);
    const d2 = evaluatePolicy(
      base({ checkpoint: "verification", destinationClass: "pipeline_handoff", originKind: "agent_produced", elevation: { forceOn: ["verification"] } }),
    );
    expect(d2.outcome).toBe("policy_unresolved");
  });
});

describe("separation of duties", () => {
  const requiredDecision = { outcome: "required" as const, separationOfDutiesRequired: true };
  it("optional gate (SoD not required) → self-approval allowed", () => {
    const r = evaluateSeparationOfDuties({
      decision: { outcome: "fire", separationOfDutiesRequired: false },
      producingActorId: "actor-1",
      reviewingActorId: "actor-1",
    });
    expect(r.eligible).toBe(true);
  });
  it("org-required gate: producer cannot be the SOLE approver", () => {
    const r = evaluateSeparationOfDuties({
      decision: requiredDecision,
      producingActorId: "actor-1",
      reviewingActorId: "actor-1",
    });
    expect(r.eligible).toBe(false);
  });
  it("org-required gate: a DISTINCT reviewer is eligible", () => {
    const r = evaluateSeparationOfDuties({
      decision: requiredDecision,
      producingActorId: "actor-1",
      reviewingActorId: "actor-2",
    });
    expect(r.eligible).toBe(true);
  });
  it("org-required gate: producer eligible once a distinct co-approver exists", () => {
    const r = evaluateSeparationOfDuties({
      decision: requiredDecision,
      producingActorId: "actor-1",
      reviewingActorId: "actor-1",
      priorApproverIds: ["actor-2"],
    });
    expect(r.eligible).toBe(true);
  });
  it("org opt-in relaxes SoD (separationOfDutiesRequired false) → producer may self-approve", () => {
    // With opt-in, evaluatePolicy sets separationOfDutiesRequired=false.
    const d = evaluatePolicy(base({ orgRule: { bound: "required", selfApprovalOptIn: true } }));
    expect(d.separationOfDutiesRequired).toBe(false);
    const r = evaluateSeparationOfDuties({
      decision: d,
      producingActorId: "actor-1",
      reviewingActorId: "actor-1",
    });
    expect(r.eligible).toBe(true);
  });
});
