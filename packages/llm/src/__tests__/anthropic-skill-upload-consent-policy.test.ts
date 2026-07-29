/**
 * Upload-on-install CONSENT POLICY (cinatra#2092, epic #2086 S5).
 *
 * The pure fail-closed decision the whole slice hinges on. Every branch of
 * `resolveAnthropicUploadConsentDecision` is a DENY except one, and each deny
 * carries a RECORDED reason — the S5 acceptance criteria require the no-op to
 * be recorded, not merely to happen.
 */
import { describe, it, expect } from "vitest";
import {
  ANTHROPIC_SKILL_UPLOAD_EGRESS_ADVISORY,
  buildAnthropicUploadConsentPrompt,
  closureConsentDigest,
  resolveAnthropicUploadConsentDecision,
  type ConsentClosureMember,
} from "../tools/anthropic-skill-upload-gate";

const ROOT: ConsentClosureMember = {
  packageId: "github:acme/my-skills",
  packageName: "acme/my-skills",
  isRoot: true,
};
const DEP: ConsentClosureMember = {
  packageId: "verdaccio:@acme/shared-skills",
  packageName: "@acme/shared-skills",
  isRoot: false,
};
const CLOSURE = [ROOT, DEP];

describe("closureConsentDigest", () => {
  it("is order-independent (the closure is sorted before hashing)", () => {
    expect(closureConsentDigest([ROOT, DEP])).toBe(closureConsentDigest([DEP, ROOT]));
  });

  it("changes when a member is added or removed", () => {
    expect(closureConsentDigest([ROOT])).not.toBe(closureConsentDigest(CLOSURE));
  });

  it("ignores duplicate members (the ledger keys on identity, once)", () => {
    expect(closureConsentDigest([ROOT, ROOT, DEP])).toBe(closureConsentDigest(CLOSURE));
  });

  it("is identity-only — a version bump cannot invalidate a confirmation", () => {
    // Consent is per PACKAGE IDENTITY and survives version updates, so the
    // digest must not depend on anything version-shaped.
    const renamedDisplay = { ...DEP, packageName: "@acme/shared-skills (newer release)" };
    expect(closureConsentDigest([ROOT, renamedDisplay])).toBe(closureConsentDigest(CLOSURE));
  });
});

describe("buildAnthropicUploadConsentPrompt", () => {
  it("lists the FULL resolved closure, root first, and carries the egress advisory", () => {
    const prompt = buildAnthropicUploadConsentPrompt({
      rootPackageName: "acme/my-skills",
      closure: CLOSURE,
      optInEnabled: true,
    });
    expect(prompt.advisory).toBe(ANTHROPIC_SKILL_UPLOAD_EGRESS_ADVISORY);
    expect(prompt.advisory).toMatch(/Anthropic Skills API/);
    expect(prompt.advisory).toMatch(/zero-data-retention/i);
    expect(prompt.closureLines).toHaveLength(2);
    expect(prompt.closureLines[0]).toContain("acme/my-skills");
    expect(prompt.closureLines[0]).not.toContain("installed as a dependency");
    // The TRANSITIVE member is listed and marked as such — the S5 deliverable
    // is the FULL closure, not just the package the operator typed.
    expect(prompt.closureLines[1]).toContain("@acme/shared-skills");
    expect(prompt.closureLines[1]).toContain("installed as a dependency");
    expect(prompt.headline).toContain("1 skill extension");
    expect(prompt.scopeKeys).toEqual([
      "github:acme/my-skills",
      "verdaccio:@acme/shared-skills",
    ]);
    expect(prompt.closureDigest).toBe(closureConsentDigest(CLOSURE));
    expect(prompt.consentApplies).toBe(true);
  });

  it("says nothing applies when the workspace opt-in is OFF", () => {
    const prompt = buildAnthropicUploadConsentPrompt({
      rootPackageName: "acme/my-skills",
      closure: CLOSURE,
      optInEnabled: false,
    });
    expect(prompt.consentApplies).toBe(false);
  });

  it("drops the dependency clause when the closure is the root alone", () => {
    const prompt = buildAnthropicUploadConsentPrompt({
      rootPackageName: "acme/my-skills",
      closure: [ROOT],
      optInEnabled: true,
    });
    expect(prompt.headline).toBe("Allow Anthropic uploads for acme/my-skills?");
  });
});

describe("resolveAnthropicUploadConsentDecision — fail-closed matrix", () => {
  const granted = { granted: true, confirmedClosureDigest: closureConsentDigest(CLOSURE) };

  it("INTERACTIVE + opt-in ON + confirmed closure ⇒ the ONLY grant path", () => {
    const d = resolveAnthropicUploadConsentDecision({
      consent: granted,
      closure: CLOSURE,
      optInEnabled: true,
      interactive: true,
    });
    expect(d.grant).toBe(true);
    expect(d.reason).toBe("granted");
    expect(d.scopeKeys).toEqual([
      "github:acme/my-skills",
      "verdaccio:@acme/shared-skills",
    ]);
  });

  it("opt-in OFF ⇒ never a grant, and the no-op is RECORDED (AC1 second half)", () => {
    const d = resolveAnthropicUploadConsentDecision({
      consent: granted,
      closure: CLOSURE,
      optInEnabled: false,
      interactive: true,
    });
    expect(d.grant).toBe(false);
    expect(d.reason).toBe("opt-in-off");
    expect(d.scopeKeys).toEqual([]);
    expect(d.outcome).toMatch(/nothing was uploaded/i);
  });

  it("NONINTERACTIVE without the explicit parameter ⇒ upload-ineligible, recorded (AC2)", () => {
    for (const consent of [null, undefined]) {
      const d = resolveAnthropicUploadConsentDecision({
        consent,
        closure: CLOSURE,
        optInEnabled: true,
        interactive: false,
      });
      expect(d.grant).toBe(false);
      expect(d.reason).toBe("no-explicit-consent");
      expect(d.outcome).toMatch(/fail-closed/i);
    }
  });

  it("NONINTERACTIVE WITH the explicit parameter ⇒ grants, no digest required (AC2)", () => {
    const d = resolveAnthropicUploadConsentDecision({
      consent: { granted: true },
      closure: CLOSURE,
      optInEnabled: true,
      interactive: false,
    });
    expect(d.grant).toBe(true);
    expect(d.scopeKeys).toHaveLength(2);
  });

  it("a truthy-but-not-`true` consent value is DENIED (strict primitive)", () => {
    for (const bad of ["true", 1, {}, [], "yes"] as unknown[]) {
      const d = resolveAnthropicUploadConsentDecision({
        consent: { granted: bad },
        closure: CLOSURE,
        optInEnabled: true,
        interactive: false,
      });
      expect(d.grant).toBe(false);
      expect(d.reason).toBe("consent-declined");
    }
  });

  it("INTERACTIVE with a MISSING or STALE closure confirmation is denied", () => {
    const stale = resolveAnthropicUploadConsentDecision({
      // Digest of a SMALLER closure: the operator confirmed a closure that has
      // since grown, so they never saw the new member.
      consent: { granted: true, confirmedClosureDigest: closureConsentDigest([ROOT]) },
      closure: CLOSURE,
      optInEnabled: true,
      interactive: true,
    });
    expect(stale.grant).toBe(false);
    expect(stale.reason).toBe("closure-confirmation-mismatch");

    const missing = resolveAnthropicUploadConsentDecision({
      consent: { granted: true },
      closure: CLOSURE,
      optInEnabled: true,
      interactive: true,
    });
    expect(missing.grant).toBe(false);
    expect(missing.reason).toBe("closure-confirmation-mismatch");
  });

  it("an EMPTY closure never grants (nothing to consent to)", () => {
    const d = resolveAnthropicUploadConsentDecision({
      consent: { granted: true },
      closure: [],
      optInEnabled: true,
      interactive: false,
    });
    expect(d.grant).toBe(false);
    expect(d.reason).toBe("empty-closure");
  });

  it("a non-boolean opt-in value is treated as OFF (fail-closed)", () => {
    for (const bad of [undefined, null, "true", 1] as unknown[]) {
      const d = resolveAnthropicUploadConsentDecision({
        consent: granted,
        closure: CLOSURE,
        optInEnabled: bad as boolean,
        interactive: true,
      });
      expect(d.grant).toBe(false);
      expect(d.reason).toBe("opt-in-off");
    }
  });

  it("every deny returns an EMPTY scope-key set (no partial grant is possible)", () => {
    const denies = [
      { consent: granted, optInEnabled: false, interactive: true },
      { consent: null, optInEnabled: true, interactive: false },
      { consent: { granted: false }, optInEnabled: true, interactive: false },
      { consent: { granted: true }, optInEnabled: true, interactive: true },
    ];
    for (const arm of denies) {
      const d = resolveAnthropicUploadConsentDecision({
        consent: arm.consent as never,
        closure: CLOSURE,
        optInEnabled: arm.optInEnabled,
        interactive: arm.interactive,
      });
      expect(d.grant).toBe(false);
      expect(d.scopeKeys).toEqual([]);
      expect(d.outcome.length).toBeGreaterThan(0);
    }
  });
});
