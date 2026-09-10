import { createHash } from "node:crypto";
// The SIGNATURE rung is "the store’s sniffer as it is" (plan section 8.6):
// imported from the store that owns it, never reimplemented here.
import { sniffMime as sniffBlobMime } from "./local-disk-blob-store";

// ---------------------------------------------------------------------------
// THE DETECTION LADDER (cinatra#3029, epic #3023 — plan items 0.18 / section 8.6).
//
// "The detection ladder, one function with a recorded verdict, in this order:
//  the explicit statement (a binding's declared form, a tool call's declared
//  type); the bytes' signature, which the store's sniffer already reads for
//  images, pdf, zip and office, audio and video; the structural probes for text
//  — the parse probe that exists, and new: the xml and html prologue, front
//  matter, the csv shape, markdown signals (headings, lists, links, emphasis,
//  fenced code); the file's name and extension, a hint that may only choose
//  within the text family the probes allow, never over a signature; and, for
//  what the probes leave ambiguous — plain, markdown or csv — the core's model."
//
// ONE function, ONE verdict. Every rung returns the form it names AND the
// reason; the pickup records both on the ledger row. The rungs run in order and
// STOP at the first confident verdict (section 8.6).
//
// The model rung is a SEAM (`askModel`). Its production implementation routes
// through the organisation's ALREADY-configured runtime — the same client the
// meaning matcher and the pickup's type classifier send content to — so no new
// class of data leaves the deployment. The suite injects a recorded answer and
// never calls a model.
// ---------------------------------------------------------------------------

/** The document floor: an end-node output at or above this many bytes takes the
 *  default road; a datum below it takes no road (plan section 3's matrix). */
export const DOCUMENT_FLOOR_BYTES = 1024;

/** At most the first 16 KB reach the model rung. */
export const MODEL_RUNG_MAX_BYTES = 16 * 1024;

/** The model rung's FIXED set of answers — the ambiguity it exists to settle. */
export const MODEL_RUNG_ANSWER_SET = [
  "text/plain",
  "text/markdown",
  "text/csv",
] as const;

/** The model rung's ONE fixed question. */
export const MODEL_RUNG_QUESTION =
  "Which of the listed forms do these bytes take? Answer with exactly one of the listed media types and nothing else.";

/** At/above this the model rung's answer is taken; below it, plain text. */
export const MODEL_RUNG_CONFIDENCE_THRESHOLD = 0.7;

/** The rung that decided. Recorded on the ledger row. */
export type DetectionRung =
  | "explicit"
  | "signature"
  | "structure"
  | "name"
  | "model"
  | "base";

/** The ladder's recorded verdict. */
export type DetectionVerdict = {
  /** The form the deciding rung names, as a canonical media type. */
  mime: string;
  /** The rung that decided. */
  rung: DetectionRung;
  /** Why that rung decided as it did. */
  reason: string;
  /** The model rung's confidence; null on every other rung. */
  confidence: number | null;
  /** The model the model rung used; null on every other rung. */
  model: string | null;
};

export type LadderInput = {
  /** The organisation — the model rung's per-organisation switch reads it. */
  orgId: string;
  /** The bytes to name. */
  bytes: Uint8Array;
  /** The explicit statement: a binding's declared form or a tool call's
   *  declared type. Absent on the default road's undeclared outputs. */
  declaredMime?: string | null;
  /** The output's file name, when it has one. A HINT only. */
  fileName?: string | null;
};

export type ModelRungAnswer = {
  mime: string;
  confidence: number;
  model: string;
};

export type ModelRungAsk = (input: {
  /** At most the first `MODEL_RUNG_MAX_BYTES` of the output, decoded. */
  text: string;
  /** The one fixed question. */
  question: string;
  /** The fixed set of answers. */
  candidates: readonly string[];
  /** Zero. */
  temperature: number;
  orgId: string;
}) => Promise<ModelRungAnswer | null>;

export type LadderDeps = {
  /** The signature rung. Defaults to the store's own sniffer. */
  sniff?: (head: Uint8Array, declared?: string) => string;
  /** The model rung's runtime call. Defaults to the organisation's configured
   *  runtime; `null` means unconfigured or unsure. */
  askModel?: ModelRungAsk;
  /** The per-organisation switch. Defaults to on. */
  modelRungEnabled?: (orgId: string) => boolean | Promise<boolean>;
  /** Content-hash cache for the model rung — one call per distinct ambiguous
   *  output within a run. The pickup passes ONE map per run. */
  cache?: Map<string, DetectionVerdict>;
};

/** Is a datum at or above the document floor? Below it, no road. */
export function isAtOrAboveDocumentFloor(bytes: Uint8Array): boolean {
  return bytes.byteLength >= DOCUMENT_FLOOR_BYTES;
}

// --- rung 1: the explicit statement ---------------------------------------

function canonicalMime(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const base = (raw.split(";", 1)[0] ?? "").trim().toLowerCase();
  if (base.length === 0) return null;
  if (!/^[\w.+-]+\/[\w.+-]+$/.test(base)) return null;
  return base;
}

// --- rung 2: the signature -------------------------------------------------

/** The sniffer's two NON-verdicts: `text/plain` hands the bytes to the
 *  structural probes, `application/octet-stream` hands them to the base. Every
 *  other return IS a signature verdict. */
const SNIFFER_NON_VERDICTS = new Set(["text/plain", "application/octet-stream"]);

// --- rung 3: the structural probes -----------------------------------------

/** The probes' outcome. `ambiguous` is the plain/markdown/csv band the name
 *  hint may narrow and the model rung may settle. */
type ProbeOutcome =
  | { kind: "named"; mime: string; reason: string }
  | { kind: "ambiguous" };

const MARKDOWN_SIGNALS: ReadonlyArray<readonly [name: string, re: RegExp]> = [
  ["a heading", /^#{1,6}\s+\S/m],
  ["a list", /^\s{0,3}([-*+]\s+\S|\d+\.\s+\S)/m],
  ["a link", /\[[^\]\n]+\]\([^)\s]+\)/],
  ["emphasis", /(\*\*[^*\n]+\*\*|__[^_\n]+__|(?<![*\w])\*[^*\n]+\*(?!\w))/],
  ["fenced code", /^\s{0,3}(```|~~~)/m],
  ["a block quote", /^\s{0,3}>\s+\S/m],
];

/** How many markdown signals a text must carry to be named markdown. */
const MARKDOWN_SIGNAL_THRESHOLD = 2;

/** How many rows a csv shape must hold, and how consistent their field count. */
const CSV_MIN_ROWS = 3;

function probeCsvShape(text: string): { ok: boolean; columns: number; rows: number } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < CSV_MIN_ROWS) return { ok: false, columns: 0, rows: lines.length };
  const counts = lines.slice(0, 50).map((l) => l.split(",").length);
  const first = counts[0] ?? 1;
  if (first < 2) return { ok: false, columns: first, rows: lines.length };
  const consistent = counts.every((c) => c === first);
  return { ok: consistent, columns: first, rows: lines.length };
}

function structuralProbes(text: string): ProbeOutcome {
  const head = text.slice(0, 4096);
  const trimmed = head.trimStart();

  // The parse probe that exists (the terminal path's finalOutputIsJson try/catch
  // and the outbox's contentIsJson branch, now one probe).
  const firstChar = trimmed[0];
  if (firstChar === "{" || firstChar === "[") {
    try {
      JSON.parse(text);
      return {
        kind: "named",
        mime: "application/json",
        reason: "the parse probe read the whole output as JSON",
      };
    } catch {
      // not JSON — fall through
    }
  }

  // The xml prologue.
  if (/^<\?xml\s/i.test(trimmed)) {
    return { kind: "named", mime: "application/xml", reason: "an xml prologue opens the output" };
  }

  // The html prologue.
  if (/^<!doctype\s+html/i.test(trimmed) || /^<html[\s>]/i.test(trimmed)) {
    return { kind: "named", mime: "text/html", reason: "an html prologue opens the output" };
  }

  // Front matter.
  if (/^---\r?\n[\s\S]*?\r?\n---\r?\n/.test(trimmed)) {
    return {
      kind: "named",
      mime: "text/markdown",
      reason: "front matter opens the output",
    };
  }

  // The csv shape — a consistent delimiter count over at least three rows.
  const csv = probeCsvShape(head);
  if (csv.ok) {
    return {
      kind: "named",
      mime: "text/csv",
      reason: `a consistent ${csv.columns}-field delimiter shape over ${csv.rows} rows`,
    };
  }

  // Markdown signals — a feature count against a fixed threshold.
  const hits = MARKDOWN_SIGNALS.filter(([, re]) => re.test(head)).map(([name]) => name);
  if (hits.length >= MARKDOWN_SIGNAL_THRESHOLD) {
    return {
      kind: "named",
      mime: "text/markdown",
      reason: `${hits.length} markdown signals (${hits.join(", ")})`,
    };
  }

  return { kind: "ambiguous" };
}

// --- rung 4: the file's name and extension ---------------------------------

/**
 * The name rung INVERTS the attachment table the model-provider path already
 * keeps (`packages/llm/src/attachments/capability-registry.ts`'s
 * `INGESTIBLE_MIME_EXTENSIONS`), restricted to the TEXT family the probes allow.
 * A hint may only choose WITHIN that family — never over a signature, and never
 * into a binary form.
 */
// The name-and-extension rung INVERTS the attachment table the model-provider
// path already keeps, narrowed to the text family the probes allow. `settles`
// says whether the hint names a form ABOVE the text base: a name ending ".txt"
// claims nothing the base does not already give, so it does NOT stop the ladder
// and the model rung still gets its turn at the ambiguity.
const NAME_HINT_TEXT_FAMILY: ReadonlyArray<
  readonly [ext: string, mime: string, settles: boolean]
> = [
  [".md", "text/markdown", true],
  [".markdown", "text/markdown", true],
  [".csv", "text/csv", true],
  [".txt", "text/plain", false],
];

function nameHint(
  fileName: string | null | undefined,
): { mime: string; ext: string; settles: boolean } | null {
  if (typeof fileName !== "string") return null;
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0 || dot === fileName.length - 1) return null;
  const ext = fileName.slice(dot).toLowerCase();
  for (const [candidate, mime, settles] of NAME_HINT_TEXT_FAMILY) {
    if (candidate === ext) return { mime, ext, settles };
  }
  return null;
}

// --- the ladder ------------------------------------------------------------

function isProbableText(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, 512);
  if (head.byteLength === 0) return false;
  return !head.includes(0);
}

/**
 * ONE function with a recorded verdict. The rungs run in the order of item 0.18
 * and STOP at the first confident verdict.
 */
export async function detectOutputForm(
  input: LadderInput,
  deps?: LadderDeps,
): Promise<DetectionVerdict> {
  const bytes = input.bytes;

  // Rung 1 — the explicit statement.
  const declared = canonicalMime(input.declaredMime);
  if (declared !== null) {
    return {
      mime: declared,
      rung: "explicit",
      reason: `the output declares "${declared}"`,
      confidence: null,
      model: null,
    };
  }

  // Rung 2 — the bytes' signature (the store's sniffer, as it is).
  const sniff = deps?.sniff ?? sniffBlobMime;
  const sniffed = canonicalMime(sniff(bytes.subarray(0, 64)));
  if (sniffed !== null && !SNIFFER_NON_VERDICTS.has(sniffed)) {
    return {
      mime: sniffed,
      rung: "signature",
      reason: `the bytes carry the "${sniffed}" signature`,
      confidence: null,
      model: null,
    };
  }

  // Not text and no signature: nothing above the base can name these bytes.
  if (!isProbableText(bytes)) {
    return {
      mime: "application/octet-stream",
      rung: "base",
      reason: "no signature, no structure and no usable name — the binary base",
      confidence: null,
      model: null,
    };
  }

  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);

  // Rung 3 — the structural probes.
  const probe = structuralProbes(text);
  if (probe.kind === "named") {
    return {
      mime: probe.mime,
      rung: "structure",
      reason: probe.reason,
      confidence: null,
      model: null,
    };
  }

  // Rung 4 — the file's name and extension, WITHIN the text family only.
  const hint = nameHint(input.fileName);
  if (hint !== null && hint.settles) {
    return {
      mime: hint.mime,
      rung: "name",
      reason: `the name ends "${hint.ext}", a hint inside the text family the probes allow`,
      confidence: null,
      model: null,
    };
  }

  // Rung 5 — the core's model, for what the probes left ambiguous.
  const plainBase: DetectionVerdict = {
    mime: "text/plain",
    rung: "base",
    reason: "the probes left the output ambiguous and no rung above settled it — plain text",
    confidence: null,
    model: null,
  };

  const enabled = (await deps?.modelRungEnabled?.(input.orgId)) ?? true;
  if (!enabled) {
    return {
      ...plainBase,
      reason: "the model rung is switched off for this organisation — plain text",
    };
  }

  const contentHash = createHash("sha256").update(bytes).digest("hex");
  const cached = deps?.cache?.get(contentHash);
  if (cached) return cached;

  const ask = deps?.askModel ?? defaultAskModel;
  let answer: ModelRungAnswer | null = null;
  try {
    answer = await ask({
      text: clampToBytes(text, MODEL_RUNG_MAX_BYTES),
      question: MODEL_RUNG_QUESTION,
      candidates: MODEL_RUNG_ANSWER_SET,
      temperature: 0,
      orgId: input.orgId,
    });
  } catch {
    // An unconfigured or unreachable runtime is never a wrong verdict: plain text.
    answer = null;
  }

  let verdict: DetectionVerdict;
  const answered = canonicalMime(answer?.mime);
  if (answer === null || answered === null) {
    verdict = {
      ...plainBase,
      reason: "the runtime is unconfigured or gave no answer — plain text",
    };
  } else if (!(MODEL_RUNG_ANSWER_SET as readonly string[]).includes(answered)) {
    // A STRICT re-parse: an answer outside the fixed set is no answer.
    verdict = {
      ...plainBase,
      reason: `the runtime answered "${answered}", off the fixed set — plain text`,
    };
  } else if (answer.confidence < MODEL_RUNG_CONFIDENCE_THRESHOLD) {
    verdict = {
      ...plainBase,
      reason: `the runtime was unsure (${answer.confidence} below ${MODEL_RUNG_CONFIDENCE_THRESHOLD}) — plain text`,
    };
  } else {
    verdict = {
      mime: answered,
      rung: "model",
      reason: `the organisation's runtime named "${answered}" for an ambiguous text output`,
      confidence: answer.confidence,
      model: answer.model,
    };
  }
  deps?.cache?.set(contentHash, verdict);
  return verdict;
}

/** Decode-safe clamp: never send more than `max` BYTES to the model rung. */
function clampToBytes(text: string, max: number): string {
  const encoded = new TextEncoder().encode(text);
  if (encoded.byteLength <= max) return text;
  return new TextDecoder("utf-8", { fatal: false }).decode(encoded.subarray(0, max));
}

/**
 * The production model rung: the organisation's ALREADY-configured runtime — the
 * one the meaning matcher and the pickup's own type classifier send content to.
 * Loaded lazily so the ladder's pure rungs (and its table test) never pull the
 * runtime into the module graph.
 */
const defaultAskModel: ModelRungAsk = async ({ text, question, candidates, temperature, orgId }) => {
  const { askOrganisationRuntimeForOutputForm } = await import(
    "./output-detection-model-rung"
  );
  return askOrganisationRuntimeForOutputForm({
    text,
    question,
    candidates,
    temperature,
    orgId,
  });
};
