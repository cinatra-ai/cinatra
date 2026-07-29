import "server-only";

import { syncCatalogSkillsToAnthropic } from "@/lib/anthropic-skill-sync-service";
import { reclaimStaleAnthropicSkills } from "@/lib/anthropic-skill-gc-service";
import { createNotification } from "@/lib/notifications";
import {
  readAnthropicSkillSyncEnabledFromDatabase,
  writeAnthropicSkillSyncEnabledToDatabase,
  // Consent-ledger writers (cinatra#2092, S5). Each runs the ledger write, the
  // recomputed `allowAnthropicUpload` projection and a reconcile-request row in
  // ONE transaction.
  grantSkillUploadConsentInDatabase,
  grantBulkSkillUploadConsentInDatabase,
  readSkillCatalogFromDatabase,
  revokeSkillUploadConsentInDatabase,
} from "@/lib/database";
import {
  buildAnthropicUploadConsentPrompt,
  resolveAnthropicUploadConsentDecision,
  type AnthropicUploadConsentInput,
  type ConsentClosureMember,
  type ConsentDecision,
  type ConsentPrompt,
} from "@cinatra-ai/llm";

/**
 * Eager, admin-save-time orchestration of the Anthropic Custom Skills sync + GC.
 *
 * Extracted from `setDefaultProvidersAction` (src/app/campaigns/actions.ts) so
 * the core LLM-settings save AND the connector-owned Skills-tab write share ONE
 * canonical path. The connector reaches this through the
 * `@cinatra-ai/host:anthropic-skill-config` host capability (registered in
 * `register-host-connector-services.ts`): the capability's `write` persists the
 * opt-in then calls this; core's own settings save calls it directly.
 *
 * Pre-syncs the catalog then reclaims stale remote skills, each notifying the
 * admin on failure and never rolling the already-persisted settings back. Both
 * underlying services short-circuit on a non-true global opt-in, so this is a
 * no-op when the Skills-upload opt-in is OFF.
 */
export async function orchestrateAnthropicSkillSync(): Promise<void> {
  // Pre-sync at admin-save time, not lazily on first agent run. The opt-in
  // write by the caller is already persisted; a sync failure must not roll the
  // save back, but it must be visible through an admin notification rather than
  // silent best-effort. Inert when the opt-in is OFF because the service returns
  // immediately on a non-true global flag.
  try {
    const result = await syncCatalogSkillsToAnthropic();
    if (!result.ok) {
      const detail =
        result.namespaceError ??
        result.preflightError?.message ??
        "Anthropic skill sync reported a configuration error.";
      await createNotification({
        title: "Anthropic skill sync configuration error",
        body: detail,
        kind: "error",
      });
    }
    // A REFUSED skill (cinatra#2089, S2): its stored bundle's router points at a
    // file the bundle does not ship, so the fail-closed one-hop lint kept it out
    // of the upload set. The run itself SUCCEEDS (`ok: true`) — every other skill
    // syncs — but the refused skill stops being published and its already
    // uploaded copy is marked stale for GC reclamation. Without this the refusal
    // would be invisible: the operator would see a green save and a skill that
    // quietly disappeared from the provider. Notify by NAME.
    const refused = result.captureDiagnostics?.refusedForDanglingReferences ?? [];
    if (refused.length > 0) {
      await createNotification({
        title: `Anthropic skill sync skipped ${refused.length} skill(s) with a broken reference`,
        body:
          "These skills were NOT uploaded because their SKILL.md points at files the " +
          "bundle does not ship (a router may only point one hop, at files it ships). " +
          "Any copy already uploaded is marked stale and will be reclaimed. Fix the " +
          "reference or ship the file, then save again: " +
          refused
            .map((r) => `${r.catalogSkillId} → ${r.missing.join(", ")}`)
            .join("; "),
        kind: "error",
      });
    }
  } catch (err) {
    await createNotification({
      title: "Anthropic skill sync failed",
      body:
        "Anthropic skill sync did not complete. The provider settings were " +
        "saved. " +
        (err instanceof Error ? err.message : String(err)),
      kind: "error",
    });
  }

  // Leased/refcounted remote GC is an explicit maintenance step, not the hot
  // agent-run path. Runs after the pre-sync above: sync marks catalog-removed
  // or excluded rows stale; GC then reclaims remote skills that have aged past
  // the grace window with zero in-flight leases. The same governance opt-in
  // controls it, so it is inert when OFF. A GC failure must not roll the settings
  // save back, but it must be visible through an admin notification.
  try {
    const gc = await reclaimStaleAnthropicSkills();
    if (!gc.ok) {
      const detail =
        gc.namespaceError ??
        (gc.errors.length > 0
          ? gc.errors
              .map((e) => `${e.anthropicSkillId}: ${e.message}`)
              .join("; ")
          : "Anthropic skill GC reported an error.");
      await createNotification({
        title: "Anthropic skill GC error",
        body: detail,
        kind: "error",
      });
    }
  } catch (err) {
    await createNotification({
      title: "Anthropic skill GC failed",
      body:
        "Anthropic skill garbage collection did not complete. The provider " +
        "settings were saved and no skill was over-deleted. " +
        (err instanceof Error ? err.message : String(err)),
      kind: "error",
    });
  }
}

/** The `{ read, write }` surface the anthropic-connector's Skills tab resolves
 * (structurally guarded on both being functions — anthropic-connector#44). */
export interface HostAnthropicSkillConfigCapability {
  /** The canonical, fail-closed (`=== true`) opt-in the core consumers read. */
  read(): boolean;
  /** Persist the opt-in then run the eager sync + GC orchestration. */
  write(enabled: boolean): Promise<void>;
}

/**
 * Build the `@cinatra-ai/host:anthropic-skill-config` host-capability impl the
 * anthropic-connector's Skills tab resolves + calls (registered in
 * `register-host-connector-services.ts`). The host owns the FULL write path so
 * the connector stays a thin caller: it just calls `write(enabled)`.
 *
 * `write` is the migrated equivalent of the core `setDefaultProvidersAction`
 * skill block: admin-gate (fail-closed) → persist a primitive boolean to the
 * canonical key → eager catalog-sync + stale-GC (admin-notify on failure, the
 * save never rolled back, inert when OFF). `read` mirrors the canonical reader
 * so the connector renders a read-backed toggle from the same value the ~7 core
 * consumers observe.
 */
/**
 * The capability's `write`: admin-gate (fail-closed) → persist the primitive
 * boolean to the canonical key → run the eager sync + GC orchestration. The
 * admin gate is imported LAZILY so the boot binder that registers this
 * capability can reach it through a dynamic import (keeping the binder's own
 * top-level module graph free of this file's sync/GC deps — auth + the sync/GC
 * services load only when an admin actually writes, not at every boot).
 */
export async function writeAnthropicSkillConfig(enabled: boolean): Promise<void> {
  // An untrusted connector call must never persist this non-ZDR data-egress
  // opt-in without an admin session (mirrors `setDefaultProvidersAction`).
  const { requireAdminSession } = await import("@/lib/auth-session");
  const session = await requireAdminSession();
  writeAnthropicSkillSyncEnabledToDatabase(enabled);
  // cinatra#2092 (S5): turning the workspace opt-in ON is the "setup with
  // Anthropic" step, and it now carries an EXPLICIT BULK-CONSENT act covering
  // the already-installed injectable packages plus the core system-tier skills.
  // Without it the derived `allowAnthropicUpload` projection would stay false
  // for every package installed BEFORE the opt-in and nothing would ever
  // upload — the exact "new skills can never acquire the flag" trap S5 closes.
  // The grant writes the ledger, recomputes the projection and appends a
  // reconcile request in ONE transaction; turning the opt-in OFF revokes
  // nothing (the ledger is durable consent, the opt-in is the outer gate that
  // already stops all egress).
  if (enabled) {
    try {
      grantSetupWithAnthropicBulkConsent(session.user?.id ?? null);
    } catch (err) {
      // Non-fatal: the opt-in is saved and the orchestration below still runs.
      // A failed bulk grant leaves packages upload-ineligible (fail-closed),
      // never over-shared.
      console.warn(
        "[anthropic-skill-consent] setup bulk-consent grant failed (opt-in saved; packages stay upload-ineligible):",
        err instanceof Error ? err.message : err,
      );
    }
  }
  await orchestrateAnthropicSkillSync();
}

export function createAnthropicSkillConfigCapability(): HostAnthropicSkillConfigCapability {
  return {
    read: (): boolean => readAnthropicSkillSyncEnabledFromDatabase(),
    write: writeAnthropicSkillConfig,
  };
}


// ---------------------------------------------------------------------------
// Upload-on-install CONSENT SERVICE (cinatra#2092, epic #2086 S5).
//
// The I/O half of the consent slice: resolve the install closure from the real
// catalog, apply the pure fail-closed policy (`@cinatra-ai/llm`, beside the
// per-skill upload gate), and write the ledger through the transactional
// writers in `@/lib/database` — each of which recomputes the derived
// `allowAnthropicUpload` projection and appends a reconcile-request row in the
// SAME transaction, so a consent change can never be lost between commit and
// worker run.
//
// It lives in THIS file — the existing Anthropic-skill config surface, already
// in every locked route's graph — rather than in a module of its own, so the
// install surfaces that call it add no route-graph pressure (the ratchet).
//
// AuthZ note: these writers are reached only from admin-gated server actions /
// admin-gated MCP handlers, or from a personal-skill owner path that checks
// ownership at its call site. Nothing here widens an authorization.
// ---------------------------------------------------------------------------

/** Fail-closed read of the workspace opt-in (any read error → OFF). */
export function readUploadOptIn(): boolean {
  try {
    return readAnthropicSkillSyncEnabledFromDatabase() === true;
  } catch {
    return false;
  }
}

/**
 * Every skill-package identity currently in the catalog. The install closure is
 * derived by DIFFING this across an install, which is exact by construction:
 * whatever the install saga actually pulled in — the root plus every transitive
 * skill extension — is precisely the set of packageIds that appeared.
 */
export function snapshotSkillPackageIds(): Set<string> {
  try {
    const catalog = readSkillCatalogFromDatabase();
    const ids = new Set<string>();
    for (const row of catalog.skillPackages) {
      const id = (row as { id?: unknown }).id;
      if (typeof id === "string" && id) ids.add(id);
    }
    return ids;
  } catch {
    return new Set<string>();
  }
}

function packageNameFor(packageId: string): string {
  try {
    const catalog = readSkillCatalogFromDatabase();
    const row = catalog.skillPackages.find(
      (entry) => (entry as { id?: unknown }).id === packageId,
    ) as { name?: unknown; packageName?: unknown } | undefined;
    const name = row?.packageName ?? row?.name;
    return typeof name === "string" && name ? name : packageId;
  } catch {
    return packageId;
  }
}

/**
 * Resolve the closure that an install ACTUALLY produced: the packages present
 * after the catalog rebuild that were not present before. `rootPackageId` marks
 * the package the operator asked for; everything else is transitive.
 */
export function resolveInstalledClosure(input: {
  before: ReadonlySet<string>;
  rootPackageId: string;
}): ConsentClosureMember[] {
  const after = snapshotSkillPackageIds();
  const added = [...after].filter((id) => !input.before.has(id));
  // An idempotent re-install adds nothing; the root is still the thing being
  // consented to, so it is always a member when it is in the catalog.
  if (after.has(input.rootPackageId) && !added.includes(input.rootPackageId)) {
    added.push(input.rootPackageId);
  }
  return added.sort().map((packageId) => ({
    packageId,
    packageName: packageNameFor(packageId),
    isRoot: packageId === input.rootPackageId,
  }));
}

/**
 * Build the interactive install confirmation for a closure the caller resolved
 * (pre-install: the planned closure; post-install: the produced one). The
 * digest it returns is the evidence the confirming call must echo back.
 */
export function buildInstallConsentPrompt(input: {
  rootPackageName: string;
  closure: readonly ConsentClosureMember[];
}): ConsentPrompt {
  return buildAnthropicUploadConsentPrompt({
    rootPackageName: input.rootPackageName,
    closure: input.closure,
    optInEnabled: readUploadOptIn(),
  });
}

export type RecordedConsentOutcome = ConsentDecision & {
  /** The scope keys actually written (empty on every fail-closed branch). */
  granted: string[];
};

/**
 * Apply the fail-closed policy to an install and, when it grants, write ONE
 * `extension` consent row per closure member. Each write recomputes the derived
 * projection and appends a reconcile request in its own transaction, so the
 * newly-consented skills upload with no manual toggle (S5 AC1) while a
 * consent-less install stays upload-ineligible with the outcome RECORDED
 * (S5 AC2).
 */
export function recordSkillInstallConsent(input: {
  consent: AnthropicUploadConsentInput | null | undefined;
  closure: readonly ConsentClosureMember[];
  grantedBy: string | null;
  interactive: boolean;
}): RecordedConsentOutcome {
  const decision = resolveAnthropicUploadConsentDecision({
    consent: input.consent,
    closure: input.closure,
    optInEnabled: readUploadOptIn(),
    interactive: input.interactive,
  });
  if (!decision.grant) {
    console.log(
      `[anthropic-skill-consent] install consent NOT recorded (${decision.reason}): ${decision.outcome}`,
    );
    return { ...decision, granted: [] };
  }
  const granted: string[] = [];
  for (const scopeKey of decision.scopeKeys) {
    grantSkillUploadConsentInDatabase({
      // Provenance only — the projection joins `extension` and `core-system`
      // identically, so a tier misclassification can never orphan a grant.
      scopeKind: "extension",
      scopeKey,
      grantedBy: input.grantedBy,
      sourceEvent: "extension-install",
    });
    granted.push(scopeKey);
  }
  console.log(
    `[anthropic-skill-consent] install consent recorded for ${granted.length} package identity/identities`,
  );
  return { ...decision, granted };
}

/**
 * Revoke a package identity's consent. The next projection run (this write's
 * own transaction) flips `allowAnthropicUpload` to false; the reconcile marks
 * the remote copy stale and the GC reclaims it (S5 AC4).
 */
export function revokeSkillPackageUploadConsent(input: {
  packageId: string;
  revokedBy: string | null;
}): void {
  // ONE call clears whichever provenance tier granted it: the revoke statement
  // matches the same COLLAPSED package target the grant checks and the unique
  // index enforces, so a bulk-consented (`core-system`) package cannot survive
  // an install-consented (`extension`) revoke or vice versa.
  revokeSkillUploadConsentInDatabase({
    scopeKind: "extension",
    scopeKey: input.packageId,
    revokedBy: input.revokedBy,
  });
}

/** Personal skills keep PER-SKILL grants (scope key = the catalog skill id). */
export function grantPersonalSkillUploadConsent(input: {
  skillId: string;
  grantedBy: string | null;
}): void {
  grantSkillUploadConsentInDatabase({
    scopeKind: "personal",
    scopeKey: input.skillId,
    grantedBy: input.grantedBy,
    sourceEvent: "personal-grant",
  });
}

export function revokePersonalSkillUploadConsent(input: {
  skillId: string;
  revokedBy: string | null;
}): void {
  revokeSkillUploadConsentInDatabase({
    scopeKind: "personal",
    scopeKey: input.skillId,
    revokedBy: input.revokedBy,
  });
}

/**
 * The setup-with-Anthropic BULK consent step: one grant per already-installed
 * injectable package identity plus the core system-tier skills. Called when an
 * admin turns the workspace opt-in ON — the explicit act that makes those
 * already-installed packages eligible without a per-package re-install.
 */
export function grantSetupWithAnthropicBulkConsent(grantedBy: string | null): void {
  grantBulkSkillUploadConsentInDatabase(grantedBy);
}
