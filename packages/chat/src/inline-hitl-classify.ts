/**
 * Chat prompt-window HITL classifier (deterministic ladder).
 *
 * When an inline HITL gate is open and the user types into the chat prompt,
 * this decides whether the message is a GATE RESPONSE (and how to turn it
 * into a submit payload) or a NORMAL CHAT message. The LLM fallback lives in a
 * server action; this module is the pure deterministic prelude so the common
 * cases never pay LLM latency and the e2e harness is deterministic.
 *
 * Deterministic classifier constraints encoded here:
 *  - exact (not substring) approval-word match, single terminal . or !
 *  - "new task" guard: @cinatra-ai mention / question-shape / continuation
 *    words ("also", "but", "and then", "too") → normal chat UNLESS the
 *    message is pure JSON or a bare single-field value
 *  - setup-loop primitive wraps under the gate's fieldName ONLY
 *  - mid-run single-field wraps under fields[0].name
 */

import type { ChatGateDescriptor } from "@cinatra-ai/agents/client-entry";

export type ClassifyGate = {
  fields: Array<{ name: string; type: string; title?: string; required: boolean }>;
  fieldName?: string;
};

export type ClassifyResult =
  | { kind: "chat" } // not a gate response — send to /api/chat
  | { kind: "submit"; value: Record<string, unknown> | string | number | boolean }
  | { kind: "llm" }; // deterministic ladder inconclusive — try the LLM fallback

const APPROVAL_WORDS = new Set([
  "yes",
  "y",
  "approve",
  "approved",
  "continue",
  "confirm",
  "confirmed",
  "ok",
  "okay",
  "go",
  "proceed",
  "lgtm",
  "looks good",
]);

const QUESTION_LEAD =
  /^\s*(what|how|why|can|does|do|is|are|should|could|would|when|where|who|which)\b/i;

const CONTINUATION = /\b(also|but|and then|too|as well|plus)\b/i;

function normalize(s: string): string {
  return s.trim().replace(/[.!]+$/, "").toLowerCase();
}

function coercePrimitive(
  raw: string,
  type: string,
): string | number | boolean | undefined {
  const v = raw.trim();
  if (v.length === 0) return undefined;
  if (type === "boolean") {
    if (/^(true|yes|y|on|enabled?)$/i.test(v)) return true;
    if (/^(false|no|n|off|disabled?)$/i.test(v)) return false;
    return undefined;
  }
  if (type === "number" || type === "integer") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  // string (incl. uri) — keep verbatim
  return v;
}

/**
 * Deterministic ladder. Returns:
 *  - {kind:"chat"}   → message is NOT a gate response; route to /api/chat
 *  - {kind:"submit"} → submit the carried value via the gate's submit()
 *  - {kind:"llm"}    → inconclusive; caller runs the LLM fallback
 */
export function classifyPromptForGate(
  message: string,
  gate: ClassifyGate,
): ClassifyResult {
  const trimmed = message.trim();
  if (trimmed.length === 0) return { kind: "chat" };

  // Only treat the message as a gate JSON response when the WHOLE trimmed
  // message parses as a JSON object, not when a JSON snippet appears inside
  // prose (e.g. `can you explain {"url":"x"}?` must NOT submit).
  const wholeJson = (() => {
    try {
      return JSON.parse(trimmed);
    } catch {
      return undefined;
    }
  })();
  const isWholeMessageJsonObject =
    wholeJson !== undefined &&
    wholeJson !== null &&
    typeof wholeJson === "object" &&
    !Array.isArray(wholeJson);

  // ---- New-task guard ------------------------------------------------------
  // @cinatra-ai mention, question-shape, or continuation words → normal chat,
  // UNLESS the message is WHOLLY JSON or a bare single-field value (those are
  // unambiguously gate responses regardless of phrasing).
  const looksLikeNewTask =
    /@cinatra-ai\//i.test(trimmed) ||
    QUESTION_LEAD.test(trimmed) ||
    trimmed.endsWith("?") ||
    CONTINUATION.test(trimmed);

  // ---- Single required primitive field + bare value -----------------------
  // Runs BEFORE approval words: a single-required-primitive gate wants the
  // VALUE, so a single required boolean gate maps "yes" → { field: true }
  // rather than the bare approval {}. Pure-approval gates have zero required
  // fields, so this no-ops for them and approval-word handling applies.
  // This MUST be evaluated before the new-task guard returns chat, so a bare
  // value overrides the guard. Guard against submitting a question/continuation
  // AS a string value: strong-typed fields (boolean/number/integer) only submit
  // when coercion succeeds; string fields submit only when the message is NOT
  // itself question-shaped.
  const requiredFields = gate.fields.filter((f) => f.required);
  const primitiveTypes = new Set(["string", "number", "integer", "boolean"]);
  if (
    requiredFields.length === 1 &&
    primitiveTypes.has(requiredFields[0].type) &&
    trimmed.length <= 300 &&
    !/[\n]/.test(trimmed)
  ) {
    const f = requiredFields[0];
    const isStringField = f.type === "string";
    const questionShaped =
      QUESTION_LEAD.test(trimmed) || trimmed.endsWith("?");
    // A single required STRING field would otherwise coerce ANY non-empty text
    // verbatim, swallowing whole-message JSON / null / array literals before
    // structured-JSON submit or fallthrough can act. For string fields, only
    // treat the message as a bare value when it is NOT itself standalone JSON
    // of any kind (object/array/null/primitive).
    const messageIsStandaloneJson = wholeJson !== undefined;
    // String field + question-shaped OR standalone-JSON → not a bare value;
    // let structured-JSON submit / the guard / LLM handle it. Strong-typed
    // fields coerce-or-fail so a question/JSON literal simply fails and falls
    // through.
    if (
      !(isStringField && questionShaped) &&
      !(isStringField && messageIsStandaloneJson)
    ) {
      const coerced = coercePrimitive(trimmed, f.type);
      if (coerced !== undefined) {
        // setup-loop primitive → wrap under gate.fieldName; mid-run single
        // field → wrap under the schema property name (fields[0].name).
        const key = gate.fieldName ?? f.name;
        return { kind: "submit", value: { [key]: coerced } };
      }
    }
  }

  // ---- Exact approval word ------------------------------------------------
  if (!looksLikeNewTask && APPROVAL_WORDS.has(normalize(trimmed))) {
    return { kind: "submit", value: {} };
  }

  // ---- Whole-message JSON wins over the new-task guard --------------------
  if (isWholeMessageJsonObject) {
    return {
      kind: "submit",
      value: wholeJson as Record<string, unknown>,
    };
  }

  if (looksLikeNewTask) return { kind: "chat" };

  // ---- Defer to LLM fallback for short/medium non-question ----------------
  if (trimmed.length <= 600) return { kind: "llm" };
  return { kind: "chat" };
}

// ---------------------------------------------------------------------------
// LLM-fallback extraction resolution (cinatra#853 — split out of
// chat-page.tsx's gate-drive block so the required-field policy is pure and
// unit-testable).
// ---------------------------------------------------------------------------

export type ExtractedGateResolution =
  /** Extraction satisfies the gate — submit `value` via gate.submit(). */
  | { kind: "submit"; value: Record<string, unknown> }
  /**
   * Extraction found SOME fields but required ones are missing — keep the
   * gate open, tell the user what is missing, do NOT route to the LLM (the
   * message was a gate attempt).
   */
  | { kind: "partial"; presentKeys: string[]; missing: string[] }
  /** Nothing extracted → fall through to normal chat routing. */
  | { kind: "none" };

/**
 * Decide what to do with the values the LLM fallback extracted from a chat
 * message for an open gate:
 *  - all required fields present → submit;
 *  - the gate has NO required fields and anything was extracted → submit;
 *  - something extracted but required fields missing → partial;
 *  - nothing extracted → none (normal chat routing).
 * `undefined`/`null` extracted values do not count as present.
 */
export function resolveExtractedGateValues(
  extracted: Record<string, unknown>,
  fields: ReadonlyArray<{ name: string; required: boolean }>,
): ExtractedGateResolution {
  const requiredNames = fields.filter((f) => f.required).map((f) => f.name);
  const hasAllRequired =
    requiredNames.length > 0 &&
    requiredNames.every(
      (n) => extracted[n] !== undefined && extracted[n] !== null,
    );
  const hasAny = Object.keys(extracted).length > 0;
  if (hasAllRequired || (requiredNames.length === 0 && hasAny)) {
    return { kind: "submit", value: extracted };
  }
  if (hasAny) {
    const missing = requiredNames.filter(
      (n) => extracted[n] === undefined || extracted[n] === null,
    );
    return { kind: "partial", presentKeys: Object.keys(extracted), missing };
  }
  return { kind: "none" };
}

// ---------------------------------------------------------------------------
// Chat-side inline HITL gate registry (cinatra#853 — the chat/run gate
// concern split out of chat-page.tsx). A pure closure factory, NOT a hook:
// chat-page holds one instance in state so the function identities are
// stable across renders (the handler is threaded to InlineAgentRunCard).
// Kept in THIS module (rather than its own file) so the /chat route's
// first-party module graph does not grow — the route-graph ratchet ceiling
// only ever shrinks.
// ---------------------------------------------------------------------------

export type ChatGateRegistry = {
  /** AgenticRunPanel's onActiveGateChange (threaded through
   *  InlineAgentRunCard). Registers an OPEN gate by runId; a `null` gate
   *  clears the entry ONLY if the registry still holds the SAME instanceId —
   *  a remounted card for the same runId must not be clobbered by an older
   *  instance's unmount. */
  handleActiveGateChange: (
    runId: string,
    gate: ChatGateDescriptor | null,
    instanceId: string,
  ) => void;
  /** The most-recently-registered OPEN gate, or undefined when none. */
  getLatestOpenGate: () => ChatGateDescriptor | undefined;
};

/**
 * Create the runId-keyed registry of OPEN inline HITL gates. Multiple
 * InlineAgentRunCards can mount (one per agent_run tool result); the
 * runId-keyed map prevents an older card from clobbering a newer gate.
 * `getLatestOpenGate` relies on Map insertion order (re-`set()` of an
 * existing runId keeps its original position), matching the previous
 * inline chat-page behavior exactly.
 */
export function createChatGateRegistry(): ChatGateRegistry {
  const gates = new Map<string, ChatGateDescriptor>();
  return {
    handleActiveGateChange(runId, gate, instanceId) {
      if (gate) {
        gates.set(runId, gate);
      } else {
        const current = gates.get(runId);
        if (current && current.instanceId === instanceId) {
          gates.delete(runId);
        }
      }
    },
    getLatestOpenGate() {
      const openGates = Array.from(gates.values());
      return openGates[openGates.length - 1];
    },
  };
}
