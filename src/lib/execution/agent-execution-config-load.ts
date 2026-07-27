import "server-only";

// Loader for the per-agent execution-config surface (exec-plane S3 slice B,
// cinatra#1708; epic #1705).
//
// Resolves the three inputs the pure view model needs — the packaged agent's
// MANIFEST claim, the project agent's stored CONFIG, and the tri-state
// execution-service readiness — plus the promotion candidates.
//
// Manifest resolution is fail-CLOSED: the bundled static manifest is consulted
// first (dev / first-party bundle), then the materialized runtime store. If the
// store read THROWS we report `manifestReadFailed`, which the view model turns
// into a READ-ONLY surface — an unreadable package must never silently hand
// edit rights over a packaged agent's reviewed recipe to the app.
//
// The promotion feed reads OBSERVED ad-hoc L2 installs. There is no observation
// store yet (the plane is dormant and no run has ever installed anything), so
// the default seam yields none and the affordance renders its honest empty
// state. The seam is injected, so the moment observations exist the same
// already-tested pure `computePromotionCandidates` drives the surface.

import { readAgentTemplateByPackageName } from "@cinatra-ai/agents";
import { resolveAgentEnvironmentAuthority } from "@cinatra-ai/agents/execution-config";
import {
  canonicalExecutionEnvironmentJson,
  parseExecutionEnvironment,
  type ExecutionEnvironmentSpec,
} from "@cinatra-ai/sdk-extensions";
import { computePromotionCandidates } from "@cinatra-ai/execution-plane/environment/promotion";
import { STATIC_EXTENSION_MANIFEST } from "@/lib/generated/extensions.server";
import { getExecutionServiceState } from "@/lib/execution/register-execution-environment-service";
import {
  buildAgentExecutionConfigView,
  type AgentExecutionConfigView,
  type PromotionCandidateView,
} from "@/lib/execution/agent-execution-config-view";

/** One observed ad-hoc install inside a run's L2 workspace (structural twin of
 *  the execution-plane's `ObservedAdhocInstall`, restated so this module takes
 *  no runtime execution-plane import). */
export type ObservedAdhocInstallView = {
  runId: string;
  manager: "npm" | "os" | "pip";
  packageName: string;
};

export type ManifestEnvironmentLookup = {
  environment: unknown;
  readFailed: boolean;
  /** The agent ships as a PACKAGED extension (a manifest was found), whether or
   *  not that manifest declares an environment. Load-bearing for the surface's
   *  copy: a packaged agent that declares none can still be given an
   *  INSTANCE-LOCAL declaration here, and the surface must say so rather than
   *  implying the package asked for it. */
  packaged: boolean;
};

/**
 * The RAW `cinatra.execution.environment` claim for a package, or `null` when
 * the package declares none. `readFailed` is set when the runtime store could
 * not be enumerated at all — the caller must treat that as read-only, not as
 * "no declaration".
 */
export async function readManifestEnvironmentClaim(
  packageName: string,
  opts: { installedExtension?: boolean } = {},
): Promise<ManifestEnvironmentLookup> {
  const bundled = STATIC_EXTENSION_MANIFEST[packageName];
  if (bundled) {
    return {
      environment: bundled.executionEnvironment ?? null,
      readFailed: false,
      packaged: true,
    };
  }
  try {
    const { resolveExtensionDataRoot } = await import("@/lib/extension-data-root");
    const { discoverStoreRecordsV2, realStoreFs } = await import("@/lib/extension-store-io");
    const records = (
      await discoverStoreRecordsV2(resolveExtensionDataRoot(), realStoreFs)
    ).filter((r) => r.packageName === packageName);

    // FAIL CLOSED on an INSTALLED package with no readable store record (codex
    // round-1 finding b3). `discoverStoreRecordsV2` SKIPS unreadable/malformed
    // manifests rather than throwing, so "no record" for a package the
    // installed-extension registry says is here means the manifest could not be
    // read — not that this is an in-app agent whose recipe the config surface
    // owns. Handing edit rights to a corrupt packaged agent is exactly the
    // fail-open this discipline forbids.
    if (records.length === 0) {
      if (opts.installedExtension) {
        // The package name is route-derived (untrusted): pass it as an
        // ARGUMENT, never interpolated into the format string, so a crafted
        // name cannot forge log lines (CodeQL js/tainted-format-string).
        console.warn(
          "[agent-execution-config] installed extension has no readable store record " +
            "— the surface degrades to read-only:",
          packageName,
        );
        return { environment: null, readFailed: true, packaged: true };
      }
      // Genuinely not a package: an in-app (project) agent, whose environment
      // the config surface owns.
      return { environment: null, readFailed: false, packaged: false };
    }

    // MULTIPLE materialized digests for one package: pick a declaration only
    // when every record AGREES on it. `.find`-ing an arbitrary digest would
    // render (and authorize edits against) a recipe that may not be the one a
    // run mounts. Disagreement fails closed to read-only.
    const declarations = records.map((r) => r.executionEnvironment ?? null);
    const fingerprints = new Set(
      declarations.map((d) => {
        if (d == null) return "null";
        const parsed = parseExecutionEnvironment(d);
        return parsed.ok ? canonicalExecutionEnvironmentJson(parsed.spec) : "invalid";
      }),
    );
    if (fingerprints.size > 1) {
      console.warn(
        "[agent-execution-config] materialized store records declare DIFFERENT execution " +
          "environments — the surface degrades to read-only:",
        packageName,
        records.length,
      );
      return { environment: null, readFailed: true, packaged: true };
    }
    return { environment: declarations[0], readFailed: false, packaged: true };
  } catch (err) {
    console.warn(
      "[agent-execution-config] could not read the extension store " +
        "(surface degrades to read-only):",
      packageName,
      err instanceof Error ? err.message : err,
    );
    return { environment: null, readFailed: true, packaged: true };
  }
}

/** No observation store exists yet — see the module header. */
async function noObservations(): Promise<ObservedAdhocInstallView[]> {
  return [];
}

export type LoadAgentExecutionConfigDeps = {
  readManifestEnvironment?: (
    packageName: string,
    opts?: { installedExtension?: boolean },
  ) => Promise<ManifestEnvironmentLookup>;
  readTemplate?: typeof readAgentTemplateByPackageName;
  readObservations?: (packageName: string) => Promise<ObservedAdhocInstallView[]>;
  serviceState?: () => ReturnType<typeof getExecutionServiceState>;
};

/**
 * Build the per-agent execution-config view for one packaged/project agent.
 * Every dependency is injectable so the loader is unit-testable without a DB,
 * an extension store, or a booted execution service.
 */
export async function loadAgentExecutionConfig(
  input: {
    packageName: string;
    displayName: string;
    /** The caller resolved this agent from the INSTALLED-EXTENSION registry, so
     *  a missing store record is an unreadable manifest, not a project agent. */
    installedExtension?: boolean;
  },
  deps: LoadAgentExecutionConfigDeps = {},
): Promise<AgentExecutionConfigView> {
  const readManifestEnvironment = deps.readManifestEnvironment ?? readManifestEnvironmentClaim;
  const readTemplate = deps.readTemplate ?? readAgentTemplateByPackageName;
  const readObservations = deps.readObservations ?? noObservations;
  const serviceState = deps.serviceState ?? getExecutionServiceState;

  const [manifest, template] = await Promise.all([
    readManifestEnvironment(input.packageName, {
      installedExtension: input.installedExtension ?? false,
    }),
    readTemplate(input.packageName).catch(() => null),
  ]);

  // The promotion baseline is the AUTHORITATIVE declaration — the same one the
  // surface renders — not whichever source happens to be non-null (codex
  // round-1 finding b5). Suggesting a package the authoritative recipe already
  // carries would be noise at best and a duplicate declaration at worst.
  const authoritative = resolveAgentEnvironmentAuthority({
    manifestEnvironment: manifest.environment,
    templateEnvironment: template?.executionEnvironment,
    manifestReadFailed: manifest.readFailed,
  });
  const promotionCandidates = resolvePromotionCandidates(
    await readObservations(input.packageName),
    authoritative.spec,
  );

  return buildAgentExecutionConfigView({
    packageName: input.packageName,
    displayName: input.displayName,
    templateId: template?.id ?? null,
    manifestEnvironment: manifest.environment,
    templateEnvironment: template?.executionEnvironment,
    manifestReadFailed: manifest.readFailed,
    packaged: manifest.packaged,
    executionEnabled: template?.executionEnabled ?? null,
    serviceState: serviceState(),
    promotionCandidates,
  });
}

/**
 * Compute promotion candidates from observed ad-hoc installs using the
 * execution-plane's already-tested pure function.
 *
 * Takes the ALREADY-RESOLVED authoritative spec (`null` = the declaration is
 * invalid): with no trustworthy baseline there is nothing to suggest, because a
 * suggestion could name a package the real recipe already carries.
 *
 * Imported through the plane's `environment/promotion` SUBPATH, not its barrel:
 * the barrel pulls the broker + docker seam, which has no business loading on a
 * settings page render. The subpath module is pure (its only dependency is the
 * sdk-extensions parser).
 */
export function resolvePromotionCandidates(
  observations: readonly ObservedAdhocInstallView[],
  declared: ExecutionEnvironmentSpec | null,
): PromotionCandidateView[] {
  if (observations.length === 0) return [];
  if (declared === null) return [];
  return computePromotionCandidates(observations, declared);
}
