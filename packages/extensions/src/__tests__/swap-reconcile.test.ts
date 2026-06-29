import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  isConcreteSwapVersion,
  planCanonicalVersionFlip,
  reconcileCanonicalVersionAfterNativeSwap,
  setSwapGenerationBumpHook,
} from "../swap-reconcile";
import type { ExtensionSource, InstalledExtension } from "../canonical-types";

// The lifecycle primitive is the only sanctioned provenance writer; mock its
// sourceSwitchExtension so the reconcile is unit-testable without a DB.
const sourceSwitchSpy = vi.fn();
vi.mock("../lifecycle-primitive", () => ({
  sourceSwitchExtension: (...args: unknown[]) => sourceSwitchSpy(...args),
}));

function verdaccioSource(version: string): ExtensionSource {
  return {
    type: "verdaccio",
    registryUrl: "http://localhost:4873",
    packageName: "@acme/foo-agent",
    version,
    integrity: "dispatcher-install",
  } as ExtensionSource;
}

function row(source: ExtensionSource, overrides: Partial<InstalledExtension> = {}): InstalledExtension {
  return {
    id: "iext_abc123",
    packageName: "@acme/foo-agent",
    ownerLevel: "platform",
    ownerId: null,
    organizationId: null,
    kind: "agent",
    status: "active",
    source,
    requiredInProd: false,
    dependencies: [],
    manifestHash: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as InstalledExtension;
}

describe("isConcreteSwapVersion", () => {
  it("accepts a real semver", () => {
    expect(isConcreteSwapVersion("1.2.3")).toBe(true);
    expect(isConcreteSwapVersion("0.1.5")).toBe(true);
  });
  it("rejects moving tags / placeholders / empty / 0.0.0", () => {
    for (const v of ["", "latest", "HEAD", "pending-resolution", "0.0.0", undefined, null]) {
      expect(isConcreteSwapVersion(v as never)).toBe(false);
    }
  });
});

describe("planCanonicalVersionFlip", () => {
  it("flips ONLY the version on a verdaccio source, preserving every other field", () => {
    const plan = planCanonicalVersionFlip(verdaccioSource("1.0.0"), "1.1.0");
    expect(plan.flip).toBe(true);
    if (!plan.flip) throw new Error("expected flip");
    expect(plan.from).toBe("1.0.0");
    expect(plan.to).toBe("1.1.0");
    expect(plan.newSource).toEqual({
      type: "verdaccio",
      registryUrl: "http://localhost:4873",
      packageName: "@acme/foo-agent",
      version: "1.1.0",
      // placeholder integrity is PRESERVED (agent/skill never finalize a real SRI).
      integrity: "dispatcher-install",
    });
  });

  it("no-ops for a non-verdaccio (github skill) source", () => {
    const github = { type: "github", repo: "acme/foo", ref: "v1", resolvedSha: "abc" } as ExtensionSource;
    const plan = planCanonicalVersionFlip(github, "1.1.0");
    expect(plan.flip).toBe(false);
    if (plan.flip) throw new Error("expected no flip");
    expect(plan.reason).toMatch(/non-verdaccio-source:github/);
  });

  it("no-ops (refuses) a non-concrete new version (moving tag / placeholder)", () => {
    expect(planCanonicalVersionFlip(verdaccioSource("1.0.0"), "latest").flip).toBe(false);
    const plan = planCanonicalVersionFlip(verdaccioSource("1.0.0"), "latest");
    if (plan.flip) throw new Error("expected no flip");
    expect(plan.reason).toMatch(/non-concrete-version:latest/);
  });

  it("no-ops on an idempotent same-version re-swap", () => {
    const plan = planCanonicalVersionFlip(verdaccioSource("2.0.0"), "2.0.0");
    expect(plan.flip).toBe(false);
    if (plan.flip) throw new Error("expected no flip");
    expect(plan.reason).toBe("same-version");
  });
});

describe("reconcileCanonicalVersionAfterNativeSwap", () => {
  beforeEach(() => {
    sourceSwitchSpy.mockReset();
    setSwapGenerationBumpHook(null);
  });
  afterEach(() => setSwapGenerationBumpHook(null));

  it("flips the canonical version via sourceSwitchExtension and bumps the generation", async () => {
    const bumps: string[] = [];
    setSwapGenerationBumpHook((pkg) => bumps.push(pkg));
    const outcome = await reconcileCanonicalVersionAfterNativeSwap({
      row: row(verdaccioSource("1.0.0")),
      newVersion: "1.2.0",
      actorSource: "dispatcher",
    });
    expect(outcome).toEqual({ reconciled: true, from: "1.0.0", to: "1.2.0" });
    expect(sourceSwitchSpy).toHaveBeenCalledTimes(1);
    expect(sourceSwitchSpy.mock.calls[0][0]).toBe("iext_abc123");
    expect(sourceSwitchSpy.mock.calls[0][1]).toMatchObject({ version: "1.2.0", integrity: "dispatcher-install" });
    expect(bumps).toEqual(["@acme/foo-agent"]);
  });

  it("preserves a locked row's status (sourceSwitchExtension preserves status; we never touch it)", async () => {
    // The reconcile NEVER passes a status — it routes through sourceSwitchExtension
    // which preserves the lifecycle status. Assert we only ever call source-switch
    // (no status write) for a locked row.
    await reconcileCanonicalVersionAfterNativeSwap({
      row: row(verdaccioSource("1.0.0"), { status: "locked", requiredInProd: true }),
      newVersion: "1.2.0",
      actorSource: "dispatcher",
    });
    expect(sourceSwitchSpy).toHaveBeenCalledTimes(1);
    // No status argument is ever forwarded.
    expect(JSON.stringify(sourceSwitchSpy.mock.calls[0])).not.toMatch(/"status"/);
  });

  it("no-ops (does not write) for a github-sourced skill", async () => {
    const github = { type: "github", repo: "acme/foo-skill", ref: "v1", resolvedSha: "deadbeef" } as ExtensionSource;
    const outcome = await reconcileCanonicalVersionAfterNativeSwap({
      row: row(github, { kind: "skill" }),
      newVersion: "1.2.0",
      actorSource: "dispatcher",
    });
    expect(outcome.reconciled).toBe(false);
    expect(sourceSwitchSpy).not.toHaveBeenCalled();
  });

  it("THROWS (never silent half-swap) when sourceSwitchExtension fails", async () => {
    sourceSwitchSpy.mockRejectedValueOnce(new Error("canonical write boom"));
    await expect(
      reconcileCanonicalVersionAfterNativeSwap({
        row: row(verdaccioSource("1.0.0")),
        newVersion: "1.2.0",
        actorSource: "dispatcher",
      }),
    ).rejects.toThrow(/canonical write boom/);
  });

  it("flips the version even when no generation-bump hook is wired (boot loader is the durable path)", async () => {
    const outcome = await reconcileCanonicalVersionAfterNativeSwap({
      row: row(verdaccioSource("1.0.0")),
      newVersion: "1.2.0",
      actorSource: "dispatcher",
    });
    expect(outcome.reconciled).toBe(true);
    expect(sourceSwitchSpy).toHaveBeenCalledTimes(1);
  });

  it("swallows a throwing generation-bump hook (the version flip already committed)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setSwapGenerationBumpHook(() => {
      throw new Error("bump boom");
    });
    const outcome = await reconcileCanonicalVersionAfterNativeSwap({
      row: row(verdaccioSource("1.0.0")),
      newVersion: "1.2.0",
      actorSource: "dispatcher",
    });
    expect(outcome.reconciled).toBe(true);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
