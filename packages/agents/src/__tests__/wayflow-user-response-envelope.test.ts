import { describe, it, expect } from "vitest";
import {
  wrapUserResponseWithAttachments,
  tryParseWrappedUserResponse,
} from "../wayflow-user-response-envelope";
import type { LlmAttachmentRef } from "@cinatra-ai/llm";

const REF_A: LlmAttachmentRef = {
  artifactId: "art-a",
  representationRevisionId: "rep-a",
  digest: "sha256:aaa",
  mime: "application/pdf",
  originKind: "upload",
  filename: "deck.pdf",
  title: "deck.pdf",
  size: 4096,
};
const REF_B: LlmAttachmentRef = {
  artifactId: "art-b",
  representationRevisionId: "rep-b",
  digest: "sha256:bbb",
  mime: "image/png",
  originKind: "email_attachment",
};

describe("wrapUserResponseWithAttachments", () => {
  it("NO attachments → byte-identical legacy text (back-compat invariant)", () => {
    const r1 = wrapUserResponseWithAttachments("plain text");
    expect(r1.wrapped).toBe(false);
    expect(r1.userResponse).toBe("plain text");

    // empty array == undefined
    const r2 = wrapUserResponseWithAttachments("plain text", []);
    expect(r2.wrapped).toBe(false);
    expect(r2.userResponse).toBe("plain text");

    // null is also fine
    const r3 = wrapUserResponseWithAttachments("plain text", null);
    expect(r3.wrapped).toBe(false);
    expect(r3.userResponse).toBe("plain text");
  });

  it("STRUCTURED-JSON payload survives byte-identical inside `text` when wrapped", () => {
    const renderer = JSON.stringify({
      campaignId: "c1",
      approved: true,
      approvedAt: "2026-05-18T19:00:00Z",
    });
    const r = wrapUserResponseWithAttachments(renderer, [REF_A]);
    expect(r.wrapped).toBe(true);
    const parsed = JSON.parse(r.userResponse) as {
      text: string;
      attachments: LlmAttachmentRef[];
    };
    expect(parsed.text).toBe(renderer); // <-- byte-identical
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0].artifactId).toBe("art-a");
    // The nested-JSON consumer can RE-PARSE the text field and get the
    // ORIGINAL structured payload back unchanged.
    const innerAgain = JSON.parse(parsed.text) as {
      campaignId: string;
      approved: boolean;
    };
    expect(innerAgain).toEqual({
      campaignId: "c1",
      approved: true,
      approvedAt: "2026-05-18T19:00:00Z",
    });
  });

  it("smuggled extra fields on a ref are STRIPPED to the parser-accepted shape", () => {
    // A renderer mis-using `as any` could push extra fields. The
    // wrapper filters them so the bridge parser (refSchema.strict())
    // never rejects.
    const smuggled = {
      ...REF_A,
      // Real LlmAttachmentRef has NO `confidence` or `evil` fields.
      // The parser's `.strict()` would 400 — strip BEFORE emit.
      confidence: 0.99,
      evil: { __proto__: null, x: 1 },
    } as unknown as LlmAttachmentRef;
    const r = wrapUserResponseWithAttachments("x", [smuggled]);
    const parsed = JSON.parse(r.userResponse) as {
      attachments: Array<Record<string, unknown>>;
    };
    const ref = parsed.attachments[0];
    expect(ref.confidence).toBeUndefined();
    expect(ref.evil).toBeUndefined();
    // All canonical fields preserved.
    expect(ref).toEqual({
      artifactId: "art-a",
      representationRevisionId: "rep-a",
      digest: "sha256:aaa",
      mime: "application/pdf",
      originKind: "upload",
      filename: "deck.pdf",
      title: "deck.pdf",
      size: 4096,
    });
  });

  it("attachment order is preserved across the wrap", () => {
    const r = wrapUserResponseWithAttachments("x", [REF_B, REF_A]);
    const parsed = JSON.parse(r.userResponse) as {
      attachments: LlmAttachmentRef[];
    };
    expect(parsed.attachments.map((r) => r.artifactId)).toEqual([
      "art-b",
      "art-a",
    ]);
  });

  it("caps at 20 refs (mirroring the bridge parser's max)", () => {
    const many: LlmAttachmentRef[] = Array.from({ length: 25 }, (_, i) => ({
      ...REF_A,
      artifactId: `art-${i}`,
    }));
    const r = wrapUserResponseWithAttachments("x", many);
    const parsed = JSON.parse(r.userResponse) as {
      attachments: LlmAttachmentRef[];
    };
    expect(parsed.attachments).toHaveLength(20);
    expect(parsed.attachments[0].artifactId).toBe("art-0");
    expect(parsed.attachments[19].artifactId).toBe("art-19");
  });

  it("optional ref fields (title/filename/size) are forwarded only when present", () => {
    const r = wrapUserResponseWithAttachments("x", [REF_B]);
    const parsed = JSON.parse(r.userResponse) as {
      attachments: Array<Record<string, unknown>>;
    };
    const ref = parsed.attachments[0];
    // REF_B has none of these.
    expect("title" in ref).toBe(false);
    expect("filename" in ref).toBe(false);
    expect("size" in ref).toBe(false);
  });
});

describe("validation gate", () => {
  it("malformed refs are FILTERED OUT (validate-then-cap, not slice-then-pick)", () => {
    const mixed: unknown[] = [
      null, // null entry
      {}, // empty
      { artifactId: "" }, // empty required string
      { ...REF_A, originKind: "bogus" }, // bad enum
      REF_A, // VALID
      { ...REF_B, size: -1 }, // negative size — invalid but size is optional, so the rest passes minus size
      { ...REF_A, artifactId: "art-c" }, // VALID
    ];
    const r = wrapUserResponseWithAttachments(
      "x",
      mixed as LlmAttachmentRef[],
    );
    expect(r.wrapped).toBe(true);
    const parsed = JSON.parse(r.userResponse) as {
      attachments: Array<Record<string, unknown>>;
    };
    expect(parsed.attachments.map((r) => r.artifactId)).toEqual([
      "art-a",
      "art-b",
      "art-c",
    ]);
    // The size:-1 entry passes the required-field gate but `size` is
    // dropped (the int+nonneg check filters that field only).
    const refB = parsed.attachments.find((r) => r.artifactId === "art-b")!;
    expect("size" in refB).toBe(false);
  });

  it("ALL-malformed → fall back to legacy byte-identical text (never blocks the gate)", () => {
    const allBad = [
      null,
      {},
      { artifactId: "x" },
      "not-an-object",
    ] as unknown as LlmAttachmentRef[];
    const r = wrapUserResponseWithAttachments("plain text", allBad);
    expect(r.wrapped).toBe(false);
    expect(r.userResponse).toBe("plain text");
  });

  it("cap applies to VALID survivors (25 valid → 20 valid kept; trailing invalid never counted)", () => {
    const refs: unknown[] = [];
    for (let i = 0; i < 25; i++) refs.push({ ...REF_A, artifactId: `art-${i}` });
    // Sprinkle some invalid refs to confirm slice-after-validate is right.
    refs.push(null, {}, { artifactId: "" });
    const r = wrapUserResponseWithAttachments(
      "x",
      refs as LlmAttachmentRef[],
    );
    const parsed = JSON.parse(r.userResponse) as {
      attachments: LlmAttachmentRef[];
    };
    expect(parsed.attachments).toHaveLength(20);
    expect(parsed.attachments[0].artifactId).toBe("art-0");
    expect(parsed.attachments[19].artifactId).toBe("art-19");
  });

  it("originKind must be one of the 5 enum values", () => {
    const goodKinds: LlmAttachmentRef["originKind"][] = [
      "upload",
      "email_attachment",
      "agent_generated",
      "external_link",
      "live_generator",
    ];
    for (const k of goodKinds) {
      const r = wrapUserResponseWithAttachments("x", [
        { ...REF_A, originKind: k },
      ]);
      expect(r.wrapped).toBe(true);
    }
    // Bad enum → all-invalid → legacy
    const bad = wrapUserResponseWithAttachments("x", [
      { ...REF_A, originKind: "unknown_kind" as never },
    ]);
    expect(bad.wrapped).toBe(false);
  });

  it("never throws on adversarial inputs (proxies / throwing getters / cycles)", () => {
    const throwy = new Proxy(
      {},
      {
        get() {
          throw new Error("getter boom");
        },
      },
    );
    expect(() =>
      wrapUserResponseWithAttachments("x", [
        throwy as LlmAttachmentRef,
      ]),
    ).not.toThrow();
    // Result is legacy fallback (no valid refs survived).
    const r = wrapUserResponseWithAttachments("x", [
      throwy as LlmAttachmentRef,
    ]);
    expect(r.wrapped).toBe(false);
  });
});

describe("tryParseWrappedUserResponse (strict bridge-rejection mirror)", () => {
  it("round-trips a wrapped envelope BYTE-EXACTLY back to the sanitized refs", () => {
    const wrapped = wrapUserResponseWithAttachments("hello", [REF_A, REF_B]);
    const back = tryParseWrappedUserResponse(wrapped.userResponse);
    expect(back).not.toBeNull();
    expect(back!.text).toBe("hello");
    expect(back!.attachments).toHaveLength(2);
    // Exact shape — every field on the wrap side comes back.
    expect(back!.attachments[0]).toEqual({
      artifactId: "art-a",
      representationRevisionId: "rep-a",
      digest: "sha256:aaa",
      mime: "application/pdf",
      originKind: "upload",
      filename: "deck.pdf",
      title: "deck.pdf",
      size: 4096,
    });
    expect(back!.attachments[1]).toEqual({
      artifactId: "art-b",
      representationRevisionId: "rep-b",
      digest: "sha256:bbb",
      mime: "image/png",
      originKind: "email_attachment",
    });
  });

  it("returns null for legacy plain text (NOT an envelope)", () => {
    expect(tryParseWrappedUserResponse("[Approved by operator]")).toBeNull();
    expect(
      tryParseWrappedUserResponse(JSON.stringify({ campaignId: "c1" })),
    ).toBeNull();
  });

  it("returns null for malformed JSON / missing required `text`", () => {
    expect(tryParseWrappedUserResponse("{not json")).toBeNull();
    // text missing → required field → null
    expect(
      tryParseWrappedUserResponse(JSON.stringify({ attachments: [] })),
    ).toBeNull();
    // attachments non-array → null
    expect(
      tryParseWrappedUserResponse(JSON.stringify({ text: "x", attachments: "not-array" })),
    ).toBeNull();
  });

  it("bridge accepts text-only envelope (attachments OPTIONAL): tryParse mirrors this with attachments:[]", () => {
    const back = tryParseWrappedUserResponse(JSON.stringify({ text: "x" }));
    expect(back).toEqual({ text: "x", attachments: [] });
    const back2 = tryParseWrappedUserResponse(
      JSON.stringify({ text: "y", attachments: [] }),
    );
    expect(back2).toEqual({ text: "y", attachments: [] });
  });

  it("STRICT: rejects an envelope with top-level extra fields", () => {
    const payload = JSON.stringify({
      text: "x",
      attachments: [REF_A],
      smuggled: true,
    });
    expect(tryParseWrappedUserResponse(payload)).toBeNull();
  });

  it("STRICT: rejects attachments.length > 20", () => {
    const many = Array.from({ length: 21 }, (_, i) => ({
      ...REF_A,
      artifactId: `art-${i}`,
    }));
    const payload = JSON.stringify({ text: "x", attachments: many });
    expect(tryParseWrappedUserResponse(payload)).toBeNull();
  });

  it("STRICT: a single invalid ref FAILS THE WHOLE PARSE (no silent filter)", () => {
    const payload = JSON.stringify({
      text: "x",
      attachments: [REF_A, { artifactId: "no-rest-of-fields" }],
    });
    expect(tryParseWrappedUserResponse(payload)).toBeNull();
  });

  it("STRICT: ref with UNKNOWN keys → null (refSchema.strict() rejection)", () => {
    const badRef = { ...REF_A, smuggled: "x" };
    const payload = JSON.stringify({ text: "x", attachments: [badRef] });
    expect(tryParseWrappedUserResponse(payload)).toBeNull();
  });

  it("STRICT: ref with present-but-invalid `size` (-1) → null (bridge `.nonnegative()` rejection)", () => {
    const badRef = { ...REF_A, size: -1 };
    const payload = JSON.stringify({ text: "x", attachments: [badRef] });
    expect(tryParseWrappedUserResponse(payload)).toBeNull();
  });

  it("STRICT: ref with present-but-invalid `title` (non-string) → null", () => {
    const badRef = { ...REF_A, title: 42 };
    const payload = JSON.stringify({ text: "x", attachments: [badRef] });
    expect(tryParseWrappedUserResponse(payload)).toBeNull();
  });

  it("STRICT: ref with present-but-invalid `filename` (non-string) → null", () => {
    const badRef = { ...REF_A, filename: false };
    const payload = JSON.stringify({ text: "x", attachments: [badRef] });
    expect(tryParseWrappedUserResponse(payload)).toBeNull();
  });

  it("STRICT: omitted optional fields (size/title/filename undefined) → still accepted", () => {
    const payload = JSON.stringify({
      text: "x",
      attachments: [REF_B], // REF_B has no title/filename/size
    });
    const back = tryParseWrappedUserResponse(payload);
    expect(back).not.toBeNull();
    expect(back!.attachments).toHaveLength(1);
    expect(back!.attachments[0].artifactId).toBe("art-b");
  });
});
