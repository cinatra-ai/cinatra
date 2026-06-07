import { describe, it, expect } from "vitest";
import {
  parseUserEnvelope,
  UserEnvelopeParseError,
} from "../user-envelope";
import type { LlmAttachmentRef } from "@cinatra-ai/llm";

// Opt-in only. body.user is passed VERBATIM to orchestration when
// enabled=false, even when it is literally a JSON object string. With
// enabled=true, strict-schema parse failures THROW so the route can respond
// with a 400 (NEVER silent fallback).

const ref1: LlmAttachmentRef = {
  artifactId: "a1",
  representationRevisionId: "v1",
  digest: "sha256:abc",
  mime: "application/pdf",
  originKind: "upload",
  filename: "in.pdf",
};
const ref2: LlmAttachmentRef = {
  artifactId: "a2",
  representationRevisionId: "v2",
  digest: "sha256:def",
  mime: "image/png",
  originKind: "upload",
};

describe("parseUserEnvelope (opt-in)", () => {
  it("enabled=false: plain string → byte-identical text, no attachments", () => {
    expect(parseUserEnvelope("hello world", false)).toEqual({
      text: "hello world",
    });
  });

  it("enabled=false: a JSON-shaped string is preserved VERBATIM (legacy invariant)", () => {
    // A caller or a user literally typing this JSON must NOT be silently
    // parsed; this is the byte-identical guarantee.
    const raw = JSON.stringify({ text: "hi" });
    expect(parseUserEnvelope(raw, false)).toEqual({ text: raw });
  });

  it("enabled=false + body.attachments → text plain, attachments from body", () => {
    const out = parseUserEnvelope("hi", false, [ref1, ref2]);
    expect(out.text).toBe("hi");
    expect(out.attachments).toEqual([ref1, ref2]);
  });

  it("enabled=true + valid envelope: text + attachments extracted", () => {
    const raw = JSON.stringify({ text: "see attached", attachments: [ref1] });
    const out = parseUserEnvelope(raw, true);
    expect(out.text).toBe("see attached");
    expect(out.attachments).toEqual([ref1]);
  });

  it("enabled=true + envelope without attachments parses cleanly", () => {
    const raw = JSON.stringify({ text: "just text" });
    const out = parseUserEnvelope(raw, true);
    expect(out.text).toBe("just text");
    expect(out.attachments).toBeUndefined();
  });

  it("enabled=true + envelope attachments AND body.attachments → MERGED (envelope first)", () => {
    const raw = JSON.stringify({ text: "see attached", attachments: [ref1] });
    const out = parseUserEnvelope(raw, true, [ref2]);
    expect(out.text).toBe("see attached");
    expect(out.attachments).toEqual([ref1, ref2]);
  });

  it("enabled=true + invalid JSON → THROWS UserEnvelopeParseError", () => {
    expect(() => parseUserEnvelope("{not json", true)).toThrow(
      UserEnvelopeParseError,
    );
  });

  it("enabled=true + JSON that does not match envelope schema → THROWS", () => {
    // strict() rejects extra keys; missing text rejects too.
    expect(() => parseUserEnvelope(JSON.stringify({ junk: 1 }), true)).toThrow(
      UserEnvelopeParseError,
    );
    expect(() =>
      parseUserEnvelope(JSON.stringify({ text: "x", junk: 1 }), true),
    ).toThrow(UserEnvelopeParseError);
  });

  it("enabled=true + 21-attachment envelope is REJECTED (no silent slicing)", () => {
    const many = Array.from({ length: 21 }, (_, i) => ({
      ...ref1,
      artifactId: `a${i}`,
    }));
    const raw = JSON.stringify({ text: "x", attachments: many });
    expect(() => parseUserEnvelope(raw, true)).toThrow(UserEnvelopeParseError);
  });

  it("MERGED 20+20 (envelope + body.attachments) exceeds the total cap → THROWS", () => {
    const env = Array.from({ length: 20 }, (_, i) => ({
      ...ref1,
      artifactId: `env-${i}`,
    }));
    const body = Array.from({ length: 20 }, (_, i) => ({
      ...ref2,
      artifactId: `body-${i}`,
    }));
    const raw = JSON.stringify({ text: "x", attachments: env });
    expect(() => parseUserEnvelope(raw, true, body)).toThrow(
      /merged attachments exceed the 20-ref total/,
    );
  });
});

describe("parseUserEnvelope — back-compat invariant", () => {
  // Pin: the WayFlow Python side may not yet forward
  // `body.user_envelope=true`. Until it does, every resume payload
  // arriving here MUST behave byte-identical to the legacy path.
  // These cases assert that contract so a future change to the parser
  // cannot quietly regress it.

  it("WayFlow runtime not yet updated (enabled=false) + JSON-shaped resume text → text VERBATIM, no envelope parse", () => {
    // The wire payload looks like an envelope but the opt-in flag is
    // not set. Invariant: pass through byte-identical; the model sees
    // the entire JSON string. NEVER auto-parse.
    const wirePayload = JSON.stringify({
      text: "Approved with edits to draft #4.",
      attachments: [
        {
          artifactId: "art_x",
          representationRevisionId: "rep_x",
          digest: "sha256:abc",
          mime: "application/pdf",
          originKind: "upload" as const,
        },
      ],
    });
    const out = parseUserEnvelope(wirePayload, false);
    expect(out.text).toBe(wirePayload);
    expect(out.attachments).toBeUndefined();
  });

  it("WayFlow runtime updated (enabled=true) + envelope shape → text + attachments extracted", () => {
    const text = "Approved with edits to draft #4.";
    const att = {
      artifactId: "art_x",
      representationRevisionId: "rep_x",
      digest: "sha256:abc",
      mime: "application/pdf",
      originKind: "upload" as const,
    };
    const wirePayload = JSON.stringify({ text, attachments: [att] });
    const out = parseUserEnvelope(wirePayload, true);
    expect(out.text).toBe(text);
    expect(out.attachments).toEqual([att]);
  });

  it("WayFlow runtime updated (enabled=true) + malformed envelope → THROWS (no silent fallback to plain text)", () => {
    // Fail-closed posture: if the WayFlow side claims it forwarded an
    // envelope but the bytes do not match, the bridge route MUST 400.
    // Silent fallback would let a half-parsed envelope reach the model.
    expect(() => parseUserEnvelope("not even close to JSON", true)).toThrow(
      /not valid JSON/,
    );
  });
});
