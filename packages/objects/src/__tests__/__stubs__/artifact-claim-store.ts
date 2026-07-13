// Test stub for the host-app artifact-claim registry read primitive
// (src/lib/objects/artifact-claim-store.ts). The real module imports
// server-only + postgres-config/schema-init/sync and is not initialised in
// the packages/objects vitest sandbox. The graphiti-projector / graphiti-
// rebuild modules import `readArtifactTypeClaimsForOrg` at top level, so this
// stub only has to make the specifier resolve with a SAFE default (no claims
// ⇒ the projector keeps its pre-claim path). Behaviour tests override via
// `vi.mock("@/lib/objects/artifact-claim-store", () => ({ ... }))`.

import type { ArbitrableClaim } from "../../claims";

export interface ArtifactTypeClaimRow extends ArbitrableClaim {
  installId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export function readArtifactTypeClaimsForOrg(_orgId: string): ArtifactTypeClaimRow[] {
  return [];
}
