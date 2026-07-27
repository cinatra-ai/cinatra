import "server-only";

// The run seam's DECLARATION-SOURCE reader (exec-plane S3, epic #1705;
// cinatra#1708 §1.1 A2/A3).
//
// `resolveRunExecutionBinding` decides `l0 | mount | refuse` from a run's
// declared-environment SOURCES. The epic names three (see "Environment model"
// and the extension-lifecycle "Versions" clause):
//
//   1. the PACKAGED agent's manifest claim — `cinatra.execution.environment`,
//      carried RAW on `NormalizedExtensionRecord.executionEnvironment`;
//   2. the run's PINNED version snapshot — "pinned runs build/mount from the
//      snapshot's recipe, never the live manifest row";
//   3. the live template config — the project-agent / instance-local recipe.
//
// A source the caller does not supply resolves as "declared nothing", so the
// run executes on L0 — the exact silent downgrade the A2 matrix forbids. This
// module resolves all three for one run so the seam can never be fed a partial
// picture, and reports a source it could not READ separately from a source
// that genuinely declares nothing (an UNKNOWN declaration refuses; an absent
// one is L0).
//
// ONE definition of "pinned". The pin is resolved through the MERGED
// `resolvePinnedRunSnapshot` (cinatra#1040 S5/S7, packages/agents/src/execution.ts)
// — the same classifier the execution worker uses — never a second rule:
//   - REQUIRED pin (`versionId` AND `packageVersion`): the exact
//     `agent_template_versions` snapshot, binding-verified; unreachable ⇒ the
//     classifier THROWS and this run refuses (the worker fails such a run
//     closed for the same reason, so the seam adds no new blast radius);
//   - `packageVersion` only: best-effort semver load, live fallback on a miss;
//   - `versionId` ONLY: the INERT pin every non-A2A run producer writes (it
//     points at the legacy `agent_versions` table, not at an immutable
//     `agent_template_versions` snapshot). It is NOT a pin — treating it as one
//     would make every ordinary run resolve against a row that does not exist.
//
// COST. The O(1) bundled-manifest lookup covers every first-party / dev agent.
// The materialized-store scan runs only for a template whose packageName is NOT
// bundled (a marketplace-installed agent), behind a dynamic import. The pin read
// happens only for a run that actually carries a `packageVersion` (A2A version
// pinning) — an ordinary run adds ZERO database work to the hot bridge path —
// and is skipped entirely when a packaged manifest already declares the recipe.

import {
  PinnedRunSnapshotUnreachableError,
  readAgentTemplateVersionById,
  readAgentTemplateVersionBySemver,
  resolvePinnedRunSnapshot,
} from "@cinatra-ai/agents";
import {
  canonicalExecutionEnvironmentJson,
  isEmptyExecutionEnvironment,
  parseExecutionEnvironment,
} from "@cinatra-ai/sdk-extensions";
import { STATIC_EXTENSION_MANIFEST } from "@/lib/generated/extensions.server";

export type RunEnvironmentSources = {
  /** RAW packaged-manifest claim, or null when the agent is not packaged / the
   *  package declares none. */
  packagedManifestEnvironment: unknown;
  /** The resolved PIN's recipe, or null when the run carries no resolved pin
   *  (the resolver treats a present value as pin-exclusive). */
  pinnedSnapshot: { executionEnvironment?: unknown } | null;
  /** Set ONLY when a source could not be read at all — the seam refuses. */
  declarationUnreadable: { detail: string } | null;
};

type ManifestClaim = { environment: unknown; readFailed: false } | { readFailed: true };

/**
 * Identity of a declaration for AGREEMENT purposes. An ABSENT claim and a claim
 * that parses to the EMPTY spec both mean "declares nothing" and must compare
 * EQUAL — fingerprinting them apart would turn a package whose retained digests
 * merely differ between `null` and `{}` into a refused run.
 */
function declarationFingerprint(raw: unknown): string {
  if (raw == null) return "{}";
  const parsed = parseExecutionEnvironment(raw);
  if (!parsed.ok) return "invalid";
  return canonicalExecutionEnvironmentJson(parsed.spec);
}

/** True when a raw claim carries an ACTUAL recipe (not absent, not empty). */
function declaresSomething(raw: unknown): boolean {
  if (raw == null) return false;
  const parsed = parseExecutionEnvironment(raw);
  // An INVALID declaration is a declaration — it must reach the resolver so the
  // matrix can refuse it, never be treated as "nothing declared".
  if (!parsed.ok) return true;
  return !isEmptyExecutionEnvironment(parsed.spec);
}

/**
 * The RAW `cinatra.execution.environment` claim for a package.
 *
 * Bundled manifest first (the build-time bundle is what a first-party/dev agent
 * actually loads from), then the materialized runtime store — the same order,
 * and the same fail-closed rules, as cinatra#1708 slice B's config-surface twin
 * `readManifestEnvironmentClaim` (src/lib/execution/agent-execution-config-load.ts),
 * so the surface that SHOWS a recipe and the seam that MOUNTS it can never
 * disagree about the same agent.
 *
 * Deliberately not a call into that twin: it statically imports
 * `@cinatra-ai/execution-plane/environment/promotion` for the config surface's
 * promotion feed, and the bridge route must not pull the execution-plane graph
 * onto its hot path (the whole reason `register-execution-environment-service`
 * is a DI slot). The two differ in exactly one policy, called out below: what a
 * MISSING store record means.
 *
 * Fail-closed: the store scan threw, several materialized digests DISAGREE about
 * the recipe (picking an arbitrary one would mount a recipe that may not be the
 * reviewed one), or a PACKAGED agent has no readable record anywhere. That last
 * arm matters — `discoverStoreRecordsV2` SKIPS unreadable/corrupt manifests
 * rather than throwing, so "no record for a package this template says it ships
 * as" means the declaration is UNKNOWN, not absent.
 */
async function readPackagedManifestClaim(packageName: string): Promise<ManifestClaim> {
  const bundled = STATIC_EXTENSION_MANIFEST[packageName];
  if (bundled) {
    return { environment: bundled.executionEnvironment ?? null, readFailed: false };
  }
  try {
    const { resolveExtensionDataRoot } = await import("@/lib/extension-data-root");
    const { discoverStoreRecordsV2, realStoreFs } = await import(
      "@/lib/extension-store-io"
    );
    const records = (
      await discoverStoreRecordsV2(resolveExtensionDataRoot(), realStoreFs)
    ).filter((r) => r.packageName === packageName);
    if (records.length === 0) {
      // No record for this package. That is UNKNOWN only if the package is
      // genuinely INSTALLED here — `discoverStoreRecordsV2` also legitimately
      // yields nothing for a deployment with no data volume at all, and
      // refusing every run of every non-bundled template on such a host would
      // be a blast radius the run seam must not take (it decides whether EVERY
      // run of an agent proceeds). So ask the canonical install registry, which
      // is the authority on "is this package installed on this instance":
      //   - an install row exists ⇒ the manifest should have been materialized
      //     and readable; it is not ⇒ UNKNOWN ⇒ refuse (fail-closed);
      //   - no install row ⇒ this template's packageName does not name an
      //     installed extension here ⇒ no packaged declaration exists to miss.
      // One indexed read, and ONLY in this already-degraded branch (a full
      // store scan just came back empty) — never on the healthy hot path.
      let installed = false;
      try {
        const { readInstalledExtensionsByPackageName } = await import(
          "@cinatra-ai/extensions/canonical-store"
        );
        installed = (await readInstalledExtensionsByPackageName(packageName)).length > 0;
      } catch {
        // The registry itself is unreadable — that IS an unknown state.
        installed = true;
      }
      if (!installed) return { environment: null, readFailed: false };
      // The package name is derived from stored template rows: pass it as an
      // ARGUMENT, never interpolated into the format string (CodeQL
      // js/tainted-format-string).
      console.warn(
        "[run-environment-sources] INSTALLED packaged agent has no readable manifest " +
          "(neither bundled nor materialized) — its declared environment is UNKNOWN and " +
          "the run refuses (fail-closed):",
        packageName,
      );
      return { readFailed: true };
    }
    const fingerprints = new Set(
      records.map((r) => declarationFingerprint(r.executionEnvironment ?? null)),
    );
    if (fingerprints.size > 1) {
      console.warn(
        "[run-environment-sources] materialized digests DISAGREE about the declared " +
          "environment — refusing rather than mounting an arbitrary one:",
        packageName,
      );
      return { readFailed: true };
    }
    return { environment: records[0].executionEnvironment ?? null, readFailed: false };
  } catch (err) {
    console.warn(
      "[run-environment-sources] extension store read failed — the declared " +
        "environment is UNKNOWN and the run refuses (fail-closed):",
      packageName,
      err instanceof Error ? err.message : String(err),
    );
    return { readFailed: true };
  }
}

/**
 * Resolve every declared-environment source for ONE run.
 *
 * Never throws: a store/DB failure becomes a structured `declarationUnreadable`
 * (or, when nothing anywhere declares an environment, nothing at all — an agent
 * that declares no environment keeps running exactly as it does today, which is
 * the whole point of the `undeclared → L0 unchanged` arm).
 */
export async function resolveRunEnvironmentSources(input: {
  /** The run's template id — the pin's binding check verifies against it. */
  templateId: string;
  /** The run's `versionId` (the exact snapshot id of a REQUIRED pin). */
  versionId: string | null | undefined;
  /** The run's `packageVersion` (the resolved semver of an A2A version pin). */
  packageVersion: string | null | undefined;
  /** The template's `packageName` — non-null means the agent ships as a package. */
  packageName: string | null | undefined;
  /** The live template row's declared environment (the config source). */
  liveTemplateEnvironment: unknown;
}): Promise<RunEnvironmentSources> {
  let packagedManifestEnvironment: unknown = null;
  if (typeof input.packageName === "string" && input.packageName.length > 0) {
    const claim = await readPackagedManifestClaim(input.packageName);
    if (claim.readFailed) {
      return {
        packagedManifestEnvironment: null,
        pinnedSnapshot: null,
        declarationUnreadable: {
          detail:
            "the agent's package manifest could not be read, so whether it declares an " +
            "execution environment is UNKNOWN — refusing rather than running the agent " +
            "without a recipe it may have declared (fail-closed)",
        },
      };
    }
    packagedManifestEnvironment = claim.environment;
  }

  // A non-empty packaged declaration is authoritative (epic D8 — it is reviewed
  // and locked through the extension review path and versioned by the INSTALLED
  // PACKAGE, which the agent-template pin does not name), so the pin read is
  // pure cost at that point. Skip it.
  if (declaresSomething(packagedManifestEnvironment)) {
    return { packagedManifestEnvironment, pinnedSnapshot: null, declarationUnreadable: null };
  }

  let pinnedSnapshot: { executionEnvironment?: unknown } | null = null;
  try {
    const pinned = await resolvePinnedRunSnapshot(
      {
        templateId: input.templateId,
        packageVersion: input.packageVersion ?? null,
        versionId: input.versionId ?? null,
      },
      { readAgentTemplateVersionById, readAgentTemplateVersionBySemver },
    );
    // `null` = no resolved pin (no pin, an inert versionId-only pin, or a
    // best-effort semver miss) → the live template config applies, unchanged.
    if (pinned) pinnedSnapshot = { executionEnvironment: pinned.executionEnvironment ?? null };
  } catch (err) {
    if (err instanceof PinnedRunSnapshotUnreachableError) {
      // A REQUIRED pin whose immutable snapshot cannot be served. The execution
      // worker already fails such a run closed for exactly this reason
      // (cinatra#1040 S7) — the seam refuses instead of resolving the
      // environment against the live row, which would be the pin bypass this
      // fix exists to close.
      return {
        packagedManifestEnvironment,
        pinnedSnapshot: null,
        declarationUnreadable: {
          detail: `${err.message} (the run's declared execution environment is therefore UNKNOWN)`,
        },
      };
    }
    console.warn(
      "[run-environment-sources] pinned version snapshot read failed:",
      err instanceof Error ? err.message : String(err),
    );
    return {
      packagedManifestEnvironment,
      pinnedSnapshot: null,
      declarationUnreadable: {
        detail:
          "this run's pinned agent version could not be read, so its declared execution " +
          "environment is UNKNOWN — refusing rather than resolving the recipe against the " +
          "live agent (fail-closed)",
      },
    };
  }

  return { packagedManifestEnvironment, pinnedSnapshot, declarationUnreadable: null };
}
