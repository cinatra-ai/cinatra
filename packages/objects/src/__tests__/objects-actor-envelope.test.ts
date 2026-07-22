// The load-bearing conversion seam for the internal-read authority
// (cinatra#1948 (b)): `actorContextToObjectsEnvelope` must carry `internalRead`
// from the kernel `ActorContext` onto the MCP envelope the objects handlers'
// authz path reads (`deriveRoleHints` → `internal_reader`). If this threading
// were dropped, the resolver tests (which inspect the PRE-conversion
// ActorContext) and the kernel tests (which hand-build envelopes) would both
// stay green while production silently denied every routing read — so this seam
// gets its own direct assertion.
import { describe, it, expect } from "vitest";
import { actorContextToObjectsEnvelope } from "../objects-actor-envelope";

type Actor = Parameters<typeof actorContextToObjectsEnvelope>[0];

const ORG = "org-env";

function systemInternalReadActor(): Actor {
  return {
    principalType: "System",
    principalId: "system",
    organizationId: ORG,
    internalRead: true,
    authSource: "worker",
    policyVersion: "v2",
  } as unknown as Actor;
}

function ownerInternalReadActor(): Actor {
  return {
    principalType: "HumanUser",
    principalId: "user-1",
    organizationId: ORG,
    internalRead: true,
    authSource: "worker",
    policyVersion: "v2",
  } as unknown as Actor;
}

describe("actorContextToObjectsEnvelope — internal-read authority threading", () => {
  it("carries internalRead:true onto the envelope for a System actor (no member impersonation)", () => {
    const env = actorContextToObjectsEnvelope(systemInternalReadActor());
    expect(env.internalRead).toBe(true);
    expect(env.actorType).toBe("system");
    expect(env.source).toBe("worker");
    expect(env.organizationId).toBe(ORG);
    // No member floor is smuggled in — the whole point of #1948 (b).
    expect(env.roles).toBeUndefined();
    // System principals are user-less on the envelope.
    expect((env as { userId?: string }).userId).toBeUndefined();
  });

  it("carries internalRead:true AND the owner userId for a HumanUser owner actor", () => {
    const env = actorContextToObjectsEnvelope(ownerInternalReadActor());
    expect(env.internalRead).toBe(true);
    expect(env.actorType).toBe("human");
    expect((env as { userId?: string }).userId).toBe("user-1");
    expect(env.roles).toBeUndefined();
  });

  it("OMITS internalRead when the actor does not carry it (default shape unchanged)", () => {
    const env = actorContextToObjectsEnvelope({
      principalType: "HumanUser",
      principalId: "user-2",
      organizationId: ORG,
      orgRole: "member",
      authSource: "ui",
      policyVersion: "v2",
    } as unknown as Actor);
    expect("internalRead" in env).toBe(false);
    // Sanity: an ordinary member still maps as before.
    expect(env.roles).toEqual(["member"]);
  });
});
