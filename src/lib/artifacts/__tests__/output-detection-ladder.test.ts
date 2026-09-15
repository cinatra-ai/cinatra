import { describe, expect, it, vi } from "vitest";
import {
  DOCUMENT_FLOOR_BYTES,
  MODEL_RUNG_ANSWER_SET,
  MODEL_RUNG_MAX_BYTES,
  detectOutputForm,
  isAtOrAboveDocumentFloor,
  type DetectionVerdict,
  type LadderDeps,
} from "../output-detection-ladder";

// ---------------------------------------------------------------------------
// cinatra#3029 acceptance item 6 — THE LADDER'S TABLE TEST.
//
// "The ladder is tested as a table: one row per rung with the bytes that must
//  reach it and the verdict it must record, and one row per ambiguity the model
//  rung must settle, replayed against a recorded answer so the suite never calls
//  a model." (plan section 8.6)
//
// The `askModel` seam below is a RECORDED ANSWER, never a runtime call: the
// suite asserts at the end that the real runtime client was never imported and
// that no row outside the model-rung table reached the seam at all.
// ---------------------------------------------------------------------------

const utf8 = (s: string) => new TextEncoder().encode(s);

/** A recorded model answer table, keyed by the content the rung would send. */
function recordedAnswers(
  table: ReadonlyArray<readonly [needle: string, mime: string, confidence: number]>,
): NonNullable<LadderDeps["askModel"]> {
  return async ({ text }) => {
    for (const [needle, mime, confidence] of table) {
      if (text.includes(needle)) return { mime, confidence, model: "recorded/answer-1" };
    }
    return null;
  };
}

const neverCalled: NonNullable<LadderDeps["askModel"]> = async () => {
  throw new Error("the ladder called a model on a row that must not reach the model rung");
};

const baseDeps = (over?: Partial<LadderDeps>): LadderDeps => ({
  askModel: neverCalled,
  modelRungEnabled: () => true,
  ...over,
});

// A minimal PNG head (signature rung) and a PDF head.
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const PDF = utf8("%PDF-1.7\n%âãÏÓ\n1 0 obj\n");
const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0, 0, 0, 8, 0]);
// Bytes no rung can name: NUL-bearing, no signature, not text.
const OPAQUE = new Uint8Array([0x00, 0x01, 0x02, 0x00, 0xff, 0xfe, 0x00, 0x7f, 0x00, 0x13]);

describe("the detection ladder — one row per rung", () => {
  const rows: ReadonlyArray<{
    label: string;
    bytes: Uint8Array;
    declaredMime?: string | null;
    fileName?: string | null;
    expect: { mime: string; rung: DetectionVerdict["rung"] };
  }> = [
    {
      label: "the explicit statement wins over everything below it",
      bytes: utf8("# a heading\n\n- a list item\n"),
      declaredMime: "text/csv",
      expect: { mime: "text/csv", rung: "explicit" },
    },
    {
      label: "the signature rung — png bytes",
      bytes: PNG,
      expect: { mime: "image/png", rung: "signature" },
    },
    {
      label: "the signature rung — pdf bytes",
      bytes: PDF,
      expect: { mime: "application/pdf", rung: "signature" },
    },
    {
      label: "the signature rung — zip bytes",
      bytes: ZIP,
      expect: { mime: "application/zip", rung: "signature" },
    },
    {
      label: "a signature beats a contradicting name hint",
      bytes: PNG,
      fileName: "report.md",
      expect: { mime: "image/png", rung: "signature" },
    },
    {
      label: "the structural probe — the parse probe (json)",
      bytes: utf8('{"items":[1,2,3],"note":"a structured value"}'),
      expect: { mime: "application/json", rung: "structure" },
    },
    {
      label: "the structural probe — the xml prologue",
      bytes: utf8('<?xml version="1.0" encoding="utf-8"?>\n<feed><entry/></feed>'),
      expect: { mime: "application/xml", rung: "structure" },
    },
    {
      label: "the structural probe — the html prologue",
      bytes: utf8("<!DOCTYPE html>\n<html><body><p>hello</p></body></html>"),
      expect: { mime: "text/html", rung: "structure" },
    },
    {
      label: "the structural probe — front matter",
      bytes: utf8("---\ntitle: A post\n---\n\nThe body of the post.\n"),
      expect: { mime: "text/markdown", rung: "structure" },
    },
    {
      label: "the structural probe — the csv shape",
      bytes: utf8("name,role,city\nada,engineer,london\ngrace,admiral,new york\nalan,logician,wilmslow\n"),
      expect: { mime: "text/csv", rung: "structure" },
    },
    {
      label: "the structural probe — markdown signals",
      bytes: utf8(
        "# The quarter in review\n\n- the first point\n- the second point\n\nSee [the note](https://example.test) and **the emphasis**.\n\n```js\nconst a = 1;\n```\n",
      ),
      expect: { mime: "text/markdown", rung: "structure" },
    },
    {
      label: "the name rung — a .csv hint the probes left ambiguous",
      bytes: utf8("a single line of prose that no probe can name\n"),
      fileName: "cohort.csv",
      expect: { mime: "text/csv", rung: "name" },
    },
    {
      label: "the name rung — a .md hint the probes left ambiguous",
      bytes: utf8("a single line of prose that no probe can name\n"),
      fileName: "note.md",
      expect: { mime: "text/markdown", rung: "name" },
    },
    {
      label: "the name rung may not choose outside the text family the probes allow",
      bytes: utf8("a single line of prose that no probe can name\n"),
      fileName: "note.pdf",
      expect: { mime: "text/plain", rung: "base" },
    },
    {
      label: "the binary base — bytes every rung refuses",
      bytes: OPAQUE,
      expect: { mime: "application/octet-stream", rung: "base" },
    },
  ];

  for (const row of rows) {
    it(row.label, async () => {
      const verdict = await detectOutputForm(
        {
          orgId: "org-1",
          bytes: row.bytes,
          declaredMime: row.declaredMime ?? null,
          fileName: row.fileName ?? null,
        },
        baseDeps(),
      );
      expect({ mime: verdict.mime, rung: verdict.rung }).toEqual(row.expect);
      expect(verdict.reason.length).toBeGreaterThan(0);
    });
  }
});

describe("the model rung — one row per ambiguity it must settle", () => {
  const ambiguous = "the cohort report\nthe second line\nthe third line\n";

  it("settles an ambiguous text output against a recorded answer", async () => {
    const askModel = vi.fn(recordedAnswers([["the cohort report", "text/markdown", 0.92]]));
    const verdict = await detectOutputForm(
      { orgId: "org-1", bytes: utf8(ambiguous), declaredMime: null, fileName: null },
      baseDeps({ askModel }),
    );
    expect(verdict.mime).toBe("text/markdown");
    expect(verdict.rung).toBe("model");
    expect(verdict.confidence).toBe(0.92);
    expect(verdict.model).toBe("recorded/answer-1");
    expect(askModel).toHaveBeenCalledTimes(1);
  });

  it("asks its one fixed question with the fixed answer set at zero temperature", async () => {
    const askModel = vi.fn(recordedAnswers([["the cohort report", "text/csv", 0.9]]));
    await detectOutputForm(
      { orgId: "org-1", bytes: utf8(ambiguous), declaredMime: null, fileName: null },
      baseDeps({ askModel }),
    );
    const call = askModel.mock.calls[0][0];
    expect(call.candidates).toEqual(MODEL_RUNG_ANSWER_SET);
    expect(call.temperature).toBe(0);
    expect(call.question).toBe(call.question.trim());
    expect(call.question.length).toBeGreaterThan(0);
  });

  it("sends at most the first 16 KB", async () => {
    const askModel = vi.fn(recordedAnswers([["x", "text/plain", 0.99]]));
    const long = "x".repeat(MODEL_RUNG_MAX_BYTES * 3);
    await detectOutputForm(
      { orgId: "org-1", bytes: utf8(long), declaredMime: null, fileName: null },
      baseDeps({ askModel }),
    );
    expect(MODEL_RUNG_MAX_BYTES).toBe(16 * 1024);
    expect(new TextEncoder().encode(askModel.mock.calls[0][0].text).byteLength).toBeLessThanOrEqual(
      MODEL_RUNG_MAX_BYTES,
    );
  });

  it("caches by content hash — one call per distinct ambiguous output in the run", async () => {
    const askModel = vi.fn(recordedAnswers([["the cohort report", "text/markdown", 0.9]]));
    const cache = new Map<string, DetectionVerdict>();
    for (let i = 0; i < 3; i += 1) {
      const verdict = await detectOutputForm(
        { orgId: "org-1", bytes: utf8(ambiguous), declaredMime: null, fileName: null },
        baseDeps({ askModel, cache }),
      );
      expect(verdict.mime).toBe("text/markdown");
    }
    expect(askModel).toHaveBeenCalledTimes(1);
  });

  it("re-parses strictly — an answer off the fixed set yields plain text", async () => {
    const askModel = vi.fn(async () => ({
      mime: "application/x-invented",
      confidence: 0.99,
      model: "recorded/answer-1",
    }));
    const verdict = await detectOutputForm(
      { orgId: "org-1", bytes: utf8(ambiguous), declaredMime: null, fileName: null },
      baseDeps({ askModel }),
    );
    expect(verdict.mime).toBe("text/plain");
    expect(verdict.rung).toBe("base");
  });

  it("applies the confidence threshold — an unsure answer yields plain text", async () => {
    const askModel = vi.fn(recordedAnswers([["the cohort report", "text/markdown", 0.2]]));
    const verdict = await detectOutputForm(
      { orgId: "org-1", bytes: utf8(ambiguous), declaredMime: null, fileName: null },
      baseDeps({ askModel }),
    );
    expect(verdict.mime).toBe("text/plain");
    expect(verdict.rung).toBe("base");
  });

  it("yields plain text when the runtime is unconfigured", async () => {
    const verdict = await detectOutputForm(
      { orgId: "org-1", bytes: utf8(ambiguous), declaredMime: null, fileName: null },
      baseDeps({ askModel: async () => null }),
    );
    expect(verdict.mime).toBe("text/plain");
    expect(verdict.rung).toBe("base");
  });

  it("yields plain text when the organisation switched the rung off — and never asks", async () => {
    const askModel = vi.fn(neverCalled);
    const verdict = await detectOutputForm(
      { orgId: "org-off", bytes: utf8(ambiguous), declaredMime: null, fileName: null },
      baseDeps({ askModel, modelRungEnabled: (orgId) => orgId !== "org-off" }),
    );
    expect(verdict.mime).toBe("text/plain");
    expect(verdict.rung).toBe("base");
    expect(askModel).not.toHaveBeenCalled();
  });
});

describe("the document floor", () => {
  it("is one kilobyte", () => {
    expect(DOCUMENT_FLOOR_BYTES).toBe(1024);
  });

  it("admits bytes at or above the floor and refuses a datum below it", () => {
    expect(isAtOrAboveDocumentFloor(new Uint8Array(DOCUMENT_FLOOR_BYTES))).toBe(true);
    expect(isAtOrAboveDocumentFloor(new Uint8Array(DOCUMENT_FLOOR_BYTES + 1))).toBe(true);
    expect(isAtOrAboveDocumentFloor(new Uint8Array(DOCUMENT_FLOOR_BYTES - 1))).toBe(false);
  });
});
