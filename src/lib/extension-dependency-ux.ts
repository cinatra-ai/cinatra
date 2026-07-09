// Dependency-UX presenters (cinatra #209 item 2).
//
// PURE view-model derivations for the dependency install/compensation UX. The
// DATA SURFACES already exist — the install batch saga writes the
// `extension_install_batches` ledger (per-member status + pre-state), the
// dependency planner walks the manifest edges, and the batch result names the
// installed / already-installed sets. This module only RESHAPES that real data
// for display; it invents no backend and performs no I/O. Keeping it pure (and
// framework-free) makes every surfacing decision unit-testable without a DB,
// a registry, or React.
//
// The three consumers (cinatra #209 item 2):
//   1. PRE-INSTALL "A requires B, C" — `summarizeRequiredDependencies` over the
//      package manifest's parsed dependency edges (the marketplace detail
//      page's install CTA).
//   2. PER-MEMBER install progress — `toMemberProgressRows` over a ledger batch.
//   3. BATCH compensation outcomes — `summarizeBatchOutcome` over a terminal
//      ledger batch (extensions admin view).

import type { ExtensionDependency } from "@cinatra-ai/extensions/canonical-types";
import { isAutoInstallableEdge } from "@cinatra-ai/extensions/dependency-closure";
import type {
  BatchMemberStatus,
  InstallBatch,
  InstallBatchMember,
  InstallBatchPhase,
} from "@/lib/extension-install-batch-ops";

// ---------------------------------------------------------------------------
// 1. Pre-install "A requires B, C"
// ---------------------------------------------------------------------------

/** A single dependency edge presented in the pre-install requires surface. */
export type RequiredDependencyRow = {
  packageName: string;
  /** The depended-on extension's declared kind, when the manifest carried it. */
  kind?: ExtensionDependency["kind"];
  /** Human-readable version constraint (`^1.2.0`, `=1.2.0`, `git:<ref>`, `any`). */
  constraint: string;
  /**
   * `auto`  — a required runtime/install-time edge: installing the root pulls
   *           this in automatically (the saga's dependencies-first install).
   * `peer`  — a coexistence constraint checked at activation time; NEVER
   *           auto-installed (the operator must install it themselves).
   * `optional` — degrades per-kind when missing; never auto-installed.
   */
  relationship: "auto" | "peer" | "optional";
};

export type RequiredDependenciesSummary = {
  /** Required runtime/install-time edges installed automatically with the root. */
  autoInstalled: RequiredDependencyRow[];
  /** Peer edges — must be present but are never auto-installed. */
  peer: RequiredDependencyRow[];
  /** Optional edges — degrade gracefully when absent. */
  optional: RequiredDependencyRow[];
  /** True when there is anything at all to surface. */
  hasAny: boolean;
};

/** Render a versionConstraint as a compact human string. */
export function formatVersionConstraint(vc: ExtensionDependency["versionConstraint"]): string {
  switch (vc.kind) {
    case "semver-range":
      return vc.range === "*" ? "any version" : vc.range;
    case "exact":
      return `=${vc.version}`;
    case "git-ref":
      return `git:${vc.ref}`;
  }
}

function toRow(
  dep: ExtensionDependency,
  relationship: RequiredDependencyRow["relationship"],
): RequiredDependencyRow {
  return {
    packageName: dep.packageName,
    ...(dep.kind ? { kind: dep.kind } : {}),
    constraint: formatVersionConstraint(dep.versionConstraint),
    relationship,
  };
}

/**
 * Bucket a package's parsed manifest dependency edges into the pre-install
 * requires summary. Keys on the SAME shared predicate the install gates and
 * the dependency planner use (`isAutoInstallableEdge`) — so what the UI
 * promises ("these install automatically") can never drift from what the saga
 * actually does. Deterministic lexicographic ordering per bucket so the
 * surface is stable.
 */
export function summarizeRequiredDependencies(
  edges: readonly ExtensionDependency[],
): RequiredDependenciesSummary {
  const autoInstalled: RequiredDependencyRow[] = [];
  const peer: RequiredDependencyRow[] = [];
  const optional: RequiredDependencyRow[] = [];

  for (const dep of edges) {
    if (dep.edgeType === "peer") {
      // peer (required or optional) is an activation-time coexistence
      // constraint — never auto-installed.
      peer.push(toRow(dep, "peer"));
    } else if (isAutoInstallableEdge(dep)) {
      // required runtime/install-time — auto-installed dependencies-first.
      autoInstalled.push(toRow(dep, "auto"));
    } else {
      // a non-peer edge that is not auto-installable ⇒ optional runtime/
      // install-time (degrades per-kind when missing).
      optional.push(toRow(dep, "optional"));
    }
  }

  const byName = (a: RequiredDependencyRow, b: RequiredDependencyRow) =>
    a.packageName.localeCompare(b.packageName);
  autoInstalled.sort(byName);
  peer.sort(byName);
  optional.sort(byName);

  return {
    autoInstalled,
    peer,
    optional,
    hasAny: autoInstalled.length > 0 || peer.length > 0 || optional.length > 0,
  };
}

// ---------------------------------------------------------------------------
// 2. Per-member install progress
// ---------------------------------------------------------------------------

/** Whether a member status is terminal-failed, in-flight, done, or pending. */
export type MemberProgressTone = "pending" | "active" | "done" | "skipped" | "failed";

export type MemberProgressRow = {
  packageName: string;
  version: string;
  status: BatchMemberStatus;
  tone: MemberProgressTone;
  /** Display label for the status (e.g. "Installing", "Rolled back"). */
  label: string;
  /** True when this member already existed before the batch (pre-state present). */
  preExisting: boolean;
  /** Operator-facing failure/compensation detail, when present. */
  detail?: string;
  /** True for the root package (the last ledger member). */
  isRoot: boolean;
};

const MEMBER_STATUS_LABEL: Record<BatchMemberStatus, string> = {
  planned: "Pending",
  "already-installed": "Already installed",
  installing: "Installing",
  installed: "Installed",
  failed: "Failed",
  compensated: "Rolled back",
  "compensation-failed": "Rollback incomplete",
};

const MEMBER_STATUS_TONE: Record<BatchMemberStatus, MemberProgressTone> = {
  planned: "pending",
  "already-installed": "skipped",
  installing: "active",
  installed: "done",
  failed: "failed",
  compensated: "skipped",
  "compensation-failed": "failed",
};

/**
 * Project a ledger batch's members into ordered progress rows. The ledger is
 * already topo-ordered (dependencies first, root last), so the rows preserve
 * that order; the root is flagged so the UI can label "this extension" vs its
 * dependencies.
 */
export function toMemberProgressRows(batch: InstallBatch): MemberProgressRow[] {
  return batch.members.map((m: InstallBatchMember) => ({
    packageName: m.packageName,
    version: m.version,
    status: m.status,
    tone: MEMBER_STATUS_TONE[m.status],
    label: MEMBER_STATUS_LABEL[m.status],
    preExisting: m.preState.present,
    ...(m.detail ? { detail: m.detail } : {}),
    isRoot: m.packageName === batch.rootPackage,
  }));
}

// ---------------------------------------------------------------------------
// 3. Batch compensation outcomes
// ---------------------------------------------------------------------------

export type BatchOutcomeTone = "success" | "compensated" | "failed" | "active";

export type BatchOutcomeSummary = {
  batchId: string;
  rootPackage: string;
  phase: InstallBatchPhase;
  tone: BatchOutcomeTone;
  /** One-line headline for the batch's terminal state. */
  headline: string;
  /** Members this batch installed that were rolled back (compensated). */
  compensated: string[];
  /** Members whose rollback FAILED — may need manual removal. */
  compensationFailed: string[];
  /** The member that failed and triggered compensation, if any. */
  failedMember: string | null;
  /** True when the batch is in a terminal (non-active) phase. */
  terminal: boolean;
  createdAt: string;
  updatedAt: string;
};

const BATCH_PHASE_TONE: Record<InstallBatchPhase, BatchOutcomeTone> = {
  planning: "active",
  installing: "active",
  finalized: "success",
  compensated: "compensated",
  failed: "failed",
};

/**
 * Summarize a ledger batch's terminal outcome for the extensions admin view.
 * Reads the per-member ledger states the saga durably wrote — `failed` names
 * the member that aborted the batch, `compensated` are the members the saga
 * rolled back, and `compensation-failed` are the ones whose rollback itself
 * failed (the loud "may need manual removal" case). Nothing is recomputed; the
 * ledger is authoritative.
 */
export function summarizeBatchOutcome(batch: InstallBatch): BatchOutcomeSummary {
  const compensated: string[] = [];
  const compensationFailed: string[] = [];
  let failedMember: string | null = null;

  for (const m of batch.members) {
    if (m.status === "compensated") compensated.push(m.packageName);
    else if (m.status === "compensation-failed") compensationFailed.push(m.packageName);
    else if (m.status === "failed") failedMember = m.packageName;
  }

  const tone = BATCH_PHASE_TONE[batch.phase];
  const terminal =
    batch.phase === "finalized" || batch.phase === "compensated" || batch.phase === "failed";

  let headline: string;
  switch (batch.phase) {
    case "finalized":
      headline = `Installed ${batch.rootPackage} with its dependencies.`;
      break;
    case "compensated":
      headline =
        compensated.length > 0
          ? `Install of ${batch.rootPackage} failed and was rolled back cleanly.`
          : `Install of ${batch.rootPackage} failed; no dependencies needed rollback.`;
      break;
    case "failed":
      headline =
        compensationFailed.length > 0
          ? `Install of ${batch.rootPackage} failed and rollback was incomplete — manual cleanup may be needed.`
          : `Install of ${batch.rootPackage} failed.`;
      break;
    case "installing":
    case "planning":
      headline = `Installing ${batch.rootPackage}…`;
      break;
  }

  return {
    batchId: batch.batchId,
    rootPackage: batch.rootPackage,
    phase: batch.phase,
    tone,
    headline,
    compensated,
    compensationFailed,
    failedMember,
    terminal,
    createdAt: batch.createdAt,
    updatedAt: batch.updatedAt,
  };
}

/**
 * True when any rendered batch is still in an ACTIVE (non-terminal) phase —
 * i.e. the panel is showing in-flight progress that will go stale without a
 * refresh. Drives the extensions admin view's live-refresh loop (cinatra
 * #851 finding 3): the screen polls only while something is actually running.
 */
export function hasActiveInstallBatch(batches: readonly InstallBatch[]): boolean {
  return batches.some((batch) => !summarizeBatchOutcome(batch).terminal);
}

// ---------------------------------------------------------------------------
// 4. Post-install "needs configuration" affordance (cinatra #1057)
// ---------------------------------------------------------------------------

/**
 * One connector's readiness as resolved by its OWN per-connector probe. The
 * `connected` boolean is the connector's INDEPENDENT readiness — this module
 * never derives it from another connector's state (see the chaining decision
 * on {@link summarizeConfigurationNeeds}).
 */
export type ConnectorReadinessRow = {
  packageName: string;
  /**
   * The connector's HUMAN-READABLE name — the manifest `displayName` the
   * `/connectors` card grid and the setup-page header already render (e.g.
   * "LinkedIn", "Gmail"). This is the PRIMARY label; the package name is only
   * ever muted secondary text. Never the bare `packageName`.
   */
  displayName: string;
  slug: string;
  /** The connector's OWN readiness-probe result. */
  connected: boolean;
  /** Deep-link to the connector's setup surface, or null when unresolved. */
  settingsHref: string | null;
  /** True when this connector is the batch root (the just-installed extension). */
  isRoot: boolean;
};

/** A single "Configure <connector>" affordance row. */
export type ConfigurationNeed = {
  packageName: string;
  /** Human-readable manifest displayName — the primary rendered label. */
  displayName: string;
  slug: string;
  settingsHref: string | null;
  isRoot: boolean;
};

export type ConfigurationNeedsSummary = {
  /** Installed connectors that are present but NOT yet configured (ordered). */
  needs: ConfigurationNeed[];
  /** True when at least one connector readiness row was considered. */
  hasConnectors: boolean;
  /** True when every considered connector is configured (nothing to surface). */
  allConfigured: boolean;
};

/**
 * Bucket the connectors an install touched (the installed extension AND its
 * connector dependencies), each with its OWN resolved readiness, into ordered
 * "Configure <connector>" affordances for the not-yet-configured ones.
 *
 * READINESS-CHAINING DECISION (cinatra #1057, ratified — per-connector probes
 * are AUTHORITATIVE): a required connector-dependency's readiness is surfaced
 * as its OWN independent row, NEVER folded into a facade/consumer connector's
 * readiness boolean. Rationale grounded in the live surface:
 *   - the base dependencies (social-media / *-oauth / email / crm connectors)
 *     register no readiness probe and default to not-connected, so folding
 *     would make every facade perpetually not-ready;
 *   - the leaf/facade probe already reflects the real chained end-state (a
 *     saved connection cannot exist unless its required base is satisfied);
 *   - the card grid and the setup-page badge are documented lock-step on the
 *     SAME single per-connector probe — folding would break that invariant.
 * This derivation therefore treats each row's `connected` as that connector's
 * own probe result and never cross-references rows: a facade whose own probe
 * reports connected is NOT re-surfaced because a dependency is unconfigured;
 * that dependency appears as its own row instead.
 *
 * Deterministic order: the root first, then dependencies lexicographically.
 * PURE — the caller resolves readiness + settingsHref (server probes); this
 * only reshapes for display, performing no I/O.
 */
export function summarizeConfigurationNeeds(
  rows: readonly ConnectorReadinessRow[],
): ConfigurationNeedsSummary {
  const needs: ConfigurationNeed[] = rows
    .filter((r) => !r.connected)
    .map((r) => ({
      packageName: r.packageName,
      displayName: r.displayName,
      slug: r.slug,
      settingsHref: r.settingsHref,
      isRoot: r.isRoot,
    }));

  needs.sort((a, b) => {
    if (a.isRoot !== b.isRoot) return a.isRoot ? -1 : 1;
    return a.packageName.localeCompare(b.packageName);
  });

  return {
    needs,
    hasConnectors: rows.length > 0,
    allConfigured: needs.length === 0,
  };
}
