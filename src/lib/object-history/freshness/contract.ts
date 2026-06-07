// External freshness contract.
//
// Five-state contract: unsupported, unknown, missing, changed, fresh.
// Restore decision semantics:
//   - `fresh`       -> restore allowed
//   - `changed`     -> block automatic restore; surface as VersionConflict
//   - `missing`     -> block restore (remote source-of-truth is gone)
//   - `unknown`     -> block automatic restore (non-silent warning); user
//                      may force via dedicated platform-admin tool
//   - `unsupported` -> ALLOWED only for non-CMS-tagged objects (no remote
//                      source-of-truth to consult). CMS-tagged objects
//                      whose connector returns `unsupported` block
//                      because we can't know whether the remote diverged.

export type FreshnessState =
  | { state: "unsupported" }
  | { state: "unknown"; reason?: string }
  | { state: "missing" }
  | {
      state: "changed";
      baseRevision: string;
      changedFields?: readonly string[];
    }
  | { state: "fresh"; baseRevision: string };

export type FreshnessAdapter = {
  // Name of the connector (e.g. "wordpress", "drupal"). Used in logs +
  // surface in the UI.
  connectorName: string;
  // Probe the remote source for the object identified by objectId. Should
  // resolve quickly (<3s); slow probes should resolve with `state: "unknown"`.
  check(args: {
    objectId: string;
    orgId: string | null;
    // The local snapshot's representation of the remote pointer
    // (RemoteRevisionRef captured at write-time). Passing this is
    // mandatory for the connector to identify which remote row to look
    // up — the local objectId is NOT the remote id.
    remoteRevisionRef: {
      connector: string;
      kind: string;
      remoteId: string;
      revisionId?: string;
      modifiedAt?: string;
    } | null;
  }): Promise<FreshnessState>;
};

// Registry: connectorName -> FreshnessAdapter. WordPress is the reference
// adapter. Other connectors register themselves in their own milestones.
const REGISTRY = new Map<string, FreshnessAdapter>();

export function registerFreshnessAdapter(adapter: FreshnessAdapter): void {
  REGISTRY.set(adapter.connectorName, adapter);
}

export function getFreshnessAdapter(
  connectorName: string,
): FreshnessAdapter | null {
  return REGISTRY.get(connectorName) ?? null;
}

export function listFreshnessAdapters(): FreshnessAdapter[] {
  return [...REGISTRY.values()];
}

// Restore-decision rule. Centralised so that every code path that consumes
// freshness reaches the same verdict.
export function freshnessAllowsRestore(
  result: FreshnessState,
  options: { isCmsObject: boolean },
): { allowed: boolean; reason?: string } {
  switch (result.state) {
    case "fresh":
      return { allowed: true };
    case "missing":
      return {
        allowed: false,
        reason: "remote source-of-truth is missing",
      };
    case "changed":
      return {
        allowed: false,
        reason: "remote source-of-truth has changed since capture",
      };
    case "unknown":
      return {
        allowed: false,
        reason: result.reason ?? "remote freshness unknown",
      };
    case "unsupported":
      return options.isCmsObject
        ? {
            allowed: false,
            reason:
              "remote freshness check unsupported by connector; cannot confirm CMS state matches snapshot",
          }
        : { allowed: true };
  }
}
