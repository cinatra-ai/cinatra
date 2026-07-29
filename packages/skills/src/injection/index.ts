/**
 * `@cinatra-ai/skills/injection` — the ONE typed skill-injection contract
 * (cinatra#2091, epic #2086 S4).
 *
 * A PURE LEAF: no `server-only`, no `node:fs`, no DB, no LLM import. Everything
 * the resolver needs from a host arrives through the ports in `./ports` (a
 * TYPE-ONLY module), so the orchestration layer, the host app, and
 * `@cinatra-ai/agents` all consume this from one import site without dragging a
 * module graph behind it.
 *
 * Deliberately ONE module rather than a barrel over six: the tracked dev-perf
 * routes carry a monotonic reachable-module ceiling (`route-graph-ratchet`), and
 * a contract every route reaches must not cost six modules to say what it can
 * say in one. The internal sections below keep the same boundaries the separate
 * files had:
 *
 *   1. vocabulary + errors        (was types.ts)
 *   2. the rank-and-cap core      (was cap.ts)
 *   3. provider -> mechanism map  (was provider-mechanism.ts)
 *   4. inline expansion core      (was inline-expansion.ts)
 *   5. the branded set + resolver (was contract.ts)
 *
 * Section 5 is the ONLY place that constructs a `ResolvedInjectedSkillSet`: the
 * brand is a module-private `unique symbol` that is never exported, so no other
 * module in the platform can produce a value of that type.
 */

import type {
  InjectionAuthorization,
  InjectionPersonalDelta,
  InjectionResolverPorts,
  InjectionSkillRef,
} from "./ports";

export type {
  InjectionAuthorization,
  InjectionPersonalDelta,
  InjectionResolverPorts,
  InjectionSkillRef,
} from "./ports";

// ===========================================================================
// 1. Vocabulary + errors
// ===========================================================================

// ---------------------------------------------------------------------------
// The hard cap
// ---------------------------------------------------------------------------

/**
 * The per-request maximum number of injected skills — **8 TOTAL, including the
 * personal delta**. Anthropic's Custom Skills API enforces 8 per request; the
 * epic generalizes that discipline to every provider so a run behaves the same
 * everywhere. This is the ONLY cap that decides what a model sees; the
 * per-provider delivery adapters keep their own caps purely as
 * defence-in-depth invariants.
 */
export const INJECTED_SKILL_CAP = 8;

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

/**
 * Where a member came from. Ranks are listed in DELIVERY order (the order the
 * member list is presented in), which is NOT the retention order used when the
 * cap truncates — see `RETENTION_PRIORITY` in `./cap.ts`.
 */
export type InjectedSkillRank =
  /** The run owner's personal delta skill. Always delivered inline. */
  | "personal_delta"
  /**
   * A skill the consuming extension DECLARES a runtime dependency on (the S3
   * dependency-to-injection projection), or an assistant's own required
   * bundle. Never dropped in favour of a recommendation.
   */
  | "declared_dependency"
  /**
   * A per-run recommendation / assignment (the confirmed selected-revision set
   * when one exists, else today's computed assignment).
   */
  | "recommendation";

/**
 * How the member reaches the model.
 *
 *  - `catalog` — the member is a catalog skill delivered by the provider's own
 *    mechanism (OpenAI tool-mount, Anthropic container, Gemini core-side inline
 *    expansion). The mechanism is chosen per provider, not per member.
 *  - `inline`  — the member's body is merged into the system context directly.
 *    The personal delta is always `inline`: it has no catalog bundle on disk to
 *    mount and no uploaded Anthropic Custom Skill to reference.
 */
export type InjectedSkillDeliveryMode = "catalog" | "inline";

/** One authoritative member of a resolved injected set. */
export type InjectedSkillMember = {
  /** The catalog skill id. NEVER empty — an unattributed member is refused. */
  readonly skillId: string;
  readonly rank: InjectedSkillRank;
  readonly deliveryMode: InjectedSkillDeliveryMode;
  /**
   * The pinned immutable revision this member resolved to, when the source
   * knows one (`run_selected_skill_revisions`, the personal-skill revision).
   * `null` when the source is a catalog id without a pinned revision.
   */
  readonly revisionId: string | null;
  /**
   * The member's literal body. Present ONLY for `deliveryMode: "inline"`
   * members resolved from a body-bearing source (the personal delta). A
   * `catalog` member never carries content — its bytes are read at delivery
   * time by the provider mechanism.
   */
  readonly content?: string;
};

// ---------------------------------------------------------------------------
// Drops
// ---------------------------------------------------------------------------

export type InjectedSkillDropReason =
  /** Ranked below the cap line. */
  | "over_cap"
  /**
   * More than `INJECTED_SKILL_CAP` REQUIRED (declared-dependency) members were
   * resolved, so required members themselves had to be dropped. This is a
   * CONFIGURATION error — the agent-creation preflight fails the same condition
   * before dispatch — surfaced at runtime rather than silently truncated.
   */
  | "over_cap_required_dependencies"
  /** The delta lost its slot to required dependencies filling the whole cap. */
  | "delta_displaced_by_required_dependencies"
  /** Inline (Gemini) expansion: the member did not fit the per-request budget. */
  | "inline_budget_exhausted"
  /** Inline expansion: the member's body could not be read. */
  | "inline_body_unresolvable";

export type InjectedSkillDrop = {
  readonly skillId: string;
  readonly rank: InjectedSkillRank;
  readonly reason: InjectedSkillDropReason;
};

// ---------------------------------------------------------------------------
// The closed intent union
// ---------------------------------------------------------------------------

/**
 * The reviewer lanes the creation-review orchestration may bind. The lane is
 * ALWAYS bound server-side by the orchestration; it is never read off a request
 * payload.
 */
export const REVIEWER_LANES = [
  "security-reviewer",
  "code-reviewer",
  "planner",
] as const;
export type ReviewerLane = (typeof REVIEWER_LANES)[number];

export function isReviewerLane(value: unknown): value is ReviewerLane {
  return (
    typeof value === "string" &&
    (REVIEWER_LANES as readonly string[]).includes(value)
  );
}

/**
 * The CLOSED explicit-purpose enum. Adding a purpose is a code change plus a
 * review — deliberately, so a new injection surface cannot appear by passing a
 * string.
 */
export const EXPLICIT_INJECTION_PURPOSES = [
  "agent-authoring",
  "agent-creation-review",
  "auditor-run-skills",
] as const;
export type ExplicitInjectionPurpose =
  (typeof EXPLICIT_INJECTION_PURPOSES)[number];

/** `explicit-purpose` subject schemas — one exact shape per purpose. */
export type ExplicitInjectionSubject = {
  /** The authoring surface's spec reference (an agent package slug/name). */
  "agent-authoring": { readonly agentSpecRef: string };
  /**
   * The candidate under review plus the reviewing lane. The lane's OWN pinned
   * methodology skills are derived — never the candidate's.
   */
  "agent-creation-review": {
    readonly candidateAgentRef: string;
    readonly reviewerLane: ReviewerLane;
  };
  /** The audited run. Ownership is server-verified by the audit authority. */
  "auditor-run-skills": { readonly runId: string };
};

export type InjectionIntent =
  /** An agent run dispatched through the bridge / agent execution. */
  | {
      readonly kind: "agent-run";
      readonly agentId: string;
      /**
       * The server-vetted run this dispatch belongs to. OPTIONAL because the
       * bridge legitimately dispatches calls it could NOT bind to a run (a
       * forged / divergent / absent run token leaves `runForPorts` null), and
       * fabricating a run id there would be strictly worse than saying so. The
       * authorization port verifies OWNERSHIP whenever a run IS claimed; an
       * absent run resolves strictly LESS (no verified owner ⇒ no personal
       * delta, actor-less assignment), never more.
       */
      readonly runId?: string;
      readonly userId?: string;
    }
  /** A conversational assistant turn. */
  | {
      readonly kind: "assistant";
      readonly agentId: string;
      readonly userId: string;
      readonly sessionId: string;
    }
  /** One of the closed explicit purposes, with its exact subject. */
  | {
      [P in ExplicitInjectionPurpose]: {
        readonly kind: "explicit-purpose";
        readonly purpose: P;
        readonly subject: ExplicitInjectionSubject[P];
      };
    }[ExplicitInjectionPurpose];

export type InjectionIntentKind = InjectionIntent["kind"];

/**
 * A stable, log-safe label for an intent (`agent-run`, `assistant`,
 * `explicit-purpose:agent-creation-review`). Carries NO subject values, so it
 * is safe in a warning line.
 */
export function describeInjectionIntent(intent: InjectionIntent): string {
  return intent.kind === "explicit-purpose"
    ? `explicit-purpose:${intent.purpose}`
    : intent.kind;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Server-side authorization refused the intent. VISIBLE by contract — a
 * refusal never degrades into "deliver nothing" (which would be
 * indistinguishable from a correctly-empty set).
 */
export class SkillInjectionAuthorizationError extends Error {
  readonly intentLabel: string;
  readonly reason: string;
  constructor(intentLabel: string, reason: string) {
    super(`Skill injection refused for intent "${intentLabel}": ${reason}`);
    this.name = "SkillInjectionAuthorizationError";
    this.intentLabel = intentLabel;
    this.reason = reason;
  }
}

/**
 * A member reached the contract without a skill id or without a delivery mode.
 * Unattributed skill content is REFUSED — it is exactly the shape the platform
 * used to deliver as a bare `customSkillContent` string with no identity.
 */
export class UnattributedSkillContentError extends Error {
  readonly detail: string;
  constructor(detail: string) {
    super(`Refusing to deliver unattributed skill content: ${detail}`);
    this.name = "UnattributedSkillContentError";
    this.detail = detail;
  }
}

/** The intent is not a member of the closed union. */
export class UnknownInjectionIntentError extends Error {
  constructor(received: string) {
    super(
      `Unknown skill-injection intent "${received}". The intent union is closed; ` +
        `adding a member is a code change plus a review.`,
    );
    this.name = "UnknownInjectionIntentError";
  }
}

/** The resolver needs a port the caller did not supply for this intent. */
export class MissingInjectionPortError extends Error {
  readonly portName: string;
  constructor(portName: string, intentLabel: string) {
    super(
      `Skill-injection port "${portName}" is required to resolve intent ` +
        `"${intentLabel}" and was not supplied.`,
    );
    this.name = "MissingInjectionPortError";
    this.portName = portName;
  }
}

// ===========================================================================
// 2. Rank + cap
// ===========================================================================


/**
 * RETENTION priority — which member keeps its slot when the cap bites. Lower
 * wins. This is deliberately NOT the delivery order.
 *
 * The ratified rank sentence carries two clauses that only reconcile as two
 * distinct orders:
 *
 *   "rank = personal delta -> declared dependencies (NEVER DROPPED) ->
 *    recommendations -> deterministic tie-break -> truncate to 8 TOTAL;
 *    if 8 required dependencies leave no slot, THE DELTA DROPS and is recorded."
 *
 * A single ordering cannot satisfy both "declared dependencies are never
 * dropped" and "with 8 required dependencies the delta drops" while also
 * presenting the delta first. So the contract keeps two orders:
 *
 *   - DELIVERY order (what the model sees, `orderMembersForDelivery`):
 *       personal delta -> declared dependencies -> recommendations.
 *   - RETENTION order (who survives truncation, here):
 *       declared dependencies -> personal delta -> recommendations.
 */
const RETENTION_PRIORITY: Record<InjectedSkillRank, number> = {
  declared_dependency: 0,
  personal_delta: 1,
  recommendation: 2,
};

/** Delivery order — the order the member list is presented in. */
const DELIVERY_PRIORITY: Record<InjectedSkillRank, number> = {
  personal_delta: 0,
  declared_dependency: 1,
  recommendation: 2,
};

export type RankAndCapInput = {
  /** The personal delta, when one resolved. */
  readonly delta: InjectedSkillMember | null;
  /** Declared runtime skill dependencies, in declaration order. */
  readonly declaredDependencies: readonly InjectedSkillMember[];
  /** Recommendations / assignments, in resolved (already ranked) order. */
  readonly recommendations: readonly InjectedSkillMember[];
  /** Override the cap. Defaults to `INJECTED_SKILL_CAP`. Tests only. */
  readonly cap?: number;
};

export type RankAndCapResult = {
  /** The surviving members in DELIVERY order. At most `cap` entries. */
  readonly members: InjectedSkillMember[];
  /** Every member that did not survive, with its reason. Deterministic order. */
  readonly dropped: InjectedSkillDrop[];
};

/**
 * Dedupe by skill id, keeping the FIRST occurrence. Runs across the whole
 * candidate list (delta first, then dependencies, then recommendations) so a
 * skill that is both a declared dependency and a recommendation occupies ONE
 * slot at its stronger rank rather than two.
 */
function dedupeByFirstSeen(
  candidates: readonly InjectedSkillMember[],
): InjectedSkillMember[] {
  const seen = new Set<string>();
  const out: InjectedSkillMember[] = [];
  for (const member of candidates) {
    if (seen.has(member.skillId)) continue;
    seen.add(member.skillId);
    out.push(member);
  }
  return out;
}

/** Sort a member list into stable DELIVERY order. */
export function orderMembersForDelivery(
  members: readonly InjectedSkillMember[],
  originalIndex: ReadonlyMap<string, number>,
): InjectedSkillMember[] {
  return [...members].sort((a, b) => {
    const ra = DELIVERY_PRIORITY[a.rank];
    const rb = DELIVERY_PRIORITY[b.rank];
    if (ra !== rb) return ra - rb;
    const ia = originalIndex.get(a.skillId) ?? Number.MAX_SAFE_INTEGER;
    const ib = originalIndex.get(b.skillId) ?? Number.MAX_SAFE_INTEGER;
    if (ia !== ib) return ia - ib;
    return a.skillId < b.skillId ? -1 : a.skillId > b.skillId ? 1 : 0;
  });
}

/**
 * Rank the candidate members, truncate to the cap, and report every drop with
 * a precise reason.
 *
 * Retention: declared dependencies first (they never yield a slot to a delta or
 * a recommendation), then the personal delta, then recommendations. Within one
 * rank the resolved input order wins; the total-order tie-break is ascending
 * skill id, so the function is a pure function of its input.
 */
export function rankAndCapInjectedMembers(
  input: RankAndCapInput,
): RankAndCapResult {
  const cap = Math.max(0, input.cap ?? INJECTED_SKILL_CAP);

  const candidates = dedupeByFirstSeen([
    ...(input.delta ? [input.delta] : []),
    ...input.declaredDependencies,
    ...input.recommendations,
  ]);

  // First-seen position in the deduped candidate list IS the within-rank
  // ordering key. Captured BEFORE any sort so no sort can influence it.
  const originalIndex = new Map<string, number>();
  candidates.forEach((m, i) => {
    if (!originalIndex.has(m.skillId)) originalIndex.set(m.skillId, i);
  });

  const ranked = [...candidates].sort((a, b) => {
    const ra = RETENTION_PRIORITY[a.rank];
    const rb = RETENTION_PRIORITY[b.rank];
    if (ra !== rb) return ra - rb;
    const ia = originalIndex.get(a.skillId) ?? Number.MAX_SAFE_INTEGER;
    const ib = originalIndex.get(b.skillId) ?? Number.MAX_SAFE_INTEGER;
    if (ia !== ib) return ia - ib;
    return a.skillId < b.skillId ? -1 : a.skillId > b.skillId ? 1 : 0;
  });

  const kept = ranked.slice(0, cap);
  const cut = ranked.slice(cap);

  const requiredCount = candidates.filter(
    (m) => m.rank === "declared_dependency",
  ).length;

  // A required set that fills or overflows the cap is a CONFIGURATION ERROR,
  // and it is failed as one where a configuration error belongs: in the
  // agent-creation preflight, BEFORE any dispatch (`preflightAgentCreation`
  // returns `skill_request_cap_exceeded` cross-provider).
  //
  // At RUNTIME the same condition can still arrive — an assistant bundle that
  // predates its consolidation, a hand-edited assignment — and this function
  // deliberately TRUNCATES-AND-RECORDS instead of throwing. Throwing here would
  // turn an over-cap bundle into a hard failure of the live turn, which is a
  // strictly worse outcome than delivering the eight highest-ranked required
  // skills with the remainder recorded under a reason that names the cause.
  // The drop is never silent: it rides the response, the efficacy ledger, and
  // an operator-visible warning.
  const dropped: InjectedSkillDrop[] = cut.map((m) => ({
    skillId: m.skillId,
    rank: m.rank,
    reason:
      m.rank === "declared_dependency"
        ? "over_cap_required_dependencies"
        : m.rank === "personal_delta" && requiredCount >= cap
          ? "delta_displaced_by_required_dependencies"
          : "over_cap",
  }));

  return {
    members: orderMembersForDelivery(kept, originalIndex),
    dropped,
  };
}

// ===========================================================================
// 3. Provider -> mechanism
// ===========================================================================

export type SkillDeliveryMechanism =
  /** Skills are MOUNTED as a tool the model reads on demand (OpenAI shell). */
  | "tool-mount"
  /** Skill bodies are merged into the system context by CORE (Gemini). */
  | "inline"
  /** Skills are referenced as pre-synced container skills (Anthropic). */
  | "container";

/**
 * The map. Keyed by the `LlmProvider` string values without importing the
 * provider union — this leaf stays free of the LLM package so
 * `@cinatra-ai/skills/injection` is importable from it.
 */
export const PROVIDER_SKILL_DELIVERY_MECHANISM: Readonly<
  Record<string, SkillDeliveryMechanism>
> = Object.freeze({
  openai: "tool-mount",
  gemini: "inline",
  anthropic: "container",
});

/** Thrown when a provider has no declared skill-delivery mechanism. */
export class UnknownSkillDeliveryMechanismError extends Error {
  constructor(provider: string) {
    super(
      `No skill-delivery mechanism is declared for provider "${provider}". ` +
        `A new provider must declare one in PROVIDER_SKILL_DELIVERY_MECHANISM ` +
        `before it can receive skills.`,
    );
    this.name = "UnknownSkillDeliveryMechanismError";
  }
}

/** Resolve a provider's mechanism, failing closed on an undeclared provider. */
export function resolveSkillDeliveryMechanism(
  provider: string,
): SkillDeliveryMechanism {
  const mechanism = PROVIDER_SKILL_DELIVERY_MECHANISM[provider];
  if (!mechanism) throw new UnknownSkillDeliveryMechanismError(provider);
  return mechanism;
}

/** True when core must expand and inline the skill bodies itself. */
export function isInlineSkillMechanism(provider: string): boolean {
  return resolveSkillDeliveryMechanism(provider) === "inline";
}

// ---------------------------------------------------------------------------
// Inline expansion budget
// ---------------------------------------------------------------------------

/**
 * The per-request byte budget for core-side inline expansion (members plus the
 * personal delta). Ratified at 200,000 bytes; deployment-configurable through
 * `CINATRA_INLINE_SKILL_BUDGET_BYTES`.
 */
export const DEFAULT_INLINE_SKILL_BUDGET_BYTES = 200_000;

/**
 * Read the configured budget. A missing / unparseable / non-positive value
 * falls back to the ratified default rather than disabling the budget.
 */
export function resolveInlineSkillBudgetBytes(
  env: Record<string, string | undefined> = {},
): number {
  const raw = env.CINATRA_INLINE_SKILL_BUDGET_BYTES;
  if (typeof raw !== "string" || raw.trim() === "") {
    return DEFAULT_INLINE_SKILL_BUDGET_BYTES;
  }
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_INLINE_SKILL_BUDGET_BYTES;
  }
  return parsed;
}

// ===========================================================================
// 4. Inline expansion (pure core)
// ===========================================================================


// ---------------------------------------------------------------------------
// Reference extraction
// ---------------------------------------------------------------------------

/**
 * Normalize a raw reference target into a repo-relative path INSIDE the skill
 * directory, or `null` when it must not be followed.
 *
 * Rejected: absolute paths, URLs / protocol-relative targets, anything that
 * escapes the skill directory via `..`, fragment/query-only targets, and empty
 * strings. Accepted targets are returned with `./` prefixes and duplicate
 * separators collapsed and back-slashes normalized to `/`.
 */
export function normalizeReferencePath(raw: string): string | null {
  if (typeof raw !== "string") return null;
  let value = raw.trim();
  if (value === "") return null;
  // Strip a surrounding <...> (markdown autolink form) and any quotes.
  value = value.replace(/^<(.*)>$/, "$1").replace(/^["'](.*)["']$/, "$1").trim();
  if (value === "") return null;
  // Drop a trailing fragment / query.
  value = value.split("#")[0]!.split("?")[0]!.trim();
  if (value === "") return null;
  // Protocol, protocol-relative, mailto, absolute path: not a bundle file.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) return null;
  if (value.startsWith("//")) return null;
  if (value.startsWith("/")) return null;
  const normalized = value.replaceAll("\\", "/");
  const segments: string[] = [];
  for (const segment of normalized.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") return null; // never escape the skill directory
    segments.push(segment);
  }
  if (segments.length === 0) return null;
  const joined = segments.join("/");
  // The router itself is not a reference to itself.
  if (joined === "SKILL.md") return null;
  return joined;
}

// Anchored on the CLOSING `](` rather than on the opening `[`: only the link
// TARGET is wanted, never the link text, and matching the text with `\[[^\]]*\]`
// makes the scan polynomial (CodeQL js/polynomial-redos) because every `[` in a
// run of them is a fresh start position that re-scans the same tail. `](` is an
// unambiguous two-character anchor. The target and title are also LENGTH-BOUND:
// a bundle-relative path is short, and an unbounded `[^)\s]+` re-scans to the
// end of the router on every `](` before backtracking to find its `)`, which is
// quadratic on a router full of `](`. A 512-character window keeps the work per
// match constant. The same bound is applied to the other two shapes below.
const MARKDOWN_LINK = /\]\(([^)\s]{1,512})(?:\s{1,8}["'][^"']{0,512}["'])?\)/g;
const BACKTICK_PATH = /`([^`\n]{1,512}?\.[A-Za-z0-9]{1,8})`/g;
const BARE_REFERENCE_PATH =
  /(?:^|[\s(])((?:references|scripts|assets)\/[^\s)`'",]{1,512})/gm;

/**
 * Extract the ONE-HOP reference targets a router body names. Deterministic:
 * first-seen order, deduped, already normalized.
 *
 * Three shapes are recognized because SKILL.md routers in this codebase use all
 * three: markdown links, back-ticked paths, and bare `references/...` mentions.
 */
export function extractOneHopReferences(routerBody: string): string[] {
  if (typeof routerBody !== "string" || routerBody === "") return [];
  const found: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string | undefined) => {
    if (!raw) return;
    const normalized = normalizeReferencePath(raw);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    found.push(normalized);
  };
  for (const match of routerBody.matchAll(MARKDOWN_LINK)) push(match[1]);
  for (const match of routerBody.matchAll(BACKTICK_PATH)) push(match[1]);
  for (const match of routerBody.matchAll(BARE_REFERENCE_PATH)) push(match[1]);
  return found;
}

// ---------------------------------------------------------------------------
// Budgeted expansion planning
// ---------------------------------------------------------------------------

/** One skill's already-read bytes, ready to be planned into a request. */
export type InlineExpansionUnit = {
  readonly skillId: string;
  readonly rank: InjectedSkillRank;
  /** The router body (SKILL.md), or the delta body for an inline member. */
  readonly body: string | null;
  /** One-hop reference files, in router order. Empty for a delta. */
  readonly references?: ReadonlyArray<{ readonly path: string; readonly content: string }>;
  /**
   * The reader found a reference that EXISTS in the bundle but is larger than
   * the whole request budget. Whole-file granularity means it can never be
   * partially inlined, and shipping the router without it would deliver
   * instructions that route somewhere unreachable — so the WHOLE skill drops.
   */
  readonly oversized?: boolean;
};

export type InlineExpansionPlan = {
  /** The rendered system-context fragment. `""` when nothing fit. */
  readonly systemContext: string;
  /** The skill ids actually inlined, in rank order. */
  readonly includedSkillIds: string[];
  /** Whole-skill drops (budget overflow / unreadable body), with reasons. */
  readonly dropped: InjectedSkillDrop[];
  /** Total bytes the rendered fragment accounts for. */
  readonly totalBytes: number;
};

function byteLength(value: string): number {
  // Node and the browser both expose TextEncoder; Buffer is not assumed here so
  // this leaf stays runtime-neutral.
  return new TextEncoder().encode(value).length;
}

function renderUnit(unit: InlineExpansionUnit): string {
  const parts: string[] = [`## skill: ${unit.skillId}`, (unit.body ?? "").trim()];
  for (const reference of unit.references ?? []) {
    parts.push(`### ${unit.skillId} :: ${reference.path}`, reference.content.trim());
  }
  return parts.filter((p) => p !== "").join("\n\n");
}

/**
 * Plan the inline expansion in RANK ORDER under a per-request byte budget.
 *
 * The units arrive in delivery (rank) order and are consumed greedily in that
 * order: the highest-ranked skills claim the budget first, so an overflow drops
 * the least important skills rather than an arbitrary set. A unit whose body is
 * unresolvable is dropped with its own reason (never silently emitted as an
 * empty skill).
 */
const HEADER = "Skill instructions:";
const SEPARATOR = "\n\n";

export function planInlineExpansion(input: {
  readonly units: readonly InlineExpansionUnit[];
  readonly budgetBytes: number;
}): InlineExpansionPlan {
  const budget = Math.max(0, input.budgetBytes);
  const rendered: string[] = [];
  const includedSkillIds: string[] = [];
  const dropped: InjectedSkillDrop[] = [];
  // The budget covers the EMITTED fragment, so the header and the separators
  // that join the units are accounted for — otherwise the string handed to the
  // provider can exceed the very number the budget names.
  let used = byteLength(HEADER);
  const separatorBytes = byteLength(SEPARATOR);

  for (const unit of input.units) {
    const body = typeof unit.body === "string" ? unit.body.trim() : "";
    if (body === "") {
      dropped.push({
        skillId: unit.skillId,
        rank: unit.rank,
        reason: "inline_body_unresolvable",
      });
      continue;
    }
    if (unit.oversized === true) {
      dropped.push({
        skillId: unit.skillId,
        rank: unit.rank,
        reason: "inline_budget_exhausted",
      });
      continue;
    }
    const text = renderUnit({ ...unit, body });
    const bytes = byteLength(text) + separatorBytes;
    if (used + bytes > budget) {
      // WHOLE-SKILL drop: the router and every reference go together.
      dropped.push({
        skillId: unit.skillId,
        rank: unit.rank,
        reason: "inline_budget_exhausted",
      });
      continue;
    }
    used += bytes;
    rendered.push(text);
    includedSkillIds.push(unit.skillId);
  }

  const systemContext =
    rendered.length > 0 ? [HEADER, ...rendered].join(SEPARATOR) : "";

  return {
    systemContext,
    includedSkillIds,
    dropped,
    // Report what was actually emitted, so an assertion can compare the two.
    totalBytes: byteLength(systemContext),
  };
}

// ===========================================================================
// 5. The branded set + the resolver (the ONLY constructor)
// ===========================================================================


// ---------------------------------------------------------------------------
// The brand
// ---------------------------------------------------------------------------

// `declare const` with a `unique symbol` type: the symbol has no runtime value
// and cannot be NAMED outside this module, so no other module can produce a
// value assignable to `ResolvedInjectedSkillSet`. This is the type-level half of
// AC-1; `assertAttributedInjectedSkillSet` below is the runtime half.
declare const INJECTED_SKILL_SET_BRAND: unique symbol;

/**
 * The authoritative injected-skill set for exactly one LLM request.
 * Constructible ONLY by {@link resolveInjectedSkillSet}.
 */
export type ResolvedInjectedSkillSet = {
  readonly [INJECTED_SKILL_SET_BRAND]: true;
  readonly intentKind: InjectionIntentKind;
  readonly intentLabel: string;
  readonly members: readonly InjectedSkillMember[];
  readonly dropped: readonly InjectedSkillDrop[];
};

// ---------------------------------------------------------------------------
// Accessors — the read surface every consumer uses
// ---------------------------------------------------------------------------

/** Every member in DELIVERY order (personal delta first). */
export function injectedSkillMembers(
  set: ResolvedInjectedSkillSet,
): readonly InjectedSkillMember[] {
  return set.members;
}

/**
 * The CATALOG members' skill ids, in delivery order — what a provider
 * mechanism (tool-mount / container / inline expansion) is asked to deliver.
 * Excludes the personal delta, which is inline system content on every
 * provider.
 */
export function injectedCatalogSkillIds(
  set: ResolvedInjectedSkillSet,
): string[] {
  return set.members
    .filter((m) => m.deliveryMode === "catalog")
    .map((m) => m.skillId);
}

/** The personal delta member, when one survived the cap. */
export function injectedPersonalDelta(
  set: ResolvedInjectedSkillSet,
): InjectedSkillMember | null {
  return set.members.find((m) => m.rank === "personal_delta") ?? null;
}

/** Every drop, with its reason — the ledger's input. */
export function injectedSkillDrops(
  set: ResolvedInjectedSkillSet,
): readonly InjectedSkillDrop[] {
  return set.dropped;
}

/** The intent this set was resolved for (log-safe; carries no subject values). */
export function injectedIntentLabel(set: ResolvedInjectedSkillSet): string {
  return set.intentLabel;
}

/** True when nothing at all is delivered — the entry point then skips delivery. */
export function isEmptyInjectedSkillSet(set: ResolvedInjectedSkillSet): boolean {
  return set.members.length === 0;
}

/**
 * A human + machine readable explanation of the truncation, or `null` when
 * nothing was dropped. Surfaced on the LLM response so a drop is never silent.
 */
export function describeInjectedSelection(
  set: ResolvedInjectedSkillSet,
): { droppedSkillIds: string[]; selectionReason: string } | null {
  if (set.dropped.length === 0) return null;
  const droppedSkillIds = set.dropped.map((d) => d.skillId);
  const byReason = new Map<string, string[]>();
  for (const drop of set.dropped) {
    const bucket = byReason.get(drop.reason) ?? [];
    bucket.push(drop.skillId);
    byReason.set(drop.reason, bucket);
  }
  const clauses = [...byReason.entries()].map(
    ([reason, ids]) => `${reason}: ${ids.join(", ")}`,
  );
  const selectionReason =
    `The injection contract delivers at most 8 skills per request including ` +
    `the personal delta. Intent "${set.intentLabel}" resolved ` +
    `${set.members.length + set.dropped.length} member(s); ` +
    `${set.members.length} kept (${set.members.map((m) => m.skillId).join(", ") || "none"}), ` +
    `${set.dropped.length} dropped — ${clauses.join("; ")}.`;
  return { droppedSkillIds, selectionReason };
}

// ---------------------------------------------------------------------------
// Runtime refusal of unattributed content
// ---------------------------------------------------------------------------

const VALID_DELIVERY_MODES = new Set(["catalog", "inline"]);

/**
 * The RUNTIME half of "no unattributed skill content". Every member must carry
 * a non-empty skill id and a known delivery mode, and any member that carries
 * literal content must be an `inline` member with an id. Called by the
 * skill-aware entry points immediately before delivery.
 */
export function assertAttributedInjectedSkillSet(
  set: ResolvedInjectedSkillSet,
): void {
  if (!set || !Array.isArray(set.members)) {
    throw new UnattributedSkillContentError(
      "the injected skill set carries no member list",
    );
  }
  for (const member of set.members) {
    if (typeof member.skillId !== "string" || member.skillId.trim() === "") {
      throw new UnattributedSkillContentError(
        `a ${member?.rank ?? "unknown"}-rank member carries no skill id`,
      );
    }
    if (!VALID_DELIVERY_MODES.has(member.deliveryMode)) {
      throw new UnattributedSkillContentError(
        `member "${member.skillId}" carries no known delivery mode ` +
          `(got ${JSON.stringify(member.deliveryMode)})`,
      );
    }
    if (
      typeof member.content === "string" &&
      member.content.length > 0 &&
      member.deliveryMode !== "inline"
    ) {
      throw new UnattributedSkillContentError(
        `member "${member.skillId}" carries literal content but is not an ` +
          `inline member`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

function requirePort<K extends keyof InjectionResolverPorts>(
  ports: InjectionResolverPorts,
  name: K,
  intentLabel: string,
): NonNullable<InjectionResolverPorts[K]> {
  const port = ports[name];
  if (typeof port !== "function") {
    throw new MissingInjectionPortError(String(name), intentLabel);
  }
  return port as NonNullable<InjectionResolverPorts[K]>;
}

function enforce(
  authorization: InjectionAuthorization | undefined,
  intentLabel: string,
): InjectionAuthorization & { ok: true } {
  if (!authorization || authorization.ok !== true) {
    throw new SkillInjectionAuthorizationError(
      intentLabel,
      authorization && authorization.ok === false
        ? authorization.reason
        : "the authorization port returned no decision",
    );
  }
  return authorization;
}

/** Turn resolved refs into members of one rank, dropping malformed entries. */
function toMembers(
  refs: readonly InjectionSkillRef[] | undefined,
  rank: InjectedSkillMember["rank"],
): InjectedSkillMember[] {
  if (!Array.isArray(refs)) return [];
  const out: InjectedSkillMember[] = [];
  for (const ref of refs) {
    const skillId = typeof ref?.skillId === "string" ? ref.skillId.trim() : "";
    // An unattributed entry is DROPPED here rather than delivered unnamed —
    // the same refusal the runtime assertion makes, applied at the source.
    if (skillId === "") continue;
    out.push({
      skillId,
      rank,
      deliveryMode: "catalog",
      revisionId: typeof ref.revisionId === "string" ? ref.revisionId : null,
    });
  }
  return out;
}

/** Turn a resolved delta into an inline member, refusing unattributed content. */
function toDeltaMember(
  delta: InjectionPersonalDelta | null | undefined,
): InjectedSkillMember | null {
  if (!delta) return null;
  const content = typeof delta.content === "string" ? delta.content : "";
  if (content.trim() === "") return null;
  const skillId = typeof delta.skillId === "string" ? delta.skillId.trim() : "";
  if (skillId === "") {
    // Personal-delta content with NO identity is exactly the shape the platform
    // used to inject as a bare string. It is refused, loudly.
    throw new UnattributedSkillContentError(
      "a personal delta resolved with content but no skill id",
    );
  }
  return {
    skillId,
    rank: "personal_delta",
    deliveryMode: "inline",
    revisionId: typeof delta.revisionId === "string" ? delta.revisionId : null,
    content,
  };
}

type DerivedMembers = {
  delta: InjectedSkillMember | null;
  declaredDependencies: InjectedSkillMember[];
  recommendations: InjectedSkillMember[];
};

async function deriveMembers(
  intent: InjectionIntent,
  ports: InjectionResolverPorts,
  intentLabel: string,
): Promise<DerivedMembers> {
  switch (intent.kind) {
    case "agent-run": {
      const authorize = requirePort(ports, "authorizeAgentRun", intentLabel);
      const authorization = enforce(
        await authorize({
          agentId: intent.agentId,
          runId: intent.runId,
          userId: intent.userId,
        }),
        intentLabel,
      );
      const recommendPort = requirePort(
        ports,
        "resolveRunRecommendedSkills",
        intentLabel,
      );
      const declared = ports.resolveDeclaredDependencySkills
        ? await ports.resolveDeclaredDependencySkills({
            consumerRef: intent.agentId,
          })
        : [];
      const recommended = await recommendPort({
        agentId: intent.agentId,
        runId: intent.runId,
        actorUserId: authorization.runOwnerUserId ?? null,
      });
      // The delta is scoped to the SERVER-VERIFIED run owner, never to a
      // caller-supplied id. No verified owner => no personal delivery.
      const ownerUserId =
        typeof authorization.runOwnerUserId === "string" &&
        authorization.runOwnerUserId.length > 0
          ? authorization.runOwnerUserId
          : null;
      const delta =
        ownerUserId && ports.resolvePersonalDelta
          ? await ports.resolvePersonalDelta({
              agentId: intent.agentId,
              userId: ownerUserId,
            })
          : null;
      return {
        delta: toDeltaMember(delta),
        declaredDependencies: toMembers(declared, "declared_dependency"),
        recommendations: toMembers(recommended, "recommendation"),
      };
    }

    case "assistant": {
      const authorize = requirePort(
        ports,
        "authorizeAssistantSession",
        intentLabel,
      );
      enforce(
        await authorize({
          agentId: intent.agentId,
          userId: intent.userId,
          sessionId: intent.sessionId,
        }),
        intentLabel,
      );
      const requiredPort = requirePort(
        ports,
        "resolveAssistantRequiredSkills",
        intentLabel,
      );
      const required = await requiredPort({ agentId: intent.agentId });
      const declaredEdges = ports.resolveDeclaredDependencySkills
        ? await ports.resolveDeclaredDependencySkills({
            consumerRef: intent.agentId,
          })
        : [];
      const delta = ports.resolvePersonalDelta
        ? await ports.resolvePersonalDelta({
            agentId: intent.agentId,
            userId: intent.userId,
          })
        : null;
      return {
        delta: toDeltaMember(delta),
        declaredDependencies: [
          ...toMembers(required, "declared_dependency"),
          ...toMembers(declaredEdges, "declared_dependency"),
        ],
        recommendations: [],
      };
    }

    case "explicit-purpose": {
      switch (intent.purpose) {
        case "agent-authoring": {
          const authorize = requirePort(
            ports,
            "authorizeAuthoringSurface",
            intentLabel,
          );
          enforce(
            await authorize({ agentSpecRef: intent.subject.agentSpecRef }),
            intentLabel,
          );
          const resolve = requirePort(
            ports,
            "resolveAuthoringSkills",
            intentLabel,
          );
          const refs = await resolve({
            agentSpecRef: intent.subject.agentSpecRef,
          });
          return {
            delta: null,
            declaredDependencies: toMembers(refs, "declared_dependency"),
            recommendations: [],
          };
        }
        case "agent-creation-review": {
          if (!isReviewerLane(intent.subject.reviewerLane)) {
            throw new SkillInjectionAuthorizationError(
              intentLabel,
              `reviewerLane ${JSON.stringify(intent.subject.reviewerLane)} is ` +
                `not a bound reviewer lane`,
            );
          }
          const authorize = requirePort(
            ports,
            "authorizeCreationReview",
            intentLabel,
          );
          enforce(
            await authorize({
              candidateAgentRef: intent.subject.candidateAgentRef,
              reviewerLane: intent.subject.reviewerLane,
            }),
            intentLabel,
          );
          const resolve = requirePort(
            ports,
            "resolveLaneMethodologySkills",
            intentLabel,
          );
          // THAT LANE's methodology skills — deliberately NOT the candidate's.
          const refs = await resolve({
            reviewerLane: intent.subject.reviewerLane,
          });
          return {
            delta: null,
            declaredDependencies: toMembers(refs, "declared_dependency"),
            recommendations: [],
          };
        }
        case "auditor-run-skills": {
          const authorize = requirePort(
            ports,
            "authorizeAuditAuthority",
            intentLabel,
          );
          enforce(
            await authorize({ runId: intent.subject.runId }),
            intentLabel,
          );
          const resolve = requirePort(
            ports,
            "resolveRecordedRunSkills",
            intentLabel,
          );
          const refs = await resolve({ runId: intent.subject.runId });
          return {
            delta: null,
            declaredDependencies: toMembers(refs, "declared_dependency"),
            recommendations: [],
          };
        }
        default: {
          const exhaustive: never = intent;
          throw new UnknownInjectionIntentError(
            `explicit-purpose:${String((exhaustive as { purpose?: string }).purpose)}`,
          );
        }
      }
    }

    default: {
      const exhaustive: never = intent;
      throw new UnknownInjectionIntentError(
        String((exhaustive as { kind?: string }).kind),
      );
    }
  }
}

/**
 * Resolve the authoritative injected-skill set for one LLM request.
 *
 * Throws — never returns a degraded set — on an authorization refusal, a
 * missing port, an unknown intent, or unattributed personal-delta content.
 */
export async function resolveInjectedSkillSet(
  intent: InjectionIntent,
  ports: InjectionResolverPorts,
): Promise<ResolvedInjectedSkillSet> {
  if (!intent || typeof intent !== "object" || typeof intent.kind !== "string") {
    throw new UnknownInjectionIntentError(String((intent as { kind?: string })?.kind));
  }
  const intentLabel = describeInjectionIntent(intent);
  const derived = await deriveMembers(intent, ports ?? {}, intentLabel);
  const { members, dropped } = rankAndCapInjectedMembers({
    delta: derived.delta,
    declaredDependencies: derived.declaredDependencies,
    recommendations: derived.recommendations,
  });

  const set = {
    intentKind: intent.kind,
    intentLabel,
    members,
    dropped,
  } as unknown as ResolvedInjectedSkillSet;

  // Fail at construction, not only at delivery.
  assertAttributedInjectedSkillSet(set);
  return set;
}
