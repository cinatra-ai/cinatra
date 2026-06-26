/**
 * Actor-scoped instance LIST authority tests.
 *
 * Pins the fail-closed read-boundary filter the host's `listAuthorizedInstances`
 * companion uses for the external-MCP toolbox-injection path. It is the
 * read-boundary twin of the `requireWrite` gate and REUSES the IDENTICAL
 * machinery (same trusted-actor resolution from the host frame, same universal
 * live-membership reverify with deny-no-row, same sanitized decisionActor, same
 * per-instance org-binding gate, same connector-package `requireConnectorAuthority`
 * check) — but FILTERS instead of throwing, so a deny DROPS the instance and an
 * unresolved actor / membership returns `[]`.
 *
 * Coverage (the host method's whole point — fail CLOSED):
 *   (a) an authorized actor gets EXACTLY their entitled, org-bound instances
 *       (foreign-org + unbound + package-denied rows are dropped);
 *   (b) an actor with NO live membership row gets [] (deny-no-row), even though
 *       the connector-PACKAGE policy is mocked to ALLOW — proving the reverify
 *       gate denies on its own (the revocation-TOCTOU / 4th-gap family);
 *   (c) the actor is taken from the TRUSTED frame, never from input: an
 *       UNRESOLVED frame yields [] and NEVER the global list, and the package
 *       policy is invoked with a decisionActor whose org == the trusted org with
 *       platformRole STRIPPED + orgRole PINNED to the live role.
 *   + membership-lookup ERROR → [] (fail-closed, never allow on read fault);
 *   + a platform-admin without a live membership row → [] (no admin bypass);
 *   + per-instance reader / package-policy faults DROP only that instance;
 *   + empty input short-circuits to [] without touching the actor frame;
 *   + an unknown connector kind THROWS at construction (host-bound, never input).
 */
import "server-only";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as auditModule from "@/lib/authz/audit";
import * as actorModule from "@/lib/extension-host-actor";
import * as authorityModule from "@/lib/connector-authority";

// Mock the host instance readers so the test controls each instance row's
// persisted org binding. The per-instance ORG-MATCH comparison that filters is
// the module's OWN un-mocked logic — these mocks only supply the rows.
const wpRows: Record<string, { id: string; orgId?: string } | null> = {};
const drupalRows: Array<{ id: string; orgId?: string }> = [];
vi.mock("@/lib/wordpress-api", () => ({
  readWordPressInstanceById: (id: string) => wpRows[id] ?? null,
}));
vi.mock("@/lib/drupal-api", () => ({
  getDrupalAPISettings: () => ({ instances: drupalRows }),
}));

// Mock the membership resolver. The universal live-membership
// reverify resolves the actor's REAL org membership host-side; the test controls
// what membership the trusted (orgId,userId) pair has. The FAIL-CLOSED branch
// that returns [] (no row / lookup error) is the module's OWN un-mocked logic.
const resolveOrgRoleForUserMock = vi.fn();
vi.mock("@/lib/auth-session", () => ({
  resolveOrgRoleForUser: (...args: unknown[]) => resolveOrgRoleForUserMock(...args),
}));

import {
  createInstanceListAuthority,
  InstanceWriteAuthorityError,
  INSTANCE_WRITE_AUTHORITY_PACKAGE_IDS,
} from "@/lib/connector-instance-write-authority";
import { POLICY_VERSION, type ActorContext } from "@/lib/authz/actor-context";

const DRUPAL_PKG = INSTANCE_WRITE_AUTHORITY_PACKAGE_IDS.drupal;

type DrupalRow = { id: string; name: string; siteUrl: string };
const drupalInstance = (id: string): DrupalRow => ({
  id,
  name: `Site ${id}`,
  siteUrl: `https://${id}.example`,
});

function actor(over: Partial<ActorContext> = {}): ActorContext {
  return {
    principalType: "HumanUser",
    principalId: "user-1",
    authSource: "mcp",
    policyVersion: POLICY_VERSION,
    organizationId: "org-1",
    orgRole: "member",
    ...over,
  } as ActorContext;
}

describe("connector-instance LIST authority", () => {
  let auditSpy: ReturnType<typeof vi.spyOn>;
  let ctxSpy: ReturnType<typeof vi.spyOn>;
  let summarySpy: ReturnType<typeof vi.spyOn>;
  let authoritySpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    for (const k of Object.keys(wpRows)) delete wpRows[k];
    drupalRows.length = 0;
    auditSpy = vi.spyOn(auditModule, "logAuditEvent").mockResolvedValue(undefined);
    ctxSpy = vi.spyOn(actorModule, "resolveExtensionActorContext");
    summarySpy = vi.spyOn(actorModule, "resolveExtensionActorSummary");
    authoritySpy = vi.spyOn(authorityModule, "requireConnectorAuthority");
    // Default: the connector-PACKAGE policy ALLOWS — so a DROP below is proven to
    // come from the actor/membership/per-instance gates, not the package check.
    authoritySpy.mockResolvedValue({ allowed: true });
    resolveOrgRoleForUserMock.mockReset();
    resolveOrgRoleForUserMock.mockResolvedValue("member");
  });
  afterEach(() => {
    auditSpy.mockRestore();
    ctxSpy.mockRestore();
    summarySpy.mockRestore();
    authoritySpy.mockRestore();
  });

  function trusted(a: ActorContext) {
    ctxSpy.mockResolvedValue(a);
    summarySpy.mockResolvedValue({
      userId: a.principalId,
      organizationId: a.organizationId ?? null,
      orgRole: a.orgRole ?? null,
    });
  }
  function untrusted() {
    ctxSpy.mockResolvedValue(null);
    summarySpy.mockResolvedValue(null);
  }
  const drupalFilter = () => createInstanceListAuthority("drupal");

  // (a) AUTHORIZED actor gets EXACTLY their entitled, org-bound instances.
  it("returns ONLY the trusted actor's org-bound, package-allowed instances (drops foreign-org / unbound / denied rows)", async () => {
    trusted(actor({ organizationId: "org-1" }));
    drupalRows.push(
      { id: "mine-a", orgId: "org-1" }, // kept
      { id: "foreign", orgId: "org-2" }, // dropped — different org
      { id: "unbound", orgId: undefined }, // dropped — no org binding
      { id: "mine-b", orgId: "org-1" }, // kept
    );
    const input: DrupalRow[] = [
      drupalInstance("mine-a"),
      drupalInstance("foreign"),
      drupalInstance("unbound"),
      drupalInstance("mine-b"),
    ];
    const result = await drupalFilter()(input);
    expect(result.map((i) => i.id)).toEqual(["mine-a", "mine-b"]);
    // FULL row threaded through unchanged for the authorized subset.
    expect(result[0]).toEqual(drupalInstance("mine-a"));
    // The package policy is consulted ONLY for the org-bound survivors, keyed on
    // the HOST-BOUND package id + the trusted org (never the global list).
    expect(authoritySpy).toHaveBeenCalledTimes(2);
    expect(authoritySpy).toHaveBeenCalledWith(
      DRUPAL_PKG,
      expect.objectContaining({ organizationId: "org-1", principalId: "user-1" }),
      { mode: "use", instanceId: "mine-a" },
    );
  });

  it("drops an org-bound instance the connector-PACKAGE policy DENIES (package check is load-bearing for the survivor set)", async () => {
    trusted(actor({ organizationId: "org-1" }));
    drupalRows.push({ id: "mine-a", orgId: "org-1" }, { id: "mine-b", orgId: "org-1" });
    authoritySpy.mockImplementation(async (_pkg, _actor, opts) =>
      opts?.instanceId === "mine-b"
        ? { allowed: false, reason: "no_grant", skipped: false }
        : { allowed: true },
    );
    const result = await drupalFilter()([drupalInstance("mine-a"), drupalInstance("mine-b")]);
    expect(result.map((i) => i.id)).toEqual(["mine-a"]);
  });

  // (b) NO membership row → [] (deny-no-row), package policy ALLOWS.
  it("returns [] when the actor has NO live org-membership row — deny-no-row, even though the package policy ALLOWS", async () => {
    trusted(actor({ organizationId: "org-1", orgRole: undefined }));
    drupalRows.push({ id: "mine-a", orgId: "org-1" });
    resolveOrgRoleForUserMock.mockResolvedValue(undefined); // no live membership
    const result = await drupalFilter()([drupalInstance("mine-a")]);
    expect(result).toEqual([]);
    expect(resolveOrgRoleForUserMock).toHaveBeenCalledWith("org-1", "user-1");
    // No per-instance package check ran — denied before the loop.
    expect(authoritySpy).not.toHaveBeenCalled();
  });

  it("returns [] for a platform-admin WITHOUT a live membership row — no admin bypass", async () => {
    trusted(actor({ platformRole: "platform_admin", orgRole: undefined, organizationId: "org-1" }));
    drupalRows.push({ id: "mine-a", orgId: "org-1" });
    resolveOrgRoleForUserMock.mockResolvedValue(undefined);
    await expect(drupalFilter()([drupalInstance("mine-a")])).resolves.toEqual([]);
    expect(authoritySpy).not.toHaveBeenCalled();
  });

  it("returns [] when the membership lookup ERRORS — fail-closed (never allow on a read fault)", async () => {
    trusted(actor({ organizationId: "org-1" }));
    drupalRows.push({ id: "mine-a", orgId: "org-1" });
    resolveOrgRoleForUserMock.mockRejectedValue(new Error("db down"));
    await expect(drupalFilter()([drupalInstance("mine-a")])).resolves.toEqual([]);
    expect(authoritySpy).not.toHaveBeenCalled();
  });

  // (c) Actor is taken from the TRUSTED frame, never from input.
  it("returns [] when NO trusted actor resolves — NEVER the global list (the actor is host-derived, not input)", async () => {
    untrusted();
    drupalRows.push({ id: "mine-a", orgId: "org-1" }, { id: "mine-b", orgId: "org-1" });
    const result = await drupalFilter()([drupalInstance("mine-a"), drupalInstance("mine-b")]);
    expect(result).toEqual([]);
    // Membership + package layers are never reached — denied at the actor frame.
    expect(resolveOrgRoleForUserMock).not.toHaveBeenCalled();
    expect(authoritySpy).not.toHaveBeenCalled();
  });

  it("keys the per-instance gate on the TRUSTED actor's org — a row 'named' for org-1 in input but bound to org-2 is dropped (no tool-input authority)", async () => {
    trusted(actor({ organizationId: "org-1" }));
    // The input row's id collides with a row the reader binds to org-2.
    drupalRows.push({ id: "looks-mine", orgId: "org-2" });
    const result = await drupalFilter()([drupalInstance("looks-mine")]);
    expect(result).toEqual([]);
    expect(authoritySpy).not.toHaveBeenCalled();
  });

  it("delegates to the package policy with platformRole STRIPPED + orgRole PINNED to the live role (admin standing cannot decide a listed instance)", async () => {
    trusted(actor({ platformRole: "platform_admin", orgRole: undefined, organizationId: "org-1" }));
    drupalRows.push({ id: "mine-a", orgId: "org-1" });
    resolveOrgRoleForUserMock.mockResolvedValue("org_admin"); // real live role
    await drupalFilter()([drupalInstance("mine-a")]);
    const passedActor = authoritySpy.mock.calls[0]?.[1] as ActorContext;
    expect(passedActor.platformRole).toBeUndefined();
    expect(passedActor.orgRole).toBe("org_admin");
    expect(passedActor.principalType).toBe("HumanUser");
    expect(passedActor.principalId).toBe("user-1");
    expect(passedActor.organizationId).toBe("org-1");
  });

  // Per-instance reader / policy faults isolate to the single instance.
  it("DROPS only the instance whose package-policy evaluation THROWS (fail-closed per-instance, not the whole list)", async () => {
    trusted(actor({ organizationId: "org-1" }));
    drupalRows.push({ id: "ok", orgId: "org-1" }, { id: "boom", orgId: "org-1" });
    authoritySpy.mockImplementation(async (_pkg, _actor, opts) => {
      if (opts?.instanceId === "boom") throw new Error("policy fault");
      return { allowed: true };
    });
    const result = await drupalFilter()([drupalInstance("ok"), drupalInstance("boom")]);
    expect(result.map((i) => i.id)).toEqual(["ok"]);
  });

  it("short-circuits to [] on empty input WITHOUT resolving the actor frame", async () => {
    await expect(drupalFilter()([])).resolves.toEqual([]);
    expect(ctxSpy).not.toHaveBeenCalled();
    expect(summarySpy).not.toHaveBeenCalled();
    expect(resolveOrgRoleForUserMock).not.toHaveBeenCalled();
    expect(authoritySpy).not.toHaveBeenCalled();
  });

  it("the connector KIND is host-bound — constructing for an unknown kind THROWS (never caller input)", () => {
    // The list authority is bound to a CLOSED kind enum at construction; an
    // unknown kind can never select another package's policy or reader.
    expect(() => createInstanceListAuthority("nope" as never)).toThrow(InstanceWriteAuthorityError);
  });
});
