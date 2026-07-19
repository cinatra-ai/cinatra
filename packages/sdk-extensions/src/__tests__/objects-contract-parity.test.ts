// Drift guard for the objects-contract + artifact-contract PARALLEL-COPIES.
//
// `packages/sdk-extensions/src/objects-contract.ts` and `./artifact-contract.ts`
// are structural parallel copies of the `@cinatra-ai/objects` source-of-truth
// types so a connector / artifact pack imports these types from the SDK, never
// `@cinatra-ai/objects`. The host binder (src/lib/register-objects-provider.ts)
// casts SDK-typed values to the objects-internal types when calling the real
// registries — that cast is only sound while the two copies stay structurally
// identical.
//
// The assertions below are COMPILE-TIME (checked by `pnpm typecheck` / tsgo): if
// either copy drifts, this file fails to typecheck. The runtime body is trivial
// so vitest has a green case to run.
//
// TWO complementary mechanisms — one alone is insufficient:
//  1. Mutual VARIABLE assignment (`_assertParity`): catches a missing/added
//     REQUIRED field and any mismatched SHARED-field shape, at ALL depths.
//  2. Exact KEY-SET parity (`KeysExact` assertions): catches a dropped/added
//     OPTIONAL field at each named contract level. The variable-assignment trick
//     in (1) is BLIND to optional-field drift — a value lacking an optional field
//     still satisfies the wider type, and a variable (not a fresh literal) gets
//     no excess-property check, so both directions typecheck while the shapes
//     have actually diverged by an optional field (the cinatra#1846 gap:
//     `objectTypes` / `objectTypeId` were missing from the SDK copy for months
//     while this guard stayed green). `keyof` INCLUDES optional keys, so an
//     exact key-set comparison is sensitive to exactly that class of drift.

import { describe, it, expect } from "vitest";
import type {
  ObjectTypeDefinition as SdkObjectTypeDefinition,
  ObjectSyncAdapter as SdkObjectSyncAdapter,
  StoredObject as SdkStoredObject,
} from "@cinatra-ai/sdk-extensions/objects-contract";
import type {
  SemanticArtifactManifest as SdkSemanticArtifactManifest,
  SemanticArtifactRef as SdkSemanticArtifactRef,
} from "@cinatra-ai/sdk-extensions/artifact-contract";
import type {
  ObjectTypeDefinition as ObjObjectTypeDefinition,
  ObjectSyncAdapter as ObjObjectSyncAdapter,
  StoredObject as ObjStoredObject,
  SemanticArtifactManifest as ObjSemanticArtifactManifest,
  SemanticArtifactRef as ObjSemanticArtifactRef,
} from "@cinatra-ai/objects";

// ---------------------------------------------------------------------------
// Mechanism 1 — mutual variable assignment (required-field + shared-shape drift).
//
// Compile-time-only — never executed. Each assignment fails to typecheck if the
// SDK copy and the @cinatra-ai/objects source-of-truth diverge (either
// direction). ObjectTypeDefinition parity transitively covers ObjectCategory /
// ObjectLifecycle / ObjectRenderers / RelationDefinition / AutomapCrudPolicy /
// SemanticArtifactManifest; the artifact manifest + ref are ALSO asserted
// DIRECTLY below so the guard does not rely on incidental transitive coverage
// (the manifest is only reached transitively via `ObjectTypeDefinition.isArtifact`).
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function _assertParity(
  sdkDef: SdkObjectTypeDefinition,
  objDef: ObjObjectTypeDefinition,
  sdkAdapter: SdkObjectSyncAdapter,
  objAdapter: ObjObjectSyncAdapter,
  sdkStored: SdkStoredObject,
  objStored: ObjStoredObject,
  sdkManifest: SdkSemanticArtifactManifest,
  objManifest: ObjSemanticArtifactManifest,
  sdkRef: SdkSemanticArtifactRef,
  objRef: ObjSemanticArtifactRef,
) {
  const a1: ObjObjectTypeDefinition = sdkDef;
  const a2: SdkObjectTypeDefinition = objDef;
  const b1: ObjObjectSyncAdapter = sdkAdapter;
  const b2: SdkObjectSyncAdapter = objAdapter;
  const c1: ObjStoredObject = sdkStored;
  const c2: SdkStoredObject = objStored;
  const d1: ObjSemanticArtifactManifest = sdkManifest;
  const d2: SdkSemanticArtifactManifest = objManifest;
  const e1: ObjSemanticArtifactRef = sdkRef;
  const e2: SdkSemanticArtifactRef = objRef;
  return [a1, a2, b1, b2, c1, c2, d1, d2, e1, e2];
}

// ---------------------------------------------------------------------------
// Mechanism 2 — exact key-set parity (optional-field drift).

/** Compiles iff `T` is exactly `true`; `AssertTrue<false>` is a type error. */
type AssertTrue<T extends true> = T;

/**
 * Exact key-set equality, OPTIONAL-SENSITIVE. `keyof` includes optional keys,
 * so dropping (or adding) an optional field on either side changes the key
 * union and breaks one of the two directions → `false` → the `AssertTrue` wrap
 * fails to typecheck. The tuple-wrapped `extends` avoids union distribution.
 * Sound for the closed, non-union object contracts asserted here (no index
 * signatures on these types, which would otherwise mask named-key drift).
 */
type KeysExact<A, B> = [keyof A] extends [keyof B]
  ? [keyof B] extends [keyof A]
    ? true
    : false
  : false;

/**
 * Guarded property access — `never` when `K` is absent from `T` — so threading
 * the nested claim/disposition shapes off a contract stays a clean type
 * expression even mid-mutation (rather than a raw "property does not exist"
 * error), keeping the top-level `KeysExact` assertions the load-bearing signal.
 */
type Prop<T, K extends PropertyKey> = K extends keyof T ? T[K] : never;
type ElementOf<T> = NonNullable<T> extends readonly (infer U)[] ? U : never;

// Thread the nested claim + disposition shapes off the PUBLIC manifest export
// via guarded indexed access — no new `@cinatra-ai/objects` exports needed.
type SdkClaim = ElementOf<Prop<SdkSemanticArtifactManifest, "objectTypes">>;
type ObjClaim = ElementOf<Prop<ObjSemanticArtifactManifest, "objectTypes">>;
type SdkDisposition = NonNullable<Prop<SdkClaim, "dispositions">>;
type ObjDisposition = NonNullable<Prop<ObjClaim, "dispositions">>;

// These fail to TYPECHECK the instant an optional field is dropped/added on
// either copy at the named level (cinatra#1846). Kept as exported type aliases
// so tsgo evaluates them.
export type _ParityManifestKeys = AssertTrue<
  KeysExact<SdkSemanticArtifactManifest, ObjSemanticArtifactManifest>
>;
export type _ParityRefKeys = AssertTrue<
  KeysExact<SdkSemanticArtifactRef, ObjSemanticArtifactRef>
>;
export type _ParityClaimKeys = AssertTrue<KeysExact<SdkClaim, ObjClaim>>;
export type _ParityDispositionKeys = AssertTrue<
  KeysExact<SdkDisposition, ObjDisposition>
>;

describe("objects/artifact-contract parallel-copy parity (drift guard)", () => {
  it("SDK contracts stay structurally identical to @cinatra-ai/objects (compile-time)", () => {
    // The mutual assignments in _assertParity and the KeysExact aliases fail to
    // TYPECHECK on drift; this runtime assertion just confirms the suite ran.
    expect(typeof _assertParity).toBe("function");
  });
});
