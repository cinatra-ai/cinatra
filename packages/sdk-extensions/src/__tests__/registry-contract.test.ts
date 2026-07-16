// Extensible shadcn registry — identity grammar, tombstone contract, serving-URL
// grammar, and publish-time DAG validation (cinatra#1623, epic #1620 S5).
import { describe, it, expect } from "vitest";
import {
  REGISTRY_NAMESPACE_RE,
  HOST_NAMESPACE,
  RESERVED_NAMESPACES,
  REGISTRY_HOST,
  isValidRegistryNamespace,
  isValidRegistrySlug,
  isReservedNamespace,
  isHostNamespace,
  canonicalNamespaceToken,
  canOnboardNamespace,
  isValidRegistryItemIdentity,
  formatRegistryItemIdentity,
  parseRegistryItemIdentity,
  registryItemPath,
  splitPathForSlug,
  namespaceTombstoneKey,
  identityTombstoneKey,
  isNamespaceTombstoned,
  isIdentityTombstoned,
  flatHostRosterUrl,
  immutableDigestUrl,
  stableAliasUrl,
  servingUrls,
  isValidRegistryDigest,
  formatRegistryDigest,
  validateRegistryDependencyGraph,
  freezeDependencyClosure,
  type RegistryItemIdentity,
  type BuiltRegistryItem,
} from "../registry-contract";

const HEX64 = "a".repeat(64);
const DIGEST = `sha256-${HEX64}`;
const id = (over: Partial<RegistryItemIdentity> = {}): RegistryItemIdentity => ({
  namespace: "acme",
  slug: "invoices",
  component: "stat-tile",
  ...over,
});

// ---------------------------------------------------------------------------
// AC2 — namespace grammar + reservation + canonical uniqueness.
// ---------------------------------------------------------------------------
describe("registry namespace grammar", () => {
  it("accepts strict lowercase kebab", () => {
    for (const ns of ["acme", "acme-co", "a1", "a-b-c", "cinatra-ai"]) {
      expect(isValidRegistryNamespace(ns), ns).toBe(true);
      expect(REGISTRY_NAMESPACE_RE.test(ns)).toBe(true);
    }
  });
  it("rejects uppercase, leading/trailing/double hyphen, spaces, symbols, empty", () => {
    for (const ns of ["Acme", "ACME", "-acme", "acme-", "acme--co", "ac me", "acme_co", "@acme", "", "acme/x"]) {
      expect(isValidRegistryNamespace(ns), ns).toBe(false);
    }
  });
  it("the slug token uses the same strict grammar", () => {
    expect(isValidRegistrySlug("invoices")).toBe(true);
    expect(isValidRegistrySlug("Invoices")).toBe(false);
  });
});

describe("reserved + canonical token (case-insensitive)", () => {
  it("cinatra-ai is reserved case-insensitively", () => {
    for (const ns of ["cinatra-ai", "Cinatra-AI", "CINATRA-AI", "cInAtRa-Ai"]) {
      expect(isReservedNamespace(ns), ns).toBe(true);
      expect(isHostNamespace(ns), ns).toBe(true);
    }
    expect(RESERVED_NAMESPACES).toContain(HOST_NAMESPACE);
  });
  it("a non-reserved namespace is not reserved", () => {
    expect(isReservedNamespace("acme")).toBe(false);
    expect(isHostNamespace("acme")).toBe(false);
  });
  it("canonical token is case-folded (uniqueness collides across case)", () => {
    expect(canonicalNamespaceToken("Acme-Co")).toBe("acme-co");
    expect(canonicalNamespaceToken("ACME")).toBe(canonicalNamespaceToken("acme"));
  });
});

describe("canOnboardNamespace", () => {
  it("accepts a fresh valid non-reserved namespace", () => {
    expect(canOnboardNamespace("acme")).toEqual({ ok: true });
  });
  it("rejects grammar, reserved, and already-taken/tombstoned (permanent)", () => {
    expect(canOnboardNamespace("Acme").ok).toBe(false);
    expect(canOnboardNamespace("cinatra-ai").ok).toBe(false);
    expect(canOnboardNamespace("Cinatra-AI").ok).toBe(false); // reserved case-insensitively
    const taken = new Set(["acme"]);
    expect(canOnboardNamespace("acme", taken).ok).toBe(false);
    // canonical fold: an already-taken token blocks a mixed-case request too.
    expect(canOnboardNamespace("ACME", taken).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC2 — identity composition + parse + slug/component split.
// ---------------------------------------------------------------------------
describe("registry item identity", () => {
  it("composes @<ns>/<slug>-<component>", () => {
    expect(formatRegistryItemIdentity(id())).toBe("@acme/invoices-stat-tile");
    expect(registryItemPath(id())).toBe("invoices-stat-tile");
  });
  it("validates each token; throws on a malformed identity", () => {
    expect(isValidRegistryItemIdentity(id())).toBe(true);
    expect(isValidRegistryItemIdentity(id({ namespace: "Acme" }))).toBe(false);
    expect(isValidRegistryItemIdentity(id({ component: "Stat" }))).toBe(false);
    expect(() => formatRegistryItemIdentity(id({ namespace: "Acme" }))).toThrow();
  });
  it("parses the OUTER shape (@ns/path) and rejects malformed strings", () => {
    expect(parseRegistryItemIdentity("@acme/invoices-stat-tile")).toEqual({
      namespace: "acme",
      path: "invoices-stat-tile",
    });
    for (const bad of ["acme/x", "@Acme/x", "@acme", "@acme/", "@acme/UP", "@acme/a b", "@/x"]) {
      expect(parseRegistryItemIdentity(bad), bad).toBeNull();
    }
  });
  it("recovers <component> from a path given the known slug", () => {
    expect(splitPathForSlug("invoices-stat-tile", "invoices")).toEqual({ component: "stat-tile" });
    expect(splitPathForSlug("invoices-stat-tile", "other")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC2 — permanent tombstoning.
// ---------------------------------------------------------------------------
describe("tombstone keys + predicates", () => {
  it("namespace tombstone key is the canonical token", () => {
    expect(namespaceTombstoneKey("Acme-Co")).toBe("acme-co");
  });
  it("identity tombstone key folds the namespace but keeps slug/component", () => {
    expect(identityTombstoneKey(id({ namespace: "ACME" }))).toBe("acme/invoices/stat-tile");
  });
  it("predicates read a caller-supplied append-only set (case-fold-stable)", () => {
    const nsTomb = new Set([namespaceTombstoneKey("acme")]);
    expect(isNamespaceTombstoned("ACME", nsTomb)).toBe(true);
    expect(isNamespaceTombstoned("beta", nsTomb)).toBe(false);
    const idTomb = new Set([identityTombstoneKey(id())]);
    expect(isIdentityTombstoned(id({ namespace: "Acme" }), idTomb)).toBe(true);
    expect(isIdentityTombstoned(id({ component: "meter" }), idTomb)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC4 — serving-URL grammar + host-roster coexistence.
// ---------------------------------------------------------------------------
describe("digest helpers", () => {
  it("accepts a sha256-<64hex> digest, rejects others", () => {
    expect(isValidRegistryDigest(DIGEST)).toBe(true);
    for (const bad of ["sha256-XYZ", "sha1-" + HEX64, HEX64, "sha256-" + "a".repeat(63), ""]) {
      expect(isValidRegistryDigest(bad), bad).toBe(false);
    }
  });
  it("composes + lowercases a digest, throwing on bad hex", () => {
    expect(formatRegistryDigest(HEX64.toUpperCase())).toBe(DIGEST);
    expect(() => formatRegistryDigest("nothex")).toThrow();
  });
});

describe("serving URLs", () => {
  it("flat host-roster URL is unchanged /r/<name>.json", () => {
    expect(flatHostRosterUrl("button")).toBe(`https://${REGISTRY_HOST}/r/button.json`);
  });
  it("immutable digest URL is byte-addressed under /rd/, requires a valid digest", () => {
    expect(immutableDigestUrl(id(), DIGEST)).toBe(
      `https://${REGISTRY_HOST}/rd/acme/invoices-stat-tile/${DIGEST}.json`,
    );
    expect(() => immutableDigestUrl(id(), "sha256-bad")).toThrow();
  });
  it("a NON-host stable-name alias is the namespaced /r/@<ns>/<path>.json", () => {
    expect(stableAliasUrl(id())).toBe(`https://${REGISTRY_HOST}/r/@acme/invoices-stat-tile.json`);
  });
  it("a FIRST-PARTY (cinatra-ai) stable alias rides the EXISTING flat mapping, slug-prefixed", () => {
    const firstParty = id({ namespace: "cinatra-ai", slug: "default", component: "empty-state" });
    expect(stableAliasUrl(firstParty)).toBe(flatHostRosterUrl("default-empty-state"));
    // …so the 14 bare host primitives and slug-prefixed first-party items share
    // ONE flat @cinatra-ai roster without collision (host = bare, ext = slug-prefixed).
    expect(stableAliasUrl(firstParty)).toBe(`https://${REGISTRY_HOST}/r/default-empty-state.json`);
    expect(flatHostRosterUrl("button")).not.toBe(stableAliasUrl(firstParty));
  });
  it("servingUrls: immutable present only with a digest; flatRoster ONLY first-party", () => {
    // third-party (acme): NO flatRoster — a flat /r/<name>.json omits the
    // namespace and would collide across vendors.
    const third = servingUrls(id());
    expect(third.immutable).toBeUndefined();
    expect(third.stableAlias).toBe(stableAliasUrl(id()));
    expect(third.flatRoster).toBeUndefined();
    expect(servingUrls(id(), DIGEST).immutable).toBe(immutableDigestUrl(id(), DIGEST));
    // first-party (cinatra-ai): flatRoster present (== the flat stable alias).
    const host = id({ namespace: "cinatra-ai", slug: "default", component: "empty-state" });
    expect(servingUrls(host).flatRoster).toBe(flatHostRosterUrl("default-empty-state"));
    expect(servingUrls(host).flatRoster).toBe(servingUrls(host).stableAlias);
  });
});

// ---------------------------------------------------------------------------
// AC3 — publish-time dependency-graph validation.
// ---------------------------------------------------------------------------
describe("validateRegistryDependencyGraph", () => {
  const item = (path: string, registryDependencies: string[] = []): BuiltRegistryItem => ({
    path,
    registryDependencies,
  });

  it("accepts a fully-qualified DAG (sibling paths + a published identifier)", () => {
    const items = [
      item("invoices-stat-tile", ["invoices-meter"]),
      item("invoices-meter", ["@acme/shared-utils"]),
    ];
    const published = new Set(["@acme/shared-utils"]);
    expect(validateRegistryDependencyGraph(items, published)).toEqual({ ok: true });
  });

  it("rejects an unqualified registry dependency (neither in batch nor published)", () => {
    const items = [item("invoices-stat-tile", ["invoices-ghost"])];
    const r = validateRegistryDependencyGraph(items);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toMatch(/not fully qualified/);
  });

  it("rejects a direct cycle", () => {
    const items = [item("a", ["b"]), item("b", ["a"])];
    const r = validateRegistryDependencyGraph(items);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toMatch(/cycle/);
  });

  it("rejects a longer cycle a->b->c->a", () => {
    const items = [item("a", ["b"]), item("b", ["c"]), item("c", ["a"])];
    const r = validateRegistryDependencyGraph(items);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toMatch(/cycle/);
  });

  it("resolves a MATCHING-namespace fully-qualified sibling (given the batch namespace)", () => {
    const items = [item("invoices-stat-tile", ["@acme/invoices-meter"]), item("invoices-meter")];
    expect(validateRegistryDependencyGraph(items, new Set(), "acme")).toEqual({ ok: true });
  });

  it("rejects a FOREIGN-namespace fully-qualified dep as an in-batch sibling (codex round-1 fix)", () => {
    // `@other/invoices-meter` path coincides with a batch item, but its namespace
    // differs → NOT an in-batch sibling; it must be a published identifier.
    const items = [item("invoices-stat-tile", ["@other/invoices-meter"]), item("invoices-meter")];
    const r = validateRegistryDependencyGraph(items, new Set(), "acme");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toMatch(/not fully qualified/);
    // …and it resolves cleanly once published as a foreign cross-batch edge.
    expect(
      validateRegistryDependencyGraph(items, new Set(["@other/invoices-meter"]), "acme"),
    ).toEqual({ ok: true });
  });

  it("does NOT forge a cross-namespace cycle via coincidental paths (codex round-1 fix)", () => {
    // a(@acme)->@other/b and b(@acme)->@other/a: namespace-blind matching would
    // read this as an a<->b cycle; with namespace identity they're foreign refs.
    const items = [item("a", ["@other/b"]), item("b", ["@other/a"])];
    expect(
      validateRegistryDependencyGraph(items, new Set(["@other/a", "@other/b"]), "acme"),
    ).toEqual({ ok: true });
  });

  it("without a batch namespace, a namespaced dep resolves ONLY via publishedIdentifiers", () => {
    const items = [item("invoices-stat-tile", ["@acme/invoices-meter"]), item("invoices-meter")];
    // no namespace given → `@acme/invoices-meter` is not an in-batch sibling.
    expect(validateRegistryDependencyGraph(items).ok).toBe(false);
    expect(
      validateRegistryDependencyGraph(items, new Set(["@acme/invoices-meter"])).ok,
    ).toBe(true);
  });

  it("rejects a duplicate path in the batch", () => {
    const items = [item("dup"), item("dup")];
    const r = validateRegistryDependencyGraph(items);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toMatch(/duplicate/);
  });

  it("accepts an item with only npm dependencies (no registry edges)", () => {
    expect(validateRegistryDependencyGraph([{ path: "leaf", dependencies: ["clsx"] }])).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// AC3/AC5 — frozen, digest-pinned dependency closures.
// ---------------------------------------------------------------------------
describe("freezeDependencyClosure", () => {
  const digestFor = (p: string) => formatRegistryDigest((p.length % 10).toString().repeat(64));

  it("pins every closure path to its published digest (frozen, immutable)", () => {
    const r = freezeDependencyClosure("root", ["dep-a", "dep-b"], digestFor);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Object.keys(r.closure.pins).sort()).toEqual(["dep-a", "dep-b", "root"]);
      expect(isValidRegistryDigest(r.closure.pins.root)).toBe(true);
      expect(Object.isFrozen(r.closure.pins)).toBe(true);
    }
  });

  it("rejects a closure path with NO published digest (never discoverable before fetchable)", () => {
    const r = freezeDependencyClosure("root", ["missing"], (p) => (p === "root" ? DIGEST : undefined));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toMatch(/no published digest/);
  });

  it("rejects an invalid digest in the closure", () => {
    const r = freezeDependencyClosure("root", [], () => "sha256-bad");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toMatch(/invalid digest/);
  });
});
