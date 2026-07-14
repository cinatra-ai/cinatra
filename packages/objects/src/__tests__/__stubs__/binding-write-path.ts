// Test stub for the host-app binding write path
// (src/lib/objects/binding-write-path.ts). The real module imports server-only
// + postgres reads; it is not initialised in the packages/objects vitest
// sandbox. `src/lib/objects-store.ts` (aliased to real source here) imports
// `reconcileArtifactBindingForWrite` at top level and calls it after every
// object write, so this stub makes the specifier resolve with a SAFE no-op
// (the sandbox has no claim registry, so a real reconcile would be a no-op
// anyway). Behaviour tests override via
// `vi.mock("@/lib/objects/binding-write-path", () => ({ ... }))`.

export interface ReconcileArtifactBindingResult {
  archived: number;
  inserted: number;
  changed: boolean;
}

export function reconcileArtifactBindingForWrite(_input: {
  orgId: string | null;
  artifactId: string;
  type: string;
}): ReconcileArtifactBindingResult {
  return { archived: 0, inserted: 0, changed: false };
}

export function reconcileArtifactBinding(_input: {
  orgId: string;
  artifactId: string;
}): ReconcileArtifactBindingResult {
  return { archived: 0, inserted: 0, changed: false };
}

export function readActiveBinding(_orgId: string, _artifactId: string): null {
  return null;
}
