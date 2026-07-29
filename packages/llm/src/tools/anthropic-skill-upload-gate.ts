/**
 * Anthropic skill-upload governance gate.
 *
 * This is the single authoritative chokepoint that decides whether ANY
 * individual catalog skill may be uploaded to Anthropic Custom Skills.
 * Anthropic Custom Skills are **not ZDR-eligible**: an upload sends the skill
 * body + bundled directory off this instance to Anthropic, which retains it
 * (materially different from OpenAI's local-shell skill read, where content
 * never leaves the instance).
 *
 * The sync engine MUST consult this gate (via the app-layer
 * `isAnthropicSkillUploadAllowedFromConfig` wrapper, which supplies the
 * default-OFF global flag) before issuing any `POST /v1/skills`. This module
 * ships the fail-closed decision core and the required-dependency contract;
 * upload code paths are structurally required to take an
 * {@link AnthropicSkillUploadGate} by construction.
 *
 * Standing invariants: this lives in `@cinatra-ai/llm` and has
 * **zero** `src/lib` import — the global opt-in is always passed in by the
 * (app-layer) caller, never read here (correct dependency direction).
 *
 * Fail-closed by construction: the ONLY code path returning `true` requires
 * the global opt-in to be the primitive `true` AND the per-skill flag to be
 * the primitive `true`. Every other input — including malformed, `null`,
 * truthy-but-not-`true` (`"true"`, `1`, `{}`), or a missing argument — denies.
 * The function accepts `unknown` and never throws (only denies).
 */

/**
 * Required-dependency contract for the sync engine. The table-backed upload
 * service MUST accept an instance of this by construction and call
 * {@link AnthropicSkillUploadGate.isUploadAllowed} before any upload, so "no
 * upload without the governance gate" is structurally enforced — not merely
 * documented.
 */
import { createHash } from "node:crypto";

export interface AnthropicSkillUploadGate {
  /**
   * @param skill - the catalog skill (only its `allowAnthropicUpload` is
   *   consulted; accepts `unknown` so malformed input denies, never throws).
   * @param globalEnabled - the resolved `anthropicSkillSyncEnabled` global
   *   opt-in (default OFF; supplied by the app layer).
   * @returns `true` ONLY when both are the primitive `true`.
   */
  isUploadAllowed(skill: unknown, globalEnabled: unknown): boolean;
}

/**
 * The pure fail-closed gate. The ONLY path that returns `true`:
 * `globalEnabled === true` AND `skill.allowAnthropicUpload === true` (strict
 * primitive — not truthy). Anything else, malformed, `null`, or an accessor
 * that would throw → `false`. Never throws.
 */
export function isAnthropicSkillUploadAllowed(
  skill: unknown,
  globalEnabled: unknown,
): boolean {
  // Global opt-in must be the literal primitive true (default OFF; any garbage
  // / non-true → deny).
  if (globalEnabled !== true) return false;
  // Malformed skill input → deny (never deref-throw).
  if (typeof skill !== "object" || skill === null) return false;
  // Per-skill flag is honored even when the global opt-in is ON. Strict
  // primitive true only — unset/null/false/"true"/1 → deny (fail-closed).
  // The property read is wrapped: a hostile object with a throwing getter or
  // a Proxy trap must DENY, never propagate (the "never throws" contract).
  try {
    return (skill as { allowAnthropicUpload?: unknown }).allowAnthropicUpload === true;
  } catch {
    return false;
  }
}

/**
 * Default gate instance. Upload services inject this (or a test double) by
 * construction; it delegates to the pure {@link isAnthropicSkillUploadAllowed}.
 */
export const defaultAnthropicSkillUploadGate: AnthropicSkillUploadGate = {
  isUploadAllowed: isAnthropicSkillUploadAllowed,
};

// ---------------------------------------------------------------------------
// Upload-on-install CONSENT POLICY (cinatra#2092, epic #2086 S5).
//
// Lives HERE, beside the per-skill upload gate, because it is the same kind of
// thing: the pure, fail-closed decision core for Anthropic skill upload, with
// zero `src/lib` import. The gate answers "may THIS skill be uploaded right
// now?"; this answers "did an install actually acquire consent for the package
// identities it pulled in?". Keeping both in one leaf means every install
// surface — the interactive server action, the headless action, the MCP
// handlers — shares one exhaustively-tested decision instead of re-deriving it,
// and none of them drags an app-layer module into a route graph to get it.
//
// The rule the S5 acceptance criteria encode:
//
//   - Installing a skills extension while the workspace opt-in is ON is the
//     admin CONSENT ACT for that package — but ONLY when the actor was actually
//     shown, and confirmed, the full resolved dependency closure together with
//     the data-egress advisory. `confirmedClosureDigest` is that evidence: it
//     must equal the digest of the closure the SERVER resolved, so a caller can
//     never consent to a closure it was not shown (a stale confirmation, a
//     closure that grew between render and submit, or a forged one all fail
//     closed).
//   - A NONINTERACTIVE / programmatic install (incl. MCP) must pass explicit
//     consent. Absent → no consent row is written, the derived
//     `allowAnthropicUpload` projection stays `false`, nothing egresses, and
//     the fail-closed outcome is RECORDED.
//   - Opt-in OFF → never a grant, whatever the caller passes. The workspace
//     opt-in is the outer gate; per-package consent is the inner one, and BOTH
//     must hold.
// ---------------------------------------------------------------------------

/**
 * The data-egress advisory carried by every upload consent surface. Mirrors the
 * language of the existing workspace opt-in (a non-ZDR data-egress opt-in) and
 * names exactly what leaves the workspace.
 */
export const ANTHROPIC_SKILL_UPLOAD_EGRESS_ADVISORY =
  "Uploading a skill sends its full SKILL.md content and bundled files to the " +
  "Anthropic Skills API, outside this workspace. Anthropic's zero-data-retention " +
  "terms do NOT cover uploaded skill content. Consent applies to the package " +
  "identity and survives version updates until you revoke it; a revoked or " +
  "uninstalled package's remote copy is reclaimed automatically.";

/** One member of the resolved install closure shown in the confirmation. */
export type ConsentClosureMember = {
  /** The version-free skill-package identity the consent ledger keys on
   *  (`skill_packages.packageId`, e.g. `github:owner/repo`,
   *  `verdaccio:@scope/pkg`) — consent survives version updates by construction. */
  packageId: string;
  /** Human-facing package name for the confirmation listing. */
  packageName: string;
  /** True for the package the operator explicitly asked to install; the rest
   *  are transitive skill extensions pulled in by the install. */
  isRoot: boolean;
};

/**
 * Stable digest over a resolved closure. Order-independent (the closure is
 * sorted first) and identity-only (a version bump must NOT invalidate a
 * confirmation the operator is mid-way through, because consent is per package
 * identity anyway).
 */
export function closureConsentDigest(closure: readonly ConsentClosureMember[]): string {
  const ids = [...new Set(closure.map((m) => m.packageId))].sort();
  return createHash("sha256").update(ids.join("\n")).digest("hex");
}

export type ConsentPrompt = {
  headline: string;
  advisory: string;
  /** One line per closure member, root first then transitive, each stable. */
  closureLines: string[];
  /** The consent scope keys a confirmation would grant. */
  scopeKeys: string[];
  /** The evidence token the confirming caller must echo back. */
  closureDigest: string;
  /** False when the workspace opt-in is OFF — nothing can egress, so the
   *  surface should say so instead of asking for consent. */
  consentApplies: boolean;
};

/**
 * Build the interactive install confirmation: the FULL resolved dependency
 * closure (transitive skill extensions included) plus the data-egress advisory.
 */
export function buildAnthropicUploadConsentPrompt(input: {
  rootPackageName: string;
  closure: readonly ConsentClosureMember[];
  optInEnabled: boolean;
}): ConsentPrompt {
  const ordered = [...input.closure].sort((a, b) => {
    if (a.isRoot !== b.isRoot) return a.isRoot ? -1 : 1;
    return a.packageId.localeCompare(b.packageId);
  });
  const transitive = ordered.filter((m) => !m.isRoot).length;
  return {
    headline:
      transitive === 0
        ? `Allow Anthropic uploads for ${input.rootPackageName}?`
        : `Allow Anthropic uploads for ${input.rootPackageName} and ${transitive} skill extension${transitive === 1 ? "" : "s"} it installs?`,
    advisory: ANTHROPIC_SKILL_UPLOAD_EGRESS_ADVISORY,
    closureLines: ordered.map(
      (m) => `${m.packageName} (${m.packageId})${m.isRoot ? "" : " — installed as a dependency"}`,
    ),
    scopeKeys: [...new Set(ordered.map((m) => m.packageId))].sort(),
    closureDigest: closureConsentDigest(ordered),
    consentApplies: input.optInEnabled === true,
  };
}

/**
 * The explicit consent parameter every install surface accepts. Both surfaces
 * use the SAME shape so the headless path is not a second, weaker contract.
 */
export type AnthropicUploadConsentInput = {
  /** The operator's affirmative decision. Anything but the literal `true` is
   *  "no consent" (fail-closed against a truthy-but-not-true value). */
  granted?: unknown;
  /** Evidence that the granting actor saw THIS closure. Required on the
   *  interactive path; optional on the headless path, where passing the
   *  parameter at all is the explicit act. */
  confirmedClosureDigest?: unknown;
};

/** Why a consent decision came out the way it did — RECORDED on the no-op paths
 *  so a fail-closed install is auditable rather than silent. */
export type ConsentDecisionReason =
  | "granted"
  | "opt-in-off"
  | "no-explicit-consent"
  | "consent-declined"
  | "closure-confirmation-mismatch"
  | "empty-closure";

export type ConsentDecision = {
  grant: boolean;
  reason: ConsentDecisionReason;
  /** The scope keys to write when `grant` is true; always empty otherwise. */
  scopeKeys: string[];
  /** One-line, non-technical outcome suitable for an audit/notice surface. */
  outcome: string;
};

const OUTCOME: Record<ConsentDecisionReason, string> = {
  granted: "Anthropic upload consent recorded for the resolved install closure.",
  "opt-in-off":
    "Workspace Anthropic skill upload is OFF — nothing was uploaded and no consent was recorded.",
  "no-explicit-consent":
    "No explicit upload consent was passed — the skill stays upload-ineligible (fail-closed).",
  "consent-declined":
    "Upload consent was declined — the skill stays upload-ineligible.",
  "closure-confirmation-mismatch":
    "The confirmed dependency closure did not match the resolved one — consent was NOT recorded (fail-closed).",
  "empty-closure":
    "The install resolved no skill packages — there was nothing to consent to.",
};

/**
 * Decide whether an install records consent. FAIL-CLOSED at every branch.
 *
 * `interactive: true` additionally REQUIRES the closure-confirmation digest to
 * match — the interactive surface is the one that renders the closure, so a
 * grant without matching evidence is a bug, not a shortcut.
 */
export function resolveAnthropicUploadConsentDecision(input: {
  consent: AnthropicUploadConsentInput | null | undefined;
  closure: readonly ConsentClosureMember[];
  optInEnabled: boolean;
  interactive: boolean;
}): ConsentDecision {
  const scopeKeys = [...new Set(input.closure.map((m) => m.packageId))].sort();
  const deny = (reason: ConsentDecisionReason): ConsentDecision => ({
    grant: false,
    reason,
    scopeKeys: [],
    outcome: OUTCOME[reason],
  });

  // The workspace opt-in is the OUTER gate: OFF ⇒ no egress, no consent row,
  // and the no-op is recorded (S5 AC1, second half).
  if (input.optInEnabled !== true) return deny("opt-in-off");
  if (input.consent == null) return deny("no-explicit-consent");
  if (input.consent.granted !== true) return deny("consent-declined");
  if (scopeKeys.length === 0) return deny("empty-closure");
  if (input.interactive) {
    const expected = closureConsentDigest(input.closure);
    if (input.consent.confirmedClosureDigest !== expected) {
      return deny("closure-confirmation-mismatch");
    }
  }
  return { grant: true, reason: "granted", scopeKeys, outcome: OUTCOME.granted };
}
