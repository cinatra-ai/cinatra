/**
 * cinatra#2202 — CI-ENFORCED structural pin for the in-process A2A actor seam.
 *
 * Why source-text and not behavior: the behavioral pins for the seam itself live
 * in `packages/a2a` (`in-process-dispatch-actor-guard.test.ts` +
 * `in-process-dispatch-actor-composed.test.ts`), and that package's vitest suite
 * has NO CI runner today — it is absent from the root `vitest.config.ts` include
 * set and from every workflow (a pre-existing coverage gap, disclosed on the PR,
 * NOT introduced here). `packages/agents` IS run in CI
 * (`cd packages/agents && pnpm test` in build-image.yml's required `test` job),
 * so this file gives the fail-closed invariant real teeth: a refactor that
 * deletes the actor frame or the seam guard turns CI red rather than silently
 * restoring the #2202 authority hole.
 *
 * Same technique + rationale as the sibling `a2a-actions.test.ts` external-branch
 * markers and the `child-dispatch-obo-ceiling-structural.test.ts` argument-text
 * scanner: assert the load-bearing tokens exist, in the right ORDER, at the call
 * site that owns the invariant.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";

const AGENTS_SRC = path.resolve(__dirname, "..");
const A2A_SRC = path.resolve(__dirname, "..", "..", "..", "a2a", "src");

function read(file: string): string {
  return readFileSync(file, "utf8");
}

describe("cinatra#2202 — the internal branch's ActorContext frame is structurally pinned", () => {
  const source = read(path.join(AGENTS_SRC, "a2a-actions.ts"));

  it("imports the SAME actor-context primitive the external A2A surface uses", () => {
    // One ALS carrier for both A2A surfaces — never a parallel invention. The
    // external surface wraps `mount.handle` in this exact function
    // (src/app/api/a2a/route.ts).
    expect(source).toMatch(
      /import\s*\{\s*withActorContext\s*\}\s*from\s*"@cinatra-ai\/llm\/actor-context"/,
    );
  });

  it("resolves the caller's ActorContext through the canonical session-lineage resolver", () => {
    // `@/lib/auth-session`'s getActorContext — the resolver that carries orgRole
    // + teamIds/teamRoles + projectGrants. NOT a hand-built literal: a
    // locally-constructed actor would skip the resolved authorization axes and
    // reintroduce the role-less-actor class from a different direction.
    expect(source).toMatch(
      /getActorContext as resolveSessionActorContext[\s\S]*?from "@\/lib\/auth-session"/,
    );
    expect(source).toContain("await resolveSessionActorContext()");
  });

  it("dispatches in-process INSIDE the frame — the wrap encloses the sendMessage call", () => {
    const wrapAt = source.indexOf("withActorContext(actorContext");
    const clientAt = source.indexOf("createInProcessA2AClient({");
    const sendAt = source.indexOf("client.sendMessage(");
    expect(wrapAt).toBeGreaterThan(-1);
    expect(clientAt).toBeGreaterThan(-1);
    expect(sendAt).toBeGreaterThan(-1);
    // Both the client construction and the dispatch sit AFTER the wrap opens —
    // the executor's own template reads are covered too, matching the external
    // surface's scope exactly.
    expect(wrapAt).toBeLessThan(clientAt);
    expect(clientAt).toBeLessThan(sendAt);
  });

  it("is the ONLY in-process dispatch in this module, so the wrap cannot be bypassed", () => {
    // If a second dispatch site ever appears it must be re-audited for its own
    // frame; this count makes that decision explicit rather than implicit.
    const dispatches = source.match(/client\.sendMessage\(/g) ?? [];
    expect(dispatches).toHaveLength(1);
  });

  it("FAILS LOUD on a missing / incoherent actor — refusing before any dispatch", () => {
    // Roleless-actor doctrine: refuse, never continue with a synthesized or
    // anonymous principal. Each refusal must precede the dispatch wrap.
    const wrapAt = source.indexOf("withActorContext(actorContext");
    for (const marker of [
      "if (!actorContext)",
      'actorContext.principalType !== "HumanUser"',
      "actorContext.principalId !== session.user.id",
      "actorContext.organizationId !== orgId",
      "if (!runAuthority)",
    ]) {
      const at = source.indexOf(marker);
      expect(at, `missing fail-closed guard: ${marker}`).toBeGreaterThan(-1);
      expect(at, `guard must precede the dispatch: ${marker}`).toBeLessThan(wrapAt);
    }
  });

  it("never degrades a missing actor to a system / anonymous principal", () => {
    // The silent-authz-drop class: the fix must not "helpfully" invent an actor.
    // No mint of a non-human dispatch authority, and no principal literal, on
    // this branch.
    expect(source).not.toContain("mintExternalA2ADispatchAuthority");
    expect(source).not.toMatch(/principalType:\s*"(System|InternalWorker|ServiceAccount)"/);
  });
});

describe("cinatra#2202 — the packages/a2a seam guard is structurally pinned", () => {
  // The precondition lives IN client.ts (the dispatch entry point). A module of
  // its own would add a first-party node to every route reaching the
  // @cinatra-ai/a2a barrel and trip the shrink-only route-graph ratchet.
  const client = read(path.join(A2A_SRC, "client.ts"));

  /** The `requireInProcessDispatchActor` body alone, so the "never fabricates a
   *  principal" assertions cannot be satisfied — or broken — by unrelated code
   *  elsewhere in client.ts. */
  const guardBody = (() => {
    const from = client.indexOf("export function requireInProcessDispatchActor(");
    expect(from, "requireInProcessDispatchActor must exist in client.ts").toBeGreaterThan(-1);
    const end = client.indexOf("\n}", from);
    expect(end).toBeGreaterThan(from);
    return client.slice(from, end + 2);
  })();

  it("createInProcessA2AClient.sendMessage asserts the actor BEFORE dispatching", () => {
    const sendAt = client.indexOf("async sendMessage(");
    const guardAt = client.indexOf("requireInProcessDispatchActor(packageName)");
    const transportAt = client.indexOf("transport.sendMessage(");
    expect(sendAt).toBeGreaterThan(-1);
    expect(guardAt).toBeGreaterThan(sendAt);
    expect(guardAt).toBeLessThan(transportAt);
  });

  it("the guard THROWS rather than returning a fabricated principal", () => {
    expect(client).toMatch(/class InProcessA2AActorMissingError extends Error/);
    // Both refusal reasons throw; the ONLY return is the ambient actor itself —
    // never a synthesized/defaulted principal object.
    expect(
      guardBody.match(/throw new InProcessA2AActorMissingError\(/g) ?? [],
    ).toHaveLength(2);
    expect(guardBody.match(/\breturn\b/g) ?? []).toHaveLength(1);
    expect(guardBody).toContain("return actor;");
    expect(guardBody).not.toMatch(/return\s*\{/);
    expect(guardBody).not.toMatch(/\?\?/);
  });

  it("the guard refuses BOTH a missing frame and a frame with no organization", () => {
    expect(guardBody).toContain("if (!actor)");
    expect(guardBody).toContain("if (!actor.organizationId)");
    // The ambient frame is read through the SAME ALS accessor the executor uses.
    expect(client).toMatch(
      /import\s*\{\s*getActorContext\s*\}\s*from\s*"@cinatra-ai\/llm\/actor-context"/,
    );
    expect(guardBody).toContain("getActorContext()");
  });
});
