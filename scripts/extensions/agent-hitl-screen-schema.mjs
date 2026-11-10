// The declared HITL screen of an agent binding (cinatra#3470).
//
// An agent package DECLARES the screen a mid-run gate shows, as data in
// `cinatra.fieldRenderers[].screen`; the host draws it with its own components
// (packages/agents/src/declared-hitl-screen-renderer.tsx). This module is the
// allow-list every declaration passes: at generation (fail-closed), in the
// runtime collector (skip-warn) and again at registration in the browser.
// Every unknown layout, section type or key is refused by name.
//
// Two layouts:
//   - "card": { layout, title, sections?, decisions?, carry?, requires? }
//     sections: note {text} | fact {label, key, qualifierKey?} |
//               words {key, label?} | quote {key} |
//               field {key, label, multiline?, placeholder?}
//     decisions: at most 3 of { label, answer } - `answer` is the exact object
//     the choice stages for the host's one Continue. A card offers decisions
//     or fields, never both.
//     carry: run-value keys copied into every staged answer.
//     requires: keys that must hold non-blank text before the host's
//     Continue can send; a choice also waits for them. Every field is a
//     required value, and a card with decisions holds the Continue until
//     one of them is chosen.
//   - "kind": { layout } - the host's own component for the binding's kind.
//
// Dependency-free and fs-free on purpose (build scripts, the runtime
// collector and browser code all import it).

export const HITL_SCREEN_KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
export const MAX_HITL_SCREEN_BYTES = 8192;
const MAX_TEXT = 600;
const MAX_LIST = 8;
const MAX_SECTIONS = 16;
const MAX_DECISIONS = 3;

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

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

const MAX_DEPTH = 8;

/**
 * Why the RAW input is not plain JSON, or null when it is. Read before any
 * JSON round trip, because a round trip hides exactly what this refuses: an
 * `undefined` value drops its key, a `toJSON` method replaces the object, and
 * a class instance or an accessor reads as an ordinary object. Allowed: null,
 * booleans, finite numbers, strings, dense arrays and objects whose prototype
 * is Object.prototype or null, each property an own enumerable data property
 * with a string key.
 */
function plainJsonProblem(v, at, ancestors, depth) {
  if (v === null || typeof v === "boolean" || typeof v === "string") return null;
  if (typeof v === "number") return Number.isFinite(v) ? null : `${at} is not a finite number`;
  if (typeof v !== "object") return `${at} is ${typeof v === "undefined" ? "undefined" : `a ${typeof v}`}`;
  if (ancestors.has(v)) return `${at} refers back to itself`;
  if (depth > MAX_DEPTH) return `${at} is nested deeper than ${MAX_DEPTH}`;
  const isArray = Array.isArray(v);
  const proto = Object.getPrototypeOf(v);
  if (isArray ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) {
    return `${at} is not a plain ${isArray ? "list" : "object"}`;
  }
  const keys = Reflect.ownKeys(v);
  if (keys.some((k) => typeof k === "symbol")) return `${at} has a symbol key`;
  if (isArray) {
    for (let i = 0; i < v.length; i += 1) {
      if (!Object.hasOwn(v, i)) return `${at}[${i}] is a hole`;
    }
    if (keys.length !== v.length + 1) return `${at} has a key that is not an index`;
  }
  ancestors.add(v);
  try {
    for (const k of keys) {
      if (isArray && k === "length") continue;
      const where = isArray ? `${at}[${k}]` : `${at}.${k}`;
      if (k === "toJSON") return `${where} is a toJSON key`;
      const d = Object.getOwnPropertyDescriptor(v, k);
      if (!d || !Object.hasOwn(d, "value")) return `${where} is an accessor`;
      if (!d.enumerable) return `${where} is not enumerable`;
      const inner = plainJsonProblem(d.value, where, ancestors, depth + 1);
      if (inner) return inner;
    }
  } finally {
    ancestors.delete(v);
  }
  return null;
}

function isText(v) {
  return typeof v === "string" && v.trim().length > 0 && v.length <= MAX_TEXT;
}

function isKey(v) {
  return typeof v === "string" && HITL_SCREEN_KEY_RE.test(v);
}

function checkProp(type, v) {
  if (type === "text") return isText(v);
  if (type === "key") return isKey(v);
  return typeof v === "boolean";
}

const TYPE_WORDS = {
  text: `non-blank text of at most ${MAX_TEXT} characters`,
  key: "a key",
  bool: "a boolean",
};

function checkObject(where, obj, shape, errors) {
  for (const k of Object.keys(obj)) {
    if (!Object.hasOwn(shape, k)) errors.push(`${where}: unknown key ${JSON.stringify(k)}`);
  }
  for (const [k, [type, required]] of Object.entries(shape)) {
    if (!Object.hasOwn(obj, k)) {
      if (required) errors.push(`${where}: ${k} is required`);
      continue;
    }
    if (!checkProp(type, obj[k])) errors.push(`${where}: ${k} must be ${TYPE_WORDS[type]}`);
  }
}

function checkKeyList(where, list, errors) {
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_LIST || !list.every(isKey)) {
    errors.push(`${where}: must be a list of 1..${MAX_LIST} keys`);
  }
}

function checkAnswer(where, answer, errors) {
  if (!isPlainObject(answer)) return errors.push(`${where}: must be an object`);
  const entries = Object.entries(answer);
  if (entries.length === 0 || entries.length > MAX_LIST) {
    return errors.push(`${where}: must carry 1..${MAX_LIST} keys`);
  }
  for (const [k, v] of entries) {
    const ok =
      isKey(k) &&
      (typeof v === "boolean" ||
        (typeof v === "number" && Number.isFinite(v)) ||
        (typeof v === "string" && v.length <= MAX_TEXT));
    if (!ok) errors.push(`${where}: key ${JSON.stringify(k)} must be a key with text, a number or a boolean`);
  }
}

/**
 * Validate one declared screen. Returns `{ screen, errors }`; `screen` is a
 * plain-JSON copy, present only when `errors` is empty.
 */
export function validateHitlScreen(raw, where = "screen") {
  const errors = [];
  if (!isPlainObject(raw)) return { errors: [`${where}: must be an object`] };
  // Fail closed on the raw input first (see plainJsonProblem).
  const problem = plainJsonProblem(raw, where, new Set(), 0);
  if (problem) return { errors: [`${where}: must be plain JSON (${problem})`] };
  let serialized;
  try {
    serialized = JSON.stringify(raw);
  } catch {
    return { errors: [`${where}: must be plain JSON`] };
  }
  if (serialized === undefined) return { errors: [`${where}: must be an object`] };
  if (new TextEncoder().encode(serialized).length > MAX_HITL_SCREEN_BYTES) {
    return { errors: [`${where}: must serialize to <= ${MAX_HITL_SCREEN_BYTES} bytes`] };
  }
  const screen = JSON.parse(serialized);
  if (screen.layout === "kind") {
    const { layout: _layout, ...rest } = screen;
    checkObject(where, rest, {}, errors);
  } else if (screen.layout === "card") {
    const { layout: _layout, sections, decisions, carry, requires, ...rest } = screen;
    checkObject(where, rest, { title: ["text", true] }, errors);
    const sectionList = sections === undefined ? [] : sections;
    if (!Array.isArray(sectionList) || sectionList.length > MAX_SECTIONS) {
      errors.push(`${where}.sections: must be a list of at most ${MAX_SECTIONS}`);
    } else {
      sectionList.forEach((s, i) => {
        const at = `${where}.sections[${i}]`;
        if (!isPlainObject(s) || typeof s.type !== "string" || !Object.hasOwn(SECTION_SHAPES, s.type)) {
          errors.push(`${at}: unknown section type ${JSON.stringify(isPlainObject(s) ? s.type : s)}`);
          return;
        }
        const { type: _type, ...props } = s;
        checkObject(at, props, SECTION_SHAPES[s.type], errors);
      });
    }
    if (decisions !== undefined) {
      if (!Array.isArray(decisions) || decisions.length === 0 || decisions.length > MAX_DECISIONS) {
        errors.push(`${where}.decisions: must be a list of 1..${MAX_DECISIONS}`);
      } else {
        decisions.forEach((d, i) => {
          const at = `${where}.decisions[${i}]`;
          if (!isPlainObject(d)) return errors.push(`${at}: must be an object`);
          const { answer, ...rest } = d;
          checkObject(at, rest, { label: ["text", true] }, errors);
          checkAnswer(`${at}.answer`, answer, errors);
        });
      }
      if (Array.isArray(sectionList) && sectionList.some((s) => isPlainObject(s) && s.type === "field")) {
        errors.push(`${where}: a card offers decisions or fields, never both`);
      }
    }
    if (carry !== undefined) checkKeyList(`${where}.carry`, carry, errors);
    if (requires !== undefined) checkKeyList(`${where}.requires`, requires, errors);
  } else {
    errors.push(`${where}: unknown layout ${JSON.stringify(screen.layout)}`);
  }
  return errors.length > 0 ? { errors } : { screen, errors };
}
