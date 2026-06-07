// showUndoToast + undoDeepLink coverage.
// The toast is imperative (sonner via cinatra-toast)
// so we mock the wrapper and assert the calls. UndoToast (the declarative
// component) wraps showUndoToast in an effect; its source is pinned separately.

import { describe, expect, it, vi, beforeEach } from "vitest";

const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@/lib/cinatra-toast", () => ({ toast: toastMock }));

import { showUndoToast, undoDeepLink } from "../undo-toast";

describe("undoDeepLink", () => {
  it("builds the change-set restore deep-link", () => {
    expect(undoDeepLink("cs_9")).toBe(
      "/data-safety/change-sets/cs_9?openRestore=1",
    );
  });
});

describe("showUndoToast", () => {
  beforeEach(() => {
    toastMock.success.mockReset();
    toastMock.error.mockReset();
  });

  it("on ok+changeSetId fires a success toast with an Undo action", () => {
    const onUndo = vi.fn();
    showUndoToast(
      { ok: true, changeSetId: "cs_1", objectId: "obj_1" },
      { title: "Restored to version 2", onUndo },
    );
    expect(toastMock.success).toHaveBeenCalledTimes(1);
    const [title, opts] = toastMock.success.mock.calls[0];
    expect(title).toBe("Restored to version 2");
    expect(opts.action.label).toBe("Undo");
    // Clicking Undo invokes the callback with the change-set id.
    opts.action.onClick();
    expect(onUndo).toHaveBeenCalledWith("cs_1");
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it("defaults the title to `Saved <objectLabel>` when no title given", () => {
    showUndoToast({ ok: true, changeSetId: "cs_1" }, { objectLabel: "Acme" });
    expect(toastMock.success.mock.calls[0][0]).toBe("Saved Acme");
  });

  it("on ok WITHOUT a changeSetId fires NO toast (nothing to undo)", () => {
    showUndoToast({ ok: true });
    expect(toastMock.success).not.toHaveBeenCalled();
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it("on failure fires an error toast with the error message", () => {
    showUndoToast({ ok: false, error: "boom" });
    expect(toastMock.error).toHaveBeenCalledWith("boom");
    expect(toastMock.success).not.toHaveBeenCalled();
  });
});
