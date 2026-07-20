// ---------------------------------------------------------------------------
// Owner-axis containment resolver PORT (epic #1883 C1 / #1885; C4 handoff).
//
// C4 (#1884) made mixed-owner-tier child OBO ceiling chains satisfiable IF the
// dispatch seam supplies server-verified `ownerContainments` facts (a narrower
// `user` is a live member of the wider `team`, etc.). C1 supplies those facts by
// resolving LIVE membership at dispatch. Membership lives in the app-layer
// better-auth store, which the leaf `@cinatra-ai/agents` package must not import
// (route-graph + dependency-direction). So the app PUBLISHES a resolver on a
// `globalThis` Symbol.for singleton (the same cross-compilation-safe port pattern
// as `@cinatra-ai/host:extension-object-type-serve/v1`), and this leaf reads it
// off globalThis with NO import edge.
//
// FAIL-CLOSED: when the port is absent (its publisher module never loaded) the
// composer receives NO facts, so a mixed-owner-tier child dispatch fails closed
// with C4's structured `unverified_owner_containment` denial — exactly the safe
// pre-C1 behavior. Single/zero owner-tier chains never consult the resolver.
//
// SNAPSHOT-vs-REVOCATION policy (C1 owns it; codex-converged): the facts are
// resolved LIVE at DISPATCH — the freshest membership read at the moment the
// child run is created — and the resulting collapsed chain is PERSISTED. A
// membership revoked AFTER dispatch is the accepted read-time staleness class
// for run-derived authority (cinatra#1131: a demoted owner's already-resolved
// authority replays until re-resolved); the persisted collapsed chain is the
// dispatch-time authority. Mint (`oboCeilingContains`) re-checks the child's own
// freshly re-derived anchor against the persisted (collapsed) chain structurally
// — it does NOT re-resolve live membership, matching how the rest of the OBO
// system treats the persisted chain. Tightening this to mint-time re-resolution
// would require a shared membership↔mint transaction and is deliberately out of
// C1's scope (noted for a future hardening slice).
// ---------------------------------------------------------------------------
import type {
  OboCeiling,
  OboOwnerContainment,
} from "@cinatra-ai/mcp-server/obo-ceiling";

const OWNER_CONTAINMENT_RESOLVER_KEY = Symbol.for(
  "@cinatra-ai/host:owner-containment-resolver/v1",
);

/** Server-side resolver: given the owner-axis elements present in a composed
 *  chain (+ the org they share), return every VERIFIED containment fact among
 *  them. Only facts whose both endpoints are proven are returned; the composer
 *  fails closed on any pair left unrelated. */
export type OwnerContainmentResolver = (input: {
  orgId: string;
  ownerElements: OboCeiling[];
}) => Promise<OboOwnerContainment[]>;

type Holder = { [k: symbol]: OwnerContainmentResolver | undefined };

/** Read the globalThis-published resolver (or `undefined` when its publisher
 *  module never loaded — the fail-closed path). */
export function readOwnerContainmentResolver(): OwnerContainmentResolver | undefined {
  return (globalThis as unknown as Holder)[OWNER_CONTAINMENT_RESOLVER_KEY];
}

/** Publish a resolver on the globalThis singleton. The app boot seam calls this
 *  (or assigns the symbol directly, as the sibling serve-port publisher does);
 *  tests use it to install a stub and reset with `undefined`. */
export function publishOwnerContainmentResolver(
  resolver: OwnerContainmentResolver | undefined,
): void {
  (globalThis as unknown as Holder)[OWNER_CONTAINMENT_RESOLVER_KEY] = resolver;
}
