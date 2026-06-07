import { describe, expect, it } from "vitest";
import type { ActorContext } from "@/lib/authz/actor-context";
import {
  withActorContext,
  getActorContext,
  getActorContextOrThrow,
  actorContextStorage,
} from "../actor-context";

const ctx: ActorContext = {
  principalType: "HumanUser",
  principalId: "u-1",
  organizationId: "org-1",
  authSource: "ui",
  policyVersion: "v2",
};

const innerCtx: ActorContext = {
  principalType: "HumanUser",
  principalId: "u-2",
  organizationId: "org-2",
  authSource: "ui",
  policyVersion: "v2",
};

describe("actor-context AsyncLocalStorage", () => {
  it("getActorContext returns undefined outside a frame", () => {
    expect(getActorContext()).toBeUndefined();
  });

  it("getActorContext returns the current frame ctx", async () => {
    await withActorContext(ctx, async () => {
      expect(getActorContext()).toBe(ctx);
    });
  });

  it("getActorContextOrThrow throws ACTOR_CONTEXT_MISSING outside a frame", () => {
    try {
      getActorContextOrThrow();
      throw new Error("should have thrown");
    } catch (err) {
      const e = err as Error & { code?: string };
      expect(e.code).toBe("ACTOR_CONTEXT_MISSING");
      expect(e.message).toBe("ActorContext is required for this operation");
    }
  });

  it("getActorContextOrThrow returns ctx inside a frame", async () => {
    await withActorContext(ctx, async () => {
      expect(getActorContextOrThrow()).toBe(ctx);
    });
  });

  it("propagates across await boundaries", async () => {
    await withActorContext(ctx, async () => {
      await new Promise((r) => setTimeout(r, 0));
      expect(getActorContext()?.principalId).toBe("u-1");
    });
  });

  it("nested withActorContext overrides for inner call only", async () => {
    await withActorContext(ctx, async () => {
      expect(getActorContext()?.principalId).toBe("u-1");
      await withActorContext(innerCtx, async () => {
        expect(getActorContext()?.principalId).toBe("u-2");
      });
      expect(getActorContext()?.principalId).toBe("u-1");
    });
    expect(getActorContext()).toBeUndefined();
  });

  it("exports actorContextStorage as AsyncLocalStorage", () => {
    expect(typeof actorContextStorage.getStore).toBe("function");
    expect(typeof actorContextStorage.run).toBe("function");
  });
});
