// FAIL-CLOSED artifact claim-archival hook seam (cinatra#1454). Pins the
// globalThis-slot contract, contrasted against the best-effort dashboard/
// data-teardown seams:
//   - THROWS when no host hook is wired (a fail-closed error, not a silent skip
//     — there is no boot backstop that re-archives a missed archival);
//   - fires the wired hook with the full (package, scope, version, install,
//     actor) input;
//   - fires at PLATFORM scope too (organizationId null/undefined) — unlike the
//     dashboard seam, artifact type claims exist at platform scope;
//   - PROPAGATES a throwing hook (never swallows).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  setExtensionArtifactClaimArchivalHook,
  fireExtensionArtifactClaimArchival,
} from "../artifact-claim-lifecycle-hook";

afterEach(() => setExtensionArtifactClaimArchivalHook(null));

// Codex Q2: throw-on-unwired is only safe because the host wiring is CO-LOCATED
// with the artifact-handler registration (so a worker that can dispatch a
// `kind:"artifact"` archive always has the seam wired). Pin that invariant at the
// source level: the Server Action bootstrap (which registers the artifact handler)
// must side-effect-import the wiring, or the fail-closed fire would throw on a
// legitimate archive.
describe("fail-closed co-location invariant (Q2)", () => {
  it("handler-bootstrap side-effect-imports the artifact claim-archival wiring alongside the artifact handler", () => {
    const src = readFileSync(join(__dirname, "..", "handler-bootstrap.ts"), "utf8");
    expect(src).toMatch(/import\s+["']@\/lib\/objects\/extension-artifact-claim-archival-wiring["']/);
    expect(src).toMatch(/createArtifactExtensionHandler/);
  });
});

describe("artifact-claim-lifecycle-hook — fail-closed wiring seam", () => {
  it("THROWS when no host hook is wired (fail-closed: cannot archive → reports, never silently drops)", async () => {
    await expect(
      fireExtensionArtifactClaimArchival({
        packageName: "@v/pkg-artifact",
        organizationId: "org-1",
        extensionVersion: "1.0.0",
      }),
    ).rejects.toThrow(/not wired/i);
  });

  it("fires the wired hook with the full (package, scope, version, install, actor) input", async () => {
    const calls: unknown[] = [];
    setExtensionArtifactClaimArchivalHook((input) => {
      calls.push(input);
    });
    await fireExtensionArtifactClaimArchival({
      packageName: "@v/pkg-artifact",
      organizationId: "org-42",
      extensionVersion: "2.1.0",
      installId: "iext_1",
      actorPrincipalId: "user-7",
    });
    expect(calls).toEqual([
      {
        packageName: "@v/pkg-artifact",
        organizationId: "org-42",
        extensionVersion: "2.1.0",
        installId: "iext_1",
        actorPrincipalId: "user-7",
      },
    ]);
  });

  it("FIRES at platform scope too (organizationId null/undefined) — artifact claims exist at platform scope", async () => {
    const hook = vi.fn();
    setExtensionArtifactClaimArchivalHook(hook);
    await fireExtensionArtifactClaimArchival({
      packageName: "@v/pkg-artifact",
      organizationId: null,
      extensionVersion: "1.0.0",
    });
    await fireExtensionArtifactClaimArchival({
      packageName: "@v/pkg-artifact",
      organizationId: undefined,
      extensionVersion: "1.0.0",
    });
    expect(hook).toHaveBeenCalledTimes(2);
    expect(hook).toHaveBeenNthCalledWith(1, expect.objectContaining({ organizationId: null }));
    expect(hook).toHaveBeenNthCalledWith(2, expect.objectContaining({ organizationId: undefined }));
  });

  it("PROPAGATES a throwing hook (fail-closed — never swallowed, unlike the dashboard seam)", async () => {
    setExtensionArtifactClaimArchivalHook(() => {
      throw new Error("claim store write failed");
    });
    await expect(
      fireExtensionArtifactClaimArchival({
        packageName: "@v/pkg-artifact",
        organizationId: "org-1",
        extensionVersion: "1.0.0",
      }),
    ).rejects.toThrow("claim store write failed");
  });

  it("awaits an async hook and propagates its rejection", async () => {
    setExtensionArtifactClaimArchivalHook(async () => {
      throw new Error("async archival failure");
    });
    await expect(
      fireExtensionArtifactClaimArchival({
        packageName: "@v/pkg-artifact",
        organizationId: "org-1",
        extensionVersion: "1.0.0",
      }),
    ).rejects.toThrow("async archival failure");
  });
});
