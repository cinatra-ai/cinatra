import { describe, it, expect, vi } from "vitest";
import { dispatchExtensionUiAction, type DispatchExtensionUiActionDeps } from "@/lib/extension-action-dispatch";
import type { ExtensionUiAction } from "@/lib/extension-ui-registry";

function makeAction(handler: (input: unknown) => Promise<unknown>): ExtensionUiAction {
  return { packageName: "@cinatra-ai/demo", id: "do-thing", handler };
}

const ACTOR = { principalId: "u-1" };
const LIVE = { packageName: "@cinatra-ai/demo", status: "active" };

function deps(over: Partial<DispatchExtensionUiActionDeps> = {}): DispatchExtensionUiActionDeps {
  return {
    resolveInstall: vi.fn().mockResolvedValue(LIVE),
    authorize: vi.fn().mockResolvedValue(true),
    resolveAction: vi.fn().mockReturnValue(makeAction(async (i) => ({ echoed: i }))),
    ...over,
  };
}

describe("dispatchExtensionUiAction", () => {
  it("401 when no actor (short-circuits before any resolution)", async () => {
    const d = deps();
    const r = await dispatchExtensionUiAction({ installId: "i", actionId: "do-thing", input: {}, actor: null }, d);
    expect(r.status).toBe(401);
    expect(d.resolveInstall).not.toHaveBeenCalled();
  });

  it("404 when the install id maps to no row", async () => {
    const d = deps({ resolveInstall: vi.fn().mockResolvedValue(null) });
    const r = await dispatchExtensionUiAction({ installId: "missing", actionId: "do-thing", input: {}, actor: ACTOR }, d);
    expect(r.status).toBe(404);
    expect(d.authorize).not.toHaveBeenCalled();
  });

  it("404 when the install is not live (archived) — never invocable", async () => {
    const d = deps({ resolveInstall: vi.fn().mockResolvedValue({ packageName: "@cinatra-ai/demo", status: "archived" }) });
    const r = await dispatchExtensionUiAction({ installId: "i", actionId: "do-thing", input: {}, actor: ACTOR }, d);
    expect(r.status).toBe(404);
    expect(d.authorize).not.toHaveBeenCalled();
  });

  it("404 (not 403) when the actor is unauthorized — existence not leaked", async () => {
    const d = deps({ authorize: vi.fn().mockResolvedValue(false) });
    const r = await dispatchExtensionUiAction({ installId: "i", actionId: "do-thing", input: {}, actor: ACTOR }, d);
    expect(r.status).toBe(404);
    expect(d.resolveAction).not.toHaveBeenCalled();
  });

  it("404 when no action is registered for the package", async () => {
    const d = deps({ resolveAction: vi.fn().mockReturnValue(null) });
    const r = await dispatchExtensionUiAction({ installId: "i", actionId: "nope", input: {}, actor: ACTOR }, d);
    expect(r.status).toBe(404);
    expect(d.resolveAction).toHaveBeenCalledWith("@cinatra-ai/demo", "nope");
  });

  it("200 + handler result on success (authorized + live)", async () => {
    const handler = vi.fn().mockResolvedValue({ ok: true });
    const d = deps({ resolveAction: vi.fn().mockReturnValue(makeAction(handler)) });
    const r = await dispatchExtensionUiAction({ installId: "i", actionId: "do-thing", input: { m: 1 }, actor: ACTOR }, d);
    expect(handler).toHaveBeenCalledWith({ m: 1 });
    expect(r).toEqual({ status: 200, result: { ok: true } });
  });

  it("DEFAULT path preserves the handler's `this` receiver (non-arrow method call, not detached)", async () => {
    // A normal-function handler reads `this` — the pre-S9 dispatch called
    // `action.handler(input)` (receiver = the action object). A detached call
    // (`const h = action.handler; h(input)`) would set `this === undefined` and
    // change behavior (the public handler type lacks `this: void`). This pins
    // the method-call invocation (codex S9 round-2).
    const action = {
      packageName: "@cinatra-ai/demo",
      id: "do-thing",
      handler: async function (this: unknown, input: unknown) {
        return { receiverId: (this as { id?: string } | undefined)?.id, input };
      },
    } as unknown as ExtensionUiAction;
    const d = deps({ resolveAction: vi.fn().mockReturnValue(action) });
    const r = await dispatchExtensionUiAction(
      { installId: "i", actionId: "do-thing", input: { m: 1 }, actor: ACTOR },
      d,
    );
    // this === the action object → this.id === "do-thing" (would be undefined if detached).
    expect(r).toEqual({ status: 200, result: { receiverId: "do-thing", input: { m: 1 } } });
  });

  it("500 with message when the handler throws", async () => {
    const d = deps({ resolveAction: vi.fn().mockReturnValue(makeAction(async () => { throw new Error("boom"); })) });
    const r = await dispatchExtensionUiAction({ installId: "i", actionId: "do-thing", input: {}, actor: ACTOR }, d);
    expect(r.status).toBe(500);
    expect(r.error).toBe("boom");
  });

  it("500 generic message for a non-Error throw", async () => {
    const d = deps({ resolveAction: vi.fn().mockReturnValue(makeAction(async () => { throw "x"; })) });
    const r = await dispatchExtensionUiAction({ installId: "i", actionId: "do-thing", input: {}, actor: ACTOR }, d);
    expect(r.status).toBe(500);
    expect(r.error).toBe("Action handler failed.");
  });
});

// cinatra#1392 S9 — ui-surface serve: a NON-DEFAULT addressed install is served
// ITS version's retained ui action, fail-closed (never the default's action).
describe("dispatchExtensionUiAction — non-default version-keyed serve (S9)", () => {
  const NONDEFAULT = { packageName: "@cinatra-ai/demo", status: "active", isDefault: false, version: "0.1.4" };

  it("serves the VERSION-KEYED action for a non-default install (never the default's)", async () => {
    const versioned = vi.fn().mockResolvedValue({ served: "0.1.4" });
    const globalResolve = vi.fn(); // must NOT be consulted for a non-default install
    const d = deps({
      resolveInstall: vi.fn().mockResolvedValue(NONDEFAULT),
      resolveAction: globalResolve,
      resolveVersionedAction: vi.fn().mockReturnValue({ kind: "serve", handler: versioned }),
    });
    const r = await dispatchExtensionUiAction({ installId: "i", actionId: "do-thing", input: { m: 1 }, actor: ACTOR }, d);
    expect(r).toEqual({ status: 200, result: { served: "0.1.4" } });
    expect(d.resolveVersionedAction).toHaveBeenCalledWith("@cinatra-ai/demo", "0.1.4", "do-thing");
    expect(versioned).toHaveBeenCalledWith({ m: 1 });
    expect(globalResolve).not.toHaveBeenCalled(); // fail-closed: no default fall-through
  });

  it("404 when the pinned version registered no such action (NO_SUCH_HANDLER) — never the default", async () => {
    const globalResolve = vi.fn().mockReturnValue(makeAction(async () => ({ leaked: true })));
    const d = deps({
      resolveInstall: vi.fn().mockResolvedValue(NONDEFAULT),
      resolveAction: globalResolve,
      resolveVersionedAction: vi.fn().mockReturnValue({ kind: "refuse", code: "NO_SUCH_HANDLER", message: "no action" }),
    });
    const r = await dispatchExtensionUiAction({ installId: "i", actionId: "do-thing", input: {}, actor: ACTOR }, d);
    expect(r.status).toBe(404);
    expect(globalResolve).not.toHaveBeenCalled();
  });

  it("500 on torn retention (NOT_SERVABLE / UNKNOWN_VERSION) — refuses, never default-serves", async () => {
    for (const code of ["NOT_SERVABLE", "UNKNOWN_VERSION", "UNPINNED"]) {
      const globalResolve = vi.fn().mockReturnValue(makeAction(async () => ({ leaked: true })));
      const d = deps({
        resolveInstall: vi.fn().mockResolvedValue(NONDEFAULT),
        resolveAction: globalResolve,
        resolveVersionedAction: vi.fn().mockReturnValue({ kind: "refuse", code, message: `torn:${code}` }),
      });
      const r = await dispatchExtensionUiAction({ installId: "i", actionId: "do-thing", input: {}, actor: ACTOR }, d);
      expect(r.status).toBe(500);
      expect(r.error).toContain(code === "UNPINNED" ? "torn:UNPINNED" : `torn:${code}`);
      expect(globalResolve).not.toHaveBeenCalled();
    }
  });

  it("500 when a non-default install is addressed but no version-keyed resolver is wired (fail-closed)", async () => {
    const globalResolve = vi.fn().mockReturnValue(makeAction(async () => ({ leaked: true })));
    const d = deps({
      resolveInstall: vi.fn().mockResolvedValue(NONDEFAULT),
      resolveAction: globalResolve,
      resolveVersionedAction: undefined,
    });
    const r = await dispatchExtensionUiAction({ installId: "i", actionId: "do-thing", input: {}, actor: ACTOR }, d);
    expect(r.status).toBe(500);
    expect(r.error).toContain("no version-keyed action resolver is wired");
    expect(globalResolve).not.toHaveBeenCalled();
  });

  it("500 when the served version-keyed handler throws", async () => {
    const d = deps({
      resolveInstall: vi.fn().mockResolvedValue(NONDEFAULT),
      resolveVersionedAction: vi.fn().mockReturnValue({
        kind: "serve",
        handler: async () => { throw new Error("versioned boom"); },
      }),
    });
    const r = await dispatchExtensionUiAction({ installId: "i", actionId: "do-thing", input: {}, actor: ACTOR }, d);
    expect(r.status).toBe(500);
    expect(r.error).toBe("versioned boom");
  });

  it("a DEFAULT install (isDefault omitted or true) keeps the global registry path — byte-identical", async () => {
    const versioned = vi.fn();
    const d = deps({
      resolveInstall: vi.fn().mockResolvedValue({ packageName: "@cinatra-ai/demo", status: "active", isDefault: true, version: "1.0.0" }),
      resolveAction: vi.fn().mockReturnValue(makeAction(async () => ({ fromGlobal: true }))),
      resolveVersionedAction: vi.fn().mockReturnValue({ kind: "serve", handler: versioned }),
    });
    const r = await dispatchExtensionUiAction({ installId: "i", actionId: "do-thing", input: {}, actor: ACTOR }, d);
    expect(r).toEqual({ status: 200, result: { fromGlobal: true } });
    expect(d.resolveAction).toHaveBeenCalled();
    expect(versioned).not.toHaveBeenCalled(); // default install never consults version-keyed
  });
});
