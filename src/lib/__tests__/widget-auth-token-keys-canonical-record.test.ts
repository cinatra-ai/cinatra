// Owner ruling 2026-07-23 (widget-auth delivery fix, path B) — the canonical
// `installed_extension.widget_auth_token_keys` write that closes the arm-(c) P5
// declaration TOCTOU. The declared token keys are recorded on the canonical row
// at the install pipeline's FINALIZE SEAM (after recordProvenance, alongside the
// dependency-edge / access-declaration writes), so the resolver reads a
// tamper-proof declaration from the DB (surfaced on the trusted anchor) instead
// of re-reading the mutable `/data/extensions` store at resolve time.
//
// Pure DI through the real pipeline — no registry, no DB, no filesystem. Mirrors
// the cinatra#951 access-declaration threading test.

import { describe, it, expect } from "vitest";

import {
  installExtensionFromRegistry,
  makeTestInstallPipelineDeps,
  type InstallPipelineDeps,
} from "@/lib/extension-install-pipeline";
import { sriForBytes } from "@/lib/extension-package-store-core";

const REGISTRY = "https://registry.cinatra.ai";
const PKG = "@acme/wordpress-runtime-connector";
const VER = "1.0.0";
const TOKEN_KEY = "wordpress_widget_auth";
const INTEGRITY = sriForBytes(Buffer.from("the-connector-tarball"));

type OrderEvent = { kind: "provenance"; version: string } | { kind: "tokenkeys"; tokenKeys: string[] };

function harness(overrides: Partial<InstallPipelineDeps> = {}) {
  const events: OrderEvent[] = [];
  const calls = {
    persisted: [] as Array<{ packageName: string; orgId: string | null; tokenKeys: string[] }>,
  };
  const deps: InstallPipelineDeps = {
    ...makeTestInstallPipelineDeps(),
    resolveIntegrity: async () => ({ integrity: INTEGRITY, registryUrl: REGISTRY }),
    materialize: async () => ({
      storeDir: "/store/dir",
      digest: "dgst",
      integrity: INTEGRITY,
      contentHash: "ch",
    }),
    readRequestedPorts: async () => [],
    // The SRI-verified manifest's declared widget-auth token keys (line-552 read).
    readWidgetAuthTokenKeys: async () => [TOKEN_KEY],
    recordProvenance: async (i) => {
      events.push({ kind: "provenance", version: i.version });
    },
    persistWidgetAuthTokenKeys: async (i) => {
      events.push({ kind: "tokenkeys", tokenKeys: i.tokenKeys });
      calls.persisted.push(i);
    },
    ...overrides,
  };
  return { deps, calls, events };
}

const kinds = (events: OrderEvent[]) => events.map((e) => e.kind);

describe("install pipeline × widget-auth declared token keys (owner ruling 2026-07-23)", () => {
  it("records the declared token keys on the canonical row at the finalize seam", async () => {
    const { deps, calls } = harness();
    await installExtensionFromRegistry({ packageName: PKG, version: VER, orgId: null }, deps);
    expect(calls.persisted).toEqual([{ packageName: PKG, orgId: null, tokenKeys: [TOKEN_KEY] }]);
  });

  it("writes AFTER recordProvenance (crash-consistent: an OLD finalized anchor never pairs with NEW keys)", async () => {
    const { deps, events } = harness();
    await installExtensionFromRegistry({ packageName: PKG, version: VER, orgId: null }, deps);
    const k = kinds(events);
    expect(k).toContain("provenance");
    expect(k).toContain("tokenkeys");
    // The column write must land AFTER the source write.
    expect(k.indexOf("provenance")).toBeLessThan(k.indexOf("tokenkeys"));
  });

  it("writes UNCONDITIONALLY — a package that declares NO widget-auth key stamps [] (a non-legacy empty declaration)", async () => {
    const { deps, calls } = harness({ readWidgetAuthTokenKeys: async () => [] });
    await installExtensionFromRegistry({ packageName: PKG, version: VER, orgId: null }, deps);
    expect(calls.persisted).toEqual([{ packageName: PKG, orgId: null, tokenKeys: [] }]);
  });

  it("RE-INSTALL updates the record: a manifest that DROPS the key writes [] over the prior declaration", async () => {
    // A re-install is just an install with the new manifest's declaration; the
    // (dropped) key is written as [] — the column is never left stale.
    const { deps, calls } = harness({
      readWidgetAuthTokenKeys: async () => [],
      readInstallOp: async () => ({ installOpId: "op-1", phase: "finalized" as const, digest: "old-dgst" }),
      readCurrentWidgetAuthTokenKeys: async () => [TOKEN_KEY],
    });
    await installExtensionFromRegistry({ packageName: PKG, version: VER, orgId: null }, deps);
    expect(calls.persisted[0]).toEqual({ packageName: PKG, orgId: null, tokenKeys: [] });
  });

  it("a failed UPDATE restores the PRIOR recorded keys in the pre-finalize unwind (rollback: OLD anchor keeps OLD declaration)", async () => {
    const { deps, calls } = harness({
      readWidgetAuthTokenKeys: async () => ["a_different_new_key"],
      // A prior finalized install exists → this run is an UPDATE.
      readInstallOp: async () => ({ installOpId: "op-1", phase: "finalized" as const, digest: "old-dgst" }),
      readCurrentWidgetAuthTokenKeys: async () => [TOKEN_KEY],
      // Blow up at the finalize seam tail so the catch path runs after the new
      // keys were persisted.
      finalizeInstallOp: async () => {
        throw new Error("finalize boom");
      },
    });
    await expect(
      installExtensionFromRegistry({ packageName: PKG, version: VER, orgId: null }, deps),
    ).rejects.toThrow(/finalize boom/);
    // First write: the NEW keys (finalize seam). Last write: the PRIOR keys restored.
    expect(calls.persisted.length).toBeGreaterThanOrEqual(2);
    expect(calls.persisted[0]).toEqual({ packageName: PKG, orgId: null, tokenKeys: ["a_different_new_key"] });
    expect(calls.persisted[calls.persisted.length - 1]).toEqual({ packageName: PKG, orgId: null, tokenKeys: [TOKEN_KEY] });
  });

  it("ROLLBACK ORDERING (codex round-2): the OLD keys are restored BEFORE the OLD provenance is re-pinned (no OLD-anchor + NEW-keys window)", async () => {
    const OLD_VER = "0.9.0";
    const { deps, events } = harness({
      readWidgetAuthTokenKeys: async () => ["a_different_new_key"],
      readInstallOp: async () => ({ installOpId: "op-1", phase: "finalized" as const, digest: "old-dgst" }),
      readCurrentWidgetAuthTokenKeys: async () => [TOKEN_KEY],
      // A prior verdaccio source exists → the pre-finalize unwind re-pins OLD provenance.
      readCurrentSource: async () => ({
        registryUrl: REGISTRY,
        version: OLD_VER,
        integrity: INTEGRITY,
        contentHash: "old-ch",
        activeDigest: "old-dgst",
      }),
      finalizeInstallOp: async () => {
        throw new Error("finalize boom");
      },
    });
    await expect(
      installExtensionFromRegistry({ packageName: PKG, version: VER, orgId: null }, deps),
    ).rejects.toThrow(/finalize boom/);
    // The RESTORE writes: the OLD token keys ([TOKEN_KEY]) and the OLD provenance
    // (version OLD_VER). The keys restore MUST precede the provenance re-pin — the
    // provenance re-pin is what makes the OLD digest anchorable again.
    const restoreKeysIdx = events.findIndex(
      (e) => e.kind === "tokenkeys" && e.tokenKeys.length === 1 && e.tokenKeys[0] === TOKEN_KEY,
    );
    const restoreProvIdx = events.findIndex((e) => e.kind === "provenance" && e.version === OLD_VER);
    expect(restoreKeysIdx).toBeGreaterThanOrEqual(0);
    expect(restoreProvIdx).toBeGreaterThanOrEqual(0);
    expect(restoreKeysIdx).toBeLessThan(restoreProvIdx);
  });

  it("a failed UPDATE from a LEGACY row restores [] (the explicit clear — never the failed candidate's keys)", async () => {
    const { deps, calls } = harness({
      readWidgetAuthTokenKeys: async () => [TOKEN_KEY],
      readInstallOp: async () => ({ installOpId: "op-1", phase: "finalized" as const, digest: "old-dgst" }),
      // Legacy row: null column.
      readCurrentWidgetAuthTokenKeys: async () => null,
      finalizeInstallOp: async () => {
        throw new Error("finalize boom");
      },
    });
    await expect(
      installExtensionFromRegistry({ packageName: PKG, version: VER, orgId: null }, deps),
    ).rejects.toThrow(/finalize boom/);
    expect(calls.persisted[calls.persisted.length - 1]).toEqual({ packageName: PKG, orgId: null, tokenKeys: [] });
  });

  it("a FRESH install failure does not attempt a token-keys restore (nothing prior — the dispatcher drops the placeholder row)", async () => {
    const { deps, calls } = harness({
      readWidgetAuthTokenKeys: async () => [TOKEN_KEY],
      finalizeInstallOp: async () => {
        throw new Error("finalize boom");
      },
    });
    await expect(
      installExtensionFromRegistry({ packageName: PKG, version: VER, orgId: null }, deps),
    ).rejects.toThrow(/finalize boom/);
    // Exactly the one forward write — no restore (priorWidgetAuthTokenKeys is null on a fresh install).
    expect(calls.persisted).toEqual([{ packageName: PKG, orgId: null, tokenKeys: [TOKEN_KEY] }]);
  });

  it("unwired persist hook is a pure no-op (older pipeline unit tests keep passing)", async () => {
    const { deps, calls } = harness({ persistWidgetAuthTokenKeys: undefined });
    await installExtensionFromRegistry({ packageName: PKG, version: VER, orgId: null }, deps);
    expect(calls.persisted).toHaveLength(0);
  });
});
