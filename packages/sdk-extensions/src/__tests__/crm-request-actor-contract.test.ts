// DI contract: the CRM request-actor resolver is host-injected at boot via
// setCrmRequestActorResolver and resolved by the crm-connector MCP handlers via
// requireCrmRequestActorResolver(). It MUST fail closed (throw) when unwired — an
// unbound resolver is a boot-wiring bug, never a silent no-op that could mint a
// mis-scoped pointer-write actor.
import { afterEach, describe, expect, it } from "vitest";
import {
  setCrmRequestActorResolver,
  requireCrmRequestActorResolver,
  _resetCrmRequestActorResolverForTests,
  type CrmRequestActor,
  type CrmRequestActorResolver,
} from "../crm-request-actor-contract";

function stub(actor: CrmRequestActor | null): CrmRequestActorResolver {
  return { getActor: () => actor };
}

afterEach(() => {
  _resetCrmRequestActorResolverForTests();
});

describe("crm-request-actor-contract — host-injected DI resolver", () => {
  it("fails CLOSED (throws) when the host never wired a resolver", () => {
    _resetCrmRequestActorResolverForTests();
    expect(() => requireCrmRequestActorResolver()).toThrow(/wired the CRM request-actor resolver/);
  });

  it("resolves the wired resolver after setCrmRequestActorResolver", () => {
    const impl = stub({ userId: "u1", orgId: "o1", platformRole: "member" });
    setCrmRequestActorResolver(impl);
    expect(requireCrmRequestActorResolver()).toBe(impl);
  });

  it("re-wiring replaces the previous resolver (boot idempotency / test swap)", () => {
    const first = stub({ userId: "u1", orgId: "o1" });
    const second = stub({ userId: "u2", orgId: "o2", platformRole: "platform_admin" });
    setCrmRequestActorResolver(first);
    setCrmRequestActorResolver(second);
    expect(requireCrmRequestActorResolver()).toBe(second);
  });

  it("getActor() passes through the request identity (incl. platformRole) and null outside a frame", () => {
    setCrmRequestActorResolver(stub({ userId: "u7", orgId: "org-1", platformRole: "platform_admin" }));
    expect(requireCrmRequestActorResolver().getActor()).toEqual({
      userId: "u7",
      orgId: "org-1",
      platformRole: "platform_admin",
    });
    setCrmRequestActorResolver(stub(null));
    expect(requireCrmRequestActorResolver().getActor()).toBeNull();
  });
});
