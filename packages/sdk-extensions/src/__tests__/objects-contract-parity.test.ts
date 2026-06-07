// Drift guard for the objects-contract PARALLEL-COPY.
//
// `packages/sdk-extensions/src/objects-contract.ts` is a structural parallel copy
// of the `@cinatra-ai/objects` source-of-truth types (the same pattern as
// `artifact-contract.ts`) so a connector imports object types from the SDK, never
// `@cinatra-ai/objects`. The host binder (src/lib/register-objects-provider.ts)
// casts SDK-typed values to the objects-internal types when calling the real
// registries — that cast is only sound while the two copies stay structurally
// identical.
//
// The mutual-assignability assertions below are COMPILE-TIME (checked by `pnpm
// typecheck` / tsgo): if either copy drifts, this file fails to typecheck. The
// runtime body is trivial so vitest has a green case to run.

import { describe, it, expect } from "vitest";
import type {
  ObjectTypeDefinition as SdkObjectTypeDefinition,
  ObjectSyncAdapter as SdkObjectSyncAdapter,
  StoredObject as SdkStoredObject,
} from "@cinatra-ai/sdk-extensions/objects-contract";
import type {
  ObjectTypeDefinition as ObjObjectTypeDefinition,
  ObjectSyncAdapter as ObjObjectSyncAdapter,
  StoredObject as ObjStoredObject,
} from "@cinatra-ai/objects";

// Compile-time-only — never executed. Each assignment fails to typecheck if the
// SDK copy and the @cinatra-ai/objects source-of-truth diverge (either direction).
// ObjectTypeDefinition parity transitively covers ObjectCategory / ObjectLifecycle
// / ObjectRenderers / RelationDefinition / AutomapCrudPolicy / SemanticArtifactManifest.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function _assertParity(
  sdkDef: SdkObjectTypeDefinition,
  objDef: ObjObjectTypeDefinition,
  sdkAdapter: SdkObjectSyncAdapter,
  objAdapter: ObjObjectSyncAdapter,
  sdkStored: SdkStoredObject,
  objStored: ObjStoredObject,
) {
  const a1: ObjObjectTypeDefinition = sdkDef;
  const a2: SdkObjectTypeDefinition = objDef;
  const b1: ObjObjectSyncAdapter = sdkAdapter;
  const b2: SdkObjectSyncAdapter = objAdapter;
  const c1: ObjStoredObject = sdkStored;
  const c2: SdkStoredObject = objStored;
  return [a1, a2, b1, b2, c1, c2];
}

describe("objects-contract parallel-copy parity (drift guard)", () => {
  it("SDK objects-contract stays structurally identical to @cinatra-ai/objects (compile-time)", () => {
    // The mutual assignments in _assertParity fail to TYPECHECK on drift; this
    // runtime assertion just confirms the suite ran.
    expect(typeof _assertParity).toBe("function");
  });
});
