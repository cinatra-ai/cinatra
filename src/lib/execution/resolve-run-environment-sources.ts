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
// COST: the O(1) bundled-manifest lookup covers every first-party / dev agent.
// The materialized-store scan only runs for a template whose packageName is
// NOT in the bundled manifest (a marketplace-installed agent), and is loaded
// through a dynamic import so the bundled path never pulls the store IO module
// onto the hot bridge path.

import {
  readAgentTemplateVersionById,
  type AgentTemplateVersionSnapshot,
} from "@cinatra-ai/agents";
import {
  canonicalExecutionEnvironmentJson,
  parseExecutionEnvironment,
} from "@cinatra-ai/sdk-extensions";
import { STATIC_EXTENSION_MANIFEST } from "@/lib/generated/extensions.server";

export type RunEnvironmentSources = {
  /** RAW packaged-manifest claim, or null when the agent is not packaged / the
   *  package declares none. */
  packagedManifestEnvironment: unknown;
  /** The immutable snapshot for a PINNED run, or null when the run is
   *  unpinned (the resolver treats a present snapshot as pin-exclusive). */
  pinnedSnapshot: Pick<AgentTemplateVersionSnapshot, "executionEnvironment"> | null;
  /** Set ONLY when a source could not be read at all — the seam refuses. */
  declarationUnreadable: { detail: string } | null;
};

type ManifestClaim = { environment: unknown; readFailed: false } | { readFailed: true };

/**
 * The RAW `cinatra.execution.environment` claim for a package.
 *
 * Fail-closed on a genuine READ failure (the store scan threw, or several
 * materialized digests of the same package DISAGREE about the recipe — picking
 * an arbitrary one would mount a recipe that may not be the reviewed one).
 *
 * DELIBERATELY NOT fail-closed on "the scan found no record for this package".
 * cinatra#1708 slice B's config-surface twin (`readManifestEnvironmentClaim`)
 * does treat that as unreadable, because it holds the installed-extension
 * registry and is deciding EDIT RIGHTS on one screen. The run seam holds no
 * such registry and decides whether EVERY run of that agent proceeds, so
 * refusing on a merely-absent store record would take a blast radius the seam
 * must not take. A package that is genuinely installed but unreadable is
 * covered by the throw arm.
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
    if (records.length === 0) return { environment: null, readFailed: false };

    // Several materialized digests for one package name: accept a declaration
    // only when they AGREE. Fingerprint through the SAME fail-closed parser the
    // builder uses, so two byte-different-but-equivalent declarations agree and
    // an unparseable one is not silently equated with "none".
    const fingerprints = new Set(
      records.map((r) => {
        const raw = r.executionEnvironment ?? null;
        if (raw == null) return "null";
        const parsed = parseExecutionEnvironment(raw);
        return parsed.ok ? canonicalExecutionEnvironmentJson(parsed.spec) : "invalid";
      }),
    );
    if (fingerprints.size > 1) return { readFailed: true };
    return { environment: records[0].executionEnvironment ?? null, readFailed: false };
  } catch (err) {
    // The package name is derived from stored template rows: pass it as an
    // ARGUMENT, never interpolated into the format string (CodeQL
    // js/tainted-format-string).
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
  /** The run's `versionId` — non-null means the run is PINNED to that snapshot. */
  versionId: string | null | undefined;
  /** The template's `packageName` — non-null means the agent ships as a package. */
  packageName: string | null | undefined;
  /** The live template row's declared environment (the config source). */
  liveTemplateEnvironment: unknown;
}): Promise<RunEnvironmentSources> {
  let packagedManifestEnvironment: unknown = null;
  let manifestUnreadable = false;
  if (typeof input.packageName === "string" && input.packageName.length > 0) {
    const claim = await readPackagedManifestClaim(input.packageName);
    if (claim.readFailed) manifestUnreadable = true;
    else packagedManifestEnvironment = claim.environment;
  }
  if (manifestUnreadable) {
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

  let pinnedSnapshot: Pick<AgentTemplateVersionSnapshot, "executionEnvironment"> | null =
    null;
  let pinUnreadable = false;
  if (typeof input.versionId === "string" && input.versionId.length > 0) {
    try {
      const version = await readAgentTemplateVersionById(input.versionId);
      if (version) pinnedSnapshot = { executionEnvironment: version.snapshot.executionEnvironment };
      else pinUnreadable = true;
    } catch (err) {
      console.warn(
        "[run-environment-sources] pinned version snapshot read failed:",
        err instanceof Error ? err.message : String(err),
      );
      pinUnreadable = true;
    }
  }

  if (pinUnreadable) {
    // The pin cannot be honored. That only CHANGES the outcome when some other
    // source shows this agent's lineage declares an environment at all:
    //  - a packaged manifest claim is authoritative over the pin anyway (the
    //    manifest is versioned by the installed package, which the agent-
    //    template pin does not name) — the resolution is unaffected;
    //  - a live template declaration means the pinned version PROBABLY declared
    //    one too, and falling back to the live row would be exactly the pin
    //    bypass this fix closes → refuse;
    //  - nothing declared anywhere ⇒ no downgrade is possible ⇒ L0, byte-
    //    identical to today (a purged snapshot must not start 409-ing every
    //    env-less run).
    const manifestDeclares = packagedManifestEnvironment != null;
    const liveDeclares = input.liveTemplateEnvironment != null;
    if (!manifestDeclares && liveDeclares) {
      return {
        packagedManifestEnvironment,
        pinnedSnapshot: null,
        declarationUnreadable: {
          detail:
            "this run is pinned to an agent version whose immutable snapshot could not " +
            "be read, while the live agent declares an execution environment — refusing " +
            "rather than swapping the live recipe under the pin (fail-closed)",
        },
      };
    }
  }

  return { packagedManifestEnvironment, pinnedSnapshot, declarationUnreadable: null };
}
