/**
 * connector authority tests.
 *
 * Covers: requireConnectorAuthority allow/deny + audit; intersection
 * (monotonic, never expands); required-vs-optional dispatch handling.
 */
import "server-only";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as auditModule from "@/lib/authz/audit";
import * as policyModule from "@/lib/connector-policy";
import {
  evaluateConnectorDependencies,
  intersectAuthorizedConnectors,
  requireConnectorAuthority,
} from "@/lib/connector-authority";
import { POLICY_VERSION, type ActorContext } from "@/lib/authz/actor-context";

function actor(over: Partial<ActorContext> = {}): ActorContext {
  return {
    principalType: "HumanUser",
    principalId: "user-1",
    authSource: "agent",
    policyVersion: POLICY_VERSION,
    organizationId: "org-1",
    orgRole: "member",
    ...over,
  } as ActorContext;
}

describe("requireConnectorAuthority", () => {
  let auditSpy: ReturnType<typeof vi.spyOn>;
  let policySpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    auditSpy = vi.spyOn(auditModule, "logAuditEvent").mockResolvedValue(undefined);
    policySpy = vi.spyOn(policyModule, "enforceConnectorPolicy");
  });
  afterEach(() => {
    auditSpy.mockRestore();
    policySpy.mockRestore();
  });

  it("returns allowed + audits when enforceConnectorPolicy says yes", async () => {
    policySpy.mockReturnValue({ allowed: true, visibility: "organization" });
    const d = await requireConnectorAuthority("@cinatra-ai/apollo-connector", actor());
    expect(d.allowed).toBe(true);
    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({ decision: "allowed", resourceType: "connector_instance" }),
    );
  });

  it("returns denied + skipped=false on a required missing connector", async () => {
    policySpy.mockReturnValue({ allowed: false, visibility: "admin", reason: "admin_only_connector" });
    const d = await requireConnectorAuthority("@cinatra-ai/apollo-connector", actor(), { requirement: "required" });
    expect(d).toMatchObject({ allowed: false, skipped: false });
    expect(auditSpy).toHaveBeenCalledWith(expect.objectContaining({ decision: "denied" }));
  });

  it("returns denied + skipped=true for an optional missing connector", async () => {
    policySpy.mockReturnValue({ allowed: false, visibility: "admin", reason: "admin_only_connector" });
    const d = await requireConnectorAuthority("@cinatra-ai/apollo-connector", actor(), { requirement: "optional" });
    expect(d).toMatchObject({ allowed: false, skipped: true });
    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({ decision: "denied", metadata: expect.objectContaining({ requirement: "optional" }) }),
    );
  });
});

describe("intersectAuthorizedConnectors", () => {
  it("returns candidate unchanged when no parent is supplied", () => {
    const out = intersectAuthorizedConnectors(undefined, new Set(["a", "b", "c"]));
    expect([...out].sort()).toEqual(["a", "b", "c"]);
  });

  it("intersects, never expands", () => {
    const parent = new Set(["a", "b"]);
    const out = intersectAuthorizedConnectors(parent, new Set(["b", "c"]));
    expect([...out].sort()).toEqual(["b"]);
  });

  it("yields empty when candidate has nothing in common with parent", () => {
    const parent = new Set(["a", "b"]);
    const out = intersectAuthorizedConnectors(parent, new Set(["x", "y"]));
    expect(out.size).toBe(0);
  });

  it("yields empty when parent is empty", () => {
    const out = intersectAuthorizedConnectors(new Set<string>(), new Set(["a"]));
    expect(out.size).toBe(0);
  });
});

describe("evaluateConnectorDependencies", () => {
  let policySpy: ReturnType<typeof vi.spyOn>;
  let auditSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    auditSpy = vi.spyOn(auditModule, "logAuditEvent").mockResolvedValue(undefined);
    policySpy = vi.spyOn(policyModule, "enforceConnectorPolicy");
  });
  afterEach(() => {
    auditSpy.mockRestore();
    policySpy.mockRestore();
  });

  it("returns ok:true when all required deps are authorized", async () => {
    policySpy.mockReturnValue({ allowed: true, visibility: "organization" });
    const out = await evaluateConnectorDependencies(
      [
        { packageId: "@cinatra-ai/apollo-connector", requirement: "required" },
        { packageId: "@cinatra-ai/gmail-connector", requirement: "required" },
      ],
      actor(),
    );
    expect(out).toMatchObject({ ok: true, skipped: [] });
  });

  it("returns ok:true + skipped list when only optional deps are missing", async () => {
    policySpy.mockImplementation((pkg) =>
      pkg === "@cinatra-ai/gmail-connector"
        ? { allowed: false, visibility: "admin" as const, reason: "no_grant" }
        : { allowed: true, visibility: "organization" as const },
    );
    const out = await evaluateConnectorDependencies(
      [
        { packageId: "@cinatra-ai/apollo-connector", requirement: "required" },
        { packageId: "@cinatra-ai/gmail-connector", requirement: "optional" },
      ],
      actor(),
    );
    expect(out).toMatchObject({ ok: true, skipped: ["@cinatra-ai/gmail-connector"] });
  });

  it("returns ok:false + failedRequired when a required dep is missing", async () => {
    policySpy.mockImplementation((pkg) =>
      pkg === "@cinatra-ai/apollo-connector"
        ? { allowed: false, visibility: "admin" as const, reason: "no_grant" }
        : { allowed: true, visibility: "organization" as const },
    );
    const out = await evaluateConnectorDependencies(
      [
        { packageId: "@cinatra-ai/apollo-connector", requirement: "required" },
        { packageId: "@cinatra-ai/gmail-connector", requirement: "optional" },
      ],
      actor(),
    );
    expect(out).toMatchObject({ ok: false, failedRequired: ["@cinatra-ai/apollo-connector"] });
  });

  it("defaults missing requirement to 'required' (strictest)", async () => {
    policySpy.mockReturnValue({ allowed: false, visibility: "admin", reason: "no_grant" });
    const out = await evaluateConnectorDependencies(
      [{ packageId: "@cinatra-ai/apollo-connector" }],
      actor(),
    );
    expect(out).toMatchObject({ ok: false, failedRequired: ["@cinatra-ai/apollo-connector"] });
  });
});
