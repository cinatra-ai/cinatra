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

  it("a platform-admin on a NON-widget path is still subject to BOTH host gates (no special-case allow)", async () => {
    trusted(actor({ platformRole: "platform_admin", orgRole: undefined, organizationId: "org-1" }));
    wpRows["wp-1"] = { id: "wp-1", orgId: "org-1" };
    // Instance org matches; the package policy denies → still denied (no bypass).
    authoritySpy.mockResolvedValue({ allowed: false, reason: "no_grant", skipped: false });
    await expect(
      wpGuard()({ instanceId: "wp-1", primitiveName: "wordpress_post_update" }),
    ).rejects.toMatchObject({ reason: "no_grant" });
    expect(authoritySpy).toHaveBeenCalled();
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
