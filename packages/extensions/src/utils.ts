import {
  getAgentPackage,
  getPublishedExtensionKind,
  getPublishedExtensionSummary,
  type PublishedExtensionSummary,
} from "@cinatra-ai/registries";

/**
 * Test/DI seam for the gatekept-install metadata path. Production code leaves
 * these undefined so the real `@/lib/gatekept-install` server-only module is
 * dynamically imported; tests inject in-memory stubs so they never touch the
 * marketplace HTTP client or a real packument read.
 */
export interface ResolveExtensionKindOptions {
  /** Override the master-flag check (defaults to `isGatekeptInstallEnabled`). */
  isGatekeptInstallEnabled?: () => boolean;
  /**
   * Override the gatekept resolver (defaults to `resolveGatekeptInstallConfig`).
   * `version` is optional — when absent or `"latest"`, the resolver resolves the
   * EXACT storefront-listed version (via `extensionGet`) before authorizing.
   */
  resolveGatekeptInstallConfig?: (
    packageName: string,
    version?: string,
  ) => Promise<{
    authorize: {
      kind: "agent" | "skill" | "connector" | "artifact" | "workflow";
      resolvedVersion: string;
    };
  }>;
}

/**
 * When gatekept install is ON, resolve the authorize-response metadata
 * (`kind` + `resolvedVersion`) for `packageName`/`packageVersion` instead of a
 * direct packument read. Returns `null` when the flag is OFF so the caller falls
 * through to the legacy path unchanged. When `packageVersion` is absent it is
 * coalesced to the `"latest"` sentinel; the gatekept resolver then resolves the
 * EXACT storefront-listed version via `extensionGet` before authorizing (so the
 * authorize call still binds a concrete listed version, never a moving tag).
 */
async function resolveGatekeptKindMetadata(
  packageName: string,
  packageVersion: string | undefined,
  options?: ResolveExtensionKindOptions,
): Promise<{ kind: "agent" | "skill" | "connector" | "artifact" | "workflow"; resolvedVersion: string } | null> {
  const isEnabled =
    options?.isGatekeptInstallEnabled ??
    (await import("@/lib/gatekept-install")).isGatekeptInstallEnabled;
  if (!isEnabled()) return null;
  const resolve =
    options?.resolveGatekeptInstallConfig ??
    (await import("@/lib/gatekept-install")).resolveGatekeptInstallConfig;
  const { authorize } = await resolve(packageName, packageVersion ?? "latest");
  return { kind: authorize.kind, resolvedVersion: authorize.resolvedVersion };
}

/**
 * Map a raw package `kind` string to a registered extensionRegistry typeId.
 *
 * Falls back to "agent" only for null/undefined (legacy packages that pre-date
 * the kind field). Throws for explicit unsupported kinds so the failure mode
 * is clean and surfaces the missing-handler gap to ops, rather than letting
 * the agent install path fail with cryptic Zod errors when it tries to read
 * agent-only manifest fields (lgGraphCode, agentDependencies, etc.) that a
 * connector package doesn't provide.
 *
 * Unknown package kinds are never silently rerouted to "agent"; doing so
 * produces cryptic downstream errors instead of exposing the missing handler.
 */
/**
 * Authoritative kind→typeId resolver for install/update/uninstall/archive/
 * restore dispatch. `getAgentPackage()` extracts agent.json and rejects for
 * skill/connector/artifact, so a `getAgentPackage(...).catch(()=>null)` →
 * `deriveTypeId(pkg?.kind)` pattern silently mis-routes every non-agent kind
 * to "agent". This falls back to the kind-agnostic packument read
 * (`getPublishedExtensionKind`) so dispatch is driven by the package's
 * declared `cinatra.kind` for ALL kinds.
 */
export async function resolveExtensionTypeId(
  packageName: string,
  packageVersion?: string,
  options?: ResolveExtensionKindOptions,
): Promise<string> {
  // Gatekept install: when ON, use the authorize response's `kind`
  // INSTEAD of a direct packument read (the instance never reads the registry
  // directly). When OFF, the legacy packument path below runs unchanged.
  const gatekept = await resolveGatekeptKindMetadata(packageName, packageVersion, options);
  if (gatekept) return deriveTypeId(gatekept.kind);

  // The registries reads fail-fast without an explicit VerdaccioConfig. Load it
  // at this server/MCP boundary via the same dynamic-import pattern the other
  // extensions dispatch sites use (mcp/handlers.ts, purge-deps.ts) and pass it
  // down, so skill/connector/artifact resolve their real `cinatra.kind` instead
  // of catch→null→"agent". Dynamic import keeps utils.ts non-server-only for
  // deriveTypeId callers.
  // Self-deriving type: exactly getAgentPackage's optional config param.
  let config: Parameters<typeof getAgentPackage>[1];
  try {
    const { loadVerdaccioConfigForReads } = await import(
      "@/lib/verdaccio-config"
    );
    config = await loadVerdaccioConfigForReads();
  } catch {
    config = undefined;
  }
  const pkg = await getAgentPackage(
    { packageName, packageVersion },
    config,
  ).catch(() => null);
  if (pkg?.kind) return deriveTypeId(pkg.kind);
  const kind = await getPublishedExtensionKind(
    { packageName, packageVersion },
    config,
  ).catch(() => null);
  return deriveTypeId(kind);
}

/**
 * Kind-agnostic lifecycle dispatcher.
 *
 * The install/update/uninstall/archive/restore/force_delete and
 * `reinstallLatestExtensionPackage` paths must not derive typeId through
 * `getAgentPackage(...).catch(() => null)`. That pattern silently fails for
 * `kind:"skill" | "connector" | "artifact"` packages:
 *   - getAgentPackage extracts the tarball + reads agent.json → throws for
 *     non-agent kinds → pkg is null → visibility check is bypassed.
 *   - dispatch falls through to resolveExtensionTypeId, which works
 *     kind-agnostically — but visibility has already been silently skipped.
 *
 * This helper closes the visibility-check bypass by issuing ONE kind-agnostic
 * packument read and surfacing both `typeId` and the kind-agnostic `origin`
 * block for the caller to gate on. Every lifecycle entry point calls this;
 * visibility is applied uniformly regardless of kind.
 */
export interface LifecycleResolution {
  typeId: string;
  kind: "agent" | "skill" | "connector" | "artifact" | "workflow";
  resolvedVersion: string | null;
  origin: { visibility?: string; scope?: string } | null;
  manifest: Record<string, unknown> | null;
}

export async function resolveExtensionPackageForLifecycle(
  packageName: string,
  packageVersion?: string,
  options?: ResolveExtensionKindOptions,
): Promise<LifecycleResolution> {
  // Gatekept install: when ON, drive typeId + resolvedVersion off the
  // authorize response INSTEAD of a direct packument read. The broker/authorize
  // call has already gated storefront-visibility + entitlement upstream, so the
  // local visibility block is moot — `origin`/`manifest` are null on this path
  // (the lifecycle caller's visibility gate is satisfied by the authorize check).
  const gatekept = await resolveGatekeptKindMetadata(packageName, packageVersion, options);
  if (gatekept) {
    return {
      typeId: deriveTypeId(gatekept.kind),
      kind: gatekept.kind,
      resolvedVersion: gatekept.resolvedVersion,
      origin: null,
      manifest: null,
    };
  }

  let config: Parameters<typeof getAgentPackage>[1];
  try {
    const { loadVerdaccioConfigForReads } = await import("@/lib/verdaccio-config");
    config = await loadVerdaccioConfigForReads();
  } catch {
    config = undefined;
  }

  const summary: PublishedExtensionSummary = await getPublishedExtensionSummary(
    { packageName, packageVersion },
    config,
  );

  // Null-kind fallback mirrors the legacy deriveTypeId behavior (warn + assume
  // agent) for packages predating the cinatra.kind field. The naming-conformance
  // regression test catches new packages missing cinatra.kind; this fallback is
  // for the historical tail.
  const safeKind = summary.kind ?? "agent";

  // Pull the publisher-set origin block from the resolved version's manifest's
  // `cinatra.origin`. This is the canonical location written by the publish
  // path. Reading `pkg.origin` from `getAgentPackage`'s extracted manifest is
  // agent-only because that path extracts the tarball + reads agent.json, so it
  // never populates `origin` for non-agent kinds. Reading directly from the
  // packument's manifest closes that gap uniformly.
  const cinatraBlock = (summary.manifest as { cinatra?: Record<string, unknown> } | null)?.cinatra;
  const originRaw = cinatraBlock?.origin as
    | { visibility?: unknown; scope?: unknown }
    | undefined;
  const origin: LifecycleResolution["origin"] = originRaw
    ? {
        visibility: typeof originRaw.visibility === "string" ? originRaw.visibility : undefined,
        scope: typeof originRaw.scope === "string" ? originRaw.scope : undefined,
      }
    : null;

  return {
    typeId: deriveTypeId(safeKind),
    kind: safeKind,
    resolvedVersion: summary.resolvedVersion,
    origin,
    manifest: summary.manifest,
  };
}

export function deriveTypeId(kind: string | null | undefined): string {
  if (kind === "agent") return "agent";
  if (kind === "skill") return "skill";
  // Connector is a registered extension kind. The connector handler's runtime
  // mutators (install/uninstall) are intentionally no-ops/guards because
  // connectors are bundle-compiled, not hot-loadable, but the typeId must
  // resolve so extensions_purge / force_delete can reach the connector handler
  // for DB + audit + Verdaccio cleanup.
  if (kind === "connector") return "connector";
  // `artifact` is a registered extension kind. The ArtifactExtensionTypeHandler's
  // lifecycle mutators are audit-logged no-ops because descriptor
  // (re)registration is owned by the object-registry bridge, not a bundle
  // rebuild, but the typeId must resolve so extensions_purge /
  // extensions_force_delete can reach the handler for DB + audit + Verdaccio
  // cleanup.
  if (kind === "artifact") return "artifact";
  // Workflow is the fifth registered extension kind. Workflow package
  // validation, deriveTypeId, and handler-bootstrap coverage keep the canonical
  // manifest checks aligned across all five kinds.
  if (kind === "workflow") return "workflow";
  if (kind == null) {
    // Legacy packages that pre-date the `kind` field — fall back to agent.
    // eslint-disable-next-line no-console
    console.warn(
      "[extensions] Package kind is null — falling back to 'agent' typeId for legacy compat",
    );
    return "agent";
  }
  // Truly unknown kind — fail loudly so ops sees the coverage gap.
  throw new Error(
    `[extensions] Unknown kind '${kind}' — no extension handler is registered for this kind`,
  );
}
