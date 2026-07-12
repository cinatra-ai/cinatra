import { describe, it, expect, beforeEach } from "vitest";

// cinatra#1392 Gap 1 — version-keyed serving registry: the RETAIN + COMMIT/ABORT
// lifecycle (attempt-ownership guarded), and the FAIL-CLOSED serve-lookup matrix
// (unpinned / unknown / not-servable / no-such-handler), asserting a lookup NEVER
// yields a value it should not — a consumer physically cannot fall through to a
// default/global registration (every refusal is a `{ kind: "refuse" }`, and every
// POINT lookup refuses on an absent handler rather than serving an empty set).

import {
  beginVersionKeyedRegistration,
  clearVersionKeyedServingForPackage,
  resolveVersionKeyedMcpTool,
  resolveVersionKeyedCapabilityProviders,
  resolveVersionKeyedObjectType,
  resolveVersionKeyedUiSetupSurfaces,
  resolveVersionKeyedUiSettingsSurfaces,
  resolveVersionKeyedUiActions,
  isVersionKeyedServable,
  __resetVersionKeyedServingForTests,
} from "@/lib/extension-version-keyed-serving";

const PKG = "@x/sibling";
const V = "1.2.3";

beforeEach(() => {
  __resetVersionKeyedServingForTests();
});

function retainAndCommit(pkg: string, ver: string) {
  const sink = beginVersionKeyedRegistration(pkg, ver);
  sink.retainMcpTool({ name: "sib_tool", handler: () => ({ ok: true }), packageName: pkg });
  sink.retainCapabilityProvider("sib-cap", { packageName: pkg, impl: { hi: true } });
  sink.retainObjectType({ typeId: `${pkg}:thing`, category: "data" });
  sink.retainUiSetupSurface({ surface: "setup" });
  sink.retainUiSettingsSurface({ surface: "settings" });
  sink.retainUiAction({ id: "do", handler: async () => ({}) });
  sink.commit();
}

describe("retain → commit → serve (positive path)", () => {
  it("serves each kind for a committed non-default version", () => {
    retainAndCommit(PKG, V);
    expect(isVersionKeyedServable(PKG, V)).toBe(true);

    const tool = resolveVersionKeyedMcpTool(PKG, V, "sib_tool");
    expect(tool.kind).toBe("serve");
    if (tool.kind === "serve") {
      expect(tool.value.packageName).toBe(PKG);
      expect(typeof tool.value.handler).toBe("function");
    }

    const caps = resolveVersionKeyedCapabilityProviders(PKG, V, "sib-cap");
    expect(caps.kind).toBe("serve");
    if (caps.kind === "serve") expect(caps.value).toHaveLength(1);

    const ot = resolveVersionKeyedObjectType(PKG, V, `${PKG}:thing`);
    expect(ot.kind).toBe("serve");

    expect(resolveVersionKeyedUiSetupSurfaces(PKG, V).kind).toBe("serve");
    expect(resolveVersionKeyedUiSettingsSurfaces(PKG, V).kind).toBe("serve");
    const actions = resolveVersionKeyedUiActions(PKG, V);
    expect(actions.kind).toBe("serve");
    if (actions.kind === "serve") expect(actions.value).toHaveLength(1);
  });

  it("a committed version with NO ui surface serves an EMPTY list (bulk kind), not a refusal", () => {
    const sink = beginVersionKeyedRegistration(PKG, V);
    sink.retainMcpTool({ name: "t", handler: () => ({}), packageName: PKG });
    sink.commit();
    const ui = resolveVersionKeyedUiActions(PKG, V);
    expect(ui.kind).toBe("serve");
    if (ui.kind === "serve") expect(ui.value).toEqual([]);
  });

  it("side-by-side versions of the same package are keyed independently", () => {
    const s1 = beginVersionKeyedRegistration(PKG, "1.0.0");
    s1.retainMcpTool({ name: "only_in_v1", handler: () => ({}), packageName: PKG });
    s1.commit();
    const s2 = beginVersionKeyedRegistration(PKG, "2.0.0");
    s2.retainMcpTool({ name: "only_in_v2", handler: () => ({}), packageName: PKG });
    s2.commit();

    expect(resolveVersionKeyedMcpTool(PKG, "1.0.0", "only_in_v1").kind).toBe("serve");
    expect(resolveVersionKeyedMcpTool(PKG, "1.0.0", "only_in_v2").kind).toBe("refuse");
    expect(resolveVersionKeyedMcpTool(PKG, "2.0.0", "only_in_v2").kind).toBe("serve");
    expect(resolveVersionKeyedMcpTool(PKG, "2.0.0", "only_in_v1").kind).toBe("refuse");
  });
});

describe("FAIL-CLOSED matrix — a lookup never falls through to a default/global serve", () => {
  it("UNPINNED: a lookup with no version refuses (never matches a default)", () => {
    retainAndCommit(PKG, V);
    for (const bad of [undefined, null, ""] as const) {
      const r = resolveVersionKeyedMcpTool(PKG, bad, "sib_tool");
      expect(r.kind).toBe("refuse");
      if (r.kind === "refuse") expect(r.code).toBe("UNPINNED");
    }
    expect(isVersionKeyedServable(PKG, undefined)).toBe(false);
    expect(resolveVersionKeyedCapabilityProviders(PKG, "", "sib-cap").kind).toBe("refuse");
  });

  it("UNKNOWN_VERSION: a (name, version) never retained refuses", () => {
    retainAndCommit(PKG, V);
    const r = resolveVersionKeyedMcpTool(PKG, "9.9.9", "sib_tool");
    expect(r.kind).toBe("refuse");
    if (r.kind === "refuse") expect(r.code).toBe("UNKNOWN_VERSION");
    const rp = resolveVersionKeyedMcpTool("@x/other", V, "sib_tool");
    if (rp.kind === "refuse") expect(rp.code).toBe("UNKNOWN_VERSION");
  });

  it("NOT_SERVABLE: a retained-but-uncommitted version refuses across every kind", () => {
    const sink = beginVersionKeyedRegistration(PKG, V);
    sink.retainMcpTool({ name: "sib_tool", handler: () => ({}), packageName: PKG });
    sink.retainCapabilityProvider("sib-cap", { packageName: PKG, impl: {} });
    sink.retainObjectType({ typeId: `${PKG}:thing` });
    // NO commit.
    expect(isVersionKeyedServable(PKG, V)).toBe(false);
    for (const r of [
      resolveVersionKeyedMcpTool(PKG, V, "sib_tool"),
      resolveVersionKeyedCapabilityProviders(PKG, V, "sib-cap"),
      resolveVersionKeyedObjectType(PKG, V, `${PKG}:thing`),
      resolveVersionKeyedUiSetupSurfaces(PKG, V),
      resolveVersionKeyedUiActions(PKG, V),
    ]) {
      expect(r.kind).toBe("refuse");
      if (r.kind === "refuse") expect(r.code).toBe("NOT_SERVABLE");
    }
  });

  it("NO_SUCH_HANDLER: a servable version refuses an unregistered POINT lookup (tool/type/capability)", () => {
    retainAndCommit(PKG, V);
    const t = resolveVersionKeyedMcpTool(PKG, V, "ghost_tool");
    expect(t.kind).toBe("refuse");
    if (t.kind === "refuse") expect(t.code).toBe("NO_SUCH_HANDLER");
    const ot = resolveVersionKeyedObjectType(PKG, V, "@x/ghost:type");
    if (ot.kind === "refuse") expect(ot.code).toBe("NO_SUCH_HANDLER");
    // A capability the version did not register is a NO_SUCH_HANDLER refuse — NOT
    // an empty serve (which a consumer could treat as a cue to serve the default).
    const cap = resolveVersionKeyedCapabilityProviders(PKG, V, "never-registered-cap");
    expect(cap.kind).toBe("refuse");
    if (cap.kind === "refuse") expect(cap.code).toBe("NO_SUCH_HANDLER");
  });

  it("ABORT: a discarded (partial/failed) register is not servable and refuses UNKNOWN_VERSION", () => {
    const sink = beginVersionKeyedRegistration(PKG, V);
    sink.retainMcpTool({ name: "sib_tool", handler: () => ({}), packageName: PKG });
    sink.abort();
    const r = resolveVersionKeyedMcpTool(PKG, V, "sib_tool");
    expect(r.kind).toBe("refuse");
    if (r.kind === "refuse") expect(r.code).toBe("UNKNOWN_VERSION");
    expect(isVersionKeyedServable(PKG, V)).toBe(false);
  });

  it("POST-TEARDOWN: clearing the package refuses every version (UNKNOWN_VERSION)", () => {
    retainAndCommit(PKG, "1.0.0");
    retainAndCommit(PKG, "2.0.0");
    const removed = clearVersionKeyedServingForPackage(PKG);
    expect(removed.sort()).toEqual(["1.0.0", "2.0.0"]);
    expect(resolveVersionKeyedMcpTool(PKG, "1.0.0", "sib_tool").kind).toBe("refuse");
    expect(resolveVersionKeyedMcpTool(PKG, "2.0.0", "sib_tool").kind).toBe("refuse");
    expect(isVersionKeyedServable(PKG, "1.0.0")).toBe(false);
  });
});

describe("attempt ownership — a superseded concurrent pass cannot corrupt the live entry", () => {
  it("a stale commit from a superseded attempt is a no-op (never marks the newer partial servable)", () => {
    const attempt1 = beginVersionKeyedRegistration(PKG, V);
    attempt1.retainMcpTool({ name: "from_attempt1", handler: () => ({}), packageName: PKG });
    // A concurrent re-activation of the SAME identity replaces the slot.
    const attempt2 = beginVersionKeyedRegistration(PKG, V);
    attempt2.retainMcpTool({ name: "from_attempt2", handler: () => ({}), packageName: PKG });

    // attempt1 finishes LATE and commits — it no longer owns the slot ⇒ no-op.
    attempt1.commit();
    expect(isVersionKeyedServable(PKG, V)).toBe(false); // attempt2 still uncommitted

    // attempt2 commits and owns the slot — its (and only its) registrations serve.
    attempt2.commit();
    expect(resolveVersionKeyedMcpTool(PKG, V, "from_attempt2").kind).toBe("serve");
    expect(resolveVersionKeyedMcpTool(PKG, V, "from_attempt1").kind).toBe("refuse");
  });

  it("a stale abort from a superseded attempt does NOT delete the newer attempt's entry", () => {
    const attempt1 = beginVersionKeyedRegistration(PKG, V);
    const attempt2 = beginVersionKeyedRegistration(PKG, V);
    attempt2.retainMcpTool({ name: "from_attempt2", handler: () => ({}), packageName: PKG });
    attempt2.commit();
    // attempt1's late failure aborts — it must not drop attempt2's live entry.
    attempt1.abort();
    expect(isVersionKeyedServable(PKG, V)).toBe(true);
    expect(resolveVersionKeyedMcpTool(PKG, V, "from_attempt2").kind).toBe("serve");
  });
});

describe("lifecycle guards", () => {
  it("beginVersionKeyedRegistration throws on a missing version (a non-default serve must be pinned)", () => {
    expect(() => beginVersionKeyedRegistration(PKG, undefined)).toThrow(/pinned version/i);
    expect(() => beginVersionKeyedRegistration(PKG, "")).toThrow(/pinned version/i);
  });

  it("re-begin REPLACES a prior entry (re-activate replaces, not stacks) and starts NON-servable", () => {
    retainAndCommit(PKG, V);
    expect(isVersionKeyedServable(PKG, V)).toBe(true);
    // Re-begin the same identity — fresh, empty, non-servable until re-committed.
    const sink = beginVersionKeyedRegistration(PKG, V);
    expect(isVersionKeyedServable(PKG, V)).toBe(false);
    expect(resolveVersionKeyedMcpTool(PKG, V, "sib_tool").kind).toBe("refuse"); // old tool gone
    sink.retainMcpTool({ name: "new_tool", handler: () => ({}), packageName: PKG });
    sink.commit();
    expect(resolveVersionKeyedMcpTool(PKG, V, "new_tool").kind).toBe("serve");
    expect(resolveVersionKeyedMcpTool(PKG, V, "sib_tool").kind).toBe("refuse");
  });

  it("a commit AFTER the entry was aborted is an ignored no-op (does not resurrect it)", () => {
    const sink = beginVersionKeyedRegistration(PKG, V);
    sink.retainMcpTool({ name: "t", handler: () => ({}), packageName: PKG });
    sink.abort();
    sink.commit(); // owns() is false — entry is gone
    expect(isVersionKeyedServable(PKG, V)).toBe(false);
  });

  it("a structurally-broken registration throws (surfaces as register-threw → abort)", () => {
    const sink = beginVersionKeyedRegistration(PKG, V);
    expect(() => sink.retainMcpTool({ name: "", handler: () => ({}), packageName: PKG })).toThrow(/no name/i);
    expect(() =>
      sink.retainMcpTool({ name: "x", handler: undefined as never, packageName: PKG }),
    ).toThrow(/no handler/i);
    expect(() => sink.retainObjectType(null as never)).toThrow(/non-object/i);
    expect(() => sink.retainObjectType({ typeId: "" } as never)).toThrow(/no typeId/i);
  });

  it("clearVersionKeyedServingForPackage scopes to the exact package (no cross-package clear)", () => {
    retainAndCommit(PKG, V);
    retainAndCommit("@x/sibling-two", V); // shares a prefix substring — must NOT be cleared
    const removed = clearVersionKeyedServingForPackage(PKG);
    expect(removed).toEqual([V]);
    expect(isVersionKeyedServable(PKG, V)).toBe(false);
    expect(isVersionKeyedServable("@x/sibling-two", V)).toBe(true);
  });
});
