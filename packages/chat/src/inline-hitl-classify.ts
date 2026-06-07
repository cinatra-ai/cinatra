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
