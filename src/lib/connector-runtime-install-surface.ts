import "server-only";

// The host-side resolver that tells the connector extension handler
// whether a connector is RUNTIME-INSTALLABLE (model-B / schema-config) or
// REBUILD-ONLY (bundled-react).
//
// It reads the published package's resolved `package.json` manifest from the
// registry (the same `getPublishedExtensionSummary` path the lifecycle resolver
// uses) and returns its declared `cinatra.uiSurface`:
//   - "schema-config" → ships NO bundled React; setup surface is DATA the host
//                        renders from the materialized manifest → INSTALLABLE.
//   - "bundled-react" → its React setup page is base-image-only → REBUILD-ONLY.
//   - null            → no declared surface; treated as model-B-installable
//                        (a legacy connector that still ships a React page is
//                        caught downstream at render time by
//                        `chooseConnectorUiRender` → requires-rebuild Alert).
//
// Lives in `@/lib` (host) — it needs the verdaccio config + the registry client,
// which `@cinatra-ai/extensions` cannot import. The handler takes it as an
// injected dep (`src/lib/extensions.ts` wires this); the handler itself does no
// registry IO.

export async function resolveConnectorUiSurfaceForPackage(
  packageName: string,
  packageVersion?: string,
): Promise<"schema-config" | "bundled-react" | null> {
  const { getPublishedExtensionSummary } = await import("@cinatra-ai/registries");
  let config: Awaited<ReturnType<typeof import("@/lib/verdaccio-config").loadVerdaccioConfigForReads>> | undefined;
  try {
    const { loadVerdaccioConfigForReads } = await import("@/lib/verdaccio-config");
    config = await loadVerdaccioConfigForReads();
  } catch {
    config = undefined;
  }

  const summary = await getPublishedExtensionSummary({ packageName, packageVersion }, config);
  const cinatra = (summary.manifest as { cinatra?: { uiSurface?: unknown } } | null)?.cinatra;
  const uiSurface = cinatra?.uiSurface;
  if (uiSurface === "schema-config" || uiSurface === "bundled-react") return uiSurface;
  return null;
}
