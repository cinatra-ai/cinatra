/**
 * Execution-plane policy + central system-cue composition (exec-plane S1,
 * cinatra#1706).
 *
 * Two distinct gates — do not conflate them:
 *
 *  1. ROLLOUT flag (`isExecutionPlaneRolloutEnabled`): a TEMPORARY merge gate,
 *     default-OFF, so S1 lands dark. This is NOT the D4 policy default (the
 *     shipped policy default is ON) — it exists only so the injection wiring
 *     can merge before the broker/worker slice is live. When off, injection is
 *     a pure passthrough and live behavior is byte-identical.
 *
 *  2. AVAILABILITY posture (`ExecutionAvailability`): the D4 per-org / per-agent
 *     policy. When the rollout flag is on, this decides whether an identified
 *     caller actually gets the capability. `"enabled"` ⇒ inject; `"disabled"`
 *     (opt-out) ⇒ a structured `capability_unavailable` error (distinguishable
 *     from `no_session`), model stays usable.
 *
 * The cue is composed HERE, in the same module that builds the tool, so the
 * tool schema and its policy-derived system cue can never diverge (the epic's
 * "tool and cue cannot diverge" invariant): `injectExecutionCapability` calls
 * `composeExecutionCue` exactly once alongside `buildSandboxExecutionTool`.
 */

import type { ExecutionSession } from "./session";
import type { SandboxStagedSkill } from "../types";

/** Per-org / per-agent D4 availability posture, resolved by the caller. */
export type ExecutionAvailability = "enabled" | "disabled";

/**
 * The temporary S1 merge gate. Default-OFF. Reads
 * `CINATRA_EXECUTION_PLANE_ROLLOUT`; only the exact string `"on"` enables it
 * (any other value — unset, `""`, `"off"`, `"true"`, `"1"` — stays off, so the
 * dark default is impossible to trip by accident). Injectable override for
 * tests.
 */
export function isExecutionPlaneRolloutEnabled(override?: string): boolean {
  const raw = override ?? process.env.CINATRA_EXECUTION_PLANE_ROLLOUT;
  return raw === "on";
}

/**
 * Technical carve-out (D4): explicit single-step / structured-output tasks have
 * no post-tool turn in which the model could consume a tool result, so the
 * execution capability is suppressed by default for them. A structured-output
 * task (`outputSchema` present) or an explicit single-step budget
 * (`maxSteps === 1`) suppresses.
 */
export function shouldSuppressExecutionForTask(task: {
  outputSchema?: unknown;
  maxSteps?: number;
}): boolean {
  if (task.outputSchema !== undefined && task.outputSchema !== null) return true;
  if (task.maxSteps === 1) return true;
  return false;
}

/**
 * Non-streaming injected calls require a tool-aware step budget — at least one
 * post-tool step so the model can act on the sandbox result. Given the caller's
 * requested budget (possibly undefined), return a budget with ≥1 post-tool step
 * guaranteed (≥2 total). Never LOWERS an already-larger budget.
 */
export function ensureToolAwareStepBudget(requested: number | undefined): number {
  const MIN_TOOL_AWARE_STEPS = 2; // ≥1 model step + ≥1 post-tool step
  if (typeof requested !== "number" || !Number.isFinite(requested)) {
    return MIN_TOOL_AWARE_STEPS;
  }
  return Math.max(requested, MIN_TOOL_AWARE_STEPS);
}

/**
 * The short, policy-derived system cue that makes the model AWARE of the
 * execution capability. Composed centrally so it is emitted if and ONLY if the
 * matching tool is injected. Kept intentionally terse and free of any secret /
 * host detail — the sandbox holds no credentials or host data (D5), and the cue
 * says so, steering the model away from expecting ambient authority inside it.
 */
export function composeExecutionCue(
  session: ExecutionSession,
  opts?: { stagedSkills?: SandboxStagedSkill[] },
): string {
  const runNote = session.runId
    ? " Files you create persist across steps within this run."
    : " Files you create persist across the steps of this task.";
  const staged = opts?.stagedSkills ?? [];
  const skillNote =
    staged.length > 0
      ? " Skill files are staged read-only under /skills/<slug> inside the " +
        "sandbox (available: " +
        staged.map((s) => `/skills/${s.slug}`).join(", ") +
        ") — read them lazily with cat/head/tail when a skill applies."
      : "";
  return (
    "You have a `sandbox_execute` tool: an isolated, non-root sandbox for " +
    "running shell commands, scripts, and unprivileged package installs " +
    "(pip / npm / user-space binaries). It has internet access for downloading " +
    "and installing tools. It contains NO credentials and NO host data — use " +
    "the connector/MCP tools for authenticated actions, never the sandbox." +
    runNote +
    skillNote
  );
}

// ---------------------------------------------------------------------------
// RENDER-SIDE PROVENANCE (cinatra#2175) — the post-turn half of the same policy
// ---------------------------------------------------------------------------
//
// The two gates above decide whether the capability is OFFERED. This section
// decides what a surface may present AFTERWARDS, and it exists because the two
// answers came apart in a live proof: with the capability fully injected on a
// chat turn (session minted, executor registered, suppression provably not
// firing, tool + cue reaching the adapter), a turn that explicitly asked to use
// `sandbox_execute` returned prose shaped exactly like captured stdout — marker
// line, platform string, a digest that was WRONG against the true value — with
// no tool call and no `execution_sandbox` audit row. The model routed around
// the tool and invented an execution-shaped answer.
//
// The audit trail was honest (no row means nothing ran); the SURFACE was not,
// and the audit trail cannot contradict a claim it correctly has no record of.
// So the plane answers one more question about a finished turn:
//
//   the capability was offered, the reply asserts that code ran — is there an
//   execution to point at?
//
// It does NOT judge whether the model was right; it judges whether the claim is
// BACKED. The backing signal is supplied by the caller as a count of COMPLETED
// sandbox dispatches, i.e. executor invocations that resolved. That count is
// the tightest available proxy for the audit record: the executor call IS the
// broker round-trip, and a resolved round-trip is exactly what writes the
// `execution_sandbox` row. One dispatch means there IS a record (and a tool
// chip in the transcript) the reader can check; zero dispatches means there is
// nothing, and the claim is marked UNVERIFIED in the transcript itself.
//
// POSTURE. Never blocks, never rewrites the model's words — it produces a
// marker the surface APPENDS (a guard that silently deleted an answer would
// trade one unfalsifiable surface for another). Inert unless the capability was
// offered, so a deployment with the plane dark is untouched. Conservative on
// claims: assertions in the past/perfect ("I ran", "here is the output", "its
// stdout was"), never offers or refusals ("I can run it", "I did not execute
// anything") — a missed claim is a silent surface and a false claim is a wrong
// accusation, so STRONG assertions (suppressed only by negation) are separated
// from WEAK mentions (also suppressed by hypothetical/modal framing).
//
// WHAT IT DOES NOT CATCH, said plainly. It keys on CLAIMS, so a reply that
// posts a block of output-shaped text and asserts nothing at all is not marked;
// widening to output SHAPE would accuse every ordinary code answer. And the
// backing count is per TURN, so a turn that genuinely executed one thing and
// invented a second is not marked either. Both are real residuals of a
// render-side guard and belong to the other two directions on the issue
// (response-side blocking, deterministic tool driving), not to this one.
//
// Pure and dependency-free, and deliberately NOT a new module: it lives beside
// the offer policy so the two halves of one decision cannot drift apart (and so
// the locked route graphs gain no module for it). Every surface that can offer
// the capability can reuse it — chat today; the agent-run transcript is the
// same shape and is the natural next consumer.

/** Verdict status for one finished turn. */
export type ExecutionProvenanceStatus =
  /** Capability not offered, or the reply asserts no execution at all. */
  | "not_applicable"
  /** The reply asserts execution AND a sandbox dispatch completed on the turn. */
  | "verified"
  /** The reply asserts execution and NOTHING ran — the fabrication case. */
  | "unverified";

export type ExecutionProvenanceVerdict = {
  status: ExecutionProvenanceStatus;
  /**
   * Why an `unverified` verdict was reached, and which marker that selects:
   *  - `"not_called"`    — the model never dispatched at all;
   *  - `"refused"`       — at least one dispatch was refused by the plane
   *                        before any command ran, and none executed (a
   *                        `sandbox_execute` result carrying the refusal
   *                        exists);
   *  - `"no_execution"`  — it dispatched, nothing ran, and nothing was refused
   *                        (an empty batch, or a call that never completed).
   * Absent on every other status. The three are genuinely different facts, and
   * a marker that stated the wrong one would itself be the false claim on the
   * page.
   */
  reason?: "not_called" | "refused" | "no_execution";
  /**
   * The claim-pattern ids that matched, deduped and stable-ordered. Diagnostic
   * only — deliberately NOT echoed into the reader-facing marker (quoting the
   * model's own sentence back at it adds noise, not proof).
   */
  matchedClaims: string[];
  /**
   * The reader-facing marker to append to the transcript when the status is
   * `unverified`; the empty string otherwise. Ready to append verbatim — it
   * carries its own leading separation.
   */
  notice: string;
};

/**
 * The visible transcript markers. Plain markdown so they ride the existing text
 * path of any surface (no new stream vocabulary, no new component): a
 * blockquote the chat renderer already styles. Each states only CHECKABLE facts
 * — never an opinion about the answer's correctness, which this guard cannot
 * and must not judge.
 *
 * There are two because there are two different truths. When the model never
 * called the tool there is genuinely no tool result and no audit entry. When it
 * called and the PLANE REFUSED, a `sandbox_execute` result IS in the transcript
 * and the refusal IS audited — claiming otherwise would make the marker itself
 * the false statement on the page.
 */
export const EXECUTION_PROVENANCE_UNVERIFIED_NOTICE =
  "\n\n> **Unverified execution claim.** This reply describes running code, " +
  "but the sandbox was never called on this turn — there is no " +
  "`sandbox_execute` tool result and no execution audit entry behind it. " +
  "Any command output above was written by the model, not captured from a run.";

export const EXECUTION_PROVENANCE_REFUSED_NOTICE =
  "\n\n> **Unverified execution claim.** This reply describes running code, " +
  "but no command ran on this turn — the execution plane refused a sandbox " +
  "call before any command started, and the `sandbox_execute` result above " +
  "carries the refusal. Any command output above was written by the model, " +
  "not captured from a run.";

/**
 * The third truth: the sandbox WAS called and yet no command ran and none was
 * refused — the call carried nothing, or it failed before the plane answered.
 * Neither of the other two markers is true for it, so it gets its own rather
 * than being rounded into the nearest one.
 */
export const EXECUTION_PROVENANCE_NO_EXECUTION_NOTICE =
  "\n\n> **Unverified execution claim.** This reply describes running code, " +
  "but the sandbox was called on this turn without any command actually " +
  "running, so there is no execution behind it. Any command output above was " +
  "written by the model, not captured from a run.";

type ClaimPattern = {
  /** Stable id, reported in `matchedClaims` and asserted by the tests. */
  id: string;
  re: RegExp;
  /**
   * `strong` — a FIRST-PERSON past assertion ("I ran it"). The speaker and the
   *            tense are both pinned by the pattern itself, so only negation
   *            can take it back; a modal elsewhere in the sentence ("I ran it,
   *            and I can re-run it") must not excuse it.
   * `weak`   — everything else: presentational framing ("here is the output"),
   *            the tool named, a sandbox mention. Each is a strong signal in an
   *            assertion and a nothing in an offer, a hypothetical or a
   *            statement about what the USER did — so these are additionally
   *            suppressed by modal framing and by a second-person actor.
   */
  strength: "strong" | "weak";
};

/**
 * Negation. A segment carrying one of these is not a claim however it reads
 * otherwise — "I did not run anything", "no command was executed", "without
 * actually running it".
 */
const NEGATION =
  /\b(?:did\s*n(?:o|')t|do\s*n(?:o|')t|does\s*n(?:o|')t|have\s*n(?:o|')t|has\s*n(?:o|')t|had\s*n(?:o|')t|was\s*n(?:o|')t|were\s*n(?:o|')t|is\s*n(?:o|')t|are\s*n(?:o|')t|cannot|can\s*not|can'?t|could\s*n(?:o|')t|will\s+not|won'?t|would\s*n(?:o|')t|never|unable\s+to|instead\s+of|rather\s+than|without\s+(?:actually\s+)?(?:running|executing)|no\s+(?:code|command|commands|script|execution)\s+(?:was|were|has|have))\b/i;

/**
 * Hypothetical / modal / offered framing. Suppresses WEAK patterns only — a
 * strong first-person assertion inside a modal sentence ("I ran it, and I can
 * re-run it") must still count.
 */
const HYPOTHETICAL =
  /\b(?:can|could|would|should|shall|will|may|might|let\s+me|want\s+me\s+to|able\s+to|going\s+to|plan\s+to|about\s+to|if\s+you|happy\s+to)\b/i;

/**
 * The actor is the USER, not the assistant ("you ran it in the previous turn",
 * "you have already executed that"). Suppresses WEAK patterns; the strong ones
 * pin `I` themselves and cannot match here.
 */
const SECOND_PERSON_ACTOR =
  /\byou(?:'ve|'d|'ll)?(?:\s+(?:have|had|already|just|then|previously|apparently))*\s+(?:ran|run|executed|execute)\b/i;

const CLAIM_PATTERNS: ClaimPattern[] = [
  // --- first-person past assertions --------------------------------------
  {
    id: "ran.first_person",
    // "I ran", "I've ran" / "I have ran" (sic, common), "I just ran".
    // "I ran into a problem" is excluded explicitly.
    re: /\bI(?:'ve|\s+have|\s+just|\s+already)?\s+ran\b(?!\s+into\b)/i,
    strength: "strong",
  },
  {
    id: "run.first_person_perfect",
    re: /\bI(?:'ve|\s+have|\s+already)\s+run\b/i,
    strength: "strong",
  },
  {
    id: "executed.first_person",
    re: /\bI\s+(?:just\s+|already\s+)?executed\b/i,
    strength: "strong",
  },
  // --- assertions about the thing that was run ---------------------------
  {
    id: "ran.the_command",
    re: /\b(?:ran|executed)\s+(?:the|this|that|your|a|an)?\s*(?:above\s+|following\s+|one-?line\s+)?(?:one-?liner|command|commands|script|code|snippet|program|python3?|node|bash|shell)\b/i,
    strength: "weak",
  },
  {
    id: "ran.it",
    re: /\b(?:ran|executed)\s+(?:it|this|that|them)\b/i,
    strength: "weak",
  },
  {
    id: "computed.by_running",
    // First-person-anchored like its siblings: "You computed it by running X"
    // is a statement about the USER and must not be flagged.
    re: /\bI\s+(?:just\s+|already\s+)?(?:computed|calculated|verified|checked|confirmed|obtained|measured)\s+(?:it|this|that|these|them|the\s+\w+)\s+by\s+(?:running|executing)\b/i,
    strength: "strong",
  },
  // --- assertions that the text below IS captured output -----------------
  {
    id: "stdout.qualified",
    re: /\b(?:its|the|command'?s?|captured|literal|raw|actual|exact|verbatim)\s+(?:std\s?out|standard\s+output)\b/i,
    strength: "weak",
  },
  {
    id: "stdout.copula",
    re: /\b(?:std\s?out|standard\s+output)\s+(?:was|is|shows?|showed|reads?|below|above)\b/i,
    strength: "weak",
  },
  {
    id: "output.here_is",
    re: /\bhere(?:'s|\s+is)\s+(?:the|its)\s+(?:literal\s+|raw\s+|actual\s+|exact\s+|captured\s+|verbatim\s+|command'?s?\s+)*(?:output|stdout)\b/i,
    strength: "weak",
  },
  {
    id: "output.copula",
    re: /\b(?:the\s+)?(?:command|script|code|program|run)(?:'s)?\s+output\s+(?:was|is)\b/i,
    strength: "weak",
  },
  {
    id: "printed.subject",
    re: /\b(?:it|the\s+(?:command|script|program|run|snippet|one-?liner))\s+(?:printed|returned|emitted|produced)\b/i,
    strength: "weak",
  },
  {
    id: "printed.relative",
    re: /\bwhich\s+(?:printed|returned|emitted|produced)\b/i,
    strength: "weak",
  },
  // --- the capability named outright -------------------------------------
  {
    id: "tool.named",
    re: /\bsandbox_execute\b/,
    strength: "weak",
  },
  // --- weak: sandbox mentions that accompany a claim ---------------------
  {
    id: "sandbox.location",
    re: /\b(?:in|inside|within|via|using|through)\s+(?:the\s+|your\s+|a\s+|an\s+|my\s+)?sandbox\b/i,
    strength: "weak",
  },
  {
    id: "sandbox.noun",
    re: /\bsandbox\s+(?:output|stdout|result|results|run|execution|session)\b/i,
    strength: "weak",
  },
];

/**
 * Split a reply into assertion-sized segments. Negation and modality bind
 * within a clause, so the guards are applied per segment rather than to the
 * whole reply — otherwise a single "if you want, I can run it" anywhere in a
 * long answer would suppress a genuine fabrication three paragraphs later.
 *
 * TWO GRANULARITIES, on purpose. Dashes also separate clauses ("I didn't
 * guess — I ran it"), and without splitting them a negation swallows the
 * assertion that follows it. But splitting them everywhere cuts the other way:
 * "I did not run it — here is the output you supplied" would leave the second
 * clause looking like a presentational claim with its negation stripped off.
 * So dashes split for the STRONG patterns only (which pin their own speaker
 * and tense, and are the ones a leading negation would wrongly cancel), while
 * the WEAK patterns keep the coarser sentence granularity that lets a negation
 * reach them.
 */
function splitSegments(text: string, opts: { dashes: boolean }): string[] {
  const re = opts.dashes
    ? /\n+|(?<=[.!?;:])\s+|\s*[\u2014\u2013]\s*|\s+--+\s+/u
    : /\n+|(?<=[.!?;:])\s+/u;
  return text
    .split(re)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * The claim-pattern ids asserted by a reply, deduped and in pattern order.
 * Empty means the reply makes no execution-shaped claim.
 */
export function detectExecutionClaims(text: string): string[] {
  if (!text || text.trim().length === 0) return [];
  const matched = new Set<string>();
  const strongPatterns = CLAIM_PATTERNS.filter((p) => p.strength === "strong");
  const weakPatterns = CLAIM_PATTERNS.filter((p) => p.strength === "weak");
  for (const segment of splitSegments(text, { dashes: true })) {
    if (NEGATION.test(segment)) continue;
    for (const pattern of strongPatterns) {
      if (pattern.re.test(segment)) matched.add(pattern.id);
    }
  }
  for (const segment of splitSegments(text, { dashes: false })) {
    if (NEGATION.test(segment)) continue;
    if (HYPOTHETICAL.test(segment) || SECOND_PERSON_ACTOR.test(segment)) continue;
    for (const pattern of weakPatterns) {
      if (pattern.re.test(segment)) matched.add(pattern.id);
    }
  }
  // Stable order = declaration order, so a verdict is deterministic.
  return CLAIM_PATTERNS.filter((p) => matched.has(p.id)).map((p) => p.id);
}

/** Convenience predicate over `detectExecutionClaims`. */
export function assertsExecution(text: string): boolean {
  return detectExecutionClaims(text).length > 0;
}

export type ExecutionProvenanceInput = {
  /**
   * Whether the execution capability was offered to the model on this turn.
   * The guard is inert when it was not, so a deployment with the plane dark is
   * byte-identical.
   *
   * Surfaces resolve this from their own execution binding (a minted session +
   * a registered executor). That deliberately OVER-approximates the injection
   * layer's `injected` status: a turn that carried a full binding but was
   * refused deeper in (e.g. an unsealable session) still gets the guard, and
   * the marker it may print — "no sandbox execution was recorded" — is exactly
   * as true there. The guard fails toward marking, never toward silence.
   */
  capabilityOffered: boolean;
  /**
   * What the turn's executor actually did. All three counts are REQUIRED, not
   * optional: each unverified reason has its own marker, and a caller that
   * under-specified the log would silently get a marker asserting the wrong
   * fact. `executed` is the one that BACKS a claim — it counts broker
   * round-trips the `execution_sandbox` audit row is written from; `refused`
   * and `attempted` only choose the wording when nothing was executed.
   *
   * SCOPE, stated so it is not over-read: these are TURN-level counts, not a
   * per-claim link. A turn that really executed something and then also
   * fabricated a second, unrelated result reads as `verified` here. Turn-level
   * is what a render-side guard can honestly assert; claim-level attribution
   * needs deterministic tool driving, which is a separate direction on the
   * issue.
   */
  dispatches: {
    /** Executor invocations STARTED. */
    attempted: number;
    /** Invocations that reached a sandbox (at least one non-refused output). */
    executed: number;
    /** Invocations the plane refused outright (every output a refusal). */
    refused: number;
  };
  /** The assistant's own text for the turn (tool results excluded). */
  text: string;
};

/** The verdict for one finished turn. Pure; never throws. */
export function evaluateExecutionProvenance(
  input: ExecutionProvenanceInput,
): ExecutionProvenanceVerdict {
  if (!input.capabilityOffered) {
    return { status: "not_applicable", matchedClaims: [], notice: "" };
  }
  const matchedClaims = detectExecutionClaims(input.text);
  if (matchedClaims.length === 0) {
    return { status: "not_applicable", matchedClaims: [], notice: "" };
  }
  const { attempted, executed, refused } = input.dispatches;
  if (executed > 0) {
    return { status: "verified", matchedClaims, notice: "" };
  }
  if (refused > 0) {
    return {
      status: "unverified",
      reason: "refused",
      matchedClaims,
      notice: EXECUTION_PROVENANCE_REFUSED_NOTICE,
    };
  }
  if (attempted > 0) {
    return {
      status: "unverified",
      reason: "no_execution",
      matchedClaims,
      notice: EXECUTION_PROVENANCE_NO_EXECUTION_NOTICE,
    };
  }
  return {
    status: "unverified",
    reason: "not_called",
    matchedClaims,
    notice: EXECUTION_PROVENANCE_UNVERIFIED_NOTICE,
  };
}
