/**
 * THE RUN SCREEN ACTUALLY MOUNTS THE RETURN WATCHER (cinatra#3369, acceptance
 * item 2) — a STATIC invariant over `instance-screens.tsx`.
 *
 * WHY STATIC, AND WHY THIS FILE EXISTS. The watcher's own suite mounts the
 * watcher directly, and the route suite stops at the draft redirect. Between
 * the two, the one line that connects them — the JSX in `SetupScreen` that
 * mounts the watcher for a run whose address carries `?onComplete=list-picker`
 * — was pinned by nothing: deleting it left every other suite green while the
 * return silently stopped happening, which is exactly the shape of the defect
 * a proof round measured. `SetupScreen` is an async server component with the
 * whole run page behind it, so the gate a suite CAN hold is the boundary
 * itself, in the manner of `instance-screens-client-boundary.test.ts`.
 *
 * Run:
 *   npx vitest run --config vitest.config.ts --no-coverage \
 *     packages/agents/src/__tests__/list-picker-return-mount.test.ts
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SCREENS = readFileSync(
  join(__dirname, "..", "instance-screens.tsx"),
  "utf8",
);

describe("instance-screens.tsx — the return contract's two ends (cinatra#3369)", () => {
  it("mounts the return watcher on the run page", () => {
    expect(SCREENS).toContain("<ListPickerReturnWatcher");
    expect(SCREENS).toContain(
      'import { ListPickerReturnWatcher } from "./list-picker-return-watcher";',
    );
  });

  it("mounts it ONLY for a run whose address carries the destination", () => {
    const mount = SCREENS.slice(SCREENS.indexOf("<ListPickerReturnWatcher") - 400);
    const guard = mount.slice(0, mount.indexOf("<ListPickerReturnWatcher"));
    expect(guard).toContain("readOnCompleteDestination(searchParams)");
    expect(guard).toContain("LIST_PICKER_ON_COMPLETE");
  });

  it("hands the watcher the run it is drawing and that run's status", () => {
    const mount = SCREENS.slice(SCREENS.indexOf("<ListPickerReturnWatcher"));
    const tag = mount.slice(0, mount.indexOf("/>") + 2);
    expect(tag).toContain("runId={run.id}");
    expect(tag).toContain("initialStatus={run.status}");
  });

  it("carries the destination through the draft redirect", () => {
    expect(SCREENS).toContain("withOnCompleteDestination(");
    const call = SCREENS.slice(SCREENS.indexOf("withOnCompleteDestination("));
    expect(call.slice(0, 300)).toContain("buildAgentInstancePath(");
  });
});
