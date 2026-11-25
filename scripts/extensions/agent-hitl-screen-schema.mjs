// The declared HITL screen of an agent binding (cinatra#3470).
//
// A bundled agent package DECLARES the screen of a mid-run step as data in
// `cinatra.fieldRenderers[].screen`; the host draws it with its own generic
// card (packages/agents/src/declared-hitl-screen-renderer.tsx). This module is
// the allow-list every declaration passes: at generation (fail-closed) and
// again when the browser registers the generated map. Every unknown layout,
// key or section type is refused by name.
//
// The one layout drawn today is the card:
//   { layout: "card", sections, carry? }
//   sections (1..16, at least one field):
//     note  { text }                     - the agent's own sentence
//     fact  { label, key, qualifierKey? } - a read-only run value
//     words { key, label? }              - a read-only run value
//     quote { key }                      - a read-only run value, as text
//     field { key, label, multiline?, placeholder? } - a text field the
//            person writes; every field is required before Continue sends
//   carry: run-value keys copied into the answer from the step's own stored
//          values, never from what the browser sent.
// A field key or a carried key is never one the host writes itself
// (RESERVED_ANSWER_KEYS). Kind layouts and decisions are refused here: they
// are drawn by later work.
//
// Dependency-free and fs-free on purpose (build scripts and browser code
// import it).

export const HITL_SCREEN_KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
export const MAX_HITL_SCREEN_BYTES = 8192;
export const MID_RUN_ONLY_MESSAGE =
  "a declared screen is drawn only at a mid-run step: the binding must declare midRunHitl: true";

const MAX_TEXT = 600;
const MAX_LIST = 8;
const MAX_SECTIONS = 16;

// The keys the host writes into an answer or its Continue: the resume text,
// the name of a single text answer, the approval flag and its time, the
// approval note, the step number and the files sent with an answer.
export const RESERVED_ANSWER_KEYS = Object.freeze([
  "userResponse",
  "userResponseFieldName",
  "approved",
  "approvedAt",
  "approvalNote",
  "stepNumber",
  "attachments",
]);

// Per section type: prop -> [type, required].
const SECTION_SHAPES = {
  note: { text: ["text", true] },
  fact: { label: ["text", true], key: ["key", true], qualifierKey: ["key", false] },
  words: { key: ["key", true], label: ["text", false] },
  quote: { key: ["key", true] },
  field: {
    key: ["key", true],
    label: ["text", true],
    multiline: ["bool", false],
    placeholder: ["text", false],
  },
};

const LATER = "is not drawn yet; declare the step as a card of notes, facts, words, quotes and fields";

const TYPE_WORDS = {
  text: `non-blank text of at most ${MAX_TEXT} characters`,
  key: "a key",
  bool: "a boolean",
};

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function isKey(v) {
  return typeof v === "string" && HITL_SCREEN_KEY_RE.test(v);
}

function checkProp(type, v) {
  if (type === "text") return typeof v === "string" && v.trim().length > 0 && v.length <= MAX_TEXT;
  if (type === "key") return isKey(v);
  return typeof v === "boolean";
}

function checkObject(where, obj, shape, errors) {
  for (const k of Object.keys(obj)) {
    if (!Object.hasOwn(shape, k)) errors.push(`${where}: unknown key ${JSON.stringify(k)}`);
  }
  for (const [k, [type, required]] of Object.entries(shape)) {
    if (!Object.hasOwn(obj, k)) {
      if (required) errors.push(`${where}: ${k} is required`);
    } else if (!checkProp(type, obj[k])) {
      errors.push(`${where}: ${k} must be ${TYPE_WORDS[type]}`);
    }
  }
}

function checkNotReserved(where, key, errors) {
  if (RESERVED_ANSWER_KEYS.includes(key)) {
    errors.push(`${where}: ${JSON.stringify(key)} is written by the host and cannot be declared`);
  }
}

/**
 * Validate one declared screen. Returns `{ screen, errors }`; `screen` is a
 * plain JSON copy, present only when `errors` is empty.
 */
export function validateHitlScreen(raw, where = "screen") {
  if (!isPlainObject(raw)) return { errors: [`${where}: must be an object`] };
  let serialized;
  try {
    serialized = JSON.stringify(raw);
  } catch {
    return { errors: [`${where}: must be plain JSON`] };
  }
  if (new TextEncoder().encode(serialized).length > MAX_HITL_SCREEN_BYTES) {
    return { errors: [`${where}: must serialize to <= ${MAX_HITL_SCREEN_BYTES} bytes`] };
  }
  // Only the JSON copy is read and returned: what was checked is what is kept.
  const screen = JSON.parse(serialized);
  const errors = [];
  if (screen.layout !== "card") {
    errors.push(
      screen.layout === "kind"
        ? `${where}: layout "kind" ${LATER}`
        : `${where}: unknown layout ${JSON.stringify(screen.layout)}`,
    );
    return { errors };
  }
  const { layout: _layout, sections, carry, ...rest } = screen;
  for (const k of Object.keys(rest)) {
    errors.push(
      k === "decisions" || k === "decisionLabel"
        ? `${where}: ${k}: a decision ${LATER}`
        : `${where}: unknown key ${JSON.stringify(k)}`,
    );
  }
  const fieldKeys = [];
  if (!Array.isArray(sections) || sections.length === 0 || sections.length > MAX_SECTIONS) {
    errors.push(`${where}.sections: must be a list of 1..${MAX_SECTIONS}`);
  } else {
    sections.forEach((s, i) => {
      const at = `${where}.sections[${i}]`;
      const type = isPlainObject(s) ? s.type : undefined;
      if (type === "decision") return errors.push(`${at}: a decision ${LATER}`);
      if (typeof type !== "string" || !Object.hasOwn(SECTION_SHAPES, type)) {
        return errors.push(`${at}: unknown section type ${JSON.stringify(isPlainObject(s) ? s.type : s)}`);
      }
      const { type: _type, ...props } = s;
      checkObject(at, props, SECTION_SHAPES[type], errors);
      if (type !== "field" || !isKey(s.key)) return;
      checkNotReserved(at, s.key, errors);
      if (fieldKeys.includes(s.key)) errors.push(`${at}: field key ${JSON.stringify(s.key)} is declared twice`);
      fieldKeys.push(s.key);
    });
    if (fieldKeys.length === 0 && errors.length === 0) {
      errors.push(`${where}.sections: a card needs at least one field section`);
    }
  }
  if (carry !== undefined) {
    if (!Array.isArray(carry) || carry.length === 0 || carry.length > MAX_LIST || !carry.every(isKey)) {
      errors.push(`${where}.carry: must be a list of 1..${MAX_LIST} keys`);
    } else {
      for (const k of carry) {
        checkNotReserved(`${where}.carry`, k, errors);
        // A carried key comes from the stored run value, a field key from the
        // person: one key cannot be both.
        if (fieldKeys.includes(k)) {
          errors.push(`${where}.carry: ${JSON.stringify(k)} is also a field key; a carried key comes from the run value only`);
        }
      }
    }
  }
  return errors.length > 0 ? { errors } : { screen, errors };
}
