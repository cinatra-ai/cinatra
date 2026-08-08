import "server-only";

// ---------------------------------------------------------------------------
// INSTALL-RECORD HEAL (cinatra#2536).
//
// THE DEFECT. Every boot importer treats a matching `packageVersion` (or
// manifest hash) as proof that the package is fully installed, and SKIPS
// re-import: `… skipped — already up to date (bump packageVersion to force
// re-import)`. But the version signal lives on a DIFFERENT row than the install
// record — `agent_templates` / the on-disk tree vs `installed_extension` — so a
// reset/reinstall (or a producer whose artifact was never pulled into the
// install closure, cinatra#2537) can leave the version signal intact while the
// canonical `installed_extension` row is ABSENT. The package then LOADS and is
// selectable/runnable, yet it is not install-active, so:
//
//   1. nothing marks it install-active → the boot claim-activation backstop
//      (`runInstallAnchorClaimBackstop`) skips it → `artifact_type_claims`
//      never seeds;
//   2. `readEffectiveArtifactSafeTypeIdsForExtension` returns []; and
//   3. the materializer fails EVERY run with a MANIFEST-BLAMING error
//      (`declares no artifact-safe object type`) although the manifest is
//      correct and the type IS registered.
//
// It does not self-heal: the next boot re-hits the same skip.
//
// THE RULE THIS MODULE ENFORCES: "already up to date" REQUIRES a LIVE
// (`active`|`locked`) canonical install record. An ABSENT record at a matching
// version is a broken install, not a healthy one — it triggers this repair.
//
// WHAT THE REPAIR MAY AND MAY NOT DO:
//   - ABSENT record  → seed ONE platform-scoped `local`-source row through the
//     canonical lifecycle primitive (`installExtensionManifest` — never raw
//     SQL), so the manifest stays the single write authority.
//   - INACTIVE record (`archived`) → REFUSED. An archived row is an operator's
//     deliberate uninstall/archive decision and is authoritative lifecycle
//     memory; resurrecting it here would be the exact anti-pattern the
//     static-bundle anchor seeder is careful to avoid. The caller keeps
//     skipping (no per-boot re-import loop) and the condition is SURFACED.
//   - LIVE ONLY IN SPECIFIC ORGS (no platform anchor) → REFUSED. The package is
//     installed, just not instance-wide; seeding the ambient anchor would hand
//     every other org an install nobody granted them. The repair RESTORES a
//     missing record, it never broadens one.
//   - A LIVE ROW THAT CANNOT ANCHOR (governs another KIND, or no live row in
//     scope is the DEFAULT) → REFUSED and SURFACED. The identity slot is taken
//     so nothing can be seeded, and the claim backstop cannot use such a row —
//     calling it healthy would restore the very silence this module ends.
//   - UNREADABLE canonical store → REFUSED (fail closed): an unreadable store
//     cannot PROVE the record is absent, and seeding on a transient read error
//     could duplicate a live row.
//
// SCOPE IS NOT OPTIONAL. "Some live row exists" is not "install-active here" —
// the write/claim chain this failure runs through (`isArtifactExtensionWrite-
// Allowed`, and the claim read whose org chain is `platform` + `org:<id>`)
// admits an org's OWN live row, else an AMBIENT platform one, never another
// org's. The repair therefore reasons about the PLATFORM anchor and the
// diagnostics reason about the FAILING ORG's chain (codex round 1).
//
// IDENTITY IS PROVEN, NOT ASSERTED: a row is only ever seeded for a package
// whose on-disk manifest at `packageDir` actually declares that
// `name` (and, when it declares a `cinatra.kind`, that kind). A caller that
// cannot point at a readable manifest gets `refused-unverified` — the heal
// never mints a row for a package it cannot see.
//
// CONVERGENT + IDEMPOTENT BY CONSTRUCTION: the repair writes the very row the
// probe requires, so the NEXT call short-circuits at `already-live` with no
// write at all. One repair per broken package, once — never a re-import loop
// (the same self-limiting shape as the cinatra#2044 lifecycle-config drift
// check in `ensureAgentPackageFromGitFile`).
//
// Kill-switchable via `CINATRA_DISABLE_INSTALL_RECORD_HEAL=true`.
// ---------------------------------------------------------------------------

import type { ExtensionKind } from "@cinatra-ai/extensions/canonical-types";

/** Live install statuses. Mirrors the install anchor + the access gates. */
const LIVE_STATUSES = new Set(["active", "locked"]);

export type InstallRecordProbe =
  /**
   * A live (`active|locked`) row GOVERNS the queried scope — the package is
   * install-active there. `scope:"platform"` is the ambient anchor every org's
   * resolution chain sees; `scope:"organization"` is that org's own install.
   */
  | {
      state: "live";
      rowId: string;
      status: string;
      scope: "platform" | "organization";
      organizationId: string | null;
      /** The anchor row's recorded version (the claim fence compares it). */
      version: string | null;
    }
  /**
   * Live rows exist but NONE governs the queried scope — the package is
   * installed only in OTHER organizations (and there is no platform anchor).
   * Distinct from `absent` because the repair must NOT silently broaden one
   * org's install into an instance-wide one.
   */
  | { state: "live-elsewhere"; organizationIds: string[] }
  /**
   * A live row governs the scope but is NOT a usable anchor: it governs a
   * different KIND, or no live row in the scope is the DEFAULT. Both make the
   * claim-activation backstop skip the package (`pickSingleActiveRow` + its
   * `row.kind !== "artifact"` gate), so reporting "healthy" here would restore
   * exactly the silent failure this issue is about — and the identity slot is
   * taken, so the repair cannot seed over it either.
   */
  | { state: "mismatched"; rowId: string; reason: string }
  /** Rows exist, none live (an archived tombstone / deliberate uninstall). */
  | { state: "inactive"; rowId: string; status: string }
  /** No `installed_extension` row at all — the cinatra#2536 state. */
  | { state: "absent" }
  /** The canonical store could not be read — callers FAIL CLOSED on this. */
  | { state: "unreadable"; reason: string };

export type CanonicalRowView = {
  id: string;
  status: string;
  organizationId: string | null;
  /** The kind the row GOVERNS (`installed_extension.kind`). */
  kind: string | null;
  /** Is this the DEFAULT row for the identity? Side-by-side versions mean a
   *  package can hold several live rows; only the default owns the package's
   *  unversioned identity, and only it is anchor-eligible. */
  isDefault: boolean;
  /**
   * The row's LIVE provenance version. Updates rewrite `source.version` on the
   * SAME canonical row while the `version` COLUMN can lag, so the claim
   * backstop's stale-record fence reads `source.version` first and falls back
   * to the column — this mirrors that precedence exactly
   * (artifact-claim-install-anchor.ts). Reading the column alone would make the
   * heal think a freshly-updated install is a different version and go quiet.
   */
  version: string | null;
};

export type InstallRecordHealDeps = {
  /** Canonical rows for a package. Default: the canonical store. */
  readRows?: (packageName: string) => Promise<CanonicalRowView[]>;
  /** Create the healed row. Default: the canonical lifecycle primitive. */
  installRow?: (input: {
    id: string;
    packageName: string;
    kind: ExtensionKind;
    version: string;
    sourcePath: string;
  }) => Promise<void>;
  /** Read an on-disk `package.json`. Default: `node:fs/promises`. */
  readManifest?: (packageDir: string) => Promise<string>;
};

/**
 * The DEFAULT canonical-row read this module uses. Exported so a test can wrap
 * the REAL read (e.g. with a barrier that forces two boot passes to race the
 * identity index) without re-implementing its projection.
 */
export async function readInstallRecordRows(packageName: string): Promise<CanonicalRowView[]> {
  const { readInstalledExtensionsByPackageName } = await import(
    "@cinatra-ai/extensions/canonical-store"
  );
  const rows = await readInstalledExtensionsByPackageName(packageName);
  return rows.map((r) => {
    // `source.version` FIRST, the column as fallback — the same precedence the
    // claim backstop's fence uses (see `CanonicalRowView.version`).
    const sourceVersion =
      r.source && typeof (r.source as { version?: unknown }).version === "string"
        ? (r.source as { version: string }).version
        : null;
    return {
      id: r.id,
      status: r.status,
      organizationId: r.organizationId ?? null,
      kind: r.kind ?? null,
      // A row read from the DB always carries `is_default` (NOT NULL DEFAULT
      // true); the `?? true` only covers hand-built fixtures, matching how every
      // other reader treats an unset value.
      isDefault: r.isDefault ?? true,
      version: sourceVersion ?? r.version ?? null,
    };
  });
}

async function defaultReadManifest(packageDir: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  return readFile(join(packageDir, "package.json"), "utf8");
}

/**
 * Probe the canonical install record for a package, AT A SCOPE.
 *
 * SCOPE MATTERS and a scope-blind probe is wrong in both directions (codex
 * round 1, High). "Some live row exists" is NOT "this package is install-active
 * here": the write/claim chain this failure runs through
 * (`isArtifactExtensionWriteAllowed` and the org-chain claim read, which sees
 * `platform` plus `org:<id>`) admits the org's OWN live row, else an AMBIENT
 * platform one — never another org's. So:
 *
 *   - `opts.orgId` GIVEN (the diagnostics view): governed by this org's own
 *     live row, else a live platform row. Live rows belonging only to OTHER
 *     orgs report `live-elsewhere`, so an unserved org is never told "it is
 *     installed, just restart".
 *   - `opts.orgId` OMITTED (the REPAIR's anchor view): only a live PLATFORM row
 *     counts. The repair seeds the ambient anchor, so an org-scoped install
 *     must not suppress it — but it must not be silently broadened into one
 *     either (see the heal's `refused-org-scoped`).
 *
 * IDENTITY MATTERS TOO (codex round 2, High). A live row is only an ANCHOR when
 * it governs the expected KIND and is the DEFAULT row: the claim-activation
 * backstop picks `pickSingleActiveRow` (default, unambiguous) and drops
 * anything whose `kind` is not `artifact`. A row failing either test would be
 * reported "healthy" while claims never seed — the exact silent failure this
 * module exists to end — so it reports `mismatched` instead.
 *
 * NEVER throws: a store read failure resolves to `unreadable` so every caller
 * can make its own fail-closed decision instead of crashing a boot importer.
 */
export async function probeInstallRecord(
  packageName: string,
  deps: InstallRecordHealDeps = {},
  opts: { orgId?: string | null; expectKind?: ExtensionKind } = {},
): Promise<InstallRecordProbe> {
  const readRows = deps.readRows ?? readInstallRecordRows;
  let rows: CanonicalRowView[];
  try {
    rows = await readRows(packageName);
  } catch (err) {
    return { state: "unreadable", reason: err instanceof Error ? err.message : String(err) };
  }
  if (rows.length === 0) return { state: "absent" };

  const live = rows.filter((r) => LIVE_STATUSES.has(r.status));
  const orgId = opts.orgId ?? null;
  // The org's OWN live rows win over the ambient anchor (same precedence as the
  // write/claim chain); the anchor view (no orgId) considers platform rows only.
  const ownLive = orgId === null ? [] : live.filter((r) => r.organizationId === orgId);
  const platformLive = live.filter((r) => r.organizationId === null);
  const inScope = ownLive.length > 0 ? ownLive : platformLive;
  if (inScope.length > 0) {
    // Anchor eligibility: EXACTLY ONE default row in the scope, governing the
    // expected kind. `pickSingleActiveRow` — the row pick the claim backstop
    // actually performs — fails closed on ambiguity, so accepting the first of
    // several defaults here would again report "healthy" for a package whose
    // claims can never activate.
    const anchors = inScope.filter(
      (r) => r.isDefault && (opts.expectKind === undefined || r.kind === opts.expectKind),
    );
    if (anchors.length === 1) {
      const anchor = anchors[0]!;
      return {
        state: "live",
        rowId: anchor.id,
        status: anchor.status,
        scope: anchor.organizationId === null ? "platform" : "organization",
        organizationId: anchor.organizationId,
        version: anchor.version,
      };
    }
    const shown = (anchors[0] ?? inScope[0])!;
    const kinds = [...new Set(inScope.map((r) => r.kind ?? "null"))].join(", ");
    return {
      state: "mismatched",
      rowId: shown.id,
      reason:
        anchors.length > 1
          ? `${anchors.length} live DEFAULT installed_extension rows share this scope — the ` +
            `claim-activation backstop resolves a single default row and fails closed on ambiguity, ` +
            `so no claim can activate; reconcile the duplicate install rows`
          : opts.expectKind !== undefined && !inScope.some((r) => r.kind === opts.expectKind)
            ? `a live installed_extension row exists but governs kind [${kinds}], not "${opts.expectKind}" — ` +
              `the claim-activation backstop drops it, so its artifact type claims can never seed; ` +
              `reinstall the package so its canonical row governs the right kind`
            : `a live installed_extension row exists but NONE is the default row for its identity ` +
              `(side-by-side versions) — the claim-activation backstop resolves only the default row; ` +
              `promote/reinstall the intended version`,
    };
  }
  // Nothing governs this scope. An ARCHIVE anywhere is checked BEFORE the
  // other-org case: it is a deliberate lifecycle decision and outranks a
  // broadening repair (see `refused-archived`).
  const inactive = rows.find((r) => !LIVE_STATUSES.has(r.status));
  if (inactive) return { state: "inactive", rowId: inactive.id, status: inactive.status };
  return {
    state: "live-elsewhere",
    organizationIds: [...new Set(live.map((r) => r.organizationId).filter((o): o is string => o !== null))],
  };
}

export type InstallRecordHealOutcome =
  /** A live row already existed — NO write (the idempotent re-fire). */
  | "already-live"
  /** A live row was created for a package that had none. */
  | "repaired"
  /** A non-live row exists — an operator decision, never resurrected. */
  | "refused-archived"
  /** Live only in specific organizations — never silently broadened. */
  | "refused-org-scoped"
  /** A live row occupies the identity slot but cannot anchor (kind/default). */
  | "refused-mismatched-row"
  /** The on-disk manifest could not prove this package's identity. */
  | "refused-unverified"
  /** The canonical store could not be read (fail closed). */
  | "refused-unreadable"
  /** `CINATRA_DISABLE_INSTALL_RECORD_HEAL=true`. */
  | "refused-disabled"
  /** The repair write itself failed. */
  | "failed";

export type InstallRecordHealResult = {
  outcome: InstallRecordHealOutcome;
  /** The live row's id — set for `already-live` and `repaired`. */
  rowId?: string;
  /** The live row's recorded VERSION — set for `already-live` and `repaired`. */
  rowVersion?: string | null;
  /** Human-readable detail for every non-healthy outcome. */
  reason?: string;
};

/** Is the package install-active after this heal? */
export function healLeftRecordLive(result: InstallRecordHealResult): boolean {
  return result.outcome === "already-live" || result.outcome === "repaired";
}

/**
 * Repair an ABSENT canonical install record for a package that is loaded from
 * an on-disk (in-tree / bundled) package dir. See the module header for the
 * absent/inactive/unreadable policy. Idempotent; never throws.
 */
export async function healMissingInstallRecord(
  input: {
    packageName: string;
    kind: ExtensionKind;
    /** The on-disk package dir — the manifest there PROVES the identity. */
    packageDir?: string;
    /** The manifest version, recorded on the healed row. */
    version?: string;
  },
  deps: InstallRecordHealDeps = {},
): Promise<InstallRecordHealResult> {
  if ((process.env.CINATRA_DISABLE_INSTALL_RECORD_HEAL ?? "").trim() === "true") {
    return { outcome: "refused-disabled", reason: "CINATRA_DISABLE_INSTALL_RECORD_HEAL=true" };
  }

  // ANCHOR VIEW (no orgId): the repair owns the ambient PLATFORM anchor, so
  // only a live platform row that can actually ANCHOR (default row, expected
  // kind) makes it a no-op.
  const probe = await probeInstallRecord(input.packageName, deps, { expectKind: input.kind });
  if (probe.state === "live") {
    return { outcome: "already-live", rowId: probe.rowId, rowVersion: probe.version };
  }
  if (probe.state === "unreadable") {
    return { outcome: "refused-unreadable", reason: probe.reason };
  }
  if (probe.state === "mismatched") {
    // The identity slot is occupied by a live row the claim backstop cannot
    // use. Seeding is impossible (unique identity) and reporting "healthy"
    // would hide the failure — surface it instead.
    return { outcome: "refused-mismatched-row", rowId: probe.rowId, reason: probe.reason };
  }
  if (probe.state === "inactive") {
    // A non-live row is authoritative lifecycle memory (an operator's
    // uninstall/archive) at SOME scope. Never resurrected here — restore is an
    // explicit, audited lifecycle op, not a boot-time side effect. Seeding an
    // ambient platform anchor would be worse than a status flip: the access
    // gates fall back to an ambient live row when an org's own row is archived,
    // so it would resurrect that org's uninstall THROUGH the anchor.
    return {
      outcome: "refused-archived",
      rowId: probe.rowId,
      reason: `installed_extension row is '${probe.status}' — a deliberate archive/uninstall is never resurrected by the boot repair; restore the extension to make it install-active`,
    };
  }
  if (probe.state === "live-elsewhere") {
    // The package IS installed — just not instance-wide. Seeding a platform
    // anchor here would hand every other org an install nobody granted them,
    // which is a governance decision the boot repair has no business making.
    // The repair only ever RESTORES a package that has no rows at all.
    return {
      outcome: "refused-org-scoped",
      reason:
        `installed_extension rows exist and are live only for organization(s) ` +
        `[${probe.organizationIds.join(", ")}] — the boot repair restores a MISSING install record, it never ` +
        `broadens an organization's install into an instance-wide one; install the extension for the ` +
        `affected organization`,
    };
  }

  // ABSENT — prove the identity off the on-disk manifest before minting a row.
  if (!input.packageDir) {
    return {
      outcome: "refused-unverified",
      reason: "no on-disk package dir was supplied — the repair never mints a row for a package it cannot read",
    };
  }
  const readManifest = deps.readManifest ?? defaultReadManifest;
  let manifest: { name?: unknown; version?: unknown; cinatra?: { kind?: unknown } };
  try {
    manifest = JSON.parse(await readManifest(input.packageDir));
  } catch (err) {
    return {
      outcome: "refused-unverified",
      reason: `package.json under ${input.packageDir} is unreadable/invalid (${err instanceof Error ? err.message : String(err)})`,
    };
  }
  if (manifest?.name !== input.packageName) {
    return {
      outcome: "refused-unverified",
      reason: `package.json under ${input.packageDir} declares name ${JSON.stringify(manifest?.name ?? null)}, not "${input.packageName}"`,
    };
  }
  const declaredKind = manifest?.cinatra?.kind;
  if (typeof declaredKind === "string" && declaredKind !== input.kind) {
    return {
      outcome: "refused-unverified",
      reason: `package.json under ${input.packageDir} declares cinatra.kind "${declaredKind}", not "${input.kind}"`,
    };
  }

  const version =
    input.version ?? (typeof manifest.version === "string" ? manifest.version : undefined) ?? "0.0.0";

  const installRow = deps.installRow ?? defaultInstallRow;
  const { randomUUID } = await import("node:crypto");
  try {
    await installRow({
      id: `iext_${randomUUID().slice(0, 12)}`,
      packageName: input.packageName,
      kind: input.kind,
      version,
      sourcePath: input.packageDir,
    });
  } catch (err) {
    // A concurrent boot/worker may have inserted the row between our probe and
    // this write (the identity slot is unique). Re-probe before reporting a
    // failure — a race that ends with a live ANCHOR row is a SUCCESS. The
    // re-probe carries the SAME `expectKind` as the first one: a race winner
    // that governs another kind (or leaves the scope ambiguous) is not a
    // healthy outcome just because it won.
    const after = await probeInstallRecord(input.packageName, deps, { expectKind: input.kind });
    if (after.state === "live") {
      return { outcome: "already-live", rowId: after.rowId, rowVersion: after.version };
    }
    return {
      outcome: "failed",
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  const after = await probeInstallRecord(input.packageName, deps, { expectKind: input.kind });
  if (after.state === "live") {
    return { outcome: "repaired", rowId: after.rowId, rowVersion: after.version };
  }
  return {
    outcome: "failed",
    reason: `the repair write reported success but no live installed_extension row is readable for ${input.packageName}`,
  };
}

async function defaultInstallRow(input: {
  id: string;
  packageName: string;
  kind: ExtensionKind;
  version: string;
  sourcePath: string;
}): Promise<void> {
  const { installExtensionManifest } = await import(
    "@cinatra-ai/extensions/lifecycle-primitive"
  );
  const { isPackageRequiredInProd } = await import("@cinatra-ai/extensions/required-in-prod");
  await installExtensionManifest(
    {
      id: input.id,
      packageName: input.packageName,
      // PLATFORM scope: the package is present on the instance's own disk, not
      // acquired by one org. This mirrors the static-bundle anchor's scope, so
      // the row is visible to every org's resolution chain (an org-scoped heal
      // would silently exclude every other org).
      ownerLevel: "platform",
      ownerId: null,
      organizationId: null,
      kind: input.kind,
      source: {
        type: "local",
        path: input.sourcePath,
        // Local sources carry no registry identity; the in-tree materialization
        // IS the payload, so the version identifies it.
        resolvedCommitOrTreeHash: `in-tree@${input.version}`,
      },
      // Passed EXPLICITLY (the store would otherwise floor a `local` source to
      // `0.0.0`): the claim-activation backstop's stale-record fence compares
      // this against the store manifest's own version, and a floored row would
      // make the fence skip every activation.
      version: input.version,
      requiredInProd: isPackageRequiredInProd(input.packageName),
      // SEED ONLY, exactly like the dispatcher's placeholder row: the manifest's
      // real edges are recorded by the materializing install path. Seeding
      // declared edges here would let a heal row carry an install-blocking edge
      // to a package that is NOT installed, which the prod extension-closure
      // boot gate fails CLOSED on — a repair must never be able to brick a boot.
      dependencies: [],
      manifestHash: null,
    },
    {
      actor: { source: "install-record-heal" },
      reason: "cinatra#2536 boot repair — loaded package had no canonical install record",
    },
  );
}

// ---------------------------------------------------------------------------
// Artifact packages: record + CLAIMS.
// ---------------------------------------------------------------------------

export type ArtifactHealResult = {
  record: InstallRecordHealResult;
  /**
   * What the claim-activation pass did.
   *   `converged`      — at least one scope activated or matched (healthy);
   *   `failed`         — the hook reported a lifecycle failure;
   *   `skipped`        — it ran (or could not run) and converged NOTHING; the
   *                      claims still do not exist → a SURFACED condition;
   *   `not-applicable` — the live record describes a DIFFERENT version than
   *                      this on-disk dir, so this dir is not its claim source
   *                      (the store-based boot backstop owns it). Not a problem.
   */
  claims: "converged" | "failed" | "skipped" | "not-applicable";
  detail?: string;
};

/**
 * The FULL instance-level heal for a loaded `kind:"artifact"` package: repair
 * the canonical install record, then converge `artifact_type_claims`.
 *
 * The claim half REUSES `runInstallAnchorClaimBackstop` — the same idempotent
 * hook the install anchor and the boot bridge rescan fire (diff-first: a
 * healthy install no-ops on a live-claims match, a drifted one routes through
 * retire+replay). No second activation path is introduced. The object-type
 * registry is warmed first so the fail-closed per-claim activation gate can
 * resolve each claimed type's validator.
 *
 * Never throws — a heal failure must never break a boot scan or a hot reload.
 */
export async function healArtifactInstallRecordAndClaims(
  input: { packageName: string; packageDir: string; version?: string },
  deps: InstallRecordHealDeps = {},
): Promise<ArtifactHealResult> {
  const record = await healMissingInstallRecord(
    { packageName: input.packageName, kind: "artifact", packageDir: input.packageDir, version: input.version },
    deps,
  );
  if (!healLeftRecordLive(record)) {
    return { record, claims: "skipped", detail: record.reason };
  }
  // A PRE-EXISTING install at a DIFFERENT version is not this dir's business:
  // the claim backstop's stale-record fence compares the row's version against
  // the manifest it is handed, so activating from an in-tree dir that describes
  // another version would (correctly) be refused. Report it as not-applicable
  // rather than as a failure, so a dev tree that runs ahead of the installed
  // version does not warn on every boot (codex round 2).
  if (
    record.outcome === "already-live" &&
    input.version !== undefined &&
    record.rowVersion != null &&
    record.rowVersion !== input.version
  ) {
    return {
      record,
      claims: "not-applicable",
      detail:
        `the live installed_extension row records version ${record.rowVersion}, not the ${input.version} ` +
        `materialized at ${input.packageDir} — its claims are owned by that version's store record`,
    };
  }
  try {
    const { ensureArtifactTypesRegistered } = await import("@/lib/artifacts/ensure-artifact-registry");
    ensureArtifactTypesRegistered();
    const { runInstallAnchorClaimBackstop } = await import(
      "@/lib/objects/artifact-claim-install-anchor"
    );
    const backstop = await runInstallAnchorClaimBackstop([
      { packageName: input.packageName, storeDir: input.packageDir },
    ]);
    const tally = `converged=${backstop.converged} failed=${backstop.failed} skipped=${backstop.skipped}`;
    // A backstop that converged NOTHING is not a success (codex round 2): it
    // skips a row whose recorded version no longer matches the vetted store
    // manifest (its stale-record fence), an unreadable manifest, and a
    // non-default/foreign-kind row. Reporting "converged" there would restore
    // the silent failure — the claims still do not exist.
    if (backstop.failed > 0) return { record, claims: "failed", detail: tally };
    if (backstop.converged === 0) {
      return {
        record,
        claims: "skipped",
        detail:
          `${tally} — the claim-activation backstop converged nothing for "${input.packageName}"; ` +
          `its artifact_type_claims remain unseeded (common causes: the canonical row's recorded version ` +
          `does not match the package manifest's version, or the manifest is unreadable at ${input.packageDir})`,
      };
    }
    return { record, claims: "converged", detail: tally };
  } catch (err) {
    return {
      record,
      claims: "failed",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// DIAGNOSTICS (cinatra#2536 item 3) — stop blaming a correct manifest.
// ---------------------------------------------------------------------------

/**
 * Explain why an extension has NO effective artifact-safe claim, in terms of
 * the INSTALL state rather than the manifest.
 *
 * The materializer's pure resolver can only see "this extension contributes
 * zero artifact-safe declared types" and historically reported that as
 * `extension "<x>" declares no artifact-safe object type — … declare a
 * produces/binding objectTypeId over an artifact-safe claim`, which sends a
 * developer to edit a manifest that is already correct. The real cause is
 * almost always an incomplete install: no install record, an archived one, or a
 * live record whose claims never activated. Each of those has a DIFFERENT heal,
 * so each gets its own sentence — and every one of them names what is missing
 * and how it heals.
 *
 * Never throws: on any read failure it returns a message that says the install
 * state could not be read (still not manifest-blaming).
 */
export async function explainAbsentArtifactSafeClaims(
  input: {
    orgId: string;
    extension: string;
    /** The type ids the pack manifest declares, when resolvable. */
    declaredObjectTypeIds?: readonly string[];
  },
  deps: InstallRecordHealDeps = {},
): Promise<string> {
  const named =
    input.declaredObjectTypeIds && input.declaredObjectTypeIds.length > 0
      ? input.declaredObjectTypeIds.map((t) => `"${t}"`).join(", ")
      : "its declared object type(s)";
  // Only ASSERT the manifest is fine when we actually read its declarations.
  // When the pack manifest could not be resolved/validated from here it may
  // ALSO be malformed, and claiming otherwise would be its own false lead
  // (codex round 3, Medium).
  const manifestNote =
    input.declaredObjectTypeIds && input.declaredObjectTypeIds.length > 0
      ? "The extension manifest is not at fault."
      : "The pack manifest could not be read/validated from this instance, so check it too — but the install state named here is the first thing to fix.";
  // SCOPED to the failing org (codex round 1, High): another org's live row must
  // never be reported to THIS org as "installed, just restart" — that advice
  // would be a no-op forever.
  const probe = await probeInstallRecord(input.extension, deps, { orgId: input.orgId });
  switch (probe.state) {
    case "absent":
      return (
        `extension "${input.extension}" is NOT install-active: no installed_extension row exists for it, ` +
        `so no artifact-safe claim over ${named} was ever seeded in artifact_type_claims for org "${input.orgId}". ` +
        `${manifestNote} Heal: install the extension (it is loaded from disk but never installed), ` +
        `or restart the instance — the boot importer repairs a missing install record and reseeds the claims (cinatra#2536).`
      );
    case "live-elsewhere":
      return (
        `extension "${input.extension}" is not install-active for org "${input.orgId}": it is installed only in ` +
        `organization(s) [${probe.organizationIds.join(", ")}] and there is no platform-wide install, so no ` +
        `artifact-safe claim over ${named} governs this org. ${manifestNote} Heal: install ` +
        `the extension for THIS organization — a restart cannot fix it (the boot repair never broadens another ` +
        `organization's install).`
      );
    case "mismatched":
      return (
        `no artifact-safe claim for ${named} governs org "${input.orgId}" — the install record for ` +
        `"${input.extension}" cannot anchor one: ${probe.reason}. ${manifestNote}`
      );
    case "inactive":
      return (
        `extension "${input.extension}" is NOT install-active: its installed_extension row is '${probe.status}' ` +
        `(archived/uninstalled), so its artifact-safe claim over ${named} is retired for org "${input.orgId}". ` +
        `${manifestNote} Heal: restore/reinstall the extension — the boot repair deliberately ` +
        `never resurrects an archive.`
      );
    case "live":
      return (
        `no active artifact-safe claim for ${named} in org "${input.orgId}" — extension install/activation incomplete ` +
        `for "${input.extension}" (its ${probe.scope}-scoped installed_extension row is '${probe.status}', but ` +
        `artifact_type_claims holds no active claim governing this org). ${manifestNote} ` +
        `Heal: restart the instance (the boot claim-activation backstop re-fires activation) or reinstall the extension.`
      );
    case "unreadable":
      return (
        `no artifact-safe claim resolved for "${input.extension}" in org "${input.orgId}" and its install state could ` +
        `not be read (${probe.reason}) — this is an install/activation or store-availability problem, not a manifest ` +
        `problem. Heal: check the database/extension store, then restart the instance.`
      );
  }
}
