/**
 * CONSENT PARITY FOR SKILLS, ON BOTH SUPPLIED ROADS
 * (cinatra#3204 leg 3 — the issue's recorded decision).
 *
 * The recorded decision reads: "the upload-consent contract the repository road
 * already honours applies unchanged on both roads: consent is an explicit act,
 * never inferred from supplying a package."
 *
 * The road this leg builds replaces `installGitHubSkillExtension` as the
 * repository road's install call, so the contract has to be honoured HERE or it
 * is honoured nowhere. These are the claims:
 *
 *   - a SKILL install with no consent records the fail-closed decision through
 *     the SANCTIONED recorder (never a second implementation of the policy) and
 *     reports the outcome instead of silently doing nothing;
 *   - an explicit interactive consent — the operator's ticked box plus the
 *     digest of the closure they were actually shown — is passed through
 *     verbatim, `interactive: true`, so the digest check is mandatory;
 *   - the closure is snapshotted BEFORE the install, so the recorded closure is
 *     what THIS install added and not the whole catalog;
 *   - a consent-recording failure never rolls the install back, and says so;
 *   - a non-skill install never asks the question at all;
 *   - the PREVIEW of a skill package carries the consent prompt, so the screen
 *     can show the closure and the advisory BEFORE anything is installed.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const session = vi.hoisted(() => ({
  user: { id: "u1" },
  session: { activeOrganizationId: "org-1" },
}));
vi.mock("@/lib/auth-session", () => ({
  requireAdminSession: vi.fn(async () => session),
  buildCanDoOptsFromSession: vi.fn(async () => ({ orgRole: "org_admin" })),
}));

vi.mock("../install-target-authz", () => ({
  readActorRolesForInstall: vi.fn(() => ({ principalId: "u1", organizationId: "org-1" })),
  assertTargetBelongsToActiveOrg: vi.fn(async () => ({ projectOwnership: null })),
  assertCanInstallAtTarget: vi.fn(async () => undefined),
}));

const supplied = vi.hoisted(() => ({
  kind: "skill" as string,
  packageName: "@acme/thing-skill",
}));

const road = vi.hoisted(() => ({
  prepareSuppliedArchiveSnapshot: vi.fn(async () => ({
    package: {
      kind: supplied.kind,
      packageName: supplied.packageName,
      version: "1.0.0",
      contentDigest: "a".repeat(64),
      provenance: { type: "local", path: "x.tgz", contentDigest: "a".repeat(64) },
    },
    tarball: new Uint8Array([1]),
    provenance: { type: "local", path: "x.tgz", contentDigest: "a".repeat(64) },
    validatorRan: true,
  })),
  candidateFromPreparedArchive: vi.fn(
    (prepared: { package: Record<string, unknown>; provenance: unknown; validatorRan: boolean }) => ({
      kind: prepared.package.kind,
      packageName: prepared.package.packageName,
      version: prepared.package.version,
      provenance: prepared.provenance,
      validatorRan: prepared.validatorRan,
    }),
  ),
  installSuppliedCandidate: vi.fn(async () => undefined),
  prepareSuppliedRepositorySnapshot: vi.fn(),
}));
vi.mock("@/lib/supplied-package-install", () => road);

vi.mock("@cinatra-ai/extensions/canonical-store", () => ({
  readInstalledExtensionByIdentity: vi.fn(async () => ({
    id: "iext-1",
    kind: supplied.kind,
    status: "active",
  })),
}));

vi.mock("@cinatra-ai/extensions/install-access-contract", () => ({
  setExtensionInstallAccess: vi.fn(async () => undefined),
}));

vi.mock("@cinatra-ai/extensions", () => ({
  extensionRegistry: { uninstall: vi.fn(async () => undefined) },
}));

vi.mock("../materialize-agent-package", () => ({
  withInstallLock: (_pkg: string, fn: () => Promise<unknown>) => fn(),
}));

vi.mock("../store", () => ({
  readAgentTemplateByPackageName: vi.fn(async () => ({ id: "tpl-1" })),
}));

vi.mock("@cinatra-ai/skills/skill-package-source", () => ({
  resolveSkillPackageSource: vi.fn(() => ({ packageId: "local:@acme/thing-skill" })),
}));

// THE SANCTIONED CONSENT SURFACE. Mocked so the claims are about WHICH calls the
// road makes and in what ORDER — not about the policy itself, which is already
// pinned by its own suite and is deliberately not re-implemented here.
const calls = vi.hoisted(() => ({ order: [] as string[] }));
const consent = vi.hoisted(() => ({
  snapshotSkillPackageIds: vi.fn(() => new Set<string>(["skill:pre-existing"])),
  resolveInstalledClosure: vi.fn(() => [
    { packageId: "local:@acme/thing-skill", packageName: "@acme/thing-skill", isRoot: true },
  ]),
  buildInstallConsentPrompt: vi.fn(() => ({
    consentApplies: true,
    headline: "Allow uploading these skills",
    advisory: "The skill files leave this instance.",
    closureLines: ["@acme/thing-skill (root)"],
    closureDigest: "d".repeat(64),
  })),
  recordSkillInstallConsent: vi.fn(() => ({
    grant: false,
    reason: "no-explicit-consent",
    outcome: "No explicit upload consent was passed — the skill stays upload-ineligible (fail-closed).",
    scopeKeys: [] as string[],
    granted: [] as string[],
  })),
}));
vi.mock("@/lib/anthropic-skill-config-service", () => ({
  snapshotSkillPackageIds: (...a: unknown[]) => {
    calls.order.push("snapshot");
    return consent.snapshotSkillPackageIds(...(a as []));
  },
  resolveInstalledClosure: (...a: unknown[]) => consent.resolveInstalledClosure(...(a as [])),
  buildInstallConsentPrompt: (...a: unknown[]) => consent.buildInstallConsentPrompt(...(a as [])),
  recordSkillInstallConsent: (...a: unknown[]) => {
    calls.order.push("record");
    return consent.recordSkillInstallConsent(...(a as []));
  },
}));

vi.mock("@/lib/archive-supplied-install", () => ({
  previewSuppliedArchive: vi.fn(async () => ({
    kind: supplied.kind,
    packageName: supplied.packageName,
    version: "1.0.0",
    contentDigest: "a".repeat(64),
  })),
}));

import {
  installSuppliedArchiveAction,
  previewSuppliedArchiveAction,
} from "../supplied-install-actions";

const ZIP = Buffer.from("zip").toString("base64");
const TARGET = { level: "workspace", id: "org-1" };

beforeEach(() => {
  vi.clearAllMocks();
  calls.order.length = 0;
  supplied.kind = "skill";
  supplied.packageName = "@acme/thing-skill";
  road.installSuppliedCandidate.mockImplementation(async () => {
    calls.order.push("install");
  });
  consent.recordSkillInstallConsent.mockReturnValue({
    grant: false,
    reason: "no-explicit-consent",
    outcome:
      "No explicit upload consent was passed — the skill stays upload-ineligible (fail-closed).",
    scopeKeys: [],
    granted: [],
  } as never);
});

describe("a skill install honours the upload-consent contract (recorded decision)", () => {
  it("records the FAIL-CLOSED decision through the sanctioned recorder when no consent was given", async () => {
    const result = await installSuppliedArchiveAction({
      zipBase64: ZIP,
      accessTarget: TARGET,
    });

    expect(result.ok).toBe(true);
    expect(consent.recordSkillInstallConsent).toHaveBeenCalledTimes(1);
    const arg = (consent.recordSkillInstallConsent.mock.calls as unknown as unknown[][])[0]![0] as Record<string, unknown>;
    expect(arg.consent ?? null).toBeNull();
    expect(arg.interactive).toBe(false);
    expect(arg.grantedBy).toBe("u1");
    // Reported, never silent.
    expect(result.ok && result.uploadConsent).toMatchObject({
      granted: false,
      reason: "no-explicit-consent",
    });
  });

  it("passes an EXPLICIT interactive consent through verbatim, digest and all", async () => {
    consent.recordSkillInstallConsent.mockReturnValue({
      grant: true,
      reason: "interactive-confirmed",
      outcome: "Consent recorded for 1 package identity.",
      scopeKeys: ["local:@acme/thing-skill"],
      granted: ["local:@acme/thing-skill"],
    } as never);

    const result = await installSuppliedArchiveAction({
      zipBase64: ZIP,
      accessTarget: TARGET,
      anthropicUploadConsent: { granted: true, confirmedClosureDigest: "d".repeat(64) },
    });

    expect(result.ok).toBe(true);
    const arg = (consent.recordSkillInstallConsent.mock.calls as unknown as unknown[][])[0]![0] as {
      consent: Record<string, unknown>;
      interactive: boolean;
    };
    expect(arg.consent).toMatchObject({
      granted: true,
      confirmedClosureDigest: "d".repeat(64),
    });
    expect(arg.interactive).toBe(true);
    expect(result.ok && result.uploadConsent?.granted).toBe(true);
  });

  it("snapshots the catalog BEFORE the install, so the closure is what this install added", async () => {
    await installSuppliedArchiveAction({ zipBase64: ZIP, accessTarget: TARGET });
    expect(calls.order).toEqual(["snapshot", "install", "record"]);
    const closureArg = (consent.resolveInstalledClosure.mock.calls as unknown as unknown[][])[0]![0] as {
      before: Set<string>;
    };
    expect([...closureArg.before]).toEqual(["skill:pre-existing"]);
  });

  it("never rolls the install back when the consent write throws — it warns instead", async () => {
    consent.recordSkillInstallConsent.mockImplementation(() => {
      throw new Error("consent store unavailable");
    });

    const result = await installSuppliedArchiveAction({
      zipBase64: ZIP,
      accessTarget: TARGET,
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.uploadConsent).toMatchObject({ granted: false });
    expect(result.ok && result.warnings?.join(" ")).toContain("upload");
  });

  it("never asks the question for a kind that has no skill catalog", async () => {
    supplied.kind = "artifact";
    supplied.packageName = "@acme/thing-artifact";

    const result = await installSuppliedArchiveAction({
      zipBase64: ZIP,
      accessTarget: TARGET,
    });

    expect(result.ok).toBe(true);
    expect(consent.recordSkillInstallConsent).not.toHaveBeenCalled();
    expect(consent.snapshotSkillPackageIds).not.toHaveBeenCalled();
  });
});

describe("the preview carries the consent prompt so the screen can ask FIRST", () => {
  it("returns the closure, the advisory and the digest for a skill package", async () => {
    const result = await previewSuppliedArchiveAction(ZIP);
    expect(result.ok).toBe(true);
    expect(result.ok && result.preview.consentPrompt).toMatchObject({
      consentApplies: true,
      closureDigest: "d".repeat(64),
    });
    expect(consent.buildInstallConsentPrompt).toHaveBeenCalledTimes(1);
  });

  it("carries no consent prompt for a kind that cannot be uploaded to the skills API", async () => {
    supplied.kind = "connector";
    supplied.packageName = "@acme/thing-connector";
    const result = await previewSuppliedArchiveAction(ZIP);
    expect(result.ok).toBe(true);
    expect(result.ok && result.preview.consentPrompt).toBeUndefined();
    expect(consent.buildInstallConsentPrompt).not.toHaveBeenCalled();
  });
});
