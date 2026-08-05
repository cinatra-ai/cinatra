// Test stub for the host-app draftable write-path lock
// (src/lib/objects/draftable-lock-gate.ts). Same shape and rationale as the
// claim-activation-gate stub beside it: the real module imports `server-only`
// AND `@/lib/artifacts/publication-ledger`, which builds a pooled pg client at
// module load — not initialisable in the packages/objects vitest sandbox.
//
// `src/mcp/handlers.ts` reaches it through a DYNAMIC import inside
// `enforceDraftableLock`, so the specifier is resolved when a write handler
// runs rather than at collection time. That is why its absence did not fail
// collection: eight handler suites went red at ASSERTION time with
// `Cannot find package '@/lib/objects/draftable-lock-gate'`, which is the state
// this package's suites were in for as long as they had no CI runner
// (cinatra#2439).
//
// SAFE SANDBOX DEFAULT, and a truthful one. The real gate is a no-op unless the
// winning claim for the type declares `mutability: "draftable"`, and it resolves
// that claim through `readArtifactTypeClaimsForOrg` — which this package ALREADY
// stubs (`@/lib/objects/artifact-claim-store`) to a no-claims reader. So under
// this sandbox the real module returns early on every call, and this stub is
// behaviourally identical to it rather than a weakening of it.
//
// A behaviour test for the lock itself belongs with the gate's own suite in the
// host tree (src/lib/objects/__tests__/), or must `vi.mock` this specifier with
// its own factory — exactly the convention the claim-activation-gate stub
// records. No packages/objects suite asserts draftable-lock behaviour today, so
// nothing here is made vacuous by the default.

export type DraftLockState = "scheduled" | "published" | "failed";

export class DraftLockedError extends Error {
  readonly objectTypeId: string;
  readonly artifactId: string;
  readonly lockState: DraftLockState;

  constructor(input: {
    objectTypeId: string;
    artifactId: string;
    lockState: DraftLockState;
  }) {
    super(
      `artifact '${input.artifactId}' of type '${input.objectTypeId}' is locked (${input.lockState}) — draftable content edits are permitted only while it is a draft`,
    );
    this.name = "DraftLockedError";
    this.objectTypeId = input.objectTypeId;
    this.artifactId = input.artifactId;
    this.lockState = input.lockState;
  }
}

export async function assertDraftableWriteAllowed(_input: {
  orgId: string | null;
  objectTypeId: string;
  artifactId: string;
}): Promise<void> {
  // No claim registry in this sandbox ⇒ no type resolves to `draftable` ⇒ the
  // real gate returns without reading the ledger. Mirrored exactly.
}
