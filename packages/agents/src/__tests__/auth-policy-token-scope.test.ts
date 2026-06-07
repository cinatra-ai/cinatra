// Tests for tokenScopes intersection inside enforceRunAccess.
//
// Pattern mirrors auth-policy.test.ts Group D (line ~180+) — we use
// `vi.spyOn(authz, "can")` to control the kernel decision; the intersection
// check we are adding runs in-process AFTER can() returns allow.
//
// Behaviors covered:
//   - PrimitiveActorContext.tokenScopes flows through buildActorContextFromPrimitive
//   - undefined/empty/populated tokenScopes preserved on the built ActorContext
//   - enforceRunAccess intersects tokenScopes with the mapped Permission for op
//   - empty tokenScopes denies all (defensive)
//   - undefined tokenScopes skips the check (HumanUser/Worker/System unaffected)
//   - role-deny precedence — when can() returns false, the role-deny error
//     wins; the token-scope error fires only after can() returned allow
//   - AuthzError message contains "token scope" so callers can distinguish
//     token-scope-insufficient from generic role-deny

import { describe, it, expect, vi, beforeEach } from "vitest";

import * as authz from "@/lib/authz";

import {
  buildActorContextFromPrimitive,
  enforceRunAccess,
} from "../auth-policy";

import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";

// ---------------------------------------------------------------------------
// Bridge: tokenScopes flows through buildActorContextFromPrimitive
// ---------------------------------------------------------------------------

describe("buildActorContextFromPrimitive — tokenScopes forwarding", () => {
  it("forwards tokenScopes from PrimitiveActorContext onto ActorContext", () => {
    const actor: PrimitiveActorContext = {
      actorType: "model",
      userId: "svc-1",
      source: "mcp",
      tokenScopes: ["run.read"],
    };
    const ctx = buildActorContextFromPrimitive(actor);
    expect(ctx.tokenScopes).toEqual(["run.read"]);
  });

  it("leaves ActorContext.tokenScopes undefined when PrimitiveActorContext has no tokenScopes", () => {
    const actor: PrimitiveActorContext = {
      actorType: "human",
      userId: "u1",
      source: "ui",
    };
    const ctx = buildActorContextFromPrimitive(actor);
    expect(ctx.tokenScopes).toBeUndefined();
  });

  it("preserves an empty tokenScopes array (defensive — empty means 'no scopes granted')", () => {
    const actor: PrimitiveActorContext = {
      actorType: "model",
      userId: "svc-1",
      source: "mcp",
      tokenScopes: [],
    };
    const ctx = buildActorContextFromPrimitive(actor);
    expect(ctx.tokenScopes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// enforceRunAccess: tokenScopes intersection
// ---------------------------------------------------------------------------

describe("enforceRunAccess — tokenScopes intersection", () => {
  beforeEach(() => vi.restoreAllMocks());

  // Use a non-owner actor so the owner short-circuit (auth-policy.ts:432) does
  // not fire. We mock can() to true so the kernel role-grant check passes — we
  // are isolating the intersection check, which sits AFTER can().
  const baseRun = { id: "r1", runBy: "u1", orgId: "o1" };
  const modelActor = (tokenScopes?: string[]): PrimitiveActorContext => ({
    actorType: "model",
    userId: "svc-1",
    source: "mcp",
    ...(tokenScopes !== undefined ? { tokenScopes } : {}),
  });

  it("allows when tokenScopes contains the mapped Permission for op", async () => {
    vi.spyOn(authz, "can").mockReturnValue(true);
    await expect(
      enforceRunAccess(baseRun, modelActor(["run.read"]), "read"),
    ).resolves.toBeUndefined();
  });

  it("DENIES when tokenScopes lacks the mapped Permission, even if can() returns true", async () => {
    vi.spyOn(authz, "can").mockReturnValue(true);
    // op="execute" maps to Permission "run.resume" (per OPERATION_PERMISSION).
    // tokenScopes=["run.read"] does NOT include "run.resume" → deny.
    await expect(
      enforceRunAccess(baseRun, modelActor(["run.read"]), "execute"),
    ).rejects.toMatchObject({ statusCode: 403, reason: "forbidden" });
  });

  it("token-scope-insufficient AuthzError carries 'token scope' in the message (distinguishable from role-deny)", async () => {
    vi.spyOn(authz, "can").mockReturnValue(true);
    try {
      await enforceRunAccess(baseRun, modelActor(["run.read"]), "execute");
      throw new Error("expected throw");
    } catch (err) {
      expect((err as Error).message.toLowerCase()).toContain("token scope");
    }
  });

  it("DENIES when tokenScopes is empty array (defensive)", async () => {
    vi.spyOn(authz, "can").mockReturnValue(true);
    await expect(
      enforceRunAccess(baseRun, modelActor([]), "read"),
    ).rejects.toMatchObject({ statusCode: 403, reason: "forbidden" });
  });

  it("does NOT apply intersection when tokenScopes is undefined (HumanUser path unaffected)", async () => {
    vi.spyOn(authz, "can").mockReturnValue(true);
    // Non-owner human actor (userId "u2" vs runBy "u1") with no tokenScopes.
    // Owner short-circuit does NOT fire; can() mock returns true; intersection
    // is skipped because tokenScopes === undefined → resolve.
    await expect(
      enforceRunAccess(baseRun, { actorType: "human", userId: "u2", source: "ui" }, "read"),
    ).resolves.toBeUndefined();
  });

  it("allows when tokenScopes contains BOTH role-granted permissions for the op", async () => {
    vi.spyOn(authz, "can").mockReturnValue(true);
    // op="execute" → "run.resume". tokenScopes contains run.read AND run.resume → allow.
    await expect(
      enforceRunAccess(baseRun, modelActor(["run.read", "run.resume"]), "execute"),
    ).resolves.toBeUndefined();
  });

  it("intersection runs AFTER can() — when can() returns false, role-deny wins (existing 'Run access denied.' message)", async () => {
    vi.spyOn(authz, "can").mockReturnValue(false);
    // tokenScopes is permissive but role denies — caller should see role-deny error,
    // NOT token-scope error. Both throw 403 forbidden but the message differs.
    try {
      await enforceRunAccess(baseRun, modelActor(["run.resume"]), "execute");
      throw new Error("expected throw");
    } catch (err) {
      const msg = (err as Error).message.toLowerCase();
      expect(msg).not.toContain("token scope"); // role-deny ran first
    }
  });
});
