// Extensible shadcn registry — vendor IDENTITY grammar, tombstone contract,
// serving-URL grammar, and publish-time dependency-graph validation
// (cinatra#1623, epic #1620 S5).
//
// This is the APP-REPO / author-facing CONTRACT for the extension-contributed
// registry. It is a SCHEMA-ONLY, host-neutral leaf (no host imports, no IO, no
// running server): the marketplace publish pipeline + the registry host
// (owned by the publishing infrastructure) CONSUME these grammars and
// predicates. The extension's DECLARATION surface (`registryItems`) lives in the
// sibling leaf `./artifact-contract`; the `<component>` token grammar is shared
// from there so a composed identity is a single strict slug.
//
// Serving model (AC4/AC5): a published item is fetchable at THREE URL classes
// that coexist with the existing flat host roster —
//   1. flat host-roster URL   `/r/<name>.json`           (EXISTING, unchanged)
//   2. canonical immutable URL `/rd/<ns>/<path>/<digest>.json` (byte-repro forever, never 404s)
//   3. stable-name alias URL   `/r/@<ns>/<path>.json`     (explicitly-mutable, append-only pointer history)
// First-party (`cinatra-ai`) items ride class 1 (the flat mapping), slug-
// prefixed — so the 14 host primitives (bare names) and first-party extension
// items (slug-prefixed names) share ONE flat roster without collision.

import { isValidRegistryComponentName } from "./artifact-contract";

// ===========================================================================
// AC2 — vendor identity grammar.
// ===========================================================================

/**
 * `registryNamespace` grammar: STRICT lowercase kebab (a leading alnum segment,
 * hyphen-joined alnum segments). Same shape as the `<slug>`/`<component>`
 * tokens, so the whole `@<ns>/<slug>-<component>` identifier is one strict slug.
 * Immutability + onboarding-time assignment are enforced by the vendor-onboarding
 * store (this is the grammar the store validates against).
 */
export const REGISTRY_NAMESPACE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The `<slug>` (extension-slug) token grammar — identical strict-lowercase. */
export const REGISTRY_SLUG_RE = REGISTRY_NAMESPACE_RE;

/** True iff `ns` is grammatically a valid `registryNamespace`. */
export function isValidRegistryNamespace(ns: unknown): boolean {
  return typeof ns === "string" && REGISTRY_NAMESPACE_RE.test(ns);
}

/** True iff `slug` is a grammatically valid extension `<slug>` token. */
export function isValidRegistrySlug(slug: unknown): boolean {
  return typeof slug === "string" && REGISTRY_SLUG_RE.test(slug);
}

/**
 * The CANONICAL token for a namespace, used for uniqueness + reservation +
 * tombstone comparison. Canonicalization is case-folding: two namespaces
 * COLLIDE iff their canonical tokens are equal (`cinatra-ai`/`Cinatra-AI`/
 * `CINATRA-AI` are the same namespace). The stored/served form is always the
 * strict-lowercase grammar; this fold makes the reservation + uniqueness
 * checks robust to a mixed-case onboarding request.
 */
export function canonicalNamespaceToken(ns: string): string {
  return String(ns).toLowerCase();
}

/**
 * The host + first-party reserved namespace. Reserved CASE-INSENSITIVELY (via
 * the canonical token) so no vendor can onboard `Cinatra-AI`, `CINATRA-AI`, etc.
 * First-party items publish under the FLAT `@cinatra-ai` mapping (slug-prefixed)
 * — see {@link servingUrls}.
 */
export const HOST_NAMESPACE = "cinatra-ai";

/**
 * Reserved namespaces — a vendor onboarding request whose canonical token is in
 * this set is REJECTED. A list (not just the host) so the reservation surface
 * can grow without a call-site change.
 */
export const RESERVED_NAMESPACES = [HOST_NAMESPACE] as const;

const RESERVED_NAMESPACE_TOKENS: ReadonlySet<string> = new Set(
  RESERVED_NAMESPACES.map(canonicalNamespaceToken),
);

/** True iff `ns` is reserved (case-insensitively) — not vendor-onboardable. */
export function isReservedNamespace(ns: string): boolean {
  return RESERVED_NAMESPACE_TOKENS.has(canonicalNamespaceToken(ns));
}

/** True iff `ns` is the host / first-party namespace (case-insensitively). */
export function isHostNamespace(ns: string): boolean {
  return canonicalNamespaceToken(ns) === HOST_NAMESPACE;
}

/**
 * A vendor namespace is ONBOARDABLE iff it is grammatically valid, not reserved,
 * and its canonical token is not already tombstoned/taken. `taken` is the
 * caller-supplied set of already-assigned/tombstoned CANONICAL tokens (the
 * onboarding store owns the append-only set; this is the pure predicate).
 */
export function canOnboardNamespace(
  ns: string,
  taken: ReadonlySet<string> = new Set(),
): { ok: true } | { ok: false; reason: string } {
  if (!isValidRegistryNamespace(ns)) {
    return { ok: false, reason: "namespace must be strict lowercase kebab ([a-z0-9], hyphen-joined)" };
  }
  if (isReservedNamespace(ns)) {
    return { ok: false, reason: `namespace "${canonicalNamespaceToken(ns)}" is reserved` };
  }
  if (taken.has(canonicalNamespaceToken(ns))) {
    return { ok: false, reason: `namespace "${canonicalNamespaceToken(ns)}" is already assigned or tombstoned (permanent)` };
  }
  return { ok: true };
}

/**
 * A registry-item identity triple. The full published identifier is
 * `@<namespace>/<slug>-<component>`; kept as a triple (not a parsed string)
 * because the `<slug>`/`<component>` boundary is only recoverable with the
 * known extension slug — CONSTRUCTION is the canonical direction.
 */
export type RegistryItemIdentity = {
  namespace: string;
  slug: string;
  component: string;
};

/** True iff every token of the triple is grammatically valid. */
export function isValidRegistryItemIdentity(id: RegistryItemIdentity): boolean {
  return (
    isValidRegistryNamespace(id.namespace) &&
    isValidRegistrySlug(id.slug) &&
    isValidRegistryComponentName(id.component)
  );
}

/**
 * Compose the canonical published identifier `@<namespace>/<slug>-<component>`.
 * Throws on an invalid token — a malformed identity must never be minted.
 */
export function formatRegistryItemIdentity(id: RegistryItemIdentity): string {
  if (!isValidRegistryItemIdentity(id)) {
    throw new Error(
      `invalid registry item identity {namespace:${JSON.stringify(id.namespace)}, slug:${JSON.stringify(
        id.slug,
      )}, component:${JSON.stringify(id.component)}}`,
    );
  }
  return `@${id.namespace}/${id.slug}-${id.component}`;
}

/**
 * The `<slug>-<component>` path segment (the part after the `@<ns>/`).
 */
export function registryItemPath(id: Pick<RegistryItemIdentity, "slug" | "component">): string {
  return `${id.slug}-${id.component}`;
}

/**
 * OUTER parse of a published identifier string `@<namespace>/<path>` — validates
 * the shape and extracts the namespace + the `<slug>-<component>` path. The
 * slug/component split is NOT attempted here: it is ambiguous without the known
 * extension slug (which the pipeline supplies). Use {@link splitPathForSlug} to
 * finish the split against a known slug. Returns null on a malformed string.
 */
export function parseRegistryItemIdentity(
  identifier: string,
): { namespace: string; path: string } | null {
  if (typeof identifier !== "string" || !identifier.startsWith("@")) return null;
  const slash = identifier.indexOf("/");
  if (slash < 0) return null;
  const namespace = identifier.slice(1, slash);
  const path = identifier.slice(slash + 1);
  if (!isValidRegistryNamespace(namespace)) return null;
  // The path is a single strict slug (`<slug>-<component>` is one kebab token).
  if (!REGISTRY_NAMESPACE_RE.test(path)) return null;
  return { namespace, path };
}

/**
 * Given a `<slug>-<component>` path and the KNOWN extension `<slug>`, recover the
 * `<component>`. Returns null when the path does not start with `<slug>-`.
 */
export function splitPathForSlug(path: string, slug: string): { component: string } | null {
  const prefix = `${slug}-`;
  if (!path.startsWith(prefix)) return null;
  const component = path.slice(prefix.length);
  return isValidRegistryComponentName(component) ? { component } : null;
}

// ===========================================================================
// AC2 — permanent tombstoning of namespaces AND (ns, slug, item) identifiers.
// ===========================================================================

/**
 * The tombstone key for a namespace — its canonical token. The onboarding store
 * keeps an APPEND-ONLY set of these; a tombstoned namespace is never reassigned.
 */
export function namespaceTombstoneKey(ns: string): string {
  return canonicalNamespaceToken(ns);
}

/**
 * The tombstone key for a `(ns, slug, item)` identifier —
 * `<canonical-ns>/<slug>/<component>`. Uses the canonical namespace token so the
 * key is case-fold-stable; slug/component are already strict-lowercase.
 */
export function identityTombstoneKey(id: RegistryItemIdentity): string {
  return `${canonicalNamespaceToken(id.namespace)}/${id.slug}/${id.component}`;
}

/** True iff `ns` is in the caller-supplied append-only namespace tombstone set. */
export function isNamespaceTombstoned(ns: string, tombstones: ReadonlySet<string>): boolean {
  return tombstones.has(namespaceTombstoneKey(ns));
}

/** True iff the identity is in the caller-supplied append-only identity tombstone set. */
export function isIdentityTombstoned(
  id: RegistryItemIdentity,
  tombstones: ReadonlySet<string>,
): boolean {
  return tombstones.has(identityTombstoneKey(id));
}

// ===========================================================================
// AC4 — serving-URL grammar (host-roster coexistence).
// ===========================================================================

/** The public registry host (matches `registry.json` homepage + components.json). */
export const REGISTRY_HOST = "registry.cinatra.ai";

/** `sha256` content-digest algorithm for the immutable class. */
export const REGISTRY_DIGEST_ALGO = "sha256";

/** A `sha256-<hex>` digest string: 64 lowercase hex chars. */
export const REGISTRY_DIGEST_RE = /^sha256-[0-9a-f]{64}$/;

/** True iff `digest` is a well-formed `sha256-<64-hex>` content digest. */
export function isValidRegistryDigest(digest: unknown): boolean {
  return typeof digest === "string" && REGISTRY_DIGEST_RE.test(digest);
}

/** Compose a `sha256-<hex>` digest from a lowercase 64-char hex string. */
export function formatRegistryDigest(hex: string): string {
  const digest = `${REGISTRY_DIGEST_ALGO}-${String(hex).toLowerCase()}`;
  if (!isValidRegistryDigest(digest)) {
    throw new Error(`invalid ${REGISTRY_DIGEST_ALGO} hex digest: ${JSON.stringify(hex)}`);
  }
  return digest;
}

/**
 * The EXISTING flat host-roster URL `/r/<name>.json` — unchanged. The 14 host
 * primitives (`button`, `card`, …) keep resolving here byte-for-byte; first-
 * party extension items reuse it slug-prefixed (`<slug>-<component>`).
 */
export function flatHostRosterUrl(name: string): string {
  return `https://${REGISTRY_HOST}/r/${name}.json`;
}

/**
 * The canonical IMMUTABLE, digest-addressed URL — byte-reproducible forever, a
 * published digest URL never 404s. Distinct `/rd/` (registry-digest) prefix so
 * an immutable blob can never collide with a mutable `/r/` alias and is trivially
 * cache-forever. (A published-VERSION pin is the same immutable class keyed by an
 * immutable published id in place of the digest; digest is the byte-exact form.)
 */
export function immutableDigestUrl(id: RegistryItemIdentity, digest: string): string {
  if (!isValidRegistryDigest(digest)) {
    throw new Error(`immutableDigestUrl requires a valid ${REGISTRY_DIGEST_ALGO} digest; got ${JSON.stringify(digest)}`);
  }
  return `https://${REGISTRY_HOST}/rd/${id.namespace}/${registryItemPath(id)}/${digest}.json`;
}

/**
 * The EXPLICITLY-MUTABLE stable-name alias — an append-only pointer whose target
 * digest may advance under compatibility-only evolution (AC5). For a first-party
 * (`cinatra-ai`) item this IS the flat host-roster URL (slug-prefixed), so the
 * first-party alias shares the existing flat `@cinatra-ai` roster; for any other
 * namespace it is the namespaced `/r/@<ns>/<path>.json` form.
 */
export function stableAliasUrl(id: RegistryItemIdentity): string {
  const path = registryItemPath(id);
  if (isHostNamespace(id.namespace)) {
    return flatHostRosterUrl(path);
  }
  return `https://${REGISTRY_HOST}/r/@${id.namespace}/${path}.json`;
}

/**
 * Every serving URL class for a published item — the coexistence surface AC4
 * names. `immutable` is present only when a digest is supplied (an item is
 * digest-pinned at publication). `flatRoster` is present ONLY for a first-party
 * (`cinatra-ai`) item (codex convergence, round 1): the flat `/r/<name>.json`
 * roster omits the namespace, so exposing it for a third-party item would let
 * two vendors with the same `<slug>-<component>` collide in one flat namespace —
 * a third-party item's serving surface is its namespaced `stableAlias` +
 * `immutable` digest URL, never the flat roster.
 */
export function servingUrls(
  id: RegistryItemIdentity,
  digest?: string,
): { stableAlias: string; immutable?: string; flatRoster?: string } {
  return {
    stableAlias: stableAliasUrl(id),
    ...(digest !== undefined ? { immutable: immutableDigestUrl(id, digest) } : {}),
    ...(isHostNamespace(id.namespace) ? { flatRoster: flatHostRosterUrl(registryItemPath(id)) } : {}),
  };
}

// ===========================================================================
// AC3 — publish-time dependency-graph validation (observable guarantees).
// ===========================================================================

/**
 * The BUILT registry-item shape the publish pipeline validates (the shadcn
 * `build` output — npm `dependencies` + `registryDependencies` are extracted
 * from the item's SOURCE, not the manifest declaration). `registryDependencies`
 * are references to OTHER registry items (by their `<slug>-<component>` path
 * within the batch, or a fully-qualified `@<ns>/<path>` identifier).
 */
export type BuiltRegistryItem = {
  /** The item's `<slug>-<component>` path (its key within a publish batch). */
  path: string;
  /** npm package specifiers (public npm only — presentational deps). */
  dependencies?: string[];
  /** references to other registry items. */
  registryDependencies?: string[];
};

export type RegistryDependencyGraphResult =
  | { ok: true }
  | { ok: false; errors: string[] };

/**
 * Validate a publish batch's registry-item dependency graph (AC3): every
 * `registryDependencies` edge must be FULLY QUALIFIED (resolvable to a sibling
 * item in the batch, or a `@<ns>/<path>` identifier that is already published —
 * supplied via `publishedIdentifiers`), and the graph must be a DAG (cycles
 * REJECTED). This is the pure predicate the pipeline runs before it freezes +
 * digest-pins a closure; it never fetches bytes.
 *
 * NAMESPACE IDENTITY (codex convergence, round 1): a publish batch belongs to
 * ONE vendor `namespace`. Batch items are keyed only by their `<slug>-<component>`
 * PATH, so a fully-qualified `@<ns>/<path>` dep is treated as an in-batch sibling
 * ONLY when `<ns>` matches the batch's namespace (case-folded) — otherwise a
 * FOREIGN `@other/<path>` whose path coincides with a batch item's would be
 * wrongly accepted as a sibling and could forge a cross-namespace cycle edge. A
 * bare `<path>` (no namespace) always refers to a batch sibling. When `namespace`
 * is omitted, a namespaced dep can ONLY resolve via `publishedIdentifiers`
 * (never in-batch) — the conservative, fail-closed default.
 *
 * @param items                 the batch's built items (unique `path`s).
 * @param publishedIdentifiers  already-published `@<ns>/<path>` identifiers a
 *                              cross-batch edge may resolve to (default empty).
 * @param namespace             the batch's vendor namespace (enables in-batch
 *                              resolution of a matching-namespace `@ns/path` dep).
 */
export function validateRegistryDependencyGraph(
  items: BuiltRegistryItem[],
  publishedIdentifiers: ReadonlySet<string> = new Set(),
  namespace?: string,
): RegistryDependencyGraphResult {
  const errors: string[] = [];
  const byPath = new Map<string, BuiltRegistryItem>();
  for (const item of items) {
    if (byPath.has(item.path)) {
      errors.push(`duplicate registry item path "${item.path}" in the publish batch`);
    }
    byPath.set(item.path, item);
  }
  const batchToken = namespace !== undefined ? canonicalNamespaceToken(namespace) : undefined;

  // The batch PATH a dep resolves to as an in-batch sibling, or null: a bare
  // `<path>` matches directly; a `@<ns>/<path>` identifier matches ONLY when its
  // namespace equals the batch namespace (case-folded).
  const inBatchPath = (dep: string): string | null => {
    if (byPath.has(dep)) return dep; // bare `<slug>-<component>` sibling
    const parsed = parseRegistryItemIdentity(dep);
    if (
      parsed !== null &&
      batchToken !== undefined &&
      canonicalNamespaceToken(parsed.namespace) === batchToken &&
      byPath.has(parsed.path)
    ) {
      return parsed.path;
    }
    return null;
  };

  // 1. Fully-qualified: every registry dep resolves in-batch or is already published.
  for (const item of items) {
    for (const dep of item.registryDependencies ?? []) {
      if (typeof dep !== "string" || dep.length === 0) {
        errors.push(`"${item.path}" declares a malformed registryDependency ${JSON.stringify(dep)}`);
        continue;
      }
      const qualified = parseRegistryItemIdentity(dep) !== null;
      if (inBatchPath(dep) !== null) continue;
      if (qualified && publishedIdentifiers.has(dep)) continue;
      errors.push(
        `"${item.path}" declares registryDependency "${dep}" that is neither a sibling in the batch ` +
          `nor an already-published identifier — dependency graph is not fully qualified.`,
      );
    }
  }

  // 2. DAG: reject any cycle among the in-batch edges.
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const p of byPath.keys()) color.set(p, WHITE);

  const siblingEdges = (item: BuiltRegistryItem): string[] => {
    const out: string[] = [];
    for (const dep of item.registryDependencies ?? []) {
      const target = inBatchPath(dep);
      if (target !== null) out.push(target);
    }
    return out;
  };

  const stack: string[] = [];
  let cycleFound = false;
  const visit = (path: string): void => {
    if (cycleFound) return;
    color.set(path, GRAY);
    stack.push(path);
    for (const next of siblingEdges(byPath.get(path)!)) {
      if (color.get(next) === GRAY) {
        const from = stack.indexOf(next);
        const cycle = [...stack.slice(from), next].join(" -> ");
        errors.push(`registry-item dependency cycle: ${cycle}`);
        cycleFound = true;
        break;
      }
      if (color.get(next) === WHITE) visit(next);
      if (cycleFound) break;
    }
    stack.pop();
    color.set(path, BLACK);
  };
  for (const p of byPath.keys()) {
    if (color.get(p) === WHITE) visit(p);
    if (cycleFound) break;
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/**
 * A digest-pinned, FROZEN dependency closure (AC3: "dependency closures frozen
 * at publication — a root validated once can never later resolve different
 * dependency bytes"). Maps every item PATH in the root's closure to the exact
 * `sha256-…` digest published for it. Byte-reproducibility per digest URL (AC5)
 * is guaranteed by resolving the closure only through these pins.
 */
export type PinnedRegistryClosure = {
  root: string;
  pins: Readonly<Record<string, string>>;
};

/**
 * Freeze a root item's dependency closure into digest pins. `digestOf` supplies
 * the published digest for each path in the closure; a missing/invalid digest is
 * an error (an item is never discoverable before it is fetchable — every path in
 * the frozen closure must already have a published digest). Returns the immutable
 * pin map the serving layer resolves through.
 */
export function freezeDependencyClosure(
  root: string,
  closurePaths: Iterable<string>,
  digestOf: (path: string) => string | undefined,
): { ok: true; closure: PinnedRegistryClosure } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const pins: Record<string, string> = {};
  const paths = new Set<string>([root, ...closurePaths]);
  for (const path of paths) {
    const digest = digestOf(path);
    if (digest === undefined) {
      errors.push(`closure path "${path}" has no published digest — cannot freeze (would be discoverable before fetchable)`);
      continue;
    }
    if (!isValidRegistryDigest(digest)) {
      errors.push(`closure path "${path}" has an invalid digest ${JSON.stringify(digest)}`);
      continue;
    }
    pins[path] = digest;
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, closure: { root, pins: Object.freeze(pins) } };
}
