/**
 * cinatra#3745 — the loaded-identity check of an outward run action.
 *
 * The owner of a tool that would act outward on a run must carry the loaded
 * identity the host's loader stamped from a verified install id and digest,
 * and it must still be the current identity of its package version. Every
 * other owner is refused: no identity, an identity without an install id or a
 * digest, a forged or copied identity, and an identity that was replaced,
 * retired or torn down. The check admits nothing by itself: the boundary still
 * refuses every outward call on a run frame, also for an owner whose identity
 * is current.
 *
 * The real registry, the real check and the real boundary run. Only the run
 * store, the audit writer and the extension-registry reader are test doubles.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@cinatra-ai/agents/store", () => ({
  readCurrentRunStepToolPolicy: vi.fn(),
  assertRunStepToolAllowed: vi.fn(),
  RunStepToolPolicyRefusal: class RunStepToolPolicyRefusal extends Error {},
}));

import * as registry from "@/lib/extension-capabilities-registry";
import * as hostContext from "@/lib/extension-host-context";
import * as auditModule from "@/lib/authz/audit";
import * as extensionRegistryModule from "@/lib/extension-mcp-registry";
import { enforceMcpBoundary } from "@/lib/authz/mcp-boundary";

const PKG = "@x/mailer";
const INSTALL = { packageName: PKG, version: "1.2.0", installId: "install-1", digest: "d".repeat(64) };

// red-first-expect: recordLoadedExtensionIdentity is not a function
const stamp = (input: Record<string, unknown> = INSTALL) =>
  (registry as unknown as { recordLoadedExtensionIdentity: (v: unknown) => registry.LoadedExtensionIdentity })
    .recordLoadedExtensionIdentity(input);
// red-first-expect: assertOutwardActionLoadedIdentity is not a function
const check = (identity: unknown) =>
  (hostContext as unknown as { assertOutwardActionLoadedIdentity: (v: unknown) => unknown })
    .assertOutwardActionLoadedIdentity(identity);
const refusalCode = (identity: unknown): string | null => {
  try {
    check(identity);
    return null;
  } catch (err) {
    expect(err).toBeInstanceOf(hostContext.OutwardActionRefusal);
    return hostContext.runActionRefusalClassCode(err);
  }
};

beforeEach(() => registry.__resetCapabilityRegistry());

describe("the loader's stamp", () => {
  it("is frozen, carries the install, and is the same identity for the same install", () => {
    const first = stamp();
    expect(first).toMatchObject(INSTALL);
    expect(Object.isFrozen(first)).toBe(true);
    expect(stamp()).toBe(first);
    expect(registry.currentLoadedExtensionIdentity(PKG, "1.2.0")).toBe(first);
  });

  it.each([
    ["no install id", { ...INSTALL, installId: undefined }],
    ["an empty digest", { ...INSTALL, digest: "" }],
    ["no version", { ...INSTALL, version: null }],
    ["a line break in a field", { ...INSTALL, installId: "install-1\nx" }],
    ["a field that is not text", { ...INSTALL, digest: 7 }],
  ])("refuses %s and stamps nothing", (_label, input) => {
    expect(() => stamp(input)).toThrow("action_loaded_identity_invalid");
    expect(registry.currentLoadedExtensionIdentity(PKG, "1.2.0")).toBeUndefined();
  });
});

describe("the check of an outward action's owner", () => {
  it("admits the current identity the loader stamped", () => {
    const identity = stamp();
    expect(check(identity)).toBe(identity);
  });

  it.each([
    ["no identity", undefined],
    ["null", null],
    ["a package name only", { packageName: PKG, version: "1.2.0" }],
    ["an identity without a digest", { ...INSTALL, digest: "", generation: 1 }],
    ["an identity without an install id", { ...INSTALL, installId: undefined, generation: 1 }],
    ["an install id behind a getter", Object.defineProperty({ ...INSTALL, generation: 1 }, "installId", { get: () => "install-1" })],
  ])("refuses %s as missing", (_label, identity) => {
    stamp();
    expect(refusalCode(identity)).toBe("action_loaded_identity_missing_or_stale");
  });

  it("refuses a copy with another generation, install id or digest as stale", () => {
    const identity = stamp();
    expect(refusalCode({ ...identity, generation: identity.generation + 1 })).toBe("action_loaded_identity_stale");
    expect(refusalCode({ ...identity, installId: "install-2" })).toBe("action_loaded_identity_stale");
    expect(refusalCode({ ...identity, digest: "e".repeat(64) })).toBe("action_loaded_identity_stale");
  });

  it("refuses an identity the loader never stamped as stale", () => {
    expect(refusalCode({ ...INSTALL, generation: 1 })).toBe("action_loaded_identity_stale");
  });

  it("refuses an identity replaced by a stamp of another digest", () => {
    const old = stamp();
    const next = stamp({ ...INSTALL, digest: "e".repeat(64) });
    expect(refusalCode(old)).toBe("action_loaded_identity_stale");
    expect(check(next)).toBe(next);
  });

  it("refuses an identity retired after a failed registration", () => {
    const identity = stamp();
    registry.retireLoadedExtensionIdentity(PKG, "1.2.0");
    expect(refusalCode(identity)).toBe("action_loaded_identity_stale");
  });

  it("refuses every identity of a package after its capability teardown, and keeps other packages", () => {
    const identity = stamp();
    const other = stamp({ ...INSTALL, packageName: "@x/other" });
    registry.invalidateProvidersForPackage(PKG);
    expect(refusalCode(identity)).toBe("action_loaded_identity_stale");
    expect(check(other)).toBe(other);
  });
});

describe("the boundary with a current loaded identity", () => {
  let auditSpy: ReturnType<typeof vi.spyOn>;
  let extensionSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    auditSpy = vi.spyOn(auditModule, "logAuditEvent").mockResolvedValue(undefined);
    extensionSpy = vi
      .spyOn(extensionRegistryModule, "getEffectiveExtensionMcpTool")
      .mockReturnValue({ packageName: PKG } as ReturnType<typeof extensionRegistryModule.getEffectiveExtensionMcpTool>);
  });
  afterEach(() => {
    auditSpy.mockRestore();
    extensionSpy.mockRestore();
  });

  it("still refuses an outward call on a run frame", async () => {
    check(stamp());
    for (const req of [
      { primitiveName: "email_send", declaresOutward: false },
      { primitiveName: "mailer_send", declaresOutward: true },
    ]) {
      const d = await enforceMcpBoundary({
        ...req,
        ctx: { orgId: "org-1", userId: "user-1", runId: "run-1", platformRole: "platform_admin" },
        delegatedRestricted: false,
      });
      expect(d).toEqual({ allowed: false, reason: "outward_effect_requires_recorded_decision", shouldBlock: true });
    }
  });
});
