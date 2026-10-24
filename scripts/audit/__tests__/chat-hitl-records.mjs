// THE CHAT-HITL STRUCTURED RECORDS, read as data (cinatra#4308).
//
// A pin move is claimed twice: once in prose (the notes) and once in two
// records the tests compare EXACTLY:
//
//   - `reRatification` in scripts/audit/chat-hitl-anchor-contract.json: the
//     move the manifest declares (previous revision, revision, day, the
//     anchors left unresolved) plus the one claim no manifest can derive,
//     `anchorsReExamined: true`.
//   - `versionHistory` in scripts/audit/chat-hitl-acceptance-manifest.json:
//     one `{version, date}` entry per manifest version, compared with the
//     frozen literal below, so every change of it shows in a diff.
//
// The prose stays narrative; nothing here reads it. JSON.parse keeps the last
// of two equal member names, so the raw texts are also scanned for duplicate
// members before any parsed comparison is trusted.
//
// This is a test helper, not a test file: deterministic, no randomness, no I/O.
// The next pin adoption appends one entry to each literal in the same PR.

import { canonicalJson } from "../lib/anchor-contract.mjs";
import { parseSpecCommit } from "../../ci/lib/design-pin.mjs";

const HEX40 = /^[0-9a-f]{40}$/;
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

export const RECORD_KEYS = Object.freeze([
  "previousRevision",
  "revision",
  "movedOn",
  "unresolvedAnchors",
  "anchorsReExamined",
]);

function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

/** The manifest versions and the day each was written, oldest first. */
export const EXPECTED_VERSION_HISTORY = deepFreeze([
  { version: 2, date: "2026-08-13" },
  { version: 3, date: "2026-08-15" },
  { version: 4, date: "2026-08-22" },
  { version: 5, date: "2026-08-25" },
  { version: 6, date: "2026-08-26" },
  { version: 7, date: "2026-08-27" },
  { version: 8, date: "2026-09-01" },
  { version: 9, date: "2026-09-18" },
  { version: 10, date: "2026-09-29" },
  { version: 11, date: "2026-10-02" },
  { version: 12, date: "2026-10-06" },
  { version: 13, date: "2026-10-07" },
  { version: 14, date: "2026-10-15" },
  { version: 15, date: "2026-10-21" },
]);

/** Each pin adoption and the manifest version it owns, oldest first. */
export const PIN_ADOPTIONS = deepFreeze([
  { revision: "8a5d5013fdcb92af5508d61e997cd43564000de3", version: 14 },
  { revision: "bc0c04e4ee4cea4ae177355ee438896ca8ce9e0f", version: 15 },
]);

export const ADOPTION_VARIANT_NAMES = Object.freeze([
  "partialPRB",
  "versionLeftAtPreviousAdoption",
  "lastLedgerVersionReused",
  "ledgerVersionsSwapped",
  "lastLedgerEntryDropped",
  "ledgerRevisionNotThePin",
  "movedOnShiftedTogether",
]);

// Two sentences that deny the move while quoting its shape; the variants carry them.
const DENYING_NOTE =
  "It then moved on to revision 0000000000000000000000000000000000000000. No anchors were RE-EXAMINED against the drawings.";
const DENYING_SENTENCE =
  "There is no record, e.g. VERSION 16 (2026-10-21, example): because no entry was written.";
const PRB_REVISION = "46b2d8bc642cfcebc20477872fb47132e1bcd795";
const PRB_PATHS = "specs/app-lifecycle-cards.html specs/app-artifact-review.html";

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function show(value) {
  return value === undefined ? "undefined" : JSON.stringify(value);
}

/** The string itself when it is a real calendar day as YYYY-MM-DD, else null. */
export function isoDay(value) {
  if (typeof value !== "string") return null;
  const match = ISO_DAY.exec(value);
  if (!match) return null;
  const date = new Date(0);
  date.setUTCFullYear(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return date.toISOString().slice(0, 10) === value ? value : null;
}

function shiftDay(day, days) {
  if (isoDay(day) === null) throw new Error(`shiftDay: ${show(day)} is not a real day`);
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** The record the manifest and the contract imply; throws when it is not derivable. */
export function expectedReRatification(manifest, contract) {
  const drift = manifest?.specCommitDrift;
  if (!isPlainObject(drift)) throw new Error("expectedReRatification: the manifest has no specCommitDrift object");
  const previousRevision = parseSpecCommit(drift.previousPin).revision;
  const revision = parseSpecCommit(manifest.specCommit).revision;
  const movedOn = isoDay(drift.movedOn);
  if (movedOn === null) throw new Error(`expectedReRatification: specCommitDrift.movedOn ${show(drift.movedOn)} is not a real day`);
  const anchors = contract?.anchorsUnresolvedAtPin;
  if (!Array.isArray(anchors) || !anchors.every((a) => typeof a === "string")) {
    throw new Error("expectedReRatification: the contract's anchorsUnresolvedAtPin is not a list of selectors");
  }
  return { previousRevision, revision, movedOn, unresolvedAnchors: [...anchors], anchorsReExamined: true };
}

/** Every way `record` is not exactly `expected`; [] only for an exact match. */
export function reRatificationProblems(record, expected) {
  if (!isPlainObject(record)) return [`reRatification: not an object but ${show(record)}`];
  if (!isPlainObject(expected)) return ["reRatification: no expected record to compare with"];
  const problems = [];
  for (const key of Object.keys(record)) {
    if (!RECORD_KEYS.includes(key)) problems.push(`reRatification.${key}: unknown key`);
  }
  for (const key of RECORD_KEYS) {
    if (!Object.hasOwn(record, key)) {
      problems.push(`reRatification.${key}: missing`);
      continue;
    }
    const value = record[key];
    if (canonicalJson(value) !== canonicalJson(expected[key])) {
      problems.push(`reRatification.${key}: ${show(value)} is not ${show(expected[key])}`);
    }
    if ((key === "previousRevision" || key === "revision") && !(typeof value === "string" && HEX40.test(value))) {
      problems.push(`reRatification.${key}: not a lowercase forty-character revision`);
    }
    if (key === "movedOn" && isoDay(value) !== value) problems.push(`reRatification.${key}: not a real day`);
    if (key === "anchorsReExamined" && value !== true) problems.push(`reRatification.${key}: not the boolean true`);
    if (key === "unresolvedAnchors") {
      const list = Array.isArray(value) && value.every((a) => typeof a === "string" && a !== "");
      if (!list || new Set(value).size !== value.length) {
        problems.push(`reRatification.${key}: not a list of distinct selectors`);
      }
    }
  }
  if (record.previousRevision === record.revision) problems.push("reRatification.revision: the same as previousRevision");
  if (problems.length === 0 && canonicalJson(record) !== canonicalJson(expected)) {
    problems.push("reRatification: differs from the expected record");
  }
  return problems;
}

function historyShapeProblems(label, history) {
  if (!Array.isArray(history)) return [`${label}: not an array but ${show(history)}`];
  if (history.length === 0) return [`${label}: empty`];
  const problems = [];
  history.forEach((entry, i) => {
    if (!isPlainObject(entry)) {
      problems.push(`${label}[${i}]: not an object but ${show(entry)}`);
      return;
    }
    const keys = Object.keys(entry).sort().join(",");
    if (keys !== "date,version") problems.push(`${label}[${i}]: keys {${keys}} are not {date, version}`);
    if (!Number.isInteger(entry.version)) problems.push(`${label}[${i}].version: ${show(entry.version)} is not an integer`);
    else if (entry.version !== i + 2) problems.push(`${label}[${i}].version: ${entry.version} is not ${i + 2}`);
    if (isoDay(entry.date) !== entry.date) problems.push(`${label}[${i}].date: ${show(entry.date)} is not a real day`);
    else if (i > 0 && isPlainObject(history[i - 1]) && isoDay(history[i - 1].date) !== null && history[i - 1].date > entry.date) {
      problems.push(`${label}[${i}].date: ${entry.date} is before the entry above`);
    }
  });
  return problems;
}

/** Every way the manifest's history is not exactly the literal; [] only for an exact match. */
export function versionHistoryProblems({ version, versionHistory }, literal = EXPECTED_VERSION_HISTORY) {
  const problems = [
    ...historyShapeProblems("versionHistory", versionHistory),
    ...historyShapeProblems("EXPECTED_VERSION_HISTORY", literal),
  ];
  if (versionHistory === undefined || canonicalJson(versionHistory) !== canonicalJson(literal)) {
    problems.push("versionHistory: differs from EXPECTED_VERSION_HISTORY");
  }
  const last = Array.isArray(literal) && literal.length > 0 ? literal[literal.length - 1]?.version : undefined;
  if (!Number.isInteger(version) || version !== last) {
    problems.push(`version: ${show(version)} is not the recorded history's last version ${show(last)}`);
  }
  return problems;
}

/** L1-L4: a pin adoption owns a new version, dated the move. */
export function pinAdoptionProblems(manifest, contract, ledger = PIN_ADOPTIONS) {
  if (!Array.isArray(ledger) || ledger.length < 2) return ["PIN_ADOPTIONS: needs at least two adoptions"];
  const problems = [];
  ledger.forEach((entry, i) => {
    if (!isPlainObject(entry) || Object.keys(entry).sort().join(",") !== "revision,version") {
      problems.push(`L1: PIN_ADOPTIONS[${i}] is not {revision, version}`);
      return;
    }
    if (!(typeof entry.revision === "string" && HEX40.test(entry.revision))) problems.push(`L1: PIN_ADOPTIONS[${i}].revision is not a revision`);
    if (!Number.isInteger(entry.version)) problems.push(`L1: PIN_ADOPTIONS[${i}].version is not an integer`);
    else if (i > 0 && !(entry.version > ledger[i - 1]?.version)) problems.push(`L1: PIN_ADOPTIONS[${i}].version does not increase`);
  });
  if (new Set(ledger.map((e) => e?.revision)).size !== ledger.length) problems.push("L1: PIN_ADOPTIONS repeats a revision");
  const last = ledger[ledger.length - 1];
  const before = ledger[ledger.length - 2];
  let pin = null;
  try {
    pin = parseSpecCommit(manifest?.specCommit).revision;
  } catch (error) {
    problems.push(`L2: the manifest pin does not parse: ${error.message}`);
  }
  if (last?.revision !== pin) problems.push(`L2: the last adoption ${show(last?.revision)} is not the manifest pin ${show(pin)}`);
  const record = contract?.reRatification;
  if (!isPlainObject(record)) problems.push("L2: the contract has no reRatification record");
  else if (before?.revision !== record.previousRevision) {
    problems.push(`L2: the adoption before the last ${show(before?.revision)} is not reRatification.previousRevision`);
  }
  if (!Number.isInteger(manifest?.version)) problems.push(`L3: manifest version ${show(manifest?.version)} is not an integer`);
  if (!(last?.version > before?.version)) problems.push("L3: the last adoption does not own a new version");
  if (!(last?.version <= manifest?.version)) problems.push(`L3: the last adoption's version ${show(last?.version)} is above the manifest version ${show(manifest?.version)}`);
  const history = Array.isArray(manifest?.versionHistory) ? manifest.versionHistory : [];
  const entries = history.filter((h) => isPlainObject(h) && h.version === last?.version);
  if (entries.length !== 1) {
    problems.push(`L4: versionHistory has ${entries.length} entries for version ${show(last?.version)}, not one`);
  } else {
    const day = entries[0].date;
    if (isoDay(day) !== day) problems.push(`L4: the entry for version ${last.version} is not dated a real day`);
    if (day !== record?.movedOn) problems.push(`L4: the entry for version ${last.version} is not dated reRatification.movedOn`);
    if (day !== manifest?.specCommitDrift?.movedOn) problems.push(`L4: the entry for version ${last.version} is not dated specCommitDrift.movedOn`);
  }
  return problems;
}

/**
 * Member names that occur twice in one object of a JSON text. The text must
 * parse (else this throws); string values are skipped whole; a name token is
 * decoded, so an escaped spelling of a name is the same name.
 */
export function duplicateMemberNames(text) {
  if (typeof text !== "string") throw new TypeError("duplicateMemberNames: the text is not a string");
  JSON.parse(text);
  const found = [];
  const stack = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      const top = stack[stack.length - 1];
      if (top && top.names && top.expectName) {
        const name = JSON.parse(text.slice(i, j + 1));
        if (top.names.has(name)) found.push({ offset: i, name });
        top.names.add(name);
        top.expectName = false;
      }
      i = j + 1;
      continue;
    }
    if (ch === "{") stack.push({ names: new Set(), expectName: true });
    else if (ch === "[") stack.push({ names: null, expectName: false });
    else if (ch === "}" || ch === "]") stack.pop();
    else if (ch === ",") {
      const top = stack[stack.length - 1];
      if (top && top.names) top.expectName = true;
    }
    i += 1;
  }
  return found;
}

/** Every malformed or unreal day the records must refuse. */
export function impossibleDays() {
  const days = [];
  const pad = (n) => String(n).padStart(2, "0");
  for (const year of [2026, 2028]) {
    for (let month = 0; month <= 13; month += 1) {
      for (let day = 0; day <= 32; day += 1) {
        const text = `${year}-${pad(month)}-${pad(day)}`;
        if (isoDay(text) === null) days.push(text);
      }
    }
  }
  days.push("2026-1-02", "26-10-21", "2026/10/21", "2026-10-21T00:00:00Z", " 2026-10-21", "2026-10-21 ", "", "2026-99-99");
  return days;
}

function collect(original) {
  const out = [];
  const names = new Set();
  const add = (name, value) => {
    if (names.has(name)) throw new Error(`variant name ${name} is not unique`);
    if (value !== undefined && original !== undefined && canonicalJson(value) === canonicalJson(original)) {
      throw new Error(`variant ${name} equals the original`);
    }
    names.add(name);
    out.push({ name, value });
  };
  return { out, add };
}

/** N1: every near-miss of the re-ratification record. */
export function reRatificationVariants(expected) {
  const { out, add } = collect(expected);
  const withKey = (key, value) => ({ ...clone(expected), [key]: value });
  add("extra:nextRevision", withKey("nextRevision", "0".repeat(40)));
  add("extra:revisions", withKey("revisions", [expected.previousRevision, expected.revision]));
  add("extra:thenRevision", withKey("thenRevision", "0".repeat(40)));
  add("extra:note", withKey("note", DENYING_NOTE));
  add("extra:movedAgainOn", withKey("movedAgainOn", expected.movedOn));
  for (const key of ["previousRevision", "revision"]) {
    const rev = expected[key];
    for (let p = 0; p < rev.length; p += 1) {
      const changed = rev[p] === "0" ? "1" : "0";
      add(`${key}:position${p}`, withKey(key, rev.slice(0, p) + changed + rev.slice(p + 1)));
    }
    add(`${key}:zeros`, withKey(key, "0".repeat(40)));
    for (const n of [7, 8, 12]) add(`${key}:abbrev${n}`, withKey(key, rev.slice(0, n)));
    add(`${key}:upper`, withKey(key, rev.toUpperCase()));
    add(`${key}:prefixed`, withKey(key, `design@${rev}`));
    add(`${key}:leadingBlank`, withKey(key, ` ${rev}`));
    add(`${key}:trailingBlank`, withKey(key, `${rev} `));
    add(`${key}:leadingNewline`, withKey(key, `\n${rev}`));
    add(`${key}:trailingNewline`, withKey(key, `${rev}\n`));
    add(`${key}:length39`, withKey(key, rev.slice(0, 39)));
    add(`${key}:length41`, withKey(key, `${rev}0`));
  }
  add("revisions:swapped", { ...clone(expected), previousRevision: expected.revision, revision: expected.previousRevision });
  for (const day of impossibleDays()) add(`movedOn:${JSON.stringify(day)}`, withKey("movedOn", day));
  add("movedOn:dayBefore", withKey("movedOn", shiftDay(expected.movedOn, -1)));
  add("movedOn:dayAfter", withKey("movedOn", shiftDay(expected.movedOn, 1)));
  const alphabet = [null, false, true, 0, 1, "", "true", [], {}];
  for (const key of RECORD_KEYS) {
    for (const value of alphabet) {
      if (canonicalJson(value) === canonicalJson(expected[key])) continue;
      add(`${key}=${JSON.stringify(value)}`, withKey(key, clone(value)));
    }
    const deleted = clone(expected);
    delete deleted[key];
    add(`${key}:deleted`, deleted);
  }
  const anchors = expected.unresolvedAnchors;
  anchors.forEach((_, i) => {
    add(`anchors:drop${i}`, withKey("unresolvedAnchors", anchors.filter((__, j) => j !== i)));
    add(`anchors:duplicate${i}`, withKey("unresolvedAnchors", [...anchors.slice(0, i + 1), anchors[i], ...anchors.slice(i + 1)]));
    add(`anchors:nonString${i}`, withKey("unresolvedAnchors", anchors.map((a, j) => (j === i ? 1 : a))));
  });
  for (let i = 0; i <= anchors.length; i += 1) {
    add(`anchors:extra${i}`, withKey("unresolvedAnchors", [...anchors.slice(0, i), `[data-x-${i}]`, ...anchors.slice(i)]));
  }
  add("anchors:reversed", withKey("unresolvedAnchors", [...anchors].reverse()));
  add("anchors:empty", withKey("unresolvedAnchors", []));
  add("record:null", null);
  add("record:array", [clone(expected)]);
  add("record:denyingSentence", DENYING_NOTE);
  return out.map(({ name, value }) => ({ name, record: value }));
}

/** N2: every near-miss of the version history, judged with the literal. */
export function versionHistoryVariants(history) {
  const version = history[history.length - 1].version;
  const original = { version, versionHistory: history };
  const { out, add } = collect(original);
  const put = (name, versionHistory, v = version) => add(name, { version: v, versionHistory });
  const at = (i, entry) => history.map((e, j) => (j === i ? entry : clone(e)));
  const shapes = (day) => {
    const [y, m, d] = day.split("-");
    return {
      compact: `${y}${m}${d}`,
      dayFirst: `${d}-${m}-${y}`,
      twoDigitYear: `${y.slice(2)}-${m}-${d}`,
      slashes: `${y}/${m}/${d}`,
      timestamp: `${day}T00:00:00Z`,
      leadingBlank: ` ${day}`,
      trailingBlank: `${day} `,
      empty: "",
    };
  };
  history.forEach((entry, i) => {
    put(`[${i}]:deleted`, history.filter((_, j) => j !== i));
    put(`[${i}]:duplicated`, [...history.slice(0, i + 1), entry, ...history.slice(i + 1)]);
    if (i < history.length - 1) put(`[${i}]:swappedWithNext`, history.map((e, j) => (j === i ? history[i + 1] : j === i + 1 ? entry : e)));
    put(`[${i}].version+1`, at(i, { ...entry, version: entry.version + 1 }));
    put(`[${i}].version-1`, at(i, { ...entry, version: entry.version - 1 }));
    put(`[${i}].version:string`, at(i, { ...entry, version: String(entry.version) }));
    put(`[${i}].version:zeroPadded`, at(i, { ...entry, version: `0${entry.version}` }));
    put(`[${i}].version:half`, at(i, { ...entry, version: entry.version + 0.5 }));
    put(`[${i}].date+1`, at(i, { ...entry, date: shiftDay(entry.date, 1) }));
    put(`[${i}].date-1`, at(i, { ...entry, date: shiftDay(entry.date, -1) }));
    for (const [shape, day] of Object.entries(shapes(entry.date))) put(`[${i}].date:${shape}`, at(i, { ...entry, date: day }));
    if (i > 0) put(`[${i}].date:beforeTheEntryAbove`, at(i, { ...entry, date: shiftDay(history[i - 1].date, -1) }));
    for (const key of ["label", "note", "body"]) put(`[${i}]:extra${key}`, at(i, { ...entry, [key]: DENYING_SENTENCE }));
    put(`[${i}]:noVersion`, at(i, { date: entry.date }));
    put(`[${i}]:noDate`, at(i, { version: entry.version }));
    put(`[${i}]:null`, at(i, null));
    put(`[${i}]:sentence`, at(i, DENYING_SENTENCE));
    put(`[${i}]:array`, at(i, [clone(entry)]));
  });
  for (const i of [0, history.length - 1]) {
    for (const day of impossibleDays()) put(`[${i}].date=${JSON.stringify(day)}`, at(i, { ...history[i], date: day }));
  }
  put("whole:lastDropped", history.slice(0, -1));
  put("whole:nextAppended", [...history, { version: version + 1, date: history[history.length - 1].date }]);
  put("whole:sentence", DENYING_SENTENCE);
  add("whole:undefined", { version, versionHistory: undefined });
  put("whole:versionBelow", history, version - 1);
  put("whole:versionAbove", history, version + 1);
  return out.map(({ name, value }) => ({ name, input: value }));
}

/** N3: the adoption near-misses, each a {manifest, contract, ledger} triple. */
export function adoptionVariants(manifest, contract, ledger = PIN_ADOPTIONS) {
  const original = { manifest, contract, ledger };
  const { out, add } = collect(original);
  const base = () => ({ manifest: clone(manifest), contract: clone(contract), ledger: clone(ledger) });
  const last = ledger.length - 1;
  {
    const v = base();
    const pin = parseSpecCommit(manifest.specCommit).revision;
    v.manifest.specCommit = `design@${PRB_REVISION} ${PRB_PATHS}`;
    v.manifest.specCommitDrift.previousPin = `design@${pin} ${PRB_PATHS}`;
    v.contract.specCommit = v.manifest.specCommit;
    v.contract.reRatification = { ...v.contract.reRatification, previousRevision: pin, revision: PRB_REVISION };
    v.ledger.push({ revision: PRB_REVISION, version: ledger[last].version + 1 });
    add("partialPRB", v);
  }
  {
    const v = base();
    v.manifest.version = ledger[last - 1].version;
    add("versionLeftAtPreviousAdoption", v);
  }
  {
    const v = base();
    v.ledger[last].version = ledger[last - 1].version;
    add("lastLedgerVersionReused", v);
  }
  {
    const v = base();
    v.ledger[last].version = ledger[last - 1].version;
    v.ledger[last - 1].version = ledger[last].version;
    add("ledgerVersionsSwapped", v);
  }
  {
    const v = base();
    v.ledger.pop();
    add("lastLedgerEntryDropped", v);
  }
  {
    const v = base();
    const rev = ledger[last].revision;
    v.ledger[last].revision = rev.slice(0, -1) + (rev.endsWith("0") ? "1" : "0");
    add("ledgerRevisionNotThePin", v);
  }
  {
    const v = base();
    const day = shiftDay(manifest.specCommitDrift.movedOn, 1);
    v.manifest.specCommitDrift.movedOn = day;
    v.contract.reRatification.movedOn = day;
    add("movedOnShiftedTogether", v);
  }
  const names = out.map((o) => o.name);
  if (canonicalJson(names) !== canonicalJson(ADOPTION_VARIANT_NAMES)) throw new Error("adoptionVariants: names drifted from ADOPTION_VARIANT_NAMES");
  return out.map(({ name, value }) => ({ name, ...value }));
}

function oneLine(lines, pattern, what) {
  const hits = lines.flatMap((line, i) => (pattern.test(line) ? [i] : []));
  if (hits.length !== 1) throw new Error(`duplicateVariants: ${hits.length} lines hold ${what}, not one`);
  return hits[0];
}

function escapedName(name) {
  return `\\u00${name.charCodeAt(0).toString(16)}${name.slice(1)}`;
}

/** N4: raw texts that still parse but carry a duplicate member. */
export function duplicateVariants({ contractText, manifestText }) {
  const out = [];
  const names = new Set();
  const add = (name, file, text) => {
    if (names.has(name)) throw new Error(`variant name ${name} is not unique`);
    const original = file === "contract" ? contractText : manifestText;
    if (text === original) throw new Error(`variant ${name} equals the original`);
    JSON.parse(text);
    names.add(name);
    out.push({ name, file, text });
  };
  const c = contractText.split("\n");
  const m = manifestText.split("\n");
  const join = (lines) => lines.join("\n");
  const insertBefore = (lines, i, extra) => join([...lines.slice(0, i), ...extra, ...lines.slice(i)]);

  const recordWrong = {
    previousRevision: JSON.stringify("0".repeat(40)),
    revision: JSON.stringify("0".repeat(40)),
    movedOn: JSON.stringify("2026-99-99"),
    unresolvedAnchors: "[]",
    anchorsReExamined: "false",
  };
  const movedOnLine = oneLine(c, /^ {2}"movedOn": /, "the record's movedOn");
  const examinedLine = oneLine(c, /^ {2}"anchorsReExamined": /, "the record's anchorsReExamined");
  add(
    "review:contractInput",
    "contract",
    join(
      c.flatMap((line, i) => {
        if (i === movedOnLine) return ['  "movedOn": "2026-99-99",', line];
        if (i === examinedLine) return ['  "anchorsReExamined": false,', line];
        return [line];
      }),
    ),
  );
  const historyLines = m.flatMap((line, i) => (/^ {2}\{"version": \d+, "date": "\d{4}-\d{2}-\d{2}"\},?$/.test(line) ? [i] : []));
  if (historyLines.length === 0) throw new Error("duplicateVariants: no versionHistory entry line");
  const lastEntry = historyLines[historyLines.length - 1];
  const entryMatch = /^ {2}\{"version": (\d+), "date": "(\d{4}-\d{2}-\d{2})"\}(,?)$/.exec(m[lastEntry]);
  const [, lastVersion, lastDate, trailer] = entryMatch;
  const withEntry = (text) => join(m.map((line, i) => (i === lastEntry ? `  ${text}${trailer}` : line)));
  add("review:manifestInput", "manifest", withEntry(`{"version":"0${lastVersion}","version":${lastVersion},"date":"${lastDate}"}`));

  for (const key of RECORD_KEYS) {
    const at = oneLine(c, new RegExp(`^ {2}"${key}": `), `the record's ${key}`);
    const line = c[at];
    const comma = line.endsWith(",");
    const bare = comma ? line.slice(0, -1) : line;
    for (const [spelling, label] of [[key, "plain"], [escapedName(key), "escaped"]]) {
      const twin = `  "${spelling}": ${recordWrong[key]}`;
      add(`record.${key}:${label}Before`, "contract", insertBefore(c, at, [`${twin},`]));
      add(
        `record.${key}:${label}After`,
        "contract",
        join([...c.slice(0, at), `${bare},`, `${twin}${comma ? "," : ""}`, ...c.slice(at + 1)]),
      );
    }
  }
  const entryWrong = { version: `"0${lastVersion}"`, date: '"2026-99-99"' };
  for (const key of ["version", "date"]) {
    for (const [spelling, label] of [[key, "plain"], [escapedName(key), "escaped"]]) {
      const twin = `"${spelling}": ${entryWrong[key]}`;
      const before =
        key === "version"
          ? `{${twin}, "version": ${lastVersion}, "date": "${lastDate}"}`
          : `{"version": ${lastVersion}, ${twin}, "date": "${lastDate}"}`;
      const after =
        key === "version"
          ? `{"version": ${lastVersion}, ${twin}, "date": "${lastDate}"}`
          : `{"version": ${lastVersion}, "date": "${lastDate}", ${twin}}`;
      add(`history.${key}:${label}Before`, "manifest", withEntry(before));
      add(`history.${key}:${label}After`, "manifest", withEntry(after));
    }
  }
  const recordStart = oneLine(c, /^ "reRatification": \{$/, "the reRatification record");
  const recordEnd = c.findIndex((line, i) => i > recordStart && /^ \},?$/.test(line));
  const stale = c
    .slice(recordStart, recordEnd + 1)
    .map((line) => (/^ {2}"revision": /.test(line) ? `  "revision": "${"0".repeat(40)}",` : line));
  stale[stale.length - 1] = " },";
  add("stale:reRatificationBlock", "contract", insertBefore(c, recordStart, stale));
  const historyStart = oneLine(m, /^ "versionHistory": \[$/, "the versionHistory array");
  add("duplicate:versionHistory", "manifest", insertBefore(m, historyStart, [' "versionHistory": [],']));
  const versionLine = oneLine(m, /^ "version": \d+,$/, "the top-level version");
  add("duplicate:version", "manifest", insertBefore(m, versionLine, [` "version": ${Number(lastVersion) - 1},`]));
  return out;
}
