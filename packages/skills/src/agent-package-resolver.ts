import "server-only";

// ---------------------------------------------------------------------------
// THE SHARED CANONICAL AGENT-PACKAGE RESOLVER (cinatra#2346 S1, epic #2345).
//
// `agent_assigned_skills` is keyed by the CANONICAL agent package name, so
// every read and every write has to turn whatever identifier its caller holds
// into that one key — or refuse. The identifiers in circulation are genuinely
// heterogeneous:
//
//   * the settings page passes the scoped package name (`@vendor/name`);
//   * the runtime bridge passes a RAW slug (`web-scrape-agent`) — that is the
//     shape `getAssignedSkillIdsForAgent` receives, and it must resolve to the
//     same rows the settings page wrote;
//   * a provider-declared on-disk agent has NO `agent_templates` row at all,
//     so a DB-template lookup (the shape
//     `agent-execution-config-actions.ts` uses) would resolve nothing for it;
//   * a multi-template agent package must resolve to ONE package key, not one
//     key per template.
//
// The existing inline lookup in `src/lib/agents-store.ts` handles the first
// three by falling back to `agentId` verbatim when nothing matches — fine for a
// best-effort read, WRONG for a storage key (it would silently write rows under
// an unresolvable id that no read ever finds again). Hence a real resolver:
//
//   1. EXACT match on any canonical identity field (packageId, id, identifier,
//      packageSlug) — first and always preferred.
//   2. UNIQUE npm-SUFFIX fallback: the segment after the last `/`. Resolves
//      `web-scrape-agent` → `@cinatra-ai/web-scrape-agent`.
//   3. AMBIGUITY IS REFUSED: if two installed packages share a suffix
//      (`@vendor-a/x` and `@vendor-b/x`), the resolver returns `ambiguous`
//      rather than guessing. Guessing here would attach an admin's assignment
//      to the wrong agent.
//   4. Nothing matched → `unknown`.
//
// WRITES apply two further refusals on top (scope item 5): the target must be
// an AGENT-kind extension, and it must NOT be an assistant. Assistant
// detection is authoritative — the persisted `installed_extension`
// `assistant_declaration` / the `agent_templates.agent_kind='assistant'`
// registry linkage — never a name suffix and never template-shape inference,
// because the assistant injection branch ignores the recommendation channel
// this epic feeds, so an assignment there could never be delivered.
// ---------------------------------------------------------------------------

import {
  isAssistantPackageSource,
  readAgentPopulationSource,
  readPackageKindSource,
} from "./agent-skill-assignment-sources";

/** The minimal agent identity shape the resolver matches on. */
export type AgentIdentityCandidate = {
  /** Canonical package id (`@vendor/name`). */
  packageId: string;
  id?: string;
  identifier?: string;
  packageSlug?: string;
};

export type AgentPackageResolution =
  | { ok: true; packageName: string; via: "exact" | "npm-suffix" }
  | { ok: false; reason: "empty" | "unknown" | "ambiguous"; matches?: string[] };

/** The npm suffix of a package name: everything after the last `/`. */
export function npmSuffix(value: string): string {
  const trimmed = value.trim();
  const idx = trimmed.lastIndexOf("/");
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

/**
 * PURE resolution over a candidate set. Exported so the exact/fallback/refusal
 * behavior is unit-testable without touching the installed-agents reader.
 *
 * Candidates are deduped by `packageId` before the ambiguity test, so a
 * multi-template package (which contributes one candidate per template in some
 * readers) never reads as ambiguous with itself.
 */
export function resolveCanonicalAgentPackageFrom(
  rawId: string,
  candidates: readonly AgentIdentityCandidate[],
): AgentPackageResolution {
  const needle = (rawId ?? "").trim();
  if (!needle) return { ok: false, reason: "empty" };

  const live = candidates.filter((c) => (c.packageId ?? "").trim().length > 0);

  /** Distinct packages among a match set. A multi-template package contributes
   *  one candidate per template, so collapsing by packageId AFTER matching (not
   *  before) keeps every alias matchable while still reading as ONE package. */
  const distinct = (matched: readonly AgentIdentityCandidate[]) => [
    ...new Set(matched.map((c) => c.packageId.trim())),
  ].sort();

  // 1. Exact match on any canonical identity field.
  const exact = distinct(
    live.filter(
      (c) =>
        c.packageId.trim() === needle ||
        c.id === needle ||
        c.identifier === needle ||
        c.packageSlug === needle,
    ),
  );
  if (exact.length === 1) return { ok: true, packageName: exact[0]!, via: "exact" };
  if (exact.length > 1) return { ok: false, reason: "ambiguous", matches: exact };

  // 2. Unique npm-suffix fallback — ONLY for a BARE identifier.
  //
  // A needle that already carries a `/` is a fully-qualified package name, and
  // its vendor scope is part of what the caller asked for. Falling back to the
  // suffix there would silently resolve `@vendor-a/x` (not installed) onto
  // `@vendor-b/x` (installed) — an admin's assignment landing on a DIFFERENT
  // vendor's agent. A qualified name that does not match exactly is UNKNOWN.
  if (!needle.includes("/")) {
    const bySuffix = distinct(live.filter((c) => npmSuffix(c.packageId) === needle));
    if (bySuffix.length === 1) return { ok: true, packageName: bySuffix[0]!, via: "npm-suffix" };
    // 3. Ambiguity is refused, never guessed.
    if (bySuffix.length > 1) return { ok: false, reason: "ambiguous", matches: bySuffix };
  }
  // 4. Nothing matched.
  return { ok: false, reason: "unknown" };
}

// ---------------------------------------------------------------------------
// I/O composition.
// ---------------------------------------------------------------------------

export type AgentPackageResolverDeps = {
  /**
   * The installed-agent population. Default = `readAgentsForSkillMatching`,
   * which already unions the DB-installed templates with the PROVIDER-DECLARED
   * on-disk agents (deduped by packageId) — the exact union a template-free
   * provider-declared agent needs in order to resolve at all.
   */
  readAgents?: () => Promise<AgentIdentityCandidate[]>;
};

/**
 * Resolve any agent identifier (raw bridge slug, scoped package name, template
 * package slug) to the canonical package name the assignment store is keyed by.
 */
export async function resolveCanonicalAgentPackage(
  rawId: string,
  deps: AgentPackageResolverDeps = {},
): Promise<AgentPackageResolution> {
  const readAgents = deps.readAgents ?? readAgentPopulationSource;
  let candidates: AgentIdentityCandidate[];
  try {
    candidates = await readAgents();
  } catch (err) {
    // Fail closed: an unreadable agent population must not resolve to the raw
    // input (the shape that would write rows under an unresolvable key).
    console.warn(
      "[skills/agent-package-resolver] installed-agent read failed — refusing to resolve:",
      err instanceof Error ? err.message : err,
    );
    return { ok: false, reason: "unknown" };
  }
  return resolveCanonicalAgentPackageFrom(rawId, candidates);
}

// ---------------------------------------------------------------------------
// Write-side target eligibility: agent-kind, non-assistant.
// ---------------------------------------------------------------------------

export type AgentWriteTargetRefusal = "not-an-agent" | "assistant" | "eligibility-unreadable";

export type AgentWriteTargetVerdict =
  | { ok: true }
  | { ok: false; reason: AgentWriteTargetRefusal };

/** The authoritative facts the write-side gate decides on. */
export type AgentWriteTargetFacts = {
  /** `cinatra.kind` of the canonical install row / registry entry. */
  kind: string | null;
  /** True iff authoritative assistant data names this package. */
  isAssistant: boolean;
};

/** PURE write-target gate. Fail-closed on an unknown kind. */
export function evaluateAgentWriteTarget(facts: AgentWriteTargetFacts): AgentWriteTargetVerdict {
  if (facts.isAssistant) return { ok: false, reason: "assistant" };
  if (facts.kind === null) return { ok: false, reason: "eligibility-unreadable" };
  if (facts.kind !== "agent") return { ok: false, reason: "not-an-agent" };
  return { ok: true };
}

export type AgentWriteTargetDeps = {
  /** Canonical `cinatra.kind` for a package, or null when unresolvable. */
  readPackageKind?: (packageName: string) => Promise<string | null>;
  /** Authoritative assistant-package predicate. */
  isAssistantPackage?: (packageName: string) => Promise<boolean>;
};



/**
 * The write-side target gate: is this canonical package an agent-kind,
 * non-assistant extension? Fail-closed — an unreadable eligibility source
 * refuses the write rather than admitting it.
 */
export async function assertAgentWriteTarget(
  packageName: string,
  deps: AgentWriteTargetDeps = {},
): Promise<AgentWriteTargetVerdict> {
  const readPackageKind = deps.readPackageKind ?? readPackageKindSource;
  const isAssistantPackage = deps.isAssistantPackage ?? isAssistantPackageSource;
  let kind: string | null;
  let isAssistant: boolean;
  try {
    [kind, isAssistant] = await Promise.all([
      readPackageKind(packageName),
      isAssistantPackage(packageName),
    ]);
  } catch (err) {
    // The package name is passed as an ARGUMENT, never spliced into the message:
    // a caller-influenced value must not be able to shape the log format.
    console.warn(
      "[skills/agent-package-resolver] write-target eligibility read failed — refusing. package / cause:",
      String(packageName ?? "")
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .slice(0, 200),
      err instanceof Error ? err.message : err,
    );
    return { ok: false, reason: "eligibility-unreadable" };
  }
  return evaluateAgentWriteTarget({ kind, isAssistant });
}
