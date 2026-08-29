import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  AMBIGUOUS_TEXT_FORMS,
  BINARY_FALLBACK_FORM,
  MARKDOWN_SIGNAL_THRESHOLD,
  MODEL_RUNG_CONFIDENCE_THRESHOLD,
  MODEL_RUNG_MAX_BYTES,
  MODEL_RUNG_QUESTION,
  countMarkdownSignals,
  detectOutputForm,
  formFromNameHint,
  probeCsv,
  probeFrontMatter,
  probeJson,
  probePrologue,
  probeStructuralForm,
  type DetectionRung,
  type DetectionVerdict,
  type ModelRungAsk,
} from "../output-detection-ladder";

// ---------------------------------------------------------------------------
// The detection ladder, tested AS A TABLE (Agents Lifecycle (C) section 8.6:
// "The ladder is tested as a table: one row per rung with the bytes that must
// reach it and the verdict it must record, and one row per ambiguity the model
// rung must settle, replayed against a recorded answer so the suite never calls
// a model.")
//
// This is issue #3029's acceptance item 6 — "the ladder's table test passes
// without calling a model" — and the test PROVES the "without" rather than
// asserting it: every row runs with an `ask` seam that fails the test if it is
// ever invoked outside the rows that deliberately replay a RECORDED answer.
// ---------------------------------------------------------------------------

const bytes = (s: string) => new TextEncoder().encode(s);
const hashOf = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/** An `ask` that FAILS the test if the ladder reaches the model rung. Every row
 *  that must stop above rung 5 runs with this. */
const neverAsk: ModelRungAsk = async () => {
  throw new Error("THE LADDER CALLED A MODEL — acceptance 6 forbids it on this row");
};

/** The recorded answer replay — the only "model" this suite ever has. */
function recordedAnswer(answer: string, confidence: number) {
  return vi.fn(async () => ({ answer, confidence }));
}

async function detect(
  content: string | Uint8Array,
  opts: { name?: string; declaredForm?: string; ask?: ModelRungAsk; modelRungEnabled?: boolean } = {},
): Promise<DetectionVerdict> {
  const b = typeof content === "string" ? bytes(content) : content;
  return detectOutputForm(
    {
      bytes: b,
      contentHash: createHash("sha256").update(b).digest("hex"),
      name: opts.name ?? null,
      declaredForm: opts.declaredForm ?? null,
    },
    { ask: opts.ask ?? neverAsk, modelRungEnabled: opts.modelRungEnabled },
  );
}

// ---------------------------------------------------------------------------
// ONE ROW PER RUNG — the bytes that must reach it, and the verdict it records.
// ---------------------------------------------------------------------------

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 10, 10, 10, 10]);
const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0, 0, 0, 0, 0]);
/** NUL-bearing bytes with no signature at all — nothing can name them. */
const UNNAMEABLE = new Uint8Array([0x7f, 0x00, 0x13, 0x37, 0x00, 0xde, 0xad, 0xbe, 0xef, 0x00, 0x01, 0x02]);

const MARKDOWN_DOC = [
  "# The upgrade road",
  "",
  "Migrations are the hardest part of self-hosting, and here is why.",
  "",
  "- the schema moves",
  "- the data does not",
  "",
  "See [the notes](https://example.invalid/notes) for the rest.",
].join("\n");

const CSV_DOC = ["name,role,team", "ada,engineer,core", "grace,engineer,core", "alan,research,labs"].join("\n");

const JSON_DOC = JSON.stringify({ ideas: [{ title: "one" }, { title: "two" }] });

/** Prose with ONE markdown signal — below the threshold, so the probes leave it
 *  ambiguous and it is exactly what the model rung exists for. */
const AMBIGUOUS_PROSE =
  "Migrations are the hardest part of self-hosting. The schema moves and the " +
  "data does not, which is a sentence and not a document structure. " +
  "Nothing here is a heading, a list, a link or a fence.";

type Row = {
  what: string;
  content: string | Uint8Array;
  name?: string;
  declaredForm?: string;
  rung: DetectionRung;
  form: string;
};

const ROWS: Row[] = [
  // ---- rung 1: the explicit statement ------------------------------------
  {
    what: "an explicitly declared form wins outright, over bytes that say otherwise",
    content: MARKDOWN_DOC,
    declaredForm: "text/plain",
    rung: "explicit",
    form: "text/plain",
  },
  {
    what: "an explicit declaration is canonicalised (parameters dropped, lowercased)",
    content: JSON_DOC,
    declaredForm: "Application/JSON; charset=utf-8",
    rung: "explicit",
    form: "application/json",
  },
  // ---- rung 2: the bytes' signature --------------------------------------
  { what: "a png signature", content: PNG, rung: "signature", form: "image/png" },
  { what: "a pdf signature", content: PDF, rung: "signature", form: "application/pdf" },
  { what: "a zip signature", content: ZIP, rung: "signature", form: "application/zip" },
  {
    what: "a signature beats a name that says otherwise (a hint never overrules bytes)",
    content: PNG,
    name: "notes.md",
    rung: "signature",
    form: "image/png",
  },
  // ---- rung 3: the structural probes -------------------------------------
  { what: "the parse probe reads structured data", content: JSON_DOC, rung: "structural", form: "application/json" },
  {
    what: "the xml prologue",
    content: '<?xml version="1.0"?><notes><note>one</note></notes>',
    rung: "structural",
    form: "application/xml",
  },
  {
    what: "the html prologue",
    content: "<!DOCTYPE html>\n<html><body><p>hello</p></body></html>",
    rung: "structural",
    form: "text/html",
  },
  {
    what: "closed front matter is markdown",
    content: "---\ntitle: the upgrade road\n---\n\nplain sentences follow and nothing else.",
    rung: "structural",
    form: "text/markdown",
  },
  { what: "the csv shape", content: CSV_DOC, rung: "structural", form: "text/csv" },
  { what: "markdown signals at or above the threshold", content: MARKDOWN_DOC, rung: "structural", form: "text/markdown" },
  {
    what: "a semicolon-delimited csv is still a csv",
    content: ["a;b;c", "1;2;3", "4;5;6"].join("\n"),
    rung: "structural",
    form: "text/csv",
  },
  // ---- rung 4: the name-and-extension hint --------------------------------
  {
    what: "the name hints markdown for text the probes left ambiguous",
    content: AMBIGUOUS_PROSE,
    name: "draft.md",
    rung: "name_extension",
    form: "text/markdown",
  },
  {
    what: "the name hints plain text",
    content: AMBIGUOUS_PROSE,
    name: "notes.txt",
    rung: "name_extension",
    form: "text/plain",
  },
  {
    what: "an out-of-family extension is NOT a hint (an .png name over text bytes hints nothing)",
    content: AMBIGUOUS_PROSE,
    name: "notes.png",
    rung: "model",
    form: "text/plain",
  },
  // ---- the binary fallback -----------------------------------------------
  {
    what: "bytes nobody can name land on the binary fallback",
    content: UNNAMEABLE,
    rung: "binary_fallback",
    form: BINARY_FALLBACK_FORM,
  },
];

describe("the detection ladder — one row per rung", () => {
  it.each(ROWS)("$what", async (row) => {
    const verdict = await detect(row.content, { name: row.name, declaredForm: row.declaredForm });
    expect(verdict.form).toBe(row.form);
    expect(verdict.rung).toBe(row.rung);
    // EVERY rung records a reason — the ledger row carries it (section 8.2).
    expect(verdict.reason.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// ONE ROW PER AMBIGUITY THE MODEL RUNG MUST SETTLE — replayed against a
// RECORDED answer, so the suite never calls a model.
// ---------------------------------------------------------------------------

describe("the model rung — the plain / markdown / csv ambiguity, replayed", () => {
  it.each(AMBIGUOUS_TEXT_FORMS)("settles on %s at full confidence", async (answer) => {
    const ask = recordedAnswer(answer, 0.95);
    const verdict = await detect(AMBIGUOUS_PROSE, { ask });
    expect(verdict.form).toBe(answer);
    expect(verdict.rung).toBe("model");
    expect(verdict.modelAnswer).toBe(answer);
    expect(verdict.confidence).toBe(0.95);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("asks the FIXED question with the FIXED set of answers", async () => {
    const ask = recordedAnswer("text/markdown", 0.9);
    await detect(AMBIGUOUS_PROSE, { ask });
    expect(ask).toHaveBeenCalledWith(
      expect.objectContaining({ question: MODEL_RUNG_QUESTION, answers: AMBIGUOUS_TEXT_FORMS }),
    );
  });

  it("sends AT MOST the first sixteen kilobytes", async () => {
    const ask = vi.fn(async (input: { text: string }) => {
      expect(new TextEncoder().encode(input.text).byteLength).toBeLessThanOrEqual(MODEL_RUNG_MAX_BYTES);
      return { answer: "text/plain", confidence: 0.99 };
    });
    // 64 KB of prose the probes leave ambiguous.
    const long = `${AMBIGUOUS_PROSE} `.repeat(400);
    expect(new TextEncoder().encode(long).byteLength).toBeGreaterThan(MODEL_RUNG_MAX_BYTES * 3);
    const verdict = await detect(long, { ask: ask as unknown as ModelRungAsk });
    expect(verdict.form).toBe("text/plain");
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("below the confidence threshold the verdict is plain text, and it says so", async () => {
    const ask = recordedAnswer("text/markdown", MODEL_RUNG_CONFIDENCE_THRESHOLD - 0.01);
    const verdict = await detect(AMBIGUOUS_PROSE, { ask });
    expect(verdict.form).toBe("text/plain");
    expect(verdict.modelSkipped).toBe("unsure");
    expect(verdict.modelAnswer).toBe("text/markdown");
  });

  it("an answer outside the fixed set is refused by the strict re-parse", async () => {
    const ask = recordedAnswer("text/x-rst", 0.99);
    const verdict = await detect(AMBIGUOUS_PROSE, { ask });
    expect(verdict.form).toBe("text/plain");
    expect(verdict.modelSkipped).toBe("unsure");
  });

  it("an unreachable runtime yields plain text and never fails the run", async () => {
    const ask: ModelRungAsk = async () => {
      throw new Error("provider down");
    };
    const verdict = await detect(AMBIGUOUS_PROSE, { ask });
    expect(verdict.form).toBe("text/plain");
    expect(verdict.modelSkipped).toBe("failed");
  });

  it("an unconfigured runtime yields plain text", async () => {
    const verdict = await detectOutputForm(
      { bytes: bytes(AMBIGUOUS_PROSE), contentHash: hashOf(AMBIGUOUS_PROSE) },
      {},
    );
    expect(verdict.form).toBe("text/plain");
    expect(verdict.modelSkipped).toBe("unconfigured");
  });

  it("the per-organisation switch turns the rung OFF and yields plain text without asking", async () => {
    const ask = recordedAnswer("text/markdown", 0.99);
    const verdict = await detect(AMBIGUOUS_PROSE, { ask, modelRungEnabled: false });
    expect(verdict.form).toBe("text/plain");
    expect(verdict.modelSkipped).toBe("switched_off");
    expect(ask).not.toHaveBeenCalled();
  });

  it("is cached by content hash — the same bytes cost ONE call in a run", async () => {
    const ask = recordedAnswer("text/markdown", 0.99);
    const cache = new Map<string, DetectionVerdict>();
    const input = {
      bytes: bytes(AMBIGUOUS_PROSE),
      contentHash: hashOf(AMBIGUOUS_PROSE),
    };
    const first = await detectOutputForm(input, { ask, cache });
    const second = await detectOutputForm(input, { ask, cache });
    expect(first).toEqual(second);
    expect(ask).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// The probes themselves — pure, fixed thresholds (section 8.6).
// ---------------------------------------------------------------------------

describe("the structural probes", () => {
  it("the parse probe takes documents, not data", () => {
    expect(probeJson(JSON_DOC)).toBe(true);
    expect(probeJson("[1,2,3]")).toBe(true);
    // A bare scalar is a datum, not a structured-data document.
    expect(probeJson("42")).toBe(false);
    expect(probeJson('"a receipt id"')).toBe(false);
    expect(probeJson("not json at all")).toBe(false);
  });

  it("the prologue test reads only the leading bytes", () => {
    expect(probePrologue('<?xml version="1.0"?>')).toBe("application/xml");
    expect(probePrologue("<!doctype html><p>x")).toBe("text/html");
    expect(probePrologue("a sentence that mentions <html> halfway through")).toBeNull();
  });

  it("front matter must be CLOSED to count", () => {
    expect(probeFrontMatter("---\ntitle: x\n---\nbody")).toBe(true);
    expect(probeFrontMatter("---\ntitle: x\nbody with no close")).toBe(false);
    expect(probeFrontMatter("body\n---\ntitle: x\n---")).toBe(false);
  });

  it("csv needs delimiter consistency, and a markdown table is not a csv", () => {
    expect(probeCsv(CSV_DOC)).toBe(true);
    expect(probeCsv("a,b,c\n1,2\n3,4,5")).toBe(false);
    expect(probeCsv("one line only,with fields")).toBe(false);
    expect(probeCsv("| a | b |\n|---|---|\n| 1 | 2 |")).toBe(false);
    // A quoted comma is one field, not two.
    expect(probeCsv('name,note\nada,"a, b"\ngrace,"c, d"')).toBe(true);
  });

  it("markdown is a COUNT of distinct signals against a fixed threshold", () => {
    expect(countMarkdownSignals(MARKDOWN_DOC)).toBeGreaterThanOrEqual(MARKDOWN_SIGNAL_THRESHOLD);
    expect(countMarkdownSignals(AMBIGUOUS_PROSE)).toBeLessThan(MARKDOWN_SIGNAL_THRESHOLD);
    expect(probeStructuralForm(AMBIGUOUS_PROSE)).toBeNull();
  });

  it("the name hint stays inside the text family", () => {
    expect(formFromNameHint("draft.md")).toBe("text/markdown");
    expect(formFromNameHint("rows.csv")).toBe("text/csv");
    expect(formFromNameHint("notes.txt")).toBe("text/plain");
    expect(formFromNameHint("data.json")).toBe("application/json");
    expect(formFromNameHint("picture.png")).toBeNull();
    expect(formFromNameHint("archive.zip")).toBeNull();
    expect(formFromNameHint("no-extension")).toBeNull();
    expect(formFromNameHint(null)).toBeNull();
  });
});
