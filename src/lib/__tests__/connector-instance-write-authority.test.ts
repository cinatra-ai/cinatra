/**
 * Per-user / per-connector-instance WRITE authority tests (cinatra#409).
 *
 * Pins the fail-closed enforcement the WordPress / Drupal content-editor MCP
 * connectors call before every write primitive. The host resolves the TRUSTED
 * user actor from the active request/run context (NEVER connector input) and
 * enforces TWO host-side layers keyed on the trusted actor's org:
 *   1. PER-INSTANCE — the instance row's persisted org binding (cinatra#274)
 *      must match the trusted actor's org (REAL logic exercised here — the
 *      instance reader is mocked to control the row's org, but the org-binding
 *      comparison that DENIES is the module's own un-mocked code).
 *   2. CONNECTOR-PACKAGE — `requireConnectorAuthority`.
 *
 * CRITICAL (codex must-fix): the forged-instance denials below ALLOW the
 * connector-PACKAGE policy (mock requireConnectorAuthority → allowed) and prove
 * the PER-INSTANCE gate alone denies a forged same-org / different-org
 * instanceId — i.e. the package check is NOT load-bearing for instance scoping;
 * the new per-instance org-binding gate is.
 *
 * Coverage:
 *   - no trusted user context                       → DENIED (no reader/policy call)
 *   - unknown instance                              → DENIED (per-instance)
 *   - unbound legacy instance (no orgId)            → DENIED (per-instance, strict)
 *   - forged SAME-org-config instance (row org ≠ actor org) → DENIED (per-instance)
 *   - forged DIFFERENT-org instance                 → DENIED (per-instance)
 *   - platform-admin on the public widget path      → DENIED (defensive)
 *   - entitled user, instance bound to actor's org  → ALLOWED
 *   - connector-PACKAGE deny propagates even when the instance org matches
 *   - the connector KIND is host-bound; an unknown kind throws (no reader/policy)
 *
 * PLATFORM-ADMIN FAIL-CLOSED on EVERY path (cinatra#406 — the merge-time review).
 * These assert with the connector-PACKAGE policy mocked to ALLOW (NOT mocked-away
 * to deny), so each denial proves the NEW host-side gate denies on its own:
 *   - platform-admin, NO membership, sourceType UNDEFINED → DENIED (without_org_membership)
 *   - platform-admin, NO membership, sourceType=widget    → DENIED (defensive widget)
 *   - platform-admin, membership lookup ERRORS            → DENIED (resolution_error)
 *   - platform-admin who IS a real org_admin → ALLOWED but delegated with
 *     platform_admin STRIPPED + orgRole pinned to the REAL role (no admin bypass)
 *   - platform-admin who is a real plain MEMBER → ALLOWED, stripped (delegates as member)
 *   - non-admin entitled user (#405/#408)     → NO-OP (no membership lookup, actor unchanged)
 *   - non-member (no trusted actor)           → DENIED before any lookup/policy
 */
import "server-only";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as auditModule from "@/lib/authz/audit";
import * as actorModule from "@/lib/extension-host-actor";
import * as authorityModule from "@/lib/connector-authority";

// Mock the host instance readers so the test controls each instance row's
// persisted org binding. The per-instance ORG-MATCH comparison that DENIES is
// the module's OWN un-mocked logic — these mocks only supply the row.
const wpRows: Record<string, { id: string; orgId?: string } | null> = {};
const drupalRows: Array<{ id: string; orgId?: string }> = [];
vi.mock("@/lib/wordpress-api", () => ({
  readWordPressInstanceById: (id: string) => wpRows[id] ?? null,
}));
vi.mock("@/lib/drupal-api", () => ({
  getDrupalAPISettings: () => ({ instances: drupalRows }),
}));

// Mock the membership resolver (cinatra#406). The platform-admin fail-closed
// gate resolves the actor's REAL org membership host-side before delegating;
// the test controls what membership the trusted (orgId,userId) pair has. The
// FAIL-CLOSED comparison that DENIES (no row / lookup error) is the module's
// OWN un-mocked logic — this mock only supplies the membership lookup result.
// Mocking the module also keeps auth-session's heavy import graph out of the
// unit under test.
const resolveOrgRoleForUserMock = vi.fn();
vi.mock("@/lib/auth-session", () => ({
  resolveOrgRoleForUser: (...args: unknown[]) => resolveOrgRoleForUserMock(...args),
}));

import {
  createInstanceWriteAuthorityService,
  INSTANCE_WRITE_AUTHORITY_PACKAGE_IDS,
  InstanceWriteAuthorityError,
} from "@/lib/connector-instance-write-authority";
import { POLICY_VERSION, type ActorContext } from "@/lib/authz/actor-context";

const WP_PKG = INSTANCE_WRITE_AUTHORITY_PACKAGE_IDS.wordpress;
const DRUPAL_PKG = INSTANCE_WRITE_AUTHORITY_PACKAGE_IDS.drupal;

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

describe("connector-instance write authority (cinatra#409)", () => {
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
    // Default: the connector-PACKAGE policy ALLOWS — so a denial below is proven
    // to come from the PER-INSTANCE gate, not the package check.
    authoritySpy.mockResolvedValue({ allowed: true });
    // Default membership lookup: the trusted (orgId,userId) is a plain member.
    // Platform-admin cases override this per-test to control the REAL membership.
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
  function wpGuard() {
    return createInstanceWriteAuthorityService().selectForConnector("wordpress").requireWrite;
  }

  it("DENIES (throws) when no trusted user context resolves — fail-closed, no reader or policy call", async () => {
    untrusted();
    wpRows["wp-1"] = { id: "wp-1", orgId: "org-1" };
    await expect(
      wpGuard()({ instanceId: "wp-1", primitiveName: "wordpress_post_update" }),
    ).rejects.toMatchObject({ reason: "no_trusted_actor" });
    // The synthetic/anonymous path NEVER reaches the connector policy.
    expect(authoritySpy).not.toHaveBeenCalled();
    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "denied",
        resourceType: "connector_instance",
        metadata: expect.objectContaining({ reason: "no_trusted_actor", packageId: WP_PKG }),
      }),
    );
  });

  it("DENIES an UNKNOWN instance — per-instance gate, before the package policy", async () => {
    trusted(actor());
    // No wpRows entry for the id → reader returns null.
    await expect(
      wpGuard()({ instanceId: "wp-nope", primitiveName: "wordpress_post_update" }),
    ).rejects.toMatchObject({ reason: "unknown_instance" });
    expect(authoritySpy).not.toHaveBeenCalled();
  });

  it("DENIES an UNBOUND legacy instance (row exists but no orgId) — strict fail-closed", async () => {
    trusted(actor());
    wpRows["wp-legacy"] = { id: "wp-legacy" }; // no orgId binding
    await expect(
      wpGuard()({ instanceId: "wp-legacy", primitiveName: "wordpress_post_update" }),
    ).rejects.toMatchObject({ reason: "instance_unbound" });
    expect(authoritySpy).not.toHaveBeenCalled();
  });

  it("DENIES a forged SAME-org-config instanceId whose row is bound to a DIFFERENT org — per-instance gate (package policy ALLOWS)", async () => {
    // The user is in org-1; the named instance row is bound to org-2. Even though
    // the connector-PACKAGE policy is mocked to ALLOW (proving the package check
    // is NOT what scopes the instance), the per-instance org gate DENIES.
    trusted(actor({ organizationId: "org-1" }));
    wpRows["wp-other-org"] = { id: "wp-other-org", orgId: "org-2" };
    await expect(
      wpGuard()({ instanceId: "wp-other-org", primitiveName: "wordpress_post_update" }),
    ).rejects.toMatchObject({ reason: "instance_org_mismatch" });
    // The package policy never gets to allow the forged write — the per-instance
    // gate short-circuits BEFORE it.
    expect(authoritySpy).not.toHaveBeenCalled();
    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "denied",
        metadata: expect.objectContaining({ reason: "instance_org_mismatch", packageId: WP_PKG }),
      }),
    );
  });

  it("DENIES a forged DIFFERENT-org instance — the gate keys on the actor's REAL org, never the tool input", async () => {
    trusted(actor({ organizationId: "org-1" }));
    // An instance physically belonging to org-2's tenant.
    wpRows["wp-belongs-to-org-2"] = { id: "wp-belongs-to-org-2", orgId: "org-2" };
    await expect(
      wpGuard()({ instanceId: "wp-belongs-to-org-2", primitiveName: "wordpress_post_update" }),
    ).rejects.toMatchObject({ reason: "instance_org_mismatch" });
    expect(authoritySpy).not.toHaveBeenCalled();
  });

  it("ALLOWS (resolves void) for an entitled user whose instance is bound to their org", async () => {
    trusted(actor({ organizationId: "org-1" }));
    wpRows["wp-1"] = { id: "wp-1", orgId: "org-1" };
    await expect(
      wpGuard()({ instanceId: "wp-1", primitiveName: "wordpress_post_update" }),
    ).resolves.toBeUndefined();
    // The HOST-BOUND package id + the resolved actor + the named instanceId reach
    // the connector-package authority (the package layer, after the instance gate).
    expect(authoritySpy).toHaveBeenCalledWith(
      WP_PKG,
      expect.objectContaining({ organizationId: "org-1", principalId: "user-1" }),
      { mode: "use", instanceId: "wp-1" },
    );
  });

  it("DENIES (throws) the CONNECTOR-PACKAGE policy deny even when the instance org matches", async () => {
    trusted(actor({ organizationId: "org-1" }));
    wpRows["wp-1"] = { id: "wp-1", orgId: "org-1" };
    // Instance org matches, but the connector-package policy denies (e.g. an
    // admin-only connector the member is not entitled to use).
    authoritySpy.mockResolvedValue({ allowed: false, reason: "admin_only_connector", skipped: false });
    await expect(
      wpGuard()({ instanceId: "wp-1", primitiveName: "wordpress_post_update" }),
    ).rejects.toMatchObject({ reason: "admin_only_connector" });
    expect(authoritySpy).toHaveBeenCalled();
    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "denied",
        metadata: expect.objectContaining({
          reason: "admin_only_connector",
          primitiveName: "wordpress_post_update",
          packageId: WP_PKG,
        }),
      }),
    );
  });

  it("DENIES (throws) a platform-admin on the public-site-widget path — defensive, BEFORE the instance read", async () => {
    trusted(actor({ platformRole: "platform_admin" }));
    wpRows["wp-1"] = { id: "wp-1", orgId: "org-1" };
    await expect(
      wpGuard()({
        instanceId: "wp-1",
        primitiveName: "wordpress_post_update",
        sourceType: "public_site_widget",
      }),
    ).rejects.toMatchObject({ reason: "platform_admin_on_public_widget" });
    // The defensive deny short-circuits BEFORE the instance read + package policy.
    expect(authoritySpy).not.toHaveBeenCalled();
    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "denied",
        metadata: expect.objectContaining({
          reason: "platform_admin_on_public_widget",
          sourceType: "public_site_widget",
        }),
      }),
    );
  });

  // ---------------------------------------------------------------------------
  // Platform-admin FAIL-CLOSED on EVERY path (cinatra#406).
  //
  // The merge-time review caught a fail-OPEN-by-default trap: the public-widget
  // suppression was OPT-IN via the OPTIONAL `sourceType` field. With sourceType
  // OMITTED (the default on every non-widget path), a platform-admin actor was
  // passed UNMODIFIED into the package authority, whose delegated evaluator
  // grants platform_admin UNCONDITIONALLY before any per-user/per-instance grant
  // check — so admin STANDING alone could authorize a content write.
  //
  // CRITICAL for these tests: the connector-PACKAGE policy is mocked to ALLOW
  // (the beforeEach default `{ allowed: true }`) — i.e. we DELIBERATELY do NOT
  // mock-away the bypass. A platform-admin denial below therefore proves the NEW
  // host-side fail-closed gate denies, NOT that the package mock happened to
  // deny. The prior test for this case mocked the package policy to DENY, which
  // masked the real bypass; that is exactly the trap being closed here.
  // ---------------------------------------------------------------------------

  it("DENIES a platform-admin with NO org membership on the NON-widget path (sourceType UNDEFINED) — even though the package policy ALLOWS", async () => {
    trusted(actor({ platformRole: "platform_admin", orgRole: undefined, organizationId: "org-1" }));
    wpRows["wp-1"] = { id: "wp-1", orgId: "org-1" }; // instance org MATCHES the actor org
    // No real membership row for this (orgId,userId) → admin standing is not a grant.
    resolveOrgRoleForUserMock.mockResolvedValue(undefined);
    // Package policy ALLOWS (default) — so the denial MUST come from the host gate.
    await expect(
      wpGuard()({ instanceId: "wp-1", primitiveName: "wordpress_post_update" }),
    ).rejects.toMatchObject({ reason: "platform_admin_without_org_membership" });
    // The fail-closed gate denies BEFORE the package authority is ever consulted.
    expect(authoritySpy).not.toHaveBeenCalled();
    expect(resolveOrgRoleForUserMock).toHaveBeenCalledWith("org-1", "user-1");
    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "denied",
        metadata: expect.objectContaining({
          reason: "platform_admin_without_org_membership",
          packageId: WP_PKG,
        }),
      }),
    );
  });

  it("DENIES a platform-admin with NO org membership when sourceType is EXPLICITLY public_site_widget — via the defensive widget deny (still fail-closed)", async () => {
    trusted(actor({ platformRole: "platform_admin", orgRole: undefined, organizationId: "org-1" }));
    wpRows["wp-1"] = { id: "wp-1", orgId: "org-1" };
    resolveOrgRoleForUserMock.mockResolvedValue(undefined);
    await expect(
      wpGuard()({
        instanceId: "wp-1",
        primitiveName: "wordpress_post_update",
        sourceType: "public_site_widget",
      }),
    ).rejects.toMatchObject({ reason: "platform_admin_on_public_widget" });
    expect(authoritySpy).not.toHaveBeenCalled();
  });

  it("DENIES a platform-admin when the membership lookup ERRORS — fail-closed (never allow on a DB read error)", async () => {
    trusted(actor({ platformRole: "platform_admin", orgRole: undefined, organizationId: "org-1" }));
    wpRows["wp-1"] = { id: "wp-1", orgId: "org-1" };
    resolveOrgRoleForUserMock.mockRejectedValue(new Error("db down"));
    await expect(
      wpGuard()({ instanceId: "wp-1", primitiveName: "wordpress_post_update" }),
    ).rejects.toMatchObject({ reason: "org_membership_resolution_error" });
    expect(authoritySpy).not.toHaveBeenCalled();
    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "denied",
        metadata: expect.objectContaining({ reason: "org_membership_resolution_error" }),
      }),
    );
  });

  it("a platform-admin who IS a real org member delegates with platform_admin STRIPPED + orgRole pinned to the REAL role (no admin bypass reaches the package policy)", async () => {
    trusted(actor({ platformRole: "platform_admin", orgRole: undefined, organizationId: "org-1" }));
    wpRows["wp-1"] = { id: "wp-1", orgId: "org-1" };
    // The platform admin is ALSO a real org_admin of org-1 (a legitimate org grant).
    resolveOrgRoleForUserMock.mockResolvedValue("org_admin");
    await expect(
      wpGuard()({ instanceId: "wp-1", primitiveName: "wordpress_post_update" }),
    ).resolves.toBeUndefined();
    // The actor that reaches the package authority must NOT carry platformRole,
    // and its orgRole must be the REAL membership role — so the decision rests on
    // the actual org grant, never platform-admin standing.
    expect(authoritySpy).toHaveBeenCalledWith(
      WP_PKG,
      expect.objectContaining({
        organizationId: "org-1",
        principalId: "user-1",
        platformRole: undefined,
        orgRole: "org_admin",
      }),
      { mode: "use", instanceId: "wp-1" },
    );
  });

  it("a platform-admin who is a real plain MEMBER still has platform_admin stripped (delegates as a member, not an admin)", async () => {
    trusted(actor({ platformRole: "platform_admin", orgRole: undefined, organizationId: "org-1" }));
    wpRows["wp-1"] = { id: "wp-1", orgId: "org-1" };
    resolveOrgRoleForUserMock.mockResolvedValue("member");
    await expect(
      wpGuard()({ instanceId: "wp-1", primitiveName: "wordpress_post_update" }),
    ).resolves.toBeUndefined();
    expect(authoritySpy).toHaveBeenCalledWith(
      WP_PKG,
      expect.objectContaining({ platformRole: undefined, orgRole: "member" }),
      { mode: "use", instanceId: "wp-1" },
    );
  });

  it("a NON-admin entitled user (#405 headless / #408 widget) is a NO-OP for the strip gate — the actor reaches the package policy unchanged, no membership lookup", async () => {
    // A normal entitled member: no platformRole. The strip branch must not fire.
    trusted(actor({ organizationId: "org-1", orgRole: "member" }));
    wpRows["wp-1"] = { id: "wp-1", orgId: "org-1" };
    await expect(
      wpGuard()({ instanceId: "wp-1", primitiveName: "wordpress_post_update" }),
    ).resolves.toBeUndefined();
    // The membership resolver is NEVER consulted for a non-admin actor.
    expect(resolveOrgRoleForUserMock).not.toHaveBeenCalled();
    expect(authoritySpy).toHaveBeenCalledWith(
      WP_PKG,
      expect.objectContaining({ organizationId: "org-1", orgRole: "member" }),
      { mode: "use", instanceId: "wp-1" },
    );
  });

  it("a NON-member (no trusted actor) is DENIED before any membership lookup or package policy", async () => {
    untrusted();
    wpRows["wp-1"] = { id: "wp-1", orgId: "org-1" };
    await expect(
      wpGuard()({ instanceId: "wp-1", primitiveName: "wordpress_post_update" }),
    ).rejects.toMatchObject({ reason: "no_trusted_actor" });
    expect(resolveOrgRoleForUserMock).not.toHaveBeenCalled();
    expect(authoritySpy).not.toHaveBeenCalled();
  });

  it("gates the Drupal connector through its own host-bound kind (package + reader)", async () => {
    trusted(actor({ organizationId: "org-1" }));
    drupalRows.push({ id: "d-1", orgId: "org-1" });
    const drupalGuard = createInstanceWriteAuthorityService().selectForConnector("drupal")
      .requireWrite;
    await expect(
      drupalGuard({ instanceId: "d-1", primitiveName: "drupal_node_update" }),
    ).resolves.toBeUndefined();
    expect(authoritySpy).toHaveBeenCalledWith(
      DRUPAL_PKG,
      expect.objectContaining({ organizationId: "org-1" }),
      { mode: "use", instanceId: "d-1" },
    );
    // A Drupal instance bound to a different org is denied by the per-instance gate.
    drupalRows.push({ id: "d-other", orgId: "org-2" });
    await expect(
      drupalGuard({ instanceId: "d-other", primitiveName: "drupal_node_update" }),
    ).rejects.toMatchObject({ reason: "instance_org_mismatch" });
  });

  it("binds the connector KIND HOST-SIDE — selectForConnector rejects an unknown kind (never caller-arbitrary)", async () => {
    const svc = createInstanceWriteAuthorityService();
    // Only the two CMS content connector KINDS are gated; anything else throws
    // BEFORE any actor resolution, instance read, or policy evaluation — the
    // package + reader can never be arbitrary caller input (codex must-fix). A
    // PACKAGE ID passed where a KIND is expected is rejected too.
    expect(() => svc.selectForConnector("apollo")).toThrow(InstanceWriteAuthorityError);
    expect(() => svc.selectForConnector("@attacker/evil")).toThrow(/unsupported_connector_kind/);
    expect(() => svc.selectForConnector("@cinatra-ai/wordpress-mcp-connector")).toThrow();
    // The legitimate kinds bind a guard.
    expect(typeof svc.selectForConnector("wordpress").requireWrite).toBe("function");
    expect(typeof svc.selectForConnector("drupal").requireWrite).toBe("function");
    // No actor resolution / audit happened on the reject path.
    expect(ctxSpy).not.toHaveBeenCalled();
    expect(authoritySpy).not.toHaveBeenCalled();
  });
});
