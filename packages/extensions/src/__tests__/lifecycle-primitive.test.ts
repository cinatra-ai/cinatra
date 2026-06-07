// lifecycle-primitive unit tests.
//
// Tests the in-memory transition matrix + locked-rejects-destructive rule.
// DB roundtrips are mocked at the canonical-store boundary so the test
// runs without a Postgres connection.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { InstalledExtension } from "../canonical-types";

vi.mock("server-only", () => ({}));
vi.mock("../canonical-store", () => ({
  readInstalledExtensionById: vi.fn(),
  _internalInsertInstalledExtension: vi.fn(async (row) => ({
    ...row,
    createdAt: new Date("2026-05-21T00:00:00Z"),
    updatedAt: new Date("2026-05-21T00:00:00Z"),
  })),
  _internalUpdateInstalledExtensionStatus: vi.fn(async (id, status) => ({
    id,
    status,
    packageName: "pkg",
    ownerLevel: "platform",
    ownerId: null,
    organizationId: null,
    kind: "agent",
    source: { type: "verdaccio", registryUrl: "x", packageName: "pkg", version: "1.0.0", integrity: "sha" },
    requiredInProd: false,
    dependencies: [],
    manifestHash: null,
    createdAt: new Date("2026-05-21T00:00:00Z"),
    updatedAt: new Date("2026-05-21T00:00:00Z"),
  })),
  _internalUpdateInstalledExtensionSource: vi.fn(async (id, source) => ({
    id,
    status: "active",
    packageName: "pkg",
    ownerLevel: "platform",
    ownerId: null,
    organizationId: null,
    kind: "agent",
    source,
    requiredInProd: false,
    dependencies: [],
    manifestHash: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  })),
  _internalDeleteInstalledExtension: vi.fn(async () => undefined),
}));

import * as store from "../canonical-store";
import {
  LifecycleTransitionError,
  deleteNonFinalizedCanonicalRow,
  installExtensionManifest,
  sourceSwitchExtension,
  transitionExtensionLifecycle,
} from "../lifecycle-primitive";
import { setExtensionInstallOpPhaseReader } from "../install-op-phase-hook";

const lockedRow: InstalledExtension = {
  id: "ext-1",
  packageName: "@cinatra-ai/security-reviewer-agent",
  ownerLevel: "platform",
  ownerId: null,
  organizationId: null,
  kind: "agent",
  status: "locked",
  source: {
    type: "verdaccio",
    registryUrl: "http://localhost:4873",
    packageName: "@cinatra-ai/security-reviewer-agent",
    version: "1.0.0",
    integrity: "sha512-x",
  },
  requiredInProd: true,
  dependencies: [],
  manifestHash: "abc",
  createdAt: new Date(),
  updatedAt: new Date(),
};

const activeRow: InstalledExtension = { ...lockedRow, id: "ext-2", status: "active", requiredInProd: false };
const archivedRow: InstalledExtension = { ...lockedRow, id: "ext-3", status: "archived", requiredInProd: false };

beforeEach(() => {
  vi.mocked(store.readInstalledExtensionById).mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

const OPTS = { actor: { source: "test" }, reason: "unit-test" };

describe("transitionExtensionLifecycle", () => {
  it("active → archived via archive", async () => {
    vi.mocked(store.readInstalledExtensionById).mockResolvedValue(activeRow);
    const out = await transitionExtensionLifecycle("ext-2", "archive", OPTS);
    expect(out?.status).toBe("archived");
  });

  it("archived → active via activate", async () => {
    vi.mocked(store.readInstalledExtensionById).mockResolvedValue(archivedRow);
    const out = await transitionExtensionLifecycle("ext-3", "activate", OPTS);
    expect(out?.status).toBe("active");
  });

  it("locked rejects archive", async () => {
    vi.mocked(store.readInstalledExtensionById).mockResolvedValue(lockedRow);
    await expect(transitionExtensionLifecycle("ext-1", "archive", OPTS)).rejects.toMatchObject({
      code: "LOCKED_REJECTS_OP",
    });
  });

  it("locked rejects uninstall", async () => {
    vi.mocked(store.readInstalledExtensionById).mockResolvedValue(lockedRow);
    await expect(transitionExtensionLifecycle("ext-1", "uninstall", OPTS)).rejects.toMatchObject({
      code: "LOCKED_REJECTS_OP",
    });
  });

  it("locked rejects force_delete / purge / registry_remove", async () => {
    vi.mocked(store.readInstalledExtensionById).mockResolvedValue(lockedRow);
    for (const op of ["force_delete", "purge", "registry_remove"] as const) {
      await expect(transitionExtensionLifecycle("ext-1", op, OPTS)).rejects.toBeInstanceOf(
        LifecycleTransitionError,
      );
    }
  });

  it("locked allows update (status preserved)", async () => {
    vi.mocked(store.readInstalledExtensionById).mockResolvedValue(lockedRow);
    const out = await transitionExtensionLifecycle("ext-1", "update", OPTS);
    expect(out?.status).toBe("locked");
  });

  it("activate PRESERVES a locked row (locked stays locked, NOT active) but still re-surfaces an archived row to active", async () => {
    // A package-wide restore fires `activate` across every same-package row. The
    // matrix must NOT silently demote a locked (e.g. required-in-prod) row to
    // active — only the admin-gated `unlock` op may do that. An archived row, by
    // contrast, is correctly re-surfaced to active by the same op.
    vi.mocked(store.readInstalledExtensionById).mockResolvedValue(lockedRow);
    const lockedOut = await transitionExtensionLifecycle("ext-1", "activate", OPTS);
    expect(lockedOut?.status).toBe("locked");
    // A no-op status transition returns the row unchanged (status preserved) and
    // never writes through the status updater.
    expect(store._internalUpdateInstalledExtensionStatus).not.toHaveBeenCalledWith(
      "ext-1",
      "active",
    );

    vi.mocked(store.readInstalledExtensionById).mockResolvedValue(archivedRow);
    const archivedOut = await transitionExtensionLifecycle("ext-3", "activate", OPTS);
    expect(archivedOut?.status).toBe("active");
  });

  it("uninstall on non-used active row removes the manifest row (returns null)", async () => {
    vi.mocked(store.readInstalledExtensionById).mockResolvedValue(activeRow);
    const out = await transitionExtensionLifecycle("ext-2", "uninstall", OPTS);
    expect(out).toBeNull();
    expect(store._internalDeleteInstalledExtension).toHaveBeenCalledWith("ext-2");
  });

  it("primitive never imports Verdaccio yank/delete clients", async () => {
    // The primitive must only delete the local manifest row. Verdaccio
    // yank/delete is not a lifecycle op and is owned elsewhere.
    // Drift in this direction would be caught here: this test asserts no
    // import of a Verdaccio client / unpublish helper from inside the
    // primitive.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(
      path.resolve(__dirname, "..", "lifecycle-primitive.ts"),
      "utf8",
    );
    // Only IMPORT lines or fetch() calls trip the gate; the body's free-text
    // explanation of the rule is allowed.
    const imports = src
      .split("\n")
      .filter((line) => /^import\b|require\(/.test(line.trim()));
    for (const line of imports) {
      expect(line).not.toMatch(/verdaccio/i);
    }
    expect(src).not.toMatch(/await\s+(?:unpublish|yank)PackageVersion/);
    expect(src).not.toMatch(/registryUrl.*\.(unpublish|delete|yank)/);
  });

  it("EXT_NOT_FOUND when extension id is unknown", async () => {
    vi.mocked(store.readInstalledExtensionById).mockResolvedValue(null);
    await expect(transitionExtensionLifecycle("missing", "archive", OPTS)).rejects.toMatchObject({
      code: "EXT_NOT_FOUND",
    });
  });
});

describe("installExtensionManifest", () => {
  it("creates a new manifest row at active by default", async () => {
    const out = await installExtensionManifest(
      {
        id: "ext-new",
        packageName: "@cinatra-ai/new-agent",
        ownerLevel: "platform",
        ownerId: null,
        organizationId: null,
        kind: "agent",
        source: {
          type: "verdaccio",
          registryUrl: "http://localhost:4873",
          packageName: "@cinatra-ai/new-agent",
          version: "0.1.0",
          integrity: "sha512-x",
        },
        requiredInProd: false,
        dependencies: [],
        manifestHash: null,
      },
      OPTS,
    );
    expect(out.status).toBe("active");
  });

  it("requires id and packageName", async () => {
    await expect(
      installExtensionManifest({} as never, OPTS),
    ).rejects.toBeInstanceOf(LifecycleTransitionError);
  });

  // required-in-prod → locked at the lowest write point.
  const requiredInProdRow = {
    id: "ext-req",
    packageName: "@cinatra-ai/security-reviewer-agent",
    ownerLevel: "platform" as const,
    ownerId: null,
    organizationId: null,
    kind: "agent" as const,
    source: {
      type: "verdaccio" as const,
      registryUrl: "http://localhost:4873",
      packageName: "@cinatra-ai/security-reviewer-agent",
      version: "1.0.0",
      integrity: "sha512-x",
    },
    requiredInProd: true,
    dependencies: [],
    manifestHash: null,
  };

  describe("required-in-prod coercion", () => {
    const prevMode = process.env.CINATRA_RUNTIME_MODE;
    afterEach(() => {
      if (prevMode === undefined) delete process.env.CINATRA_RUNTIME_MODE;
      else process.env.CINATRA_RUNTIME_MODE = prevMode;
    });

    it("coerces an active required-in-prod install to locked in non-dev (prod) mode", async () => {
      delete process.env.CINATRA_RUNTIME_MODE; // not "development" → prod
      const out = await installExtensionManifest({ ...requiredInProdRow }, OPTS);
      expect(out.status).toBe("locked");
    });

    it("leaves an active required-in-prod install active in dev mode + logs an advisory", async () => {
      process.env.CINATRA_RUNTIME_MODE = "development";
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const out = await installExtensionManifest({ ...requiredInProdRow }, OPTS);
      expect(out.status).toBe("active");
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(
          "ADVISORY: required-in-prod package @cinatra-ai/security-reviewer-agent installed unlocked in dev mode",
        ),
      );
      warn.mockRestore();
    });

    it("does NOT advisory-log when a required-in-prod install is already locked in dev mode", async () => {
      process.env.CINATRA_RUNTIME_MODE = "development";
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const out = await installExtensionManifest({ ...requiredInProdRow, status: "locked" }, OPTS);
      expect(out.status).toBe("locked");
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it("does NOT coerce a non-required install in prod mode", async () => {
      delete process.env.CINATRA_RUNTIME_MODE;
      const out = await installExtensionManifest(
        { ...requiredInProdRow, requiredInProd: false },
        OPTS,
      );
      expect(out.status).toBe("active");
    });
  });
});

describe("sourceSwitchExtension", () => {
  it("preserves status when switching source type", async () => {
    vi.mocked(store.readInstalledExtensionById).mockResolvedValue({
      ...activeRow,
      status: "archived",
    });
    const out = await sourceSwitchExtension(
      "ext-3",
      { type: "github", repo: "owner/repo", ref: "v1", resolvedSha: "abc123" },
      OPTS,
    );
    expect(out.source.type).toBe("github");
  });

  it("rejects a source-switch with incomplete provenance", async () => {
    vi.mocked(store.readInstalledExtensionById).mockResolvedValue(activeRow);
    await expect(
      sourceSwitchExtension(
        "ext-2",
        { type: "github", repo: "owner/repo", ref: "", resolvedSha: "" } as never,
        OPTS,
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});

describe("unlock policy gate", () => {
  it("rejects unlock without allowUnlock + platform_admin", async () => {
    vi.mocked(store.readInstalledExtensionById).mockResolvedValue(lockedRow);
    await expect(transitionExtensionLifecycle("ext-1", "unlock", OPTS)).rejects.toMatchObject({
      code: "LOCKED_REJECTS_OP",
    });
  });

  it("rejects unlock with allowUnlock but non-admin actor", async () => {
    vi.mocked(store.readInstalledExtensionById).mockResolvedValue(lockedRow);
    await expect(
      transitionExtensionLifecycle("ext-1", "unlock", {
        actor: { source: "test", roles: ["member"] },
        reason: "x",
        allowUnlock: true,
      }),
    ).rejects.toMatchObject({ code: "LOCKED_REJECTS_OP" });
  });

  it("permits unlock with allowUnlock + platform_admin", async () => {
    vi.mocked(store.readInstalledExtensionById).mockResolvedValue(lockedRow);
    const out = await transitionExtensionLifecycle("ext-1", "unlock", {
      actor: { source: "test", roles: ["platform_admin"] },
      reason: "x",
      allowUnlock: true,
    });
    expect(out?.status).toBe("active");
  });
});

describe("install provenance validation", () => {
  it("rejects install with incomplete verdaccio provenance", async () => {
    await expect(
      installExtensionManifest(
        {
          id: "ext-bad",
          packageName: "@cinatra-ai/bad",
          ownerLevel: "platform",
          ownerId: null,
          organizationId: null,
          kind: "agent",
          source: { type: "verdaccio", registryUrl: "x", packageName: "y", version: "", integrity: "" } as never,
          requiredInProd: false,
          dependencies: [],
          manifestHash: null,
        },
        OPTS,
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});

// A live (active) row the install pipeline never finalized — placeholder
// integrity. This is the ONLY shape deleteNonFinalizedCanonicalRow may drop.
const placeholderRow: InstalledExtension = {
  ...activeRow,
  id: "ext-placeholder",
  source: {
    type: "verdaccio",
    registryUrl: "http://localhost:4873",
    packageName: "@cinatra-ai/security-reviewer-agent",
    version: "1.0.0",
    integrity: "dispatcher-install",
  },
};

describe("deleteNonFinalizedCanonicalRow (rollback-only canonical delete)", () => {
  afterEach(() => {
    // The journal-aware check reads a globalThis-anchored reader slot — clear it
    // so no reader leaks between tests (default: no reader → integrity fallback).
    setExtensionInstallOpPhaseReader(null);
  });

  it("deletes a NON-finalized (placeholder-integrity) active row", async () => {
    vi.mocked(store.readInstalledExtensionById).mockResolvedValue(placeholderRow);
    await expect(deleteNonFinalizedCanonicalRow("ext-placeholder")).resolves.toBeUndefined();
    expect(store._internalDeleteInstalledExtension).toHaveBeenCalledWith("ext-placeholder");
  });

  it("is a no-op for a missing row (idempotent — never throws, never deletes)", async () => {
    vi.mocked(store.readInstalledExtensionById).mockResolvedValue(null);
    await expect(deleteNonFinalizedCanonicalRow("ext-gone")).resolves.toBeUndefined();
    expect(store._internalDeleteInstalledExtension).not.toHaveBeenCalled();
  });

  it("REFUSES to delete a FINALIZED healthy locked row (ILLEGAL_TRANSITION) and never writes", async () => {
    // lockedRow carries a REAL sha512 integrity = a genuine admin/required-in-prod
    // lock the pipeline finalized. The journal-aware signal classes it as healthy,
    // so the rollback-only delete refuses it (route a healthy-row removal through
    // transitionExtensionLifecycle, which applies the lock guard).
    vi.mocked(store.readInstalledExtensionById).mockResolvedValue(lockedRow);
    await expect(deleteNonFinalizedCanonicalRow("ext-1")).rejects.toMatchObject({
      code: "ILLEGAL_TRANSITION",
    });
    expect(store._internalDeleteInstalledExtension).not.toHaveBeenCalled();
  });

  it("DELETES a NON-finalized (placeholder-integrity) LOCKED placeholder — the dispatcher creates these for required-in-prod new installs", async () => {
    // syncCanonicalManifestInstall creates a required-in-prod new install at status
    // 'locked' while it still carries placeholder integrity (dispatcher-install).
    // A failed prod install must be rollbackable: status 'locked' is NOT a standalone
    // discriminator — only the journal-aware signal can tell this placeholder apart
    // from a finalized admin-lock. This is byte-equivalent to the pre-primitive caller,
    // which deleted any row the signal classed as non-finalized (locked included).
    const lockedPlaceholderRow: InstalledExtension = {
      ...placeholderRow,
      id: "ext-locked-placeholder",
      status: "locked",
      requiredInProd: true,
    };
    vi.mocked(store.readInstalledExtensionById).mockResolvedValue(lockedPlaceholderRow);
    await expect(
      deleteNonFinalizedCanonicalRow("ext-locked-placeholder"),
    ).resolves.toBeUndefined();
    expect(store._internalDeleteInstalledExtension).toHaveBeenCalledWith("ext-locked-placeholder");
  });

  it("REFUSES to delete a FINALIZED healthy active row (ILLEGAL_TRANSITION) and never writes", async () => {
    // activeRow carries a REAL sha512 integrity = finalized; the unguarded helper
    // would have hard-deleted it, stranding a real install. The self-guard refuses.
    vi.mocked(store.readInstalledExtensionById).mockResolvedValue(activeRow);
    await expect(deleteNonFinalizedCanonicalRow("ext-2")).rejects.toMatchObject({
      code: "ILLEGAL_TRANSITION",
    });
    expect(store._internalDeleteInstalledExtension).not.toHaveBeenCalled();
  });

  it("REFUSES to delete an archived row (ILLEGAL_TRANSITION) and never writes", async () => {
    vi.mocked(store.readInstalledExtensionById).mockResolvedValue(archivedRow);
    await expect(deleteNonFinalizedCanonicalRow("ext-3")).rejects.toMatchObject({
      code: "ILLEGAL_TRANSITION",
    });
    expect(store._internalDeleteInstalledExtension).not.toHaveBeenCalled();
  });

  it("JOURNAL-AWARE: REFUSES a real-integrity row whose journal phase is 'finalized'", async () => {
    setExtensionInstallOpPhaseReader(() => "finalized");
    vi.mocked(store.readInstalledExtensionById).mockResolvedValue(activeRow);
    await expect(deleteNonFinalizedCanonicalRow("ext-2")).rejects.toMatchObject({
      code: "ILLEGAL_TRANSITION",
    });
    expect(store._internalDeleteInstalledExtension).not.toHaveBeenCalled();
  });

  it("JOURNAL-AWARE: DELETES a real-integrity row whose journal phase is NOT 'finalized' (provenance-before-finalize window)", async () => {
    // Real integrity (passes the integrity check as 'healthy') BUT the journal says
    // the install op never finalized → the journal-aware signal classes it
    // non-finalized, so the rollback-only delete is permitted.
    setExtensionInstallOpPhaseReader(() => "provenance");
    vi.mocked(store.readInstalledExtensionById).mockResolvedValue(activeRow);
    await expect(deleteNonFinalizedCanonicalRow("ext-2")).resolves.toBeUndefined();
    expect(store._internalDeleteInstalledExtension).toHaveBeenCalledWith("ext-2");
  });

});
