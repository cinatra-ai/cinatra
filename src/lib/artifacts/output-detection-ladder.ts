// ---------------------------------------------------------------------------
// The detection ladder (Agents Lifecycle (C) item 0.18, section 8.6).
//
// ONE function with a RECORDED VERDICT, run in this order and stopping at the
// first confident rung:
//
//   1. the explicit statement — a binding's declared form, a tool call's
//      declared type;
//   2. the bytes' signature — the store's own sniffer, unchanged
//      (`./blob-mime-sniff`);
//   3. the structural probes for text — the parse probe, the xml and html
//      prologue, front matter, the csv shape, and markdown signals (headings,
//      lists, links, emphasis, fenced code);
//   4. the file's name and extension — a HINT that may only choose WITHIN the
//      text family the probes allow, and never over a signature;
//   5. for what the probes leave ambiguous — plain, markdown or csv — the
//      deployment's configured runtime, over at most the first 16 KB, one call
//      per ambiguous text output, a fixed question with a fixed set of answers
//      at zero temperature, cached by content hash, with a strict re-parse and
//      a confidence threshold; plain text when the runtime is unconfigured or
//      unsure, and a per-organisation switch that turns the rung off and yields
//      plain text.
//
// When no rung can name the form the verdict is the BINARY fallback, whose
// display is the download card.
//
// EVERY rung returns the form it names AND the reason, and the pickup records
// both on the ledger row (section 8.2). The module is PURE apart from the model
// rung, which reaches its runtime through an INJECTED seam — so the ladder's
// table test (acceptance 6) never calls a model.
// ---------------------------------------------------------------------------

// The store's own sniffer, from its existing home (see the note there).
import { sniffMime } from "./local-disk-blob-store";

/** The rung that decided the form. Recorded on the ledger row. */
export type DetectionRung =
  | "explicit"
  | "signature"
  | "structural"
  | "name_extension"
  | "model"
  | "binary_fallback";

/** Why the model rung did not settle the question. `off` and `unconfigured`
 *  and `unsure` all yield plain text — the difference is only readable. */
export type ModelRungSkip = "switched_off" | "unconfigured" | "unsure" | "failed";

/** The ladder's recorded verdict — the value the ledger row carries. */
export type DetectionVerdict = {
  /** The detected form (a canonical, parameter-free MIME). */
  form: string;
  /** The rung that decided it. */
  rung: DetectionRung;
  /** Why that rung decided it — free text, for the row and for an operator. */
  reason: string;
  /** The model rung's raw answer, when it ran. */
  modelAnswer?: string;
  /** The model rung's confidence, when it ran. */
  confidence?: number;
  /** Why the model rung did not settle it, when it was reached and did not. */
  modelSkipped?: ModelRungSkip;
};

/** At most the first sixteen kilobytes reach the model rung (item 0.18). */
export const MODEL_RUNG_MAX_BYTES = 16 * 1024;

/** The model rung's confidence threshold; below it the verdict is plain text. */
export const MODEL_RUNG_CONFIDENCE_THRESHOLD = 0.8;

/** The three forms the structural probes cannot tell apart — and the ONLY
 *  question the model rung is ever asked. */
export const AMBIGUOUS_TEXT_FORMS = ["text/plain", "text/markdown", "text/csv"] as const;
export type AmbiguousTextForm = (typeof AMBIGUOUS_TEXT_FORMS)[number];

/** The fixed question, verbatim. It is a constant so the cache key, the test
 *  fixture and the call all name the same string. */
export const MODEL_RUNG_QUESTION =
  "Which of these three forms is this text? Answer with exactly one of " +
  '"text/plain", "text/markdown" or "text/csv". Answer "text/markdown" only ' +
  "when the text actually uses markdown syntax, and \"text/csv\" only when every " +
  "line is a delimited record of the same shape. Otherwise answer \"text/plain\".";

/** The model rung's seam: the deployment's configured runtime, asked the fixed
 *  question at zero temperature. Returns the answer + confidence, or null when
 *  no runtime is configured. THROWS only on an infrastructure failure — the
 *  ladder catches it and yields plain text (a form decision must never fail a
 *  run). */
export type ModelRungAsk = (input: {
  /** The first `MODEL_RUNG_MAX_BYTES` of the text, and no more. */
  text: string;
  /** The fixed question. */
  question: string;
  /** The fixed set of answers. */
  answers: readonly AmbiguousTextForm[];
}) => Promise<{ answer: string; confidence: number } | null>;

export type DetectionDeps = {
  /** The model rung. Absent ⇒ the rung is not run and the verdict is plain
   *  text (`unconfigured`) — which is what the ladder's table test relies on. */
  ask?: ModelRungAsk;
  /** The per-organisation switch. `false` turns the model rung off and yields
   *  plain text. Absent ⇒ on. */
  modelRungEnabled?: boolean;
  /** Cache by content hash, for the run (item 0.18). The pickup passes ONE map
   *  per run so an ambiguous output repeated in a run costs one call. */
  cache?: Map<string, DetectionVerdict>;
};

export type DetectionInput = {
  /** The bytes to type. */
  bytes: Uint8Array;
  /** sha256 of the bytes — the model rung's cache key. */
  contentHash: string;
  /** An EXPLICIT statement of the form, when one exists (a binding's declared
   *  form, a tool call's declared type). Wins outright. */
  declaredForm?: string | null;
  /** A name to read an extension off, when one exists. A HINT ONLY. */
  name?: string | null;
};

// ---------------------------------------------------------------------------
// Rung 3 — the structural probes. Pure functions over the first bytes, each
// with a FIXED threshold (section 8.6).
// ---------------------------------------------------------------------------

/** How many distinct markdown signals a text must carry before the markdown
 *  probe is confident. Below it the text stays ambiguous and falls to the
 *  model rung — the whole reason the rung exists. */
export const MARKDOWN_SIGNAL_THRESHOLD = 2;

/** The parse probe: valid JSON whose root is an object or an array. A bare
 *  number/string/boolean is NOT structured data — `42` is a datum. */
export function probeJson(text: string): boolean {
  const t = text.trim();
  if (t.length === 0) return false;
  if (!(t.startsWith("{") || t.startsWith("["))) return false;
  try {
    const parsed: unknown = JSON.parse(t);
    return typeof parsed === "object" && parsed !== null;
  } catch {
    return false;
  }
}

/** The prologue test for xml and html. Reads only the leading bytes. */
export function probePrologue(text: string): "application/xml" | "text/html" | null {
  const head = text.slice(0, 512).replace(/^﻿/, "").trimStart();
  const lower = head.toLowerCase();
  if (lower.startsWith("<?xml")) return "application/xml";
  if (lower.startsWith("<!doctype html")) return "text/html";
  if (lower.startsWith("<html")) return "text/html";
  return null;
}

/** The front-matter test: a `---` fence on the first line closed by another
 *  `---` line. Front matter is a markdown convention, so a hit is markdown. */
export function probeFrontMatter(text: string): boolean {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return false;
  for (let i = 1; i < Math.min(lines.length, 200); i += 1) {
    if (lines[i]?.trim() === "---") return i > 1;
  }
  return false;
}

/**
 * The csv shape: delimiter consistency. At least two non-empty lines, at least
 * two fields per line, and EVERY line carrying the same field count under the
 * same delimiter. A markdown table is excluded on purpose — its rows start and
 * end with a pipe and it carries a `---|---` separator row.
 */
export function probeCsv(text: string): boolean {
  const lines = text
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .slice(0, 200);
  if (lines.length < 2) return false;
  // A markdown table is not a csv, however consistent its pipe count.
  if (lines.some((l) => /^\s*\|?\s*:?-{3,}\s*:?\s*(\|\s*:?-{3,}\s*:?\s*)+\|?\s*$/.test(l))) {
    return false;
  }
  for (const delimiter of [",", ";", "\t"]) {
    const counts = lines.map((l) => splitDelimited(l, delimiter).length);
    if (counts[0] < 2) continue;
    if (counts.every((c) => c === counts[0])) return true;
  }
  return false;
}

/** A delimiter split that honours double-quoted fields, so an embedded comma
 *  inside `"a,b"` does not fake an extra column. */
function splitDelimited(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        field += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (!quoted && ch === delimiter) {
      out.push(field);
      field = "";
      continue;
    }
    field += ch;
  }
  out.push(field);
  return out;
}

/** The markdown feature count: headings, lists, links, emphasis, fenced code.
 *  Returns the number of DISTINCT signals present. */
export function countMarkdownSignals(text: string): number {
  const sample = text.slice(0, 64 * 1024);
  const signals: Array<[string, RegExp]> = [
    ["heading", /^#{1,6}\s+\S/m],
    ["list", /^\s{0,3}([-*+]\s+\S|\d+\.\s+\S)/m],
    ["link", /\[[^\]\n]+\]\([^)\s]+\)/],
    ["emphasis", /(\*\*[^\s*][^*]*\*\*)|(__[^\s_][^_]*__)/],
    ["fence", /^\s{0,3}(```|~~~)/m],
    ["blockquote", /^\s{0,3}>\s+\S/m],
    ["table", /^\s*\|.*\|\s*$/m],
  ];
  let n = 0;
  for (const [, re] of signals) if (re.test(sample)) n += 1;
  return n;
}

/** The structural probes, in order. `null` ⇒ the text is left ambiguous. */
export function probeStructuralForm(
  text: string,
): { form: string; reason: string } | null {
  if (probeJson(text)) {
    return { form: "application/json", reason: "the parse probe read the text as a JSON document" };
  }
  const prologue = probePrologue(text);
  if (prologue) {
    return { form: prologue, reason: `the prologue names ${prologue}` };
  }
  if (probeFrontMatter(text)) {
    return { form: "text/markdown", reason: "the text opens with closed front matter" };
  }
  if (probeCsv(text)) {
    return { form: "text/csv", reason: "every line carries the same field count under one delimiter" };
  }
  const signals = countMarkdownSignals(text);
  if (signals >= MARKDOWN_SIGNAL_THRESHOLD) {
    return {
      form: "text/markdown",
      reason: `the text carries ${signals} distinct markdown signals (threshold ${MARKDOWN_SIGNAL_THRESHOLD})`,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rung 4 — the name and extension HINT.
// ---------------------------------------------------------------------------

/** The text family the hint may choose WITHIN. A hint never overrules a
 *  signature and never leaves this family (item 0.18). */
const NAME_HINT_FORMS: Readonly<Record<string, string>> = {
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  tsv: "text/csv",
  txt: "text/plain",
  text: "text/plain",
  json: "application/json",
};

/** The form a name's extension hints at, or null. Only within the text
 *  family; an `.png` name never reaches a form here — a signature does. */
export function formFromNameHint(name: string | null | undefined): string | null {
  if (!name) return null;
  const dot = name.lastIndexOf(".");
  if (dot < 0 || dot === name.length - 1) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  return NAME_HINT_FORMS[ext] ?? null;
}

// ---------------------------------------------------------------------------
// The ladder.
// ---------------------------------------------------------------------------

/** The sniffer's two NON-signature answers: its UTF-8 text heuristic and its
 *  give-up. Neither is a signature HIT, so neither stops the ladder. */
const SNIFFER_NON_SIGNATURE = new Set(["text/plain", "application/octet-stream"]);

/** The binary fallback's form — the base whose display is the download card. */
export const BINARY_FALLBACK_FORM = "application/octet-stream";

function normalizeForm(mime: string): string {
  return (mime.split(";", 1)[0] ?? "").trim().toLowerCase();
}

function isAmbiguousTextForm(form: string): form is AmbiguousTextForm {
  return (AMBIGUOUS_TEXT_FORMS as readonly string[]).includes(form);
}

/**
 * Run the ladder over one output's bytes and return the recorded verdict.
 *
 * NEVER throws: a form decision must not fail a run. An infrastructure failure
 * inside the model rung degrades to plain text with `modelSkipped:"failed"`,
 * exactly as an unconfigured runtime does.
 */
export async function detectOutputForm(
  input: DetectionInput,
  deps: DetectionDeps = {},
): Promise<DetectionVerdict> {
  // ---- Rung 1: the explicit statement ------------------------------------
  const declared = input.declaredForm ? normalizeForm(input.declaredForm) : "";
  if (declared.length > 0) {
    return {
      form: declared,
      rung: "explicit",
      reason: "the form was declared explicitly",
    };
  }

  // ---- Rung 2: the bytes' signature --------------------------------------
  // The store's own sniffer, over the SAME sixteen-byte head it reads at the
  // blob write, run here on the pickup's own copy of the value.
  const head = input.bytes.subarray(0, 16);
  const sniffed = normalizeForm(sniffMime(head));
  if (!SNIFFER_NON_SIGNATURE.has(sniffed)) {
    return {
      form: sniffed,
      rung: "signature",
      reason: `the bytes' signature reads ${sniffed}`,
    };
  }

  // The sniffer gave up AND the bytes are not text: nothing below this rung
  // reads binary, so the ladder is done.
  if (sniffed === BINARY_FALLBACK_FORM) {
    return {
      form: BINARY_FALLBACK_FORM,
      rung: "binary_fallback",
      reason: "no rung can name the form: the bytes carry no signature and are not text",
    };
  }

  // ---- The text rungs ----------------------------------------------------
  const text = new TextDecoder("utf-8", { fatal: false }).decode(input.bytes);

  // ---- Rung 3: the structural probes --------------------------------------
  const structural = probeStructuralForm(text);
  if (structural) {
    return { form: structural.form, rung: "structural", reason: structural.reason };
  }

  // ---- Rung 4: the name-and-extension hint --------------------------------
  const hinted = formFromNameHint(input.name);
  if (hinted) {
    return {
      form: hinted,
      rung: "name_extension",
      reason: `the name's extension hints at ${hinted}, within the text family the probes allow`,
    };
  }

  // ---- Rung 5: the model, for plain / markdown / csv ----------------------
  const cached = deps.cache?.get(input.contentHash);
  if (cached) return cached;

  const verdict = await askModelRung(text, deps);
  deps.cache?.set(input.contentHash, verdict);
  return verdict;
}

async function askModelRung(
  text: string,
  deps: DetectionDeps,
): Promise<DetectionVerdict> {
  const plain = (skipped: ModelRungSkip, reason: string): DetectionVerdict => ({
    form: "text/plain",
    rung: "model",
    reason,
    modelSkipped: skipped,
  });

  if (deps.modelRungEnabled === false) {
    return plain(
      "switched_off",
      "the model rung is switched off for this organisation; plain text",
    );
  }
  if (!deps.ask) {
    return plain(
      "unconfigured",
      "no runtime is configured for the model rung; plain text",
    );
  }

  // At most the first sixteen kilobytes reach the runtime. Sliced by BYTES,
  // not by characters, and re-decoded so a multi-byte character is never cut
  // in half on the way out.
  const encoded = new TextEncoder().encode(text);
  const window =
    encoded.byteLength <= MODEL_RUNG_MAX_BYTES
      ? text
      : new TextDecoder("utf-8", { fatal: false }).decode(
          encoded.subarray(0, MODEL_RUNG_MAX_BYTES),
        );

  let answered: { answer: string; confidence: number } | null;
  try {
    answered = await deps.ask({
      text: window,
      question: MODEL_RUNG_QUESTION,
      answers: AMBIGUOUS_TEXT_FORMS,
    });
  } catch {
    return plain("failed", "the model rung could not be reached; plain text");
  }
  if (!answered) {
    return plain("unconfigured", "no runtime is configured for the model rung; plain text");
  }

  // A STRICT re-parse: the answer must be exactly one of the fixed set.
  const answer = normalizeForm(answered.answer);
  if (!isAmbiguousTextForm(answer)) {
    return {
      ...plain("unsure", `the model answered outside the fixed set ("${answered.answer}"); plain text`),
      modelAnswer: answered.answer,
      confidence: answered.confidence,
    };
  }
  if (!(answered.confidence >= MODEL_RUNG_CONFIDENCE_THRESHOLD)) {
    return {
      ...plain(
        "unsure",
        `the model answered ${answer} below the ${MODEL_RUNG_CONFIDENCE_THRESHOLD} threshold; plain text`,
      ),
      modelAnswer: answered.answer,
      confidence: answered.confidence,
    };
  }
  return {
    form: answer,
    rung: "model",
    reason: `the model settled the plain/markdown/csv ambiguity at ${answered.confidence}`,
    modelAnswer: answered.answer,
    confidence: answered.confidence,
  };
}
