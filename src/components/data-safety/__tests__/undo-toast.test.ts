// showUndoToast + undoDeepLink coverage.
// The toast is imperative (sonner via cinatra-toast)
// so we mock the wrapper and assert the calls. UndoToast (the declarative
// component) wraps showUndoToast in an effect; its source is pinned separately.

import { describe, expect, it, vi, beforeEach } from "vitest";

const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}));
const eligibilityMock = vi.hoisted(() => ({ canRestoreChangeSetAction: vi.fn() }));

vi.mock("@/lib/cinatra-toast", () => ({ toast: toastMock }));
// §VI: the toast's Undo affordance is server-side eligibility-gated.
vi.mock("@/components/data-safety/restore-change-set-action", () => ({
  canRestoreChangeSetAction: eligibilityMock.canRestoreChangeSetAction,
}));

import { showUndoToast, undoDeepLink } from "../undo-toast";

// showUndoToast is fire-and-forget; the eligibility check makes the success
// path async. Flush the microtask + task queues so the toast (or its
// suppression) has settled before asserting.
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("undoDeepLink", () => {
  it("lands on the consolidated undo surface AND carries the change-set id so that row's restore modal auto-opens (the per-change-set route was retired in cinatra#1431 §VII)", () => {
    expect(undoDeepLink("cs_9")).toBe("/artifacts?mode=undo&openRestore=cs_9");
  });

  it("url-encodes the change-set id", () => {
    expect(undoDeepLink("cs/9 a")).toBe("/artifacts?mode=undo&openRestore=cs%2F9%20a");
  });
});

describe("showUndoToast", () => {
  beforeEach(() => {
    toastMock.success.mockReset();
    toastMock.error.mockReset();
    eligibilityMock.canRestoreChangeSetAction.mockReset();
    // Default: eligible — suppression cases pin { eligible: false } explicitly.
    eligibilityMock.canRestoreChangeSetAction.mockResolvedValue({ eligible: true });
  });

  it("on ok+changeSetId AND eligible fires a success toast with an Undo action", async () => {
    const onUndo = vi.fn();
    showUndoToast(
      { ok: true, changeSetId: "cs_1", objectId: "obj_1" },
      { title: "Restored to version 2", onUndo },
    );
    await flush();
    expect(eligibilityMock.canRestoreChangeSetAction).toHaveBeenCalledWith({
      changeSetId: "cs_1",
    });
    expect(toastMock.success).toHaveBeenCalledTimes(1);
    const [title, opts] = toastMock.success.mock.calls[0];
    expect(title).toBe("Restored to version 2");
    expect(opts.action.label).toBe("Undo");
    // Clicking Undo invokes the callback with the change-set id.
    opts.action.onClick();
    expect(onUndo).toHaveBeenCalledWith("cs_1");
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it("defaults the title to `Saved <objectLabel>` when no title given", async () => {
    showUndoToast({ ok: true, changeSetId: "cs_1" }, { objectLabel: "Acme" });
    await flush();
    expect(toastMock.success.mock.calls[0][0]).toBe("Saved Acme");
  });

  it("SUPPRESSES the toast (no Undo affordance) when the actor is INELIGIBLE (§VI, no admin bypass)", async () => {
    eligibilityMock.canRestoreChangeSetAction.mockResolvedValue({ eligible: false });
    showUndoToast({ ok: true, changeSetId: "cs_1" }, { objectLabel: "Acme" });
    await flush();
    expect(toastMock.success).not.toHaveBeenCalled();
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it("fails closed (no toast) when the eligibility check throws", async () => {
    eligibilityMock.canRestoreChangeSetAction.mockRejectedValue(new Error("boom"));
    showUndoToast({ ok: true, changeSetId: "cs_1" });
    await flush();
    expect(toastMock.success).not.toHaveBeenCalled();
  });

  it("on ok WITHOUT a changeSetId fires NO toast and never checks eligibility", async () => {
    showUndoToast({ ok: true });
    await flush();
    expect(toastMock.success).not.toHaveBeenCalled();
    expect(toastMock.error).not.toHaveBeenCalled();
    expect(eligibilityMock.canRestoreChangeSetAction).not.toHaveBeenCalled();
  });

  it("on failure fires an error toast synchronously, no eligibility check", async () => {
    showUndoToast({ ok: false, error: "boom" });
    expect(toastMock.error).toHaveBeenCalledWith("boom");
    expect(toastMock.success).not.toHaveBeenCalled();
    expect(eligibilityMock.canRestoreChangeSetAction).not.toHaveBeenCalled();
  });
});
