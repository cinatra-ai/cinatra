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
