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
  it("deep-links to the single change set's targeted-restore route nested under the Artifacts console (cinatra#1786)", () => {
    expect(undoDeepLink("cs_9")).toBe("/configuration/artifacts/restore/cs_9");
  });

  it("url-encodes the change-set id", () => {
    expect(undoDeepLink("cs/9 a")).toBe("/configuration/artifacts/restore/cs%2F9%20a");
  });
});

describe("showUndoToast", () => {
  beforeEach(() => {
    toastMock.success.mockReset();
    toastMock.error.mockReset();
    eligibilityMock.canRestoreChangeSetAction.mockReset();
    // Default: an ELIGIBLE ADMIN — the only shape that still earns an Undo
    // action after cinatra#2701 (epic #2699 S2). The non-admin and
    // ineligible-admin cases pin their own shapes explicitly.
    eligibilityMock.canRestoreChangeSetAction.mockResolvedValue({
      eligible: true,
      admin: true,
    });
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

  it("SUPPRESSES the toast (no Undo affordance) when an ADMIN actor is INELIGIBLE (§VI, no admin bypass)", async () => {
    eligibilityMock.canRestoreChangeSetAction.mockResolvedValue({
      eligible: false,
      admin: true,
    });
    showUndoToast({ ok: true, changeSetId: "cs_1" }, { objectLabel: "Acme" });
    await flush();
    expect(toastMock.success).not.toHaveBeenCalled();
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  // ── cinatra#2701 (epic #2699 S2) — aligned affordance ────────────────────
  // The Undo action deep-links into `/configuration/artifacts/...`, which is
  // admin-only. A non-admin is offered NO link, but the save still reports
  // itself: the toast INFORMS without a link.

  it("a NON-ADMIN gets an informing toast with NO Undo action (no link into /configuration)", async () => {
    const onUndo = vi.fn();
    eligibilityMock.canRestoreChangeSetAction.mockResolvedValue({
      eligible: false,
      admin: false,
    });
    showUndoToast({ ok: true, changeSetId: "cs_1" }, { objectLabel: "Acme", onUndo });
    await flush();
    expect(toastMock.success).toHaveBeenCalledTimes(1);
    const [title, opts] = toastMock.success.mock.calls[0];
    expect(title).toBe("Saved Acme");
    // No second argument at all — no `action`, so no control to click.
    expect(opts).toBeUndefined();
    expect(onUndo).not.toHaveBeenCalled();
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it("the non-admin toast never carries a /configuration href in any argument", async () => {
    eligibilityMock.canRestoreChangeSetAction.mockResolvedValue({
      eligible: false,
      admin: false,
    });
    showUndoToast({ ok: true, changeSetId: "cs_1" }, { title: "Saved" });
    await flush();
    expect(JSON.stringify(toastMock.success.mock.calls)).not.toContain("/configuration");
  });

  it("fails closed on a throwing check — the toast informs, and carries no Undo link", async () => {
    eligibilityMock.canRestoreChangeSetAction.mockRejectedValue(new Error("boom"));
    showUndoToast({ ok: true, changeSetId: "cs_1" });
    await flush();
    // `admin` cannot be established, so the closed answer is the linkless
    // toast — never an Undo action.
    expect(toastMock.success).toHaveBeenCalledTimes(1);
    expect(toastMock.success.mock.calls[0][1]).toBeUndefined();
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
