// Risk-level resolution for the registry catalog LIST view.
//
// `riskLevel` lives on the registry summary (AgentPackageSummary) — never on
// AgentTemplateRecord, the row type for both the Active and Archived tabs —
// so the list view resolves it through the registry:
//
//   1. Fast path: the catalog screen already fetches a `listAgentPackages`
//      page for update detection. Every summary on that page carries
//      riskLevel, so it seeds the map for free.
//   2. Backfill: that page is narrowed by the `q` filter, the row cap and
//      viewer scope, so an installed/archived row can miss it while still
//      having registry metadata. Missing names are backfilled with a
//      packument-only read (getPublishedExtensionSummary — no tarball
//      extraction) and `manifest.cinatra.riskLevel` is parsed from it. The
//      agent manifest schema REQUIRES that field
//      (packages/agents/src/verdaccio/package-contract.ts,
//      cinatraAgentPackageMetadataSchema), so agent packages resolve here.
//   3. Names that still don't resolve (unpublished package, registry error,
//      pre-schema legacy manifest) are simply absent from the returned map —
//      the caller renders a neutral placeholder, never a guessed level.
//
// Kept as a pure module (DI'd registry read) so the resolution contract is
// unit-testable without network or the RSC screen.

import type { AgentPackageSummary } from "@cinatra-ai/registries";

/** Registry risk level — the `AgentPackageSummary["riskLevel"]` union. */
export type RegistryRiskLevel = AgentPackageSummary["riskLevel"];

const REGISTRY_RISK_LEVELS = [
  "low",
  "medium",
  "high",
  "critical",
] as const satisfies readonly RegistryRiskLevel[];

/**
 * Narrow `manifest.cinatra.riskLevel` out of a packument version manifest.
 * Returns null for anything that is not exactly one of the four registry
 * levels — a malformed manifest must surface as "unknown", not as a level.
 */
export function parsePackumentRiskLevel(
  manifest: Record<string, unknown> | null,
): RegistryRiskLevel | null {
  if (!manifest) return null;
  const cinatra = manifest["cinatra"];
  if (!cinatra || typeof cinatra !== "object") return null;
  const riskLevel = (cinatra as Record<string, unknown>)["riskLevel"];
  return typeof riskLevel === "string" &&
    (REGISTRY_RISK_LEVELS as readonly string[]).includes(riskLevel)
    ? (riskLevel as RegistryRiskLevel)
    : null;
}

/**
 * Resolve risk levels for the catalog rows' package names.
 *
 * `summaries` is the already-fetched registry page (fast path); only names
 * absent from it hit `readPublishedSummary`, deduplicated, in parallel via
 * Promise.allSettled — one unreachable package never blanks the whole
 * column. See the module doc for the full contract.
 */
export async function resolveRiskLevelsByPackageName(input: {
  summaries: ReadonlyArray<
    Pick<AgentPackageSummary, "packageName" | "riskLevel">
  >;
  packageNames: ReadonlyArray<string | null | undefined>;
  readPublishedSummary: (
    packageName: string,
  ) => Promise<{ manifest: Record<string, unknown> | null }>;
}): Promise<Map<string, RegistryRiskLevel>> {
  const riskByName = new Map<string, RegistryRiskLevel>(
    input.summaries.map((summary) => [summary.packageName, summary.riskLevel]),
  );
  const unresolved = [
    ...new Set(
      input.packageNames.filter(
        (name): name is string =>
          typeof name === "string" && name !== "" && !riskByName.has(name),
      ),
    ),
  ];
  if (unresolved.length === 0) return riskByName;

  const backfilled = await Promise.allSettled(
    unresolved.map(async (packageName) => ({
      packageName,
      riskLevel: parsePackumentRiskLevel(
        (await input.readPublishedSummary(packageName)).manifest,
      ),
    })),
  );
  for (const result of backfilled) {
    if (result.status !== "fulfilled" || result.value.riskLevel === null) {
      continue;
    }
    riskByName.set(result.value.packageName, result.value.riskLevel);
  }
  return riskByName;
}
