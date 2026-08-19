// Read-model derivation matrix (cinatra#657). DI'd — no DB / no `/data` store.
//
// Exercises the query-time read-model's derived fields: actor visibility, the
// 3-status + absent mapping (archived≈disabled-recoverable, absent≈uninstalled),
// the live-wins row pick, teardown state, activation generation, the
// supersession-first row pick + the picked-row-bound trust verdict
// (cinatra#2848), and the best-effort trust verdict.
// Runs in the root vitest suite (`src/**/__tests__/**/*.test.ts` is in the root
// include — the gate of record).

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  buildInstalledExtensionReadModel,
  type ReadModelAnchorTarget,
} from "@/lib/installed-extension-read-model.server";
import type { TrustVerdict } from "@/lib/extension-trust";
import type { InstalledExtension } from "@cinatra-ai/extensions/canonical-types";
import { PLATFORM_OWNER_SENTINEL } from "@cinatra-ai/extensions/canonical-types";
import { POLICY_VERSION, type ActorContext } from "@/lib/authz/actor-context";
import {
  evaluateExtensionAccess,
  type ExtensionAccessDecision,
  type ExtensionAccessResource,
} from "@cinatra-ai/extensions/enforce-extension-access";
import { accessTargetToInstallPolicy } from "@cinatra-ai/extensions/install-access-target";
import type { AgentAuthPolicy } from "@cinatra-ai/agents/auth-policy-types";
import { decideRuntimeCubeServe } from "@cinatra-ai/dashboards/runtime-cube-serve-gate";

const actor: ActorContext = {
  principalType: "HumanUser",
  principalId: "user-1",
  organizationId: "org-1",
  teamIds: ["team-A"],
  authSource: "ui",
  policyVersion: POLICY_VERSION,
};

function row(partial: Partial<InstalledExtension>): InstalledExtension {
  return {
    id: "iext_x",
    packageName: "@cinatra-ai/demo-connector",
    ownerLevel: "organization",
    ownerId: null,
    organizationId: "org-1",
    kind: "connector",
    status: "active",
    source: { type: "verdaccio", registryUrl: "r", packageName: "p", version: "1", integrity: "i" },
    requiredInProd: false,
    dependencies: [],
    manifestHash: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...partial,
  } as InstalledExtension;
}

/**
 * Audience: ADMIT. The read model gates the picked row on its access policy
 * (cinatra#2850), and the platform's default for a row with no stored policy is
 * workspace-visible — i.e. admit. Injected here so the row-derivation cases stay
 * isolated from the permissions store; the GATE itself is driven against the
 * REAL evaluator in its own describe block below.
 */
const admitAll = async (): Promise<ExtensionAccessDecision> => ({ allowed: true });

// Default deps: no store record, no anchor, fixed generation — isolate the
// canonical-row derivation from the heavy trust IO.
const baseDeps = {
  discoverRecords: async () => [],
  resolveTrustAnchor: async () => null,
  getActivationGeneration: () => 7,
  canAccessInstallRow: admitAll,
};

describe("buildInstalledExtensionReadModel — actor-scoped status derivation", () => {
  it("a live active row → status active, visible, teardownState live", async () => {
    const rm = await buildInstalledExtensionReadModel("@cinatra-ai/demo-connector", actor, {
      ...baseDeps,
      readRows: async () => [row({ status: "active" })],
    });
    expect(rm.actorVisible).toBe(true);
    expect(rm.status).toBe("active");
    expect(rm.teardownState).toBe("live");
    expect(rm.kind).toBe("connector");
    expect(rm.activationGeneration).toBe(7);
    expect(rm.trust).toBeNull(); // no anchor → not resolvable, best-effort null
    expect(rm.sourcePackageStoreRecordPresent).toBe(false);
  });

  it("a locked row → status locked, visible, live", async () => {
    const rm = await buildInstalledExtensionReadModel("@cinatra-ai/demo-connector", actor, {
      ...baseDeps,
      readRows: async () => [row({ status: "locked" })],
    });
    expect(rm.status).toBe("locked");
    expect(rm.teardownState).toBe("live");
  });

  it("an archived addressable row → status archived (disabled-recoverable), visible, torn-down", async () => {
    const rm = await buildInstalledExtensionReadModel("@cinatra-ai/demo-connector", actor, {
      ...baseDeps,
      readRows: async () => [row({ status: "archived" })],
    });
    expect(rm.actorVisible).toBe(true);
    expect(rm.status).toBe("archived");
    expect(rm.teardownState).toBe("torn-down");
  });

  it("no addressable row → status absent (uninstalled), not visible", async () => {
    const rm = await buildInstalledExtensionReadModel("@cinatra-ai/demo-connector", actor, {
      ...baseDeps,
      readRows: async () => [],
    });
    expect(rm.actorVisible).toBe(false);
    expect(rm.status).toBe("absent");
    expect(rm.ownerScope).toBeNull();
    expect(rm.teardownState).toBe("torn-down");
  });

  it("a cross-org row is NOT addressable → absent", async () => {
    const rm = await buildInstalledExtensionReadModel("@cinatra-ai/demo-connector", actor, {
      ...baseDeps,
      readRows: async () => [row({ status: "active", organizationId: "org-OTHER" })],
    });
    expect(rm.status).toBe("absent");
    expect(rm.actorVisible).toBe(false);
  });

  it("live wins: an active and an archived addressable row → active", async () => {
    const rm = await buildInstalledExtensionReadModel("@cinatra-ai/demo-connector", actor, {
      ...baseDeps,
      readRows: async () => [row({ status: "archived", id: "a" }), row({ status: "active", id: "b" })],
    });
    expect(rm.status).toBe("active");
  });

  it("platform_admin: the active-org row wins over a cross-org row with a better status (same-org preference, P3)", async () => {
    const platformAdmin: ActorContext = { ...actor, platformRole: "platform_admin" };
    const rm = await buildInstalledExtensionReadModel("@cinatra-ai/demo-connector", platformAdmin, {
      ...baseDeps,
      // The cross-org row is ACTIVE (better status) but must NOT out-rank the
      // admin's OWN-org locked row — the read-model metadata stays in the actor's
      // active org rather than bleeding an arbitrary other org's install.
      readRows: async () => [
        row({ status: "active", id: "cross", organizationId: "org-OTHER" }),
        row({ status: "locked", id: "mine", organizationId: "org-1" }),
      ],
    });
    expect(rm.status).toBe("locked");
    expect(rm.actorVisible).toBe(true);
  });

  it("an owner-less user row fails closed (not addressable) → absent", async () => {
    const rm = await buildInstalledExtensionReadModel("@cinatra-ai/demo-connector", actor, {
      ...baseDeps,
      readRows: async () => [row({ status: "active", ownerLevel: "user", ownerId: null })],
    });
    expect(rm.status).toBe("absent");
  });

  it("a team row addressable to a team member is visible", async () => {
    const rm = await buildInstalledExtensionReadModel("@cinatra-ai/demo-connector", actor, {
      ...baseDeps,
      readRows: async () => [row({ status: "active", ownerLevel: "team", ownerId: "team-A" })],
    });
    expect(rm.status).toBe("active");
    expect(rm.actorVisible).toBe(true);
  });

  it("null actor → absent record", async () => {
    const rm = await buildInstalledExtensionReadModel("@cinatra-ai/demo-connector", null, baseDeps);
    expect(rm.status).toBe("absent");
    expect(rm.actorVisible).toBe(false);
  });

  it("canonical-store outage (readRows throws) → fail-safe absent", async () => {
    const rm = await buildInstalledExtensionReadModel("@cinatra-ai/demo-connector", actor, {
      ...baseDeps,
      readRows: async () => {
        throw new Error("db down");
      },
    });
    expect(rm.status).toBe("absent");
    expect(rm.actorVisible).toBe(false);
  });

  it("a present store record + trusted anchor surfaces the trust verdict + store presence", async () => {
    const rm = await buildInstalledExtensionReadModel("@cinatra-ai/demo-connector", actor, {
      ...baseDeps,
      readRows: async () => [row({ status: "active" })],
      discoverRecords: async () =>
        [
          { packageName: "@cinatra-ai/demo-connector", uiSurface: "schema-config", configSchema: null } as never,
        ],
      resolveTrustAnchor: async () => ({
        // cinatra#2848: the anchor must identify the row the model picked
        // (`row()`'s default id) or the verdict degrades to null.
        installId: "iext_x",
        integrity: "sha512-x",
        contentHash: "ch",
        registryUrl: "https://registry.example",
        trustDecision: true,
        version: "1.0.0",
        signature: null,
      }),
      verifyIntegrity: async () => true,
      classifyTrust: () => ({ tier: "trusted-bootstrap", trusted: true, reason: "test" }),
    });
    expect(rm.sourcePackageStoreRecordPresent).toBe(true);
    expect(rm.trust?.trusted).toBe(true);
    expect(rm.trust?.tier).toBe("trusted-bootstrap");
  });
});

// cinatra#792 — the read-model's trust verdict binds to the ANCHOR-BOUND record
// (kind + digest), never an arbitrary first match; an ambiguous store with a
// digest-unbound anchor yields NO verdict (fail closed). The verdict feeds
// runtime gates (cube serving), not just display.
describe("buildInstalledExtensionReadModel — cinatra#792 anchor-bound record selection", () => {
  const DIG_A = "a1".padEnd(64, "0");
  const DIG_B = "b2".padEnd(64, "0");
  const anchor = {
    // cinatra#2848: identifies `row()`'s default id — these cases pin the
    // RECORD selection, so the identity check must be satisfied, not exercised.
    installId: "iext_x",
    integrity: "sha512-x",
    contentHash: "ch",
    registryUrl: "https://registry.example",
    trustDecision: true,
    version: "1.0.0",
    signature: null,
  };
  const rec = (declaredDigest: string, kind = "connector") =>
    ({ packageName: "@cinatra-ai/demo-connector", declaredDigest, kind, uiSurface: "schema-config", configSchema: null }) as never;

  it("a digest-BOUND anchor evaluates the verdict against exactly the record it pins", async () => {
    const verified: string[] = [];
    const rm = await buildInstalledExtensionReadModel("@cinatra-ai/demo-connector", actor, {
      ...baseDeps,
      readRows: async () => [row({ status: "active" })],
      discoverRecords: async () => [rec(DIG_B), rec(DIG_A)],
      resolveTrustAnchor: async () => ({ ...anchor, kind: "connector", digest: DIG_A }),
      verifyIntegrity: async (r: { declaredDigest?: string }) => {
        verified.push(r.declaredDigest ?? "(flat)");
        return true;
      },
      classifyTrust: () => ({ tier: "trusted-bootstrap", trusted: true, reason: "test" }),
    });
    expect(rm.sourcePackageStoreRecordPresent).toBe(true);
    expect(rm.trust?.trusted).toBe(true);
    expect(verified).toEqual([DIG_A]); // never the retained prior digest
  });

  it("FAIL-CLOSED: a digest-UNBOUND anchor with >1 on-disk record → no verdict (ambiguous)", async () => {
    const rm = await buildInstalledExtensionReadModel("@cinatra-ai/demo-connector", actor, {
      ...baseDeps,
      readRows: async () => [row({ status: "active" })],
      discoverRecords: async () => [rec(DIG_A), rec(DIG_B)],
      resolveTrustAnchor: async () => ({ ...anchor, kind: "connector" }),
      verifyIntegrity: async () => true,
      classifyTrust: () => ({ tier: "trusted-bootstrap", trusted: true, reason: "test" }),
    });
    expect(rm.sourcePackageStoreRecordPresent).toBe(true); // present on disk...
    expect(rm.trust).toBeNull(); // ...but no verdict from an ambiguous store
  });

  it("FAIL-CLOSED: the anchor's canonical-row kind contradicts the record's path kind → no verdict", async () => {
    const rm = await buildInstalledExtensionReadModel("@cinatra-ai/demo-connector", actor, {
      ...baseDeps,
      readRows: async () => [row({ status: "active" })],
      discoverRecords: async () => [rec(DIG_A, "connector"), rec(DIG_B, "connector")],
      resolveTrustAnchor: async () => ({ ...anchor, kind: "agent", digest: DIG_A }),
      verifyIntegrity: async () => true,
      classifyTrust: () => ({ tier: "trusted-bootstrap", trusted: true, reason: "test" }),
    });
    expect(rm.sourcePackageStoreRecordPresent).toBe(true);
    expect(rm.trust).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// cinatra#2848 — SUPERSESSION-FIRST in the installed-rows READ MODEL.
//
// The rule already exists on main and the lifecycle target resolver applies it
// first (`effectiveInstallRows` → `addressableLifecycleRows`); the four
// write-side seams were aligned to it in #2774. This read model picked without
// it, so a superseded organization row could still be the row a read-model-driven
// surface reported (the CG-5 runtime-cube serve gate is the production consumer).
//
// The helper is NOT mocked here: these drive the real
// `@cinatra-ai/extensions/lifecycle-target-resolver` export through the real
// `buildInstalledExtensionReadModel`; only the canonical-store READ is injected.
//
// WHAT THE REVERT SHOWS. Four cases below are BEHAVIOUR CHANGES — they fail on
// the pre-fix pick: the better-ranked org row, the array-order case, the platform
// admin's own-org row, and the same-org survivor. The two marked INVARIANT PIN
// already passed pre-fix (the status ranking / the scope filter decided them on
// their own); they are kept because they pin the NARROWNESS of the rule, and
// they are labelled so no claim rests on them. The no-supersession cases at the
// bottom pin shapes that must not move at all.
// ---------------------------------------------------------------------------

/** The exact workspace anchor the S2 write path persists: org-NULL, `workspace`,
 *  `__platform__`. Anything else is NOT a superseding row. */
function workspaceRow(partial: Partial<InstalledExtension> = {}): InstalledExtension {
  return row({
    id: "iext_workspace",
    ownerLevel: "workspace",
    ownerId: PLATFORM_OWNER_SENTINEL,
    organizationId: null,
    ...partial,
  });
}

describe("buildInstalledExtensionReadModel — supersession-first (cinatra#2848)", () => {
  it("a superseded organization row is NOT the reported row — the live workspace row is, even when the org row ranks better", async () => {
    // Pre-fix this returned the ORG row: both rows are addressable and neither is
    // cross-org, so the status ranking alone decided and `active` beat `locked`.
    const rm = await buildInstalledExtensionReadModel("@cinatra-ai/demo-connector", actor, {
      ...baseDeps,
      readRows: async () => [
        row({ id: "iext_org", status: "active", organizationId: "org-1" }),
        workspaceRow({ status: "locked" }),
      ],
    });
    expect(rm.status).toBe("locked");
    expect(rm.ownerScope).toEqual({
      ownerLevel: "workspace",
      ownerId: PLATFORM_OWNER_SENTINEL,
      organizationId: null,
    });
  });

  it("array order can no longer surface the superseded row (two live rows, org row first)", async () => {
    // Two live rows of equal status rank: the pick was first-wins, so the row the
    // canonical store happened to return first was reported.
    const rm = await buildInstalledExtensionReadModel("@cinatra-ai/demo-connector", actor, {
      ...baseDeps,
      readRows: async () => [
        row({ id: "iext_org", status: "active", organizationId: "org-1", kind: "agent" }),
        workspaceRow({ status: "active", kind: "connector" }),
      ],
    });
    expect(rm.ownerScope?.organizationId).toBeNull();
    // No field of the superseded row leaks into the record either.
    expect(rm.kind).toBe("connector");
  });

  // INVARIANT PIN (not a behaviour change): the live workspace row already
  // out-ranked the archived org row pre-fix via the status ranking, so this
  // passes with or without supersession. It pins that supersession did not
  // INVERT it — a superseded archived row must never become the reported row.
  it("INVARIANT PIN: a superseded ARCHIVED organization row does not report `archived` / `torn-down`", async () => {
    const rm = await buildInstalledExtensionReadModel("@cinatra-ai/demo-connector", actor, {
      ...baseDeps,
      readRows: async () => [
        row({ id: "iext_org", status: "archived", organizationId: "org-1" }),
        workspaceRow({ status: "active" }),
      ],
    });
    expect(rm.status).toBe("active");
    expect(rm.teardownState).toBe("live");
    expect(rm.ownerScope?.organizationId).toBeNull();
  });

  it("a platform admin's OWN-org row is superseded too (the same-org preference does not rescue it)", async () => {
    const platformAdmin: ActorContext = { ...actor, platformRole: "platform_admin" };
    const rm = await buildInstalledExtensionReadModel("@cinatra-ai/demo-connector", platformAdmin, {
      ...baseDeps,
      readRows: async () => [
        row({ id: "iext_org", status: "active", organizationId: "org-1" }),
        row({ id: "iext_other", status: "active", organizationId: "org-OTHER" }),
        workspaceRow({ status: "active" }),
      ],
    });
    expect(rm.ownerScope?.organizationId).toBeNull();
    expect(rm.ownerScope?.ownerLevel).toBe("workspace");
  });

  // THE SURVIVOR. Supersession never blanks the model: the superseding row is
  // org-NULL and workspace-anchored, so it is addressable by every authenticated
  // actor — including one whose org holds no row at all. The read model reports
  // the row that IS in force, which is what the write seams would address.
  it("supersession-survivor: the live workspace row is reported, visible and live", async () => {
    const rm = await buildInstalledExtensionReadModel("@cinatra-ai/demo-connector", actor, {
      ...baseDeps,
      readRows: async () => [
        row({ id: "iext_org", status: "active", organizationId: "org-1" }),
        workspaceRow({ status: "active" }),
      ],
    });
    expect(rm.actorVisible).toBe(true);
    expect(rm.status).toBe("active");
    expect(rm.teardownState).toBe("live");
    expect(rm.ownerScope?.ownerLevel).toBe("workspace");
  });

  // INVARIANT PIN (not a behaviour change): for an actor whose org holds no
  // row, the org row was never addressable, so the scope filter alone already
  // left the workspace row pre-fix. It pins that supersession did not take the
  // survivor away — the model must not go `absent` for these actors.
  it("INVARIANT PIN: an actor whose org holds NO row still reads the workspace row", async () => {
    const otherOrgActor: ActorContext = { ...actor, organizationId: "org-9" };
    const rm = await buildInstalledExtensionReadModel("@cinatra-ai/demo-connector", otherOrgActor, {
      ...baseDeps,
      readRows: async () => [
        row({ id: "iext_org", status: "active", organizationId: "org-1" }),
        workspaceRow({ status: "active" }),
      ],
    });
    expect(rm.actorVisible).toBe(true);
    expect(rm.status).toBe("active");
    expect(rm.ownerScope?.ownerLevel).toBe("workspace");
  });

  // NO-SUPERSESSION CASES — the rule is keyed on a LIVE, WORKSPACE-ANCHORED row.
  // Every other shape must be byte-identical to the pre-fix pick.
  it("an ARCHIVED workspace row supersedes nothing — the org row is still reported", async () => {
    const rm = await buildInstalledExtensionReadModel("@cinatra-ai/demo-connector", actor, {
      ...baseDeps,
      readRows: async () => [
        row({ id: "iext_org", status: "active", organizationId: "org-1" }),
        workspaceRow({ status: "archived" }),
      ],
    });
    expect(rm.status).toBe("active");
    expect(rm.ownerScope?.organizationId).toBe("org-1");
  });

  it("a live PLATFORM (bundled) org-NULL anchor supersedes nothing — the org row is still reported", async () => {
    // Narrowness pin: the bundled `platform` tier sits at the SAME org-NULL scope
    // but is not the workspace anchor, so it must not drop the org rows.
    const rm = await buildInstalledExtensionReadModel("@cinatra-ai/demo-connector", actor, {
      ...baseDeps,
      readRows: async () => [
        row({ id: "iext_org", status: "active", organizationId: "org-1" }),
        row({ id: "iext_bundled", status: "active", ownerLevel: "platform", ownerId: null, organizationId: null }),
      ],
    });
    expect(rm.status).toBe("active");
    expect(rm.ownerScope?.organizationId).toBe("org-1");
  });

  it("no workspace row at all — the org-only pick is unchanged", async () => {
    const rm = await buildInstalledExtensionReadModel("@cinatra-ai/demo-connector", actor, {
      ...baseDeps,
      readRows: async () => [
        row({ id: "iext_org_archived", status: "archived", organizationId: "org-1" }),
        row({ id: "iext_org_active", status: "active", organizationId: "org-1" }),
      ],
    });
    expect(rm.status).toBe("active");
    expect(rm.ownerScope?.organizationId).toBe("org-1");
  });
});

// ---------------------------------------------------------------------------
// cinatra#2848 — ONE ROW, ONE VERDICT: the trust verdict describes the PICKED
// row or is null.
//
// The row pick and the trust anchor are TWO resolutions. Before this change the
// anchor was resolved at `actor.organizationId` with no supersession awareness,
// so for a superseded pair (a live org row beside a live workspace row) the
// record's status/kind/ownerScope came from the WORKSPACE row while its
// trust/signatureVerified could come from the superseded ORG row. The CG-5
// runtime-cube serve gate reads `status` and `trust` together as ONE effective
// install, so that split record could serve an untrusted effective install on a
// trusted superseded anchor (or deny a trusted one).
//
// These drive the real `buildInstalledExtensionReadModel` with DISTINCT anchors
// per row and OPPOSITE trust outcomes, so a verdict sourced from the wrong row
// is visible in the assertion rather than hidden behind one synthetic anchor.
// ---------------------------------------------------------------------------

const TRUSTED_REGISTRY = "https://trusted.example";
const ROGUE_REGISTRY = "https://rogue.example";

/** An anchor BOUND to a canonical row id, carrying the registry that decides its verdict. */
function anchorForRow(installId: string | null, registryUrl: string) {
  return {
    installId,
    integrity: "sha512-x",
    contentHash: "ch",
    registryUrl,
    trustDecision: true,
    version: "1.0.0",
    // An UNKNOWN signature transport (a ":"-prefixed non-v2 scheme) makes
    // `resolveSignatureVerdict` a hard `false` rather than `undefined`, so
    // `signatureVerified` distinguishes "computed from THIS anchor" (false)
    // from "degraded — no verdict at all" (null).
    signature: "bogus-scheme:zz",
  };
}

/**
 * Registry-keyed classifier: the reported verdict is traceable to the exact
 * anchor it was computed from, which is the whole point of these cases.
 */
const classifyByRegistry = (input: { registryUrl?: string | null }): TrustVerdict =>
  input.registryUrl === TRUSTED_REGISTRY
    ? { tier: "trusted-bootstrap", trusted: true, reason: "test: trusted registry" }
    : { tier: "untrusted", trusted: false, reason: "test: rogue registry" };

/** One store record for the package, so a digest-unbound anchor selects it unambiguously. */
const oneRecord = async () =>
  [{ packageName: "@cinatra-ai/demo-connector", uiSurface: "schema-config", configSchema: null } as never];

/** Deps that compute a real verdict from whatever anchor the resolver returns. */
const trustDeps = {
  getActivationGeneration: () => 7,
  discoverRecords: oneRecord,
  verifyIntegrity: async () => true,
  classifyTrust: classifyByRegistry,
  canAccessInstallRow: admitAll,
};

/** The superseded pair: a live org-1 row + the live workspace row that supersedes it. */
const supersededPair = async (): Promise<InstalledExtension[]> => [
  row({ id: "iext_org", status: "active", organizationId: "org-1" }),
  workspaceRow({ status: "active" }),
];

/**
 * A resolver that answers per ROW IDENTITY — what a resolution targeted at the
 * picked row yields. Records what it was asked for.
 */
function anchorsByRow(
  byId: Record<string, ReturnType<typeof anchorForRow>>,
  asked: ReadModelAnchorTarget[],
) {
  return async (_packageName: string, target: ReadModelAnchorTarget) => {
    asked.push(target);
    return (byId[target.installId ?? ""] ?? null) as never;
  };
}

describe("buildInstalledExtensionReadModel — the trust verdict describes the PICKED row (cinatra#2848)", () => {
  it("trusted superseded ORG anchor + untrusted WORKSPACE anchor → the UNTRUSTED workspace verdict is reported", async () => {
    const asked: ReadModelAnchorTarget[] = [];
    const rm = await buildInstalledExtensionReadModel("@cinatra-ai/demo-connector", actor, {
      ...trustDeps,
      readRows: supersededPair,
      resolveTrustAnchor: anchorsByRow(
        {
          iext_org: anchorForRow("iext_org", TRUSTED_REGISTRY),
          iext_workspace: anchorForRow("iext_workspace", ROGUE_REGISTRY),
        },
        asked,
      ),
    });
    // The record describes the workspace row...
    expect(rm.ownerScope?.ownerLevel).toBe("workspace");
    expect(rm.status).toBe("active");
    // ...and so does its trust verdict. The trusted superseded org anchor never
    // reaches the serve gate: this is the "authorize serving an untrusted
    // effective install" direction of the split.
    expect(rm.trust?.trusted).toBe(false);
    expect(rm.trust?.tier).toBe("untrusted");
    expect(rm.signatureVerified).toBe(false); // computed from the workspace anchor
    // The resolution was ASKED for the effective (workspace) identity — the
    // actor's own org (`org-1`) is never the question.
    expect(asked).toEqual([{ installId: "iext_workspace", organizationId: null }]);
  });

  it("untrusted superseded ORG anchor + trusted WORKSPACE anchor → the TRUSTED workspace verdict is reported", async () => {
    const asked: ReadModelAnchorTarget[] = [];
    const rm = await buildInstalledExtensionReadModel("@cinatra-ai/demo-connector", actor, {
      ...trustDeps,
      readRows: supersededPair,
      resolveTrustAnchor: anchorsByRow(
        {
          iext_org: anchorForRow("iext_org", ROGUE_REGISTRY),
          iext_workspace: anchorForRow("iext_workspace", TRUSTED_REGISTRY),
        },
        asked,
      ),
    });
    // The inverse direction: the picked row's REAL trust survives — the fix is
    // not "always deny", and a superseded untrusted anchor cannot deny it.
    expect(rm.ownerScope?.ownerLevel).toBe("workspace");
    expect(rm.trust?.trusted).toBe(true);
    expect(rm.trust?.tier).toBe("trusted-bootstrap");
    expect(asked[0]).toEqual({ installId: "iext_workspace", organizationId: null });
  });

  it("BACKSTOP: a resolver that answers for the superseded ORG row degrades trust to null (never reports the wrong row)", async () => {
    // Exactly what `makeDefaultInstallAnchorResolver(actor.organizationId)` does
    // on main: a supersession-UNAWARE resolution that lands on the org row while
    // the model reports the workspace row. The identity check catches it.
    const rm = await buildInstalledExtensionReadModel("@cinatra-ai/demo-connector", actor, {
      ...trustDeps,
      readRows: supersededPair,
      resolveTrustAnchor: async () => anchorForRow("iext_org", TRUSTED_REGISTRY) as never,
    });
    expect(rm.ownerScope?.ownerLevel).toBe("workspace");
    expect(rm.trust).toBeNull();
    expect(rm.signatureVerified).toBeNull();
    // The FIELD degrades, never the record: the canonical status fields stay
    // authoritative and store presence is still reported.
    expect(rm.actorVisible).toBe(true);
    expect(rm.status).toBe("active");
    expect(rm.sourcePackageStoreRecordPresent).toBe(true);
  });

  it("BACKSTOP: an IDENTITY-LESS anchor cannot prove it describes the picked row → trust null", async () => {
    // A legacy/identity-less anchor for a picked INSTALL row proves nothing: the
    // rows this model reads always carry a canonical id, so "no installId" is
    // treated as disagreement rather than as agreement-by-default.
    const rm = await buildInstalledExtensionReadModel("@cinatra-ai/demo-connector", actor, {
      ...trustDeps,
      readRows: supersededPair,
      resolveTrustAnchor: async () => anchorForRow(null, TRUSTED_REGISTRY) as never,
    });
    expect(rm.ownerScope?.ownerLevel).toBe("workspace");
    expect(rm.trust).toBeNull();
    expect(rm.signatureVerified).toBeNull();
  });

  it("no supersession: the resolution is asked for the picked ORG row's own identity and its agreeing verdict IS reported", async () => {
    // The check is not a blanket null: an anchor that DOES describe the picked
    // row reports its verdict exactly as before.
    const asked: ReadModelAnchorTarget[] = [];
    const rm = await buildInstalledExtensionReadModel("@cinatra-ai/demo-connector", actor, {
      ...trustDeps,
      readRows: async () => [row({ status: "active" })], // id `iext_x`, org-1
      resolveTrustAnchor: anchorsByRow({ iext_x: anchorForRow("iext_x", TRUSTED_REGISTRY) }, asked),
    });
    expect(asked).toEqual([{ installId: "iext_x", organizationId: "org-1" }]);
    expect(rm.trust?.trusted).toBe(true);
    expect(rm.signatureVerified).toBe(false);
  });

  it("the resolution targets the PICKED ROW's scope, not the actor's (platform admin reading another org's row)", async () => {
    // The admin's own org holds no row; the picked row is org-OTHER's. Resolving
    // at the ACTOR's org would answer for a scope that has no row at all.
    const platformAdmin: ActorContext = { ...actor, platformRole: "platform_admin" };
    const asked: ReadModelAnchorTarget[] = [];
    const rm = await buildInstalledExtensionReadModel("@cinatra-ai/demo-connector", platformAdmin, {
      ...trustDeps,
      readRows: async () => [row({ id: "iext_other", status: "active", organizationId: "org-OTHER" })],
      resolveTrustAnchor: anchorsByRow({ iext_other: anchorForRow("iext_other", TRUSTED_REGISTRY) }, asked),
    });
    expect(asked).toEqual([{ installId: "iext_other", organizationId: "org-OTHER" }]);
    expect(rm.ownerScope?.organizationId).toBe("org-OTHER");
    expect(rm.trust?.trusted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// cinatra#2850 (blocker 1) — the SINGLE-DEFAULT rule precedes the status ranking.
//
// Exactly one row per (org, owner, package) is the DEFAULT that owns the
// package's unversioned global name (cinatra#1040 S1, DB-enforced). A
// side-by-side version install (`extension-side-by-side-install.ts`) creates an
// explicitly NON-default row that stands LIVE beside it, so one scope can hold
// two `active` rows. The canonical read has no ORDER BY
// (`readInstalledExtensionsByPackageName`), so the status ranking alone was a
// TIE and ARRAY ORDER picked the row.
//
// Every case below puts the SIBLING FIRST — the order that reproduced the bug.
// The consequence is not cosmetic: the default install anchor resolver selects
// the exactly-one-default row, so picking the sibling made the identity backstop
// disagree, null `trust`, and the CG-5 serve gate DENY a cube it had served.
// ---------------------------------------------------------------------------

describe("buildInstalledExtensionReadModel — single-default before the status ranking (cinatra#2850)", () => {
  /**
   * Live default + live side-by-side sibling, SIBLING FIRST in the array.
   * The record carries no row id, so the two rows are given DISTINCT `kind`s:
   * `kind` is what makes the pick observable in the assertion (the same device
   * the supersession array-order case above uses).
   */
  const siblingFirst = async (): Promise<InstalledExtension[]> => [
    row({ id: "iext_sbs", status: "active", isDefault: false, version: "2.0.0", kind: "agent" }),
    row({ id: "iext_default", status: "active", isDefault: true, version: "1.0.0", kind: "connector" }),
  ];

  it("the sibling is FIRST in the row array and the DEFAULT row is still the one reported", async () => {
    // Pre-fix this returned `iext_sbs`: both rows are addressable, neither is
    // cross-org, and both are `active` — the ranking was a tie and array order won.
    const rm = await buildInstalledExtensionReadModel("@cinatra-ai/demo-connector", actor, {
      ...baseDeps,
      readRows: siblingFirst,
    });
    expect(rm.kind).toBe("connector"); // the DEFAULT row's kind, not the sibling's
    expect(rm.status).toBe("active");
    expect(rm.actorVisible).toBe(true);
    expect(rm.ownerScope).toEqual({
      ownerLevel: "organization",
      ownerId: null,
      organizationId: "org-1",
    });
  });

  it("the serve gate keeps SERVING: the anchor's exactly-one-default row IS the picked row, so trust survives", async () => {
    // THE REGRESSION THIS BLOCKS. The default anchor resolver answers for the
    // DEFAULT row; picking the sibling made `anchor.installId !== row.id`, the
    // identity backstop nulled `trust`, and `decideRuntimeCubeServe` returned
    // `cube_untrusted` for an install that had been serving.
    const asked: ReadModelAnchorTarget[] = [];
    const rm = await buildInstalledExtensionReadModel("@cinatra-ai/demo-connector", actor, {
      ...trustDeps,
      readRows: siblingFirst,
      // The resolver's exactly-one-default selection: it answers for the DEFAULT
      // row whatever the read model picked. An anchor keyed to `iext_sbs` is
      // deliberately absent, so a sibling pick degrades to `trust: null`.
      resolveTrustAnchor: anchorsByRow(
        { iext_default: anchorForRow("iext_default", TRUSTED_REGISTRY) },
        asked,
      ),
    });
    expect(asked).toEqual([{ installId: "iext_default", organizationId: "org-1" }]);
    expect(rm.trust?.trusted).toBe(true);
    expect(
      decideRuntimeCubeServe({
        cubeId: "runtime.demo",
        isRuntimeCube: () => true,
        facts: { actorVisible: rm.actorVisible, status: rm.status, trust: rm.trust },
      }),
    ).toEqual({ ok: true });
  });

  // INVARIANT PIN (not a behaviour change): with one row the ranking never runs.
  // Kept because it pins that the rule DEMOTES rather than FILTERS — a side-by-side
  // row whose default has been removed must not blank the model.
  it("INVARIANT PIN: a non-default row is only DEMOTED, never dropped — alone in scope it is still reported", async () => {
    const rm = await buildInstalledExtensionReadModel("@cinatra-ai/demo-connector", actor, {
      ...baseDeps,
      readRows: async () => [row({ id: "iext_sbs", status: "active", isDefault: false })],
    });
    expect(rm.status).toBe("active");
    expect(rm.actorVisible).toBe(true);
  });

  // INVARIANT PIN (not a behaviour change): pins the NARROWNESS of the rule —
  // legacy / pre-#1040 rows carry no flag and must keep their pre-fix pick.
  it("INVARIANT PIN: only an EXPLICIT `isDefault === false` is demoted — an unset flag still counts as the default", async () => {
    // Legacy / pre-#1040 rows and fixtures carry no flag. Ranking those below a
    // flagged sibling would move every such pick; the rule must not reach them.
    const rm = await buildInstalledExtensionReadModel("@cinatra-ai/demo-connector", actor, {
      ...baseDeps,
      readRows: async () => [
        row({ id: "iext_flagged", status: "active", isDefault: true }),
        row({ id: "iext_unflagged", status: "archived" }), // no isDefault at all
      ],
    });
    // The unflagged row is NOT demoted for lacking the flag — the status ranking
    // (the next key) decides between the two, exactly as before.
    expect(rm.status).toBe("active");
  });

  it("the default outranks a better-STATUS sibling: an active sibling does not beat the default", async () => {
    const rm = await buildInstalledExtensionReadModel("@cinatra-ai/demo-connector", actor, {
      ...baseDeps,
      readRows: async () => [
        row({ id: "iext_sbs", status: "active", isDefault: false }),
        row({ id: "iext_default", status: "locked", isDefault: true }),
      ],
    });
    // single-default is ranked BEFORE the status ranking, so `locked` (the
    // default) is reported over `active` (the sibling).
    expect(rm.status).toBe("locked");
  });

  // INVARIANT PIN (not a behaviour change): the same-org preference already
  // decided this pre-fix. It is kept because the new key is inserted directly
  // BELOW it, and ranking single-default higher would silently invert it.
  it("INVARIANT PIN / KEY ORDER: single-default ranks BELOW the same-org preference (the invariant is per-scope)", async () => {
    // Exactly-one-default holds per (org, owner, package), so "the default row"
    // is only meaningful WITHIN a scope. An admin must still read their OWN org's
    // row rather than another org's merely because that one carries the flag.
    const platformAdmin: ActorContext = { ...actor, platformRole: "platform_admin" };
    const rm = await buildInstalledExtensionReadModel("@cinatra-ai/demo-connector", platformAdmin, {
      ...baseDeps,
      readRows: async () => [
        row({ id: "iext_other_default", status: "active", organizationId: "org-OTHER", isDefault: true }),
        row({ id: "iext_mine_sbs", status: "active", organizationId: "org-1", isDefault: false }),
      ],
    });
    expect(rm.ownerScope?.organizationId).toBe("org-1");
  });

  // INVARIANT PIN (not a behaviour change): supersession already dropped the org
  // row pre-fix. Kept as the ORDER pin — the new key sits below supersession, and
  // ranking it above would resurrect a superseded row.
  it("INVARIANT PIN / ORDER: supersession still runs FIRST — a superseded org DEFAULT loses to the live workspace row", async () => {
    // Order pin — supersession -> [precedence, reserved for #2774] -> single-default.
    // Ranking single-default above supersession would resurrect the org row.
    const rm = await buildInstalledExtensionReadModel("@cinatra-ai/demo-connector", actor, {
      ...baseDeps,
      readRows: async () => [
        row({ id: "iext_org", status: "active", organizationId: "org-1", isDefault: true }),
        workspaceRow({ status: "active", isDefault: false }),
      ],
    });
    expect(rm.ownerScope?.ownerLevel).toBe("workspace");
    expect(rm.ownerScope?.organizationId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// cinatra#2850 (blocker 2) — the AUDIENCE gate.
//
// "Workspace: All" and "Workspace: Admins only" persist the SAME canonical row
// (the workspace anchor — `accessTargetToRowOwnership`); the audience that tells
// them apart lives ONLY in the access policy (`accessTargetToInstallPolicy`).
// Neither `isInstallRowAddressableByActor` (an org-NULL row is addressable by
// every authenticated actor, by design) nor `decideRuntimeCubeServe` reads that
// policy — so without the gate an ordinary member of any organization reads an
// ADMINS-ONLY workspace install as their live, trusted install and serves its
// runtime cubes.
//
// The policies here are built by the REAL `accessTargetToInstallPolicy` and the
// decision is the REAL `evaluateExtensionAccess` — which is exactly what
// `canExtensionAccess` runs after its policy / co-owner / installer reads. So
// these pin the platform's own audience semantics, not a mock's opinion.
// ---------------------------------------------------------------------------

/** The audience decision `canExtensionAccess` would return for `policy`, computed by the real evaluator. */
function audienceFrom(policy: AgentAuthPolicy) {
  return async (
    resource: ExtensionAccessResource,
    a: ActorContext,
    op: "use",
  ): Promise<ExtensionAccessDecision> =>
    evaluateExtensionAccess({
      kind: resource.kind,
      policy,
      coOwnerUserIds: [],
      installedByUserId: null,
      owner: resource.owner,
      actor: a,
      op,
    });
}

const ADMINS_ONLY = accessTargetToInstallPolicy({ level: "admin", id: "org-1" })!;
const WORKSPACE_ALL = accessTargetToInstallPolicy({ level: "workspace", id: "org-1" })!;

describe("buildInstalledExtensionReadModel — the picked row's AUDIENCE gates the record (cinatra#2850)", () => {
  /** The single workspace-anchored row a "Workspace: …" install persists. */
  const workspaceInstall = async (): Promise<InstalledExtension[]> => [
    workspaceRow({ status: "active" }),
  ];

  /** The install facts `runtime-cube-serve-host` derives from the record. */
  const serve = (rm: Awaited<ReturnType<typeof buildInstalledExtensionReadModel>>) =>
    decideRuntimeCubeServe({
      cubeId: "runtime.demo",
      isRuntimeCube: () => true,
      facts: { actorVisible: rm.actorVisible, status: rm.status, trust: rm.trust },
    });

  it("an ordinary member reading an ADMINS-ONLY workspace install → absent, and the serve gate DENIES", async () => {
    // `actor` is a plain member of org-1: no platformRole, no orgRole. The row is
    // org-NULL, so `hasAdminStandingOverExtension` admits platform admins only —
    // the member is not in the audience.
    const rm = await buildInstalledExtensionReadModel("@cinatra-ai/demo-connector", actor, {
      ...trustDeps,
      readRows: workspaceInstall,
      canAccessInstallRow: audienceFrom(ADMINS_ONLY),
      resolveTrustAnchor: anchorsByRow(
        { iext_workspace: anchorForRow("iext_workspace", TRUSTED_REGISTRY) },
        [],
      ),
    });
    expect(rm.actorVisible).toBe(false);
    expect(rm.status).toBe("absent");
    expect(rm.ownerScope).toBeNull();
    expect(rm.trust).toBeNull();
    expect(serve(rm)).toEqual({
      ok: false,
      code: "cube_not_active",
      reason: 'runtime cube "runtime.demo" is not install-active for the actor (status: absent)',
    });
  });

  it("an ORG_ADMIN is still not admitted to an admins-only WORKSPACE row (admin standing over an org-NULL row is platform-admin-only)", async () => {
    const orgAdmin: ActorContext = { ...actor, orgRole: "org_admin" };
    const rm = await buildInstalledExtensionReadModel("@cinatra-ai/demo-connector", orgAdmin, {
      ...trustDeps,
      readRows: workspaceInstall,
      canAccessInstallRow: audienceFrom(ADMINS_ONLY),
    });
    expect(rm.status).toBe("absent");
    expect(serve(rm).ok).toBe(false);
  });

  it("an ADMITTED actor (platform_admin) reads the same admins-only row live and trusted → the serve gate ALLOWS", async () => {
    const platformAdmin: ActorContext = { ...actor, platformRole: "platform_admin" };
    const rm = await buildInstalledExtensionReadModel("@cinatra-ai/demo-connector", platformAdmin, {
      ...trustDeps,
      readRows: workspaceInstall,
      canAccessInstallRow: audienceFrom(ADMINS_ONLY),
      resolveTrustAnchor: anchorsByRow(
        { iext_workspace: anchorForRow("iext_workspace", TRUSTED_REGISTRY) },
        [],
      ),
    });
    expect(rm.actorVisible).toBe(true);
    expect(rm.status).toBe("active");
    expect(rm.ownerScope?.ownerLevel).toBe("workspace");
    expect(rm.trust?.trusted).toBe(true);
    expect(serve(rm)).toEqual({ ok: true });
  });

  it('a "Workspace: All" install still reaches an ordinary member — the gate narrows nothing it should not', async () => {
    // The DISCLOSED deny->allow direction of this PR: an org-scoped actor now
    // resolves the workspace row's own anchor (`org-then-workspace`) and reads it
    // trusted. That is correct for the `workspace` audience and must not regress.
    const rm = await buildInstalledExtensionReadModel("@cinatra-ai/demo-connector", actor, {
      ...trustDeps,
      readRows: workspaceInstall,
      canAccessInstallRow: audienceFrom(WORKSPACE_ALL),
      resolveTrustAnchor: anchorsByRow(
        { iext_workspace: anchorForRow("iext_workspace", TRUSTED_REGISTRY) },
        [],
      ),
    });
    expect(rm.actorVisible).toBe(true);
    expect(rm.status).toBe("active");
    expect(rm.trust?.trusted).toBe(true);
    expect(serve(rm)).toEqual({ ok: true });
  });

  it("the org-then-workspace anchor arm is never even ASKED for an actor the audience refuses", async () => {
    // The gate runs BEFORE the anchor resolution, so the arm that flips this
    // record from no-trust to trusted for an org-scoped actor is reached only by
    // an admitted one. No second audience check exists downstream to rely on.
    const asked: ReadModelAnchorTarget[] = [];
    const rm = await buildInstalledExtensionReadModel("@cinatra-ai/demo-connector", actor, {
      ...trustDeps,
      readRows: workspaceInstall,
      canAccessInstallRow: audienceFrom(ADMINS_ONLY),
      resolveTrustAnchor: anchorsByRow(
        { iext_workspace: anchorForRow("iext_workspace", TRUSTED_REGISTRY) },
        asked,
      ),
    });
    expect(asked).toEqual([]);
    expect(rm.status).toBe("absent");
  });

  it("the gate is asked about the PICKED row — the workspace row, not the superseded org row", async () => {
    const seen: ExtensionAccessResource[] = [];
    await buildInstalledExtensionReadModel("@cinatra-ai/demo-connector", actor, {
      ...baseDeps,
      readRows: supersededPair,
      canAccessInstallRow: async (resource) => {
        seen.push(resource);
        return { allowed: true };
      },
    });
    expect(seen).toEqual([
      {
        kind: "connector",
        resourceId: "iext_workspace",
        owner: { ownerLevel: "workspace", ownerId: PLATFORM_OWNER_SENTINEL, organizationId: null },
      },
    ]);
  });

  it("FAIL-SAFE: a policy read that throws is not an admission → absent", async () => {
    const rm = await buildInstalledExtensionReadModel("@cinatra-ai/demo-connector", actor, {
      ...trustDeps,
      readRows: workspaceInstall,
      canAccessInstallRow: async () => {
        throw new Error("permissions store unreachable");
      },
    });
    expect(rm.actorVisible).toBe(false);
    expect(rm.status).toBe("absent");
    expect(serve(rm).ok).toBe(false);
  });

  it("SCOPE: a kind whose install row is NOT the access resource is not gated at all", async () => {
    // The polymorphic access resource IS the `installed_extension.id` for
    // connector / artifact / workflow and only those (INSTALL_ACCESS_TARGET_KINDS
    // — the same kinds whose install persists an audience). A canonical `agent`
    // row's id belongs to a different identity space, so there is no install-row
    // audience to consult and the gate must not invent one by reading a policy
    // under the wrong resource.
    const asked: ExtensionAccessResource[] = [];
    const rm = await buildInstalledExtensionReadModel("@cinatra-ai/demo-connector", actor, {
      ...baseDeps,
      readRows: async () => [row({ status: "active", kind: "agent" })],
      canAccessInstallRow: async (resource) => {
        asked.push(resource);
        return { allowed: false, reason: "not_visible" };
      },
    });
    expect(asked).toEqual([]); // never consulted
    expect(rm.status).toBe("active"); // and the record is unchanged
    expect(rm.actorVisible).toBe(true);
  });

  it("an ORG-anchored row keeps the pre-gate reach for a same-org member (no-regression)", async () => {
    // The default policy for a row with no stored audience is workspace-visible;
    // the gate must not narrow the ordinary org install at all.
    const rm = await buildInstalledExtensionReadModel("@cinatra-ai/demo-connector", actor, {
      ...baseDeps,
      readRows: async () => [row({ status: "active" })],
      canAccessInstallRow: audienceFrom(WORKSPACE_ALL),
    });
    expect(rm.actorVisible).toBe(true);
    expect(rm.status).toBe("active");
  });
});
