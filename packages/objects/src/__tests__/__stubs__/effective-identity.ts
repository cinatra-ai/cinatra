// Test stub for the host-app effective-identity resolver
// (src/lib/objects/effective-identity.ts). The real module imports
// server-only + postgres reads + the pure @cinatra-ai/objects leaves; it is
// not initialised in the packages/objects vitest sandbox. The graphiti-
// projector imports `resolveArtifactEffectiveIdentity` at top level, so this
// stub makes the specifier resolve with a SAFE default (floor identity, no
// eligible extensions). Behaviour tests override via
// `vi.mock("@/lib/objects/effective-identity", () => ({ ... }))`.

import type { EffectiveIdentity } from "../../effective-identity";

export type { EffectiveIdentity } from "../../effective-identity";

export interface ArtifactIdentityEnrichment {
  identity: EffectiveIdentity;
  eligibleExtensions: string[];
}

export function resolveArtifactEffectiveIdentity(_input: {
  orgId: string;
  artifactId: string;
  baseType: string;
}): ArtifactIdentityEnrichment {
  return {
    identity: { kind: "no-primary" },
    eligibleExtensions: [],
  };
}
