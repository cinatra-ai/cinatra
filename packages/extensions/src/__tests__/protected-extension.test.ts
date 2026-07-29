import { describe, it, expect, vi } from "vitest";

// cinatra#1927 — the shared refusal kernel behind BOTH removal paths.
//
// The generic dispatcher (`assertNoLockedCanonicalRow`) and the direct
// agent-registry installer (`assertAgentTemplateRemovable`) both refuse through
// `assertExtensionNotProtected` → `assertNotDeclaredProtected`. These tests pin
// the kernel's contract; the two path-level tests
// (protected-extension-dispatcher.test.ts here, removal-gate-protected.test.ts
// in packages/agents) pin that each path actually reaches it.

import {
  ProtectedExtensionRemovalError,
  assertNotDeclaredProtected,
  assertExtensionNotProtected,
  resolveDeclaredProtection,
  protectedExtensionRemovalMessage,
} from "../protected-extension";
import { classifyRemovalFailure } from "../removal-failure";

const PKG = "@acme/protected-thing";
const OTHER = "@acme/ordinary-thing";

describe("assertNotDeclaredProtected — the pure refusal kernel", () => {
  it("refuses when the declaration says protected", () => {
    expect(() => assertNotDeclaredProtected(PKG, "uninstall", true)).toThrow(
      ProtectedExtensionRemovalError,
    );
  });

  it("is a no-op when the declaration does NOT say protected", () => {
    expect(() => assertNotDeclaredProtected(PKG, "uninstall", false)).not.toThrow();
  });

  it("carries a STABLE .code/.name for cross-module duck-typing", () => {
    try {
      assertNotDeclaredProtected(PKG, "force_delete", true);
      throw new Error("expected a refusal");
    } catch (err) {
      const e = err as ProtectedExtensionRemovalError;
      expect(e.code).toBe("DECLARED_PROTECTED_EXTENSION");
      expect(e.name).toBe("ProtectedExtensionRemovalError");
      expect(e.packageName).toBe(PKG);
      expect(e.op).toBe("force_delete");
    }
  });

  it("names the op and the package, and says update is still permitted", () => {
    const msg = protectedExtensionRemovalMessage(PKG, "uninstall");
    expect(msg).toContain(PKG);
    expect(msg).toContain("uninstall");
    expect(msg).toMatch(/Update is permitted/i);
  });

  it("refuses EVERY destructive op, not just uninstall", () => {
    for (const op of ["archive", "uninstall", "force_delete", "purge", "registry_remove"] as const) {
      expect(() => assertNotDeclaredProtected(PKG, op, true)).toThrow(
        ProtectedExtensionRemovalError,
      );
    }
  });
});

describe("assertExtensionNotProtected — the injected resolver", () => {
  it("refuses a protected package", async () => {
    const readDeclaredProtection = vi.fn(async () => true);
    await expect(
      assertExtensionNotProtected(PKG, "uninstall", { readDeclaredProtection }),
    ).rejects.toMatchObject({ code: "DECLARED_PROTECTED_EXTENSION" });
    expect(readDeclaredProtection).toHaveBeenCalledWith(PKG);
  });

  it("leaves an UNPROTECTED package's removal completely unaffected", async () => {
    const readDeclaredProtection = vi.fn(async () => false);
    await expect(
      assertExtensionNotProtected(OTHER, "uninstall", { readDeclaredProtection }),
    ).resolves.toBeUndefined();
  });

  it("PROPAGATES a reader throw (fail-closed: an unprovable package is not removed)", async () => {
    const readDeclaredProtection = vi.fn(async () => {
      throw new Error("config.json exists but is unreadable");
    });
    await expect(
      assertExtensionNotProtected(PKG, "uninstall", { readDeclaredProtection }),
    ).rejects.toThrow(/unreadable/);
  });

  it("resolveDeclaredProtection surfaces the verdict without refusing", async () => {
    await expect(
      resolveDeclaredProtection(PKG, { readDeclaredProtection: async () => true }),
    ).resolves.toBe(true);
  });
});

describe("classifyRemovalFailure — the returned user-facing contract", () => {
  it("maps the declaration-driven refusal onto the existing `system` reason", () => {
    expect(classifyRemovalFailure(new ProtectedExtensionRemovalError(PKG, "uninstall"))).toEqual({
      ok: false,
      reason: "system",
    });
  });

  it("classifies by .code alone (survives the dynamic-import boundary)", () => {
    // A structurally-identical error object from another module instance.
    expect(
      classifyRemovalFailure({ code: "DECLARED_PROTECTED_EXTENSION", message: "…" }),
    ).toEqual({ ok: false, reason: "system" });
  });
});
