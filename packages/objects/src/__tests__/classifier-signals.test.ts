import { describe, it, expect } from "vitest";

// Classifier signal intake helpers. These pin:
//   - strict-schema rejection of smuggled fields;
//   - the message-stripper drops everything except {role, content};
//   - per-field caps + per-payload byte cap;
//   - dedupeProduces collapses by `extension`;
//   - the composer's three-step pipeline (dedupe → strict parse → byte cap).

import {
  classifierSignalsSchema,
  composeAndValidateClassifierSignals,
  CLASSIFIER_SIGNALS_CAPS,
  dedupeProduces,
  enforceClassifierSignalsByteCap,
  stripChatMessagesForClassifier,
  type ClassifierSignals,
} from "../classifier-signals";

const minimalUpload = {
  originKind: "upload" as const,
};

describe("stripChatMessagesForClassifier", () => {
  it("drops everything except {role, content} and respects last-N cap", () => {
    const raw = [
      { id: "a", role: "user", content: "hi", createdAt: "t1", toolCalls: [{ id: "tc1" }] },
      { id: "b", role: "assistant", content: "yo", thinking: "secret" },
      { id: "c", role: "user", content: "third" },
      { id: "d", role: "user", content: "fourth" },
    ];
    const out = stripChatMessagesForClassifier(raw, { maxMessages: 3, maxContentChars: 100 });
    expect(out).toEqual([
      { role: "assistant", content: "yo" },
      { role: "user", content: "third" },
      { role: "user", content: "fourth" },
    ]);
    // No tool-call / thinking / id field survives.
    for (const m of out) {
      expect(Object.keys(m).sort()).toEqual(["content", "role"]);
    }
  });

  it("truncates message content over maxContentChars (does not throw)", () => {
    const big = "a".repeat(2000);
    const out = stripChatMessagesForClassifier(
      [{ role: "user", content: big }],
      { maxMessages: 10, maxContentChars: 50 },
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.content).toHaveLength(50);
  });

  it("ignores empty-content and non-user/assistant roles", () => {
    const out = stripChatMessagesForClassifier([
      { role: "system", content: "x" },
      { role: "tool", content: "y" },
      { role: "user", content: "" },
      { role: "user", content: "z" },
    ]);
    expect(out).toEqual([{ role: "user", content: "z" }]);
  });
});

describe("dedupeProduces", () => {
  it("collapses duplicates by extension, preserving first occurrence", () => {
    const out = dedupeProduces([
      { extension: "@a/x" },
      { extension: "@b/y" },
      { extension: "@a/x" },
      { extension: "@c/z" },
    ]);
    expect(out).toEqual([
      { extension: "@a/x" },
      { extension: "@b/y" },
      { extension: "@c/z" },
    ]);
  });

  it("filters out malformed entries (missing/non-string extension)", () => {
    const out = dedupeProduces([
      { extension: "@a/x" },
      { extension: 42 } as unknown as { extension: string },
      { extension: "" },
      { extension: "@b/y" },
    ]);
    // empty string is technically a string, but the schema cap below
    // rejects min-len-0 — dedupe itself only drops non-strings.
    expect(out).toEqual([
      { extension: "@a/x" },
      { extension: "" },
      { extension: "@b/y" },
    ]);
  });
});

describe("classifierSignalsSchema (strict)", () => {
  it("accepts minimal upload-only signals", () => {
    const s: ClassifierSignals = { upload: { originKind: "upload" } };
    expect(classifierSignalsSchema.parse(s)).toEqual(s);
  });

  it("rejects unknown top-level fields (closes the smuggling surface)", () => {
    const malicious: unknown = {
      upload: { originKind: "upload" },
      // smuggled field — strict schema MUST reject
      forgedHighConfidence: { extension: "@evil/extension" },
    };
    expect(() => classifierSignalsSchema.parse(malicious)).toThrow();
  });

  it("rejects unknown nested fields under chatContext / produces / upload", () => {
    const cases: Array<unknown> = [
      // chatContext with extra field
      {
        upload: { originKind: "upload" },
        chatContext: { threadId: "t", messages: [], extra: 1 },
      },
      // chatContext.messages[].extra
      {
        upload: { originKind: "upload" },
        chatContext: {
          threadId: "t",
          messages: [{ role: "user", content: "hi", extra: 1 }],
        },
      },
      // produces[].extra
      {
        upload: { originKind: "upload" },
        produces: [{ extension: "@a/x", extra: 1 }],
      },
      // upload.extra
      { upload: { originKind: "upload", extra: 1 } },
    ];
    for (const c of cases) {
      expect(() => classifierSignalsSchema.parse(c)).toThrow();
    }
  });

  it("rejects chatContext with >maxChatMessages messages", () => {
    const tooMany = Array.from(
      { length: CLASSIFIER_SIGNALS_CAPS.maxChatMessages + 1 },
      () => ({ role: "user" as const, content: "x" }),
    );
    expect(() =>
      classifierSignalsSchema.parse({
        upload: minimalUpload,
        chatContext: { threadId: "t", messages: tooMany },
      }),
    ).toThrow();
  });

  it("rejects produces with >maxProducesEntries entries", () => {
    const tooMany = Array.from(
      { length: CLASSIFIER_SIGNALS_CAPS.maxProducesEntries + 1 },
      (_, i) => ({ extension: `@a/x${i}` }),
    );
    expect(() =>
      classifierSignalsSchema.parse({
        upload: minimalUpload,
        produces: tooMany,
      }),
    ).toThrow();
  });
});

describe("enforceClassifierSignalsByteCap", () => {
  it("returns input unchanged when under cap", () => {
    const s: ClassifierSignals = { upload: { originKind: "upload" } };
    expect(enforceClassifierSignalsByteCap(s)).toEqual(s);
  });

  it("drops chat messages oldest-first until cap fits", () => {
    const heavy = "x".repeat(2500);
    const s: ClassifierSignals = {
      upload: { originKind: "upload" },
      chatContext: {
        threadId: "t",
        messages: [
          { role: "user", content: heavy }, // oldest
          { role: "assistant", content: heavy },
          { role: "user", content: heavy }, // newest
        ],
      },
    };
    const out = enforceClassifierSignalsByteCap(s);
    // Final byteLength must be <= cap.
    expect(Buffer.byteLength(JSON.stringify(out), "utf8")).toBeLessThanOrEqual(
      CLASSIFIER_SIGNALS_CAPS.maxSerializedByteLength,
    );
    // If chatContext survives, it has dropped the oldest message(s) first.
    if (out.chatContext) {
      const remaining = out.chatContext.messages;
      // The last message (newest) must be preserved if any messages survive.
      if (remaining.length > 0) {
        expect(remaining[remaining.length - 1]?.content).toBe(heavy);
      }
    }
  });

  it("drops chatContext entirely if messages cannot fit, then trims produces", () => {
    const huge = "x".repeat(10_000);
    const s: ClassifierSignals = {
      upload: { originKind: "upload" },
      chatContext: {
        threadId: "t",
        messages: [{ role: "user", content: huge }],
      },
      produces: Array.from({ length: 16 }, (_, i) => ({
        extension: `@a/x${i}-${"y".repeat(20)}`,
      })),
    };
    const out = enforceClassifierSignalsByteCap(s);
    expect(Buffer.byteLength(JSON.stringify(out), "utf8")).toBeLessThanOrEqual(
      CLASSIFIER_SIGNALS_CAPS.maxSerializedByteLength,
    );
    expect(out.chatContext).toBeUndefined();
  });
});

describe("composeAndValidateClassifierSignals", () => {
  it("dedupes produces, validates with strict schema, then enforces byte cap", () => {
    const out = composeAndValidateClassifierSignals({
      upload: { originKind: "upload", filename: "x.pdf" },
      produces: [{ extension: "@a/x" }, { extension: "@a/x" }, { extension: "@b/y" }],
    });
    expect(out.produces).toEqual([{ extension: "@a/x" }, { extension: "@b/y" }]);
    expect(out.upload.filename).toBe("x.pdf");
  });

  it("throws on schema-invalid input (smuggling surface closed)", () => {
    // The composer runs `classifierSignalsSchema.parse(input)` FIRST,
    // BEFORE destructuring. A smuggled top-level field bypasses TS via
    // `as ClassifierSignals` but the strict zod schema rejects at
    // runtime — proving the smuggling surface is closed for `as any`
    // callers.
    const smuggled = {
      upload: { originKind: "upload" as const },
      forgedClassification: { extension: "@evil/extension" },
    } as unknown as ClassifierSignals;
    expect(() => composeAndValidateClassifierSignals(smuggled)).toThrow();
  });

  it("normalizes empty produces array to omitted", () => {
    const out = composeAndValidateClassifierSignals({
      upload: { originKind: "upload" },
      produces: [],
    });
    expect(out.produces).toBeUndefined();
  });

  // ----- Long scalar fields are truncated instead of suppressing signals. -----
  it("a long upload.filename is TRUNCATED, not rejected (no signal suppression)", () => {
    const long = "a".repeat(1000);
    const out = composeAndValidateClassifierSignals({
      upload: { originKind: "upload", filename: long },
    });
    expect(out.upload.filename).toHaveLength(
      CLASSIFIER_SIGNALS_CAPS.maxIdentifierChars,
    );
  });

  it("long parentId / parentType / declaredMime are truncated, not rejected", () => {
    const long = "x".repeat(1000);
    const out = composeAndValidateClassifierSignals({
      upload: {
        originKind: "upload",
        parentId: long,
        parentType: long,
        declaredMime: long,
      },
    });
    expect(out.upload.parentId).toHaveLength(
      CLASSIFIER_SIGNALS_CAPS.maxIdentifierChars,
    );
    expect(out.upload.parentType).toHaveLength(
      CLASSIFIER_SIGNALS_CAPS.maxIdentifierChars,
    );
    expect(out.upload.declaredMime).toHaveLength(
      CLASSIFIER_SIGNALS_CAPS.maxIdentifierChars,
    );
  });

  it("a long threadId is truncated, not rejected", () => {
    const long = "t".repeat(1000);
    const out = composeAndValidateClassifierSignals({
      upload: { originKind: "upload" },
      chatContext: {
        threadId: long,
        messages: [{ role: "user", content: "hi" }],
      },
    });
    expect(out.chatContext?.threadId).toHaveLength(
      CLASSIFIER_SIGNALS_CAPS.maxThreadIdChars,
    );
  });

  it("a long produces[].extension is truncated, not rejected", () => {
    const long = `@vendor/${"x".repeat(1000)}-artifact`;
    const out = composeAndValidateClassifierSignals({
      upload: { originKind: "upload" },
      produces: [{ extension: long }],
    });
    expect(out.produces?.[0].extension).toHaveLength(
      CLASSIFIER_SIGNALS_CAPS.maxProducesExtensionChars,
    );
  });

  // ----- Message content is capped by the schema, not only by the stripper. -----
  it("message content over 1000 chars is truncated at the SCHEMA level (not just by the stripper)", () => {
    // Direct call to the composer — NOT going through the stripper.
    // The exported leaf contract must enforce the per-message cap.
    const huge = "x".repeat(7000);
    const out = composeAndValidateClassifierSignals({
      upload: { originKind: "upload" },
      chatContext: {
        threadId: "t",
        messages: [{ role: "user", content: huge }],
      },
    });
    expect(out.chatContext?.messages[0]?.content).toHaveLength(
      CLASSIFIER_SIGNALS_CAPS.maxChatMessageContentChars,
    );
  });

  // ----- Pathological combined inputs still fit under the byte cap. -----
  it("pathological combined input (huge messages + huge produces + huge identifiers) fits under the byte cap", () => {
    const huge = "x".repeat(10_000);
    const out = composeAndValidateClassifierSignals({
      upload: {
        originKind: "upload",
        filename: huge,
        declaredMime: huge,
        parentId: huge,
        parentType: huge,
      },
      chatContext: {
        threadId: "t",
        messages: Array.from({ length: 3 }, (_, i) => ({
          role: "user" as const,
          content: `${huge}-${i}`,
        })),
      },
      produces: Array.from({ length: 16 }, (_, i) => ({
        extension: `@vendor/${huge}-${i}`,
      })),
    });
    expect(Buffer.byteLength(JSON.stringify(out), "utf8")).toBeLessThanOrEqual(
      CLASSIFIER_SIGNALS_CAPS.maxSerializedByteLength,
    );
    // The minimal-fallback floor is always `{upload:{originKind,sizeBytes?}}`.
    expect(out.upload.originKind).toBe("upload");
  });
});
