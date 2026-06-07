/**
 * workflow-launcher placeholder-values derivation. Locks the invalidation
 * contract: non-dirty fields TRACK upstream inputs (so a late-arriving
 * projects-pane.selectedId seeds projectId automatically); dirty fields keep
 * their overlay (picker state wins on launch); upstream clears invalidate
 * non-dirty values (no stale launch).
 */
import { describe, it, expect } from "vitest";
import { computeLauncherValues } from "../launcher-values";

const KEYS = ["projectId", "postId", "wordpressInstanceId"] as const;
const empty: ReadonlySet<string> = new Set();

describe("computeLauncherValues", () => {
  it("late-arriving upstream selection seeds non-dirty values", async () => {
    // Template loaded first (inputs empty); upstream selections come later.
    const empty1 = computeLauncherValues(KEYS, {}, empty, {});
    expect(empty1).toEqual({ projectId: "", postId: "", wordpressInstanceId: "" });
    const after = computeLauncherValues(KEYS, { projectId: "P1", postId: "PO1" }, empty, {});
    expect(after).toEqual({ projectId: "P1", postId: "PO1", wordpressInstanceId: "" });
  });

  it("operator picker overrides win on launch (dirty fields keep the overlay)", async () => {
    const dirty: ReadonlySet<string> = new Set(["wordpressInstanceId"]);
    const out = computeLauncherValues(KEYS, { projectId: "P1", postId: "PO1" }, dirty, { wordpressInstanceId: "wp-X" });
    expect(out).toEqual({ projectId: "P1", postId: "PO1", wordpressInstanceId: "wp-X" });
  });

  it("clearing upstream selection INVALIDATES non-dirty values (no stale launch)", async () => {
    const selectedA = computeLauncherValues(KEYS, { projectId: "P-A", postId: "PO-A" }, empty, {});
    expect(selectedA).toEqual({ projectId: "P-A", postId: "PO-A", wordpressInstanceId: "" });
    // Upstream clears (projects-pane selection invalidated); non-dirty values drop.
    const cleared = computeLauncherValues(KEYS, {}, empty, {});
    expect(cleared).toEqual({ projectId: "", postId: "", wordpressInstanceId: "" });
  });

  it("upstream CHANGES non-dirty values; dirty fields are untouched by the change", async () => {
    const dirty: ReadonlySet<string> = new Set(["wordpressInstanceId"]);
    const initial = computeLauncherValues(KEYS, { projectId: "P-A", postId: "PO-A" }, dirty, { wordpressInstanceId: "wp-1" });
    expect(initial).toEqual({ projectId: "P-A", postId: "PO-A", wordpressInstanceId: "wp-1" });
    // Selection switches to project B
    const switched = computeLauncherValues(KEYS, { projectId: "P-B", postId: "PO-B" }, dirty, { wordpressInstanceId: "wp-1" });
    expect(switched).toEqual({ projectId: "P-B", postId: "PO-B", wordpressInstanceId: "wp-1" });
  });

  it("non-string upstream inputs (numbers, undefined, null) collapse to empty string when not dirty", async () => {
    const out = computeLauncherValues(
      KEYS,
      { projectId: 123 as unknown as string, postId: null as unknown as string },
      empty,
      {},
    );
    expect(out).toEqual({ projectId: "", postId: "", wordpressInstanceId: "" });
  });
});
