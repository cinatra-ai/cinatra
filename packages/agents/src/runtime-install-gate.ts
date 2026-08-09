// Pure runtime-install lifecycle gate for AGENT consumer surfaces (cinatra#659).
//
// This is the DECISION half of the runtime-sourced "may this agent be
// discovered / executed" predicate — no IO, no DB. The host wraps it by reading
// the canonical `installed_extension` effective status (the org-aggregate
// `readEffectiveStatusByPackageNames`, a Map<packageName, "active"|"archived">)
// and handing the resolved status for ONE package here.
//
// WHY a separate pure module (mirrors `connector-installed-predicate.ts` from
// cinatra#657): the four non-connector consumer surfaces — `agent_run`
// (execution), the workflow `agent_task` executor + its instantiate/start
// re-auth probe, the `/agents` picker, and the `agent_list` MCP discovery
// primitive — must apply ONE consistent runtime-lifecycle rule. Centralizing the
// rule in a pure, directly-unit-tested function keeps the four call sites from
// drifting and keeps the fail-open/fail-closed/CG-1 semantics in exactly one place.
//
// CG-1 (the load-bearing invariant): the boot seeder anchors a canonical
// `installed_extension` row ONLY for bundled packages WITH a serverEntry OR
// required-in-prod. For AGENTS (a serverEntry kind) the seeder DOES anchor a row,
// so a runtime archive is observable as an `archived` status. But a legacy
// agent_templates row that predates lifecycle seeding — or any agent whose
// package the canonical store does not track — has NO row (status `undefined`).
// A naive fail-CLOSED flip ("runnable iff a live row") would BLANK such
// built-in/ungoverned agents. So fail-CLOSED applies ONLY to a RUNTIME-archived
// row (`archived`); NO row (`undefined`) falls back to the bundled/ungoverned
// floor — EXACTLY the rule the skills resolver (`isSkillExtensionLiveFailClosed`
// "no lifecycle rows -> image-shipped floor") and the workflow host-deps
// (`assertExtensionAccess` "no install row -> ungoverned -> allow") already use.
//
// Store-OUTAGE is NOT an input here: it is an IO concern the host wrapper owns
// (a status read that throws). The wrapper treats an outage as fail-OPEN for
// these surfaces — execution/discovery must not be blocked by a degraded status
// store, because the FULL execute gate (ownership / tenancy / project grant) runs
// independently and is the real authorization boundary. This gate is the ADDITIVE
// lifecycle-presence layer; a `true` here is never render/execute authorization.

// PROVISIONING (cinatra#2605) — the second half of "may this agent run".
//
// CG-1 above is stated for a package "the canonical store does not track". A
// BUNDLED `resolution:"guardedOptional"` package is different in kind: the
// generator classifies it as opt-IN (packages/sdk-extensions manifest.ts), the
// boot seeder anchors a row ONLY for the `required` set, and #2536's boot
// repair mints a row only where it can PROVE the package identity from an
// on-disk dir (the dev git-file loader) — never on the prod system-ZIP path. So
// on a stock instance a guardedOptional bundled agent has NO row *because it
// was never installed*, not because it is ungoverned: the catalog TRACKS it and
// says it is opt-in. Reading "no row" as the ungoverned floor there is what let
// `/agents` offer Run for an agent that cannot run (#2605).
//
// The provisioning rule therefore adds exactly two refusals on top of the
// lifecycle rule, both keyed on evidence the generated catalog PROVES:
//
//   NOT-INSTALLED   — catalog says `guardedOptional` AND there is no canonical
//                     row. (An `active` row means installed; an uncatalogued or
//                     `required`-resolution package keeps the CG-1 floor — the
//                     SDK's own instruction is to read a missing/unknown
//                     `resolution` as `required`, i.e. NOT gated.)
//   MISSING-REQUIRED-DEPENDENCY
//                 — a DIRECT install-blocking dependency edge (the SHARED
//                   `isInstallBlockingEdge` predicate — required, non-peer) whose
//                   target is archived, or is itself a guardedOptional package
//                   with no row. An agent whose own required dependencies are
//                   not installed cannot complete a run (#2536/#2537 are the two
//                   shipped failure modes). DIRECT, not the whole closure — see
//                   the SCOPE note on `resolveAgentRunAvailability`.
//
// Everything else stays fail-OPEN, and the two failure sources are kept
// INDEPENDENT: a canonical-store outage yields "runnable" for every input (as
// before), while an unreadable CATALOG falls back to the lifecycle rule alone —
// it must never resurrect a package whose row was successfully read as
// `archived`, and it must never be collapsed into "no catalog entry".

import type { ExtensionDependency, NormalizedExtensionRecord } from "@cinatra-ai/sdk-extensions";

/** The effective canonical install status for a single package, as resolved by
 *  `readEffectiveStatusByPackageNames`. `undefined` = NO canonical row at all. */
export type AgentEffectiveInstallStatus = "active" | "archived" | undefined;

/**
 * Decide whether an agent is runnable/discoverable for the runtime-lifecycle
 * gate, from an already-read effective status.
 *
 * Rule:
 *   1. `packageName == null`        → runnable. A legacy/no-package template is
 *      not lifecycle-tracked; this gate never blocks it (unchanged behavior).
 *   2. status `"active"`            → runnable. The runtime source of truth says
 *      at least one canonical row is `active|locked`.
 *   3. status `"archived"`          → NOT runnable. Every canonical row for this
 *      package is archived — an operator disabled/uninstalled it. FAIL-CLOSED:
 *      the bundled floor must NOT resurrect an explicitly archived agent.
 *   4. status `undefined` (no row)  → runnable. CG-1 bundled/ungoverned floor: a
 *      package the canonical store does not track is "live by being installed"
 *      (same rule skills + workflows use). This is the ONLY case the bundled
 *      fallback applies — a present-but-archived row never falls back.
 *
 * NOTE on store outage: callers that read the status with a try/catch should, on
 * a read failure, pass `undefined` (no proven archive) — which yields `true`
 * (fail-OPEN). Never invent an `archived` on an outage.
 */
export function isAgentRuntimeRunnable(input: {
  packageName: string | null | undefined;
  effectiveStatus: AgentEffectiveInstallStatus;
}): boolean {
  if (input.packageName == null) return true; // (1) untracked legacy template
  if (input.effectiveStatus === "archived") return false; // (3) explicit archive — fail-closed
  // (2) "active" and (4) undefined/no-row both resolve to runnable: a live row is
  // the runtime source of truth; no row is the CG-1 bundled/ungoverned floor.
  return true;
}

// ---------------------------------------------------------------------------
// Provisioning layer (cinatra#2605)
// ---------------------------------------------------------------------------

/** One catalog record — the generated `STATIC_EXTENSION_MANIFEST` entry shape. */
export type AgentCatalogRecord = Pick<
  NormalizedExtensionRecord,
  "packageName" | "kind" | "version" | "resolution" | "dependencies"
> & { displayName?: string | null };

/** The generated catalog, keyed by packageName. `null` = catalog UNREADABLE
 *  (never "empty catalog": an empty object means "no package is governed",
 *  which is a different, weaker statement). */
export type AgentCatalogView = Readonly<Record<string, AgentCatalogRecord>> | null;

/** A package the run needs but that is not installed. `reason` distinguishes an
 *  explicit archive from a never-installed opt-in package. */
export type MissingAgentDependency = {
  packageName: string;
  displayName: string | null;
  kind: string;
  reason: "not-installed" | "archived";
};

/**
 * Why an agent may (or may not) be RUN, for the surfaces that offer a run.
 * `runnable` is the only state a Run affordance may be built from.
 */
export type AgentRunAvailability =
  | { state: "runnable" }
  /** Every canonical row is archived — an operator disabled/uninstalled it. */
  | { state: "archived" }
  /** Catalog-governed opt-in package with NO canonical install row. */
  | { state: "not-installed"; displayName: string | null }
  /** Installed, but one of its OWN required dependencies is not. `missing` is
   *  deduped and ordered by packageName so a caller's "first missing" CTA is
   *  stable. */
  | { state: "missing-required-dependency"; missing: MissingAgentDependency[] };

/** The generator's opt-IN classification. A missing/unknown `resolution` reads
 *  as `"required"` per the SDK contract — i.e. NOT gated by this layer. */
function isOptInPackage(record: AgentCatalogRecord): boolean {
  return record.resolution === "guardedOptional";
}

/** Is this package PROVISIONED — proven installed, or not provably absent? */
function isProvisioned(
  record: AgentCatalogRecord | undefined,
  status: AgentEffectiveInstallStatus,
): { ok: true } | { ok: false; reason: "not-installed" | "archived" } {
  if (status === "archived") return { ok: false, reason: "archived" };
  if (status === "active") return { ok: true };
  // No canonical row: only an opt-in package the catalog TRACKS is provably
  // uninstalled. Everything else keeps the CG-1 floor.
  if (record && isOptInPackage(record)) return { ok: false, reason: "not-installed" };
  return { ok: true };
}

/**
 * Decide an agent's run availability. PURE — every read is injected.
 *
 * @param catalog     the generated catalog, or `null` when it could not be read
 *                    (then this degrades to {@link isAgentRuntimeRunnable}).
 * @param statusOf    effective canonical status for ANY package (deps included).
 * @param isBlockingEdge  the SHARED install-blocking edge predicate
 *                    (`@cinatra-ai/extensions/dependency-closure`'s
 *                    `isInstallBlockingEdge`) — injected rather than restated so
 *                    the required/peer semantics cannot drift from the installer.
 * @param templateVersion  the version the RUN would use. When it is known and
 *                    differs from the catalog record's version, the catalog's
 *                    dependency edges describe a DIFFERENT build, so the
 *                    dependency arm is skipped (fail-open) rather than blocking
 *                    a legitimately upgraded install on stale bundled edges.
 * @param versionAmbiguous  set when the caller holds SEVERAL templates for this
 *                    package at DIFFERENT versions: one verdict cannot speak for
 *                    both builds, so the dependency arm is skipped rather than
 *                    attributing one template's edges to another.
 *
 * SCOPE — DIRECT required dependencies, not the whole closure. The catalog is
 * the IMAGE-pinned record set; for a dependency that is installed we know its
 * status but not its installed VERSION, so walking THROUGH it would evaluate a
 * possibly-stale record's edges and could refuse a legitimately upgraded
 * install. This layer therefore reports only the agent's OWN required edges —
 * the ones the user must install to run it — and never invents a deeper claim.
 * A deeper break still fails at run time exactly as it does today (under-refusal
 * is the deliberate direction for a gate whose every other arm is fail-open).
 */
export function resolveAgentRunAvailability(input: {
  packageName: string | null | undefined;
  effectiveStatus: AgentEffectiveInstallStatus;
  templateVersion?: string | null;
  versionAmbiguous?: boolean;
  catalog: AgentCatalogView;
  statusOf: (packageName: string) => AgentEffectiveInstallStatus;
  isBlockingEdge: (dep: ExtensionDependency) => boolean;
}): AgentRunAvailability {
  if (input.packageName == null) return { state: "runnable" }; // CG-1 legacy floor
  if (input.effectiveStatus === "archived") return { state: "archived" };
  // Catalog unreadable → lifecycle rule only (never a resurrection, never a
  // guess about provisioning).
  if (input.catalog == null) return { state: "runnable" };
  const record = input.catalog[input.packageName];
  if (!record) return { state: "runnable" }; // ungoverned/user-imported floor

  const own = isProvisioned(record, input.effectiveStatus);
  if (!own.ok && own.reason === "not-installed") {
    return { state: "not-installed", displayName: record.displayName ?? null };
  }

  // Version fence: only the catalog record that DESCRIBES this build may speak
  // for its dependency edges — and only when ONE build is in question.
  if (
    input.versionAmbiguous === true ||
    (typeof input.templateVersion === "string" &&
      input.templateVersion.length > 0 &&
      typeof record.version === "string" &&
      record.version.length > 0 &&
      record.version !== input.templateVersion)
  ) {
    return { state: "runnable" };
  }

  // The agent's OWN install-blocking edges (see SCOPE above). Deduped
  // (`missingByName`), self-edge-safe (`seen`), deterministic (sorted below).
  const seen = new Set<string>([input.packageName]);
  const missingByName = new Map<string, MissingAgentDependency>();
  for (const dep of record.dependencies ?? []) {
    if (!input.isBlockingEdge(dep)) continue;
    const depName = dep.packageName;
    if (typeof depName !== "string" || depName.length === 0) continue;
    if (seen.has(depName)) continue;
    seen.add(depName);
    const depRecord = input.catalog[depName];
    const provisioned = isProvisioned(depRecord, input.statusOf(depName));
    if (!provisioned.ok) {
      missingByName.set(depName, {
        packageName: depName,
        displayName: depRecord?.displayName ?? null,
        kind: depRecord?.kind ?? dep.kind ?? "extension",
        reason: provisioned.reason,
      });
    }
  }
  if (missingByName.size > 0) {
    return {
      state: "missing-required-dependency",
      missing: [...missingByName.values()].sort((a, b) =>
        a.packageName.localeCompare(b.packageName),
      ),
    };
  }
  return { state: "runnable" };
}

/** A template carrying everything the availability decision keys on. */
export type AgentAvailabilityItem = {
  packageName?: string | null;
  /** The version the run would use — fences the catalog's dependency edges. */
  packageVersion?: string | null;
};

/** Override the generated-catalog read (tests). `null` = unreadable. */
export type ReadAgentCatalog = () => Promise<AgentCatalogView>;

async function defaultReadAgentCatalog(): Promise<AgentCatalogView> {
  try {
    const mod = await import("@/lib/generated/extensions.server");
    return mod.STATIC_EXTENSION_MANIFEST as unknown as AgentCatalogView;
  } catch (err) {
    console.warn(
      "[agents/runtime-install-gate] generated extension catalog unavailable — provisioning checks skipped (lifecycle rule only):",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

async function defaultBlockingEdgePredicate(): Promise<(dep: ExtensionDependency) => boolean> {
  try {
    const mod = await import("@cinatra-ai/extensions/dependency-closure");
    return mod.isInstallBlockingEdge;
  } catch (err) {
    // Never restate the predicate here — an unreadable installer contract makes
    // the dependency arm INERT (fail-open), it does not license a second copy
    // of the required/peer semantics.
    console.warn(
      "[agents/runtime-install-gate] install-blocking edge predicate unavailable — dependency checks skipped (fail-open):",
      err instanceof Error ? err.message : err,
    );
    return () => false;
  }
}

/** The DIRECT install-blocking edge targets of `roots` — exactly the packages
 *  the decision needs a status for (the layer never walks deeper; see the SCOPE
 *  note on {@link resolveAgentRunAvailability}). */
function collectBlockingEdgeTargets(
  roots: ReadonlyArray<string>,
  catalog: AgentCatalogView,
  isBlockingEdge: (dep: ExtensionDependency) => boolean,
): string[] {
  if (catalog == null) return [];
  const seen = new Set<string>(roots);
  const targets: string[] = [];
  for (const name of roots) {
    const record = catalog[name];
    if (!record) continue;
    for (const dep of record.dependencies ?? []) {
      if (!isBlockingEdge(dep)) continue;
      const depName = dep.packageName;
      if (typeof depName !== "string" || depName.length === 0) continue;
      if (seen.has(depName)) continue;
      seen.add(depName);
      targets.push(depName);
    }
  }
  return targets;
}

/**
 * Resolve {@link AgentRunAvailability} for each item, keyed by packageName.
 *
 * Reads the canonical effective status for the items AND their DIRECT
 * install-blocking dependency targets in ONE store call, and the generated
 * catalog through a fail-soft dynamic import. Fail-open, independently:
 *   - canonical-store outage  → EVERY input is `runnable` (never invent a state);
 *   - unreadable catalog      → the lifecycle rule alone (a proven `archived`
 *                               row still refuses).
 * Items with a `null`/absent packageName are not in the returned map — the CG-1
 * floor makes them runnable and every caller already treats them that way.
 */
export async function resolveAgentRunAvailabilityMap(
  items: ReadonlyArray<AgentAvailabilityItem>,
  deps: {
    readStatus?: ReadEffectiveInstallStatus;
    readCatalog?: ReadAgentCatalog;
    isBlockingEdge?: (dep: ExtensionDependency) => boolean;
  } = {},
): Promise<Map<string, AgentRunAvailability>> {
  const out = new Map<string, AgentRunAvailability>();
  const versionByName = new Map<string, string | null>();
  // Several templates CAN share a packageName at different versions. One
  // per-package verdict cannot speak for two builds, so such a package is
  // marked AMBIGUOUS and its dependency arm is skipped (the not-installed arm
  // is version-independent and still applies).
  const ambiguousVersions = new Set<string>();
  for (const item of items) {
    const name = item.packageName;
    if (typeof name !== "string" || name.length === 0) continue;
    const version = item.packageVersion ?? null;
    if (!versionByName.has(name)) {
      versionByName.set(name, version);
      continue;
    }
    if ((versionByName.get(name) ?? null) !== version) ambiguousVersions.add(name);
  }
  const named = [...versionByName.keys()];
  if (named.length === 0) return out;

  const catalog = await (deps.readCatalog ?? defaultReadAgentCatalog)();
  const isBlockingEdge = deps.isBlockingEdge ?? (await defaultBlockingEdgePredicate());

  let statusMap: Map<string, "active" | "archived">;
  try {
    const readStatus =
      deps.readStatus ??
      (await import("@cinatra-ai/extensions/canonical-store")).readEffectiveStatusByPackageNames;
    statusMap = await readStatus([
      ...named,
      ...collectBlockingEdgeTargets(named, catalog, isBlockingEdge),
    ]);
  } catch (err) {
    // Canonical-store OUTAGE → fail-OPEN for every input (unchanged doctrine).
    console.warn(
      "[agents/runtime-install-gate] effective-status read failed — treating all agents as runnable (fail-open):",
      err instanceof Error ? err.message : err,
    );
    for (const name of named) out.set(name, { state: "runnable" });
    return out;
  }

  const statusOf = (packageName: string): AgentEffectiveInstallStatus =>
    statusMap.get(packageName);
  for (const name of named) {
    out.set(
      name,
      resolveAgentRunAvailability({
        packageName: name,
        effectiveStatus: statusMap.get(name),
        templateVersion: versionByName.get(name) ?? null,
        versionAmbiguous: ambiguousVersions.has(name),
        catalog,
        statusOf,
        isBlockingEdge,
      }),
    );
  }
  return out;
}

/** Override the canonical effective-status reader (tests). Mirrors
 *  `readEffectiveStatusByPackageNames`'s shape: a Map keyed by packageName whose
 *  value is the live-wins effective status; an ABSENT key means NO canonical row. */
export type ReadEffectiveInstallStatus = (
  packageNames: string[],
) => Promise<Map<string, "active" | "archived">>;

/**
 * Read the canonical effective install status for `packageNames` and gate each
 * against {@link isAgentRuntimeRunnable}, returning the set of packageNames that
 * are RUNNABLE (live or no-row/CG-1; not runtime-archived).
 *
 * Fail-OPEN on a canonical-store OUTAGE: a read failure resolves EVERY input as
 * runnable (no proven archive) so a degraded status store never blocks
 * discovery/execution — the ownership/tenancy/project gates at each call site are
 * the real authorization boundary. The status read goes through a FAIL-SOFT
 * dynamic import of `@cinatra-ai/extensions/canonical-store` (the established
 * `@cinatra-ai/agents -> @cinatra-ai/extensions` static-cycle break).
 *
 * Returns a `Set<string>` of runnable names; callers keep only items whose
 * packageName is in the set (and treat a `null` packageName as runnable per
 * the pure gate's case 1).
 */
export async function resolveRunnableAgentPackageNames(
  packageNames: ReadonlyArray<string | null | undefined>,
  deps: {
    readStatus?: ReadEffectiveInstallStatus;
    readCatalog?: ReadAgentCatalog;
    isBlockingEdge?: (dep: ExtensionDependency) => boolean;
  } = {},
): Promise<Set<string>> {
  const named = [...new Set(packageNames.filter((p): p is string => typeof p === "string" && p.length > 0))];
  if (named.length === 0) return new Set();
  // ONE rule for every consumer surface (cinatra#2605): runnable == the
  // availability layer's `runnable` state — lifecycle (not archived) AND
  // provisioned AND its direct required dependencies provisioned. Both
  // fail-open paths live
  // in `resolveAgentRunAvailabilityMap`.
  const availability = await resolveAgentRunAvailabilityMap(
    named.map((packageName) => ({ packageName })),
    deps,
  );
  const runnable = new Set<string>();
  for (const name of named) {
    if ((availability.get(name)?.state ?? "runnable") === "runnable") runnable.add(name);
  }
  return runnable;
}

/**
 * agent_run (MCP execution) call-site helper — the fail-CLOSED execution gate.
 *
 * Before any run insert, intersect the resolved template's package against the
 * canonical `installed_extension` source of truth: a disabled/uninstalled
 * (archived) agent must NOT execute even though its `agent_templates` row still
 * exists. CG-1: a template with NO canonical row (legacy/bundled/ungoverned) — or
 * a `null`/absent `packageName` — is ALLOWED (the bundled floor — same rule the
 * skills + workflow gates use). Fail-OPEN on a canonical-store outage (handled by
 * {@link resolveRunnableAgentPackageNames}; never block execution on a degraded
 * status store; the ownership/tenancy/project gates at the call site are the real
 * authz boundary). This is ADDITIVE — it does not replace `enforceRunAccess`.
 *
 * @returns `null` when the package may run (runnable, or untracked/no-package);
 *   a `{ error }` structured refusal naming `identifierForError` otherwise. The
 *   ARCHIVED refusal text — `Agent is not installed (disabled or uninstalled):
 *   <identifier>` — is the unchanged gate contract; the two provisioning states
 *   (cinatra#2605) get their own actionable text so a refusal never misreports
 *   an opt-in package as "disabled" or hides which dependency is missing.
 */
export async function assertAgentPackageRunnable(
  packageName: string | null | undefined,
  identifierForError: string,
  deps: {
    readStatus?: ReadEffectiveInstallStatus;
    readCatalog?: ReadAgentCatalog;
    isBlockingEdge?: (dep: ExtensionDependency) => boolean;
    /** The version the run would use — fences the catalog's dependency edges. */
    packageVersion?: string | null;
  } = {},
): Promise<{ error: string } | null> {
  if (!packageName) return null; // no package → untracked/legacy → never blocked
  const availability = await resolveAgentRunAvailabilityMap(
    [{ packageName, packageVersion: deps.packageVersion ?? null }],
    deps,
  );
  const verdict = availability.get(packageName) ?? { state: "runnable" as const };
  switch (verdict.state) {
    case "runnable":
      return null;
    case "not-installed":
      return {
        error:
          `Agent is not installed: ${identifierForError} — it ships with Cinatra but is opt-in. ` +
          `Install it from the marketplace before running it.`,
      };
    case "missing-required-dependency":
      return {
        error:
          `Agent cannot run: ${identifierForError} requires ${verdict.missing
            .map((m) => `${m.displayName ?? m.packageName} (${m.packageName})`)
            .join(", ")}, which ${verdict.missing.length === 1 ? "is" : "are"} not installed. ` +
          `Install the missing extension${verdict.missing.length === 1 ? "" : "s"} from the marketplace first.`,
      };
    case "archived":
    default:
      return { error: `Agent is not installed (disabled or uninstalled): ${identifierForError}` };
  }
}

/** A template carrying the canonical `packageName` the runtime-lifecycle gate
 *  keys on, plus the version the availability layer fences catalog edges with. */
export type RunnablePartitionItem = { packageName?: string | null; packageVersion?: string | null };

/**
 * agent_list (MCP discovery) / picker call-site helper — the lifecycle FILTER.
 *
 * The chat LLM discovers agents via `agent_list` then dispatches via `agent_run`.
 * Intersect the listed items against the canonical `installed_extension` source of
 * truth so a disabled/uninstalled (archived) agent disappears from discovery (it
 * would also be refused at `agent_run`, but the acceptance criterion is
 * "disappears from listing AND refuses to run"). CG-1: an item with NO canonical
 * row (legacy/bundled/ungoverned) or a `null` `packageName` stays listed (the
 * bundled floor). Fail-OPEN on a store outage (keep all — handled by
 * {@link resolveRunnableAgentPackageNames}).
 *
 * @returns the input `items`, in order, with every NON-runnable package removed —
 *   runtime-archived, catalog-governed-but-not-installed, or missing a required
 *   dependency (cinatra#2605: discovery must not advertise what `agent_run` will
 *   refuse). `null`/no-package and CG-1 no-row items are always kept. Any `total`
 *   / count is left to the caller (it is the org-wide upper bound, not the page
 *   size — under-counting it on a partial page would be misleading).
 */
export async function partitionRunnableAgentPackages<T extends RunnablePartitionItem>(
  items: ReadonlyArray<T>,
  deps: {
    readStatus?: ReadEffectiveInstallStatus;
    readCatalog?: ReadAgentCatalog;
    isBlockingEdge?: (dep: ExtensionDependency) => boolean;
  } = {},
): Promise<T[]> {
  const availability = await resolveAgentRunAvailabilityMap(
    items.map((t) => ({ packageName: t.packageName ?? null, packageVersion: t.packageVersion ?? null })),
    deps,
  );
  return items.filter(
    (t) =>
      t.packageName == null ||
      (availability.get(t.packageName)?.state ?? "runnable") === "runnable",
  );
}
