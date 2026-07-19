import { describe, it, expect } from "vitest";
import {
  EMBED_PROTOCOL_VERSION,
  EMBED_MESSAGE_TYPES,
  RESIZE_MAX_HEIGHT,
  embedReadySchema,
  embedBootstrapSchema,
  embedResizeSchema,
  embedApplyIntentSchema,
  embedUplinkSchema,
  originMatchesExpected,
  sourceMatchesExpected,
  evaluateBootstrap,
  createMonotonicSeqGate,
  createSingleUseGate,
} from "@/lib/embed/bridge-protocol";

// A well-formed CSPRNG-shaped base64url id (>=22 chars) for the id fields.
const NONCE = "abcdefghijklmnopqrstuvwxyz012345";
const CORR = "CORRELATION-id_0123456789ABCDEFG";

function validBootstrap(overrides: Record<string, unknown> = {}) {
  return {
    type: EMBED_MESSAGE_TYPES.bootstrap,
    protocolVersion: EMBED_PROTOCOL_VERSION,
    correlationId: CORR,
    nonceEcho: NONCE,
    seq: 0,
    auth: { citToken: "cit_site_transport_token", cwuToken: "cwu_per_user_token" },
    session: { threadId: "thread-1", assistant: "wordpress" },
    cms: { instanceId: "inst-1" },
    ...overrides,
  };
}

describe("bridge-protocol READY (§3a)", () => {
  it("accepts a well-formed READY with no correlationId", () => {
    const r = embedReadySchema.safeParse({
      type: EMBED_MESSAGE_TYPES.ready,
      protocolVersion: 1,
      nonce: NONCE,
      seq: 0,
    });
    expect(r.success).toBe(true);
  });

  it("B13: rejects a READY carrying a correlationId (unknown key, strict)", () => {
    const r = embedReadySchema.safeParse({
      type: EMBED_MESSAGE_TYPES.ready,
      protocolVersion: 1,
      nonce: NONCE,
      seq: 0,
      correlationId: CORR,
    });
    expect(r.success).toBe(false);
  });

  it("rejects a too-short (low-entropy) nonce", () => {
    const r = embedReadySchema.safeParse({
      type: EMBED_MESSAGE_TYPES.ready,
      protocolVersion: 1,
      nonce: "short",
      seq: 0,
    });
    expect(r.success).toBe(false);
  });
});

describe("bridge-protocol BOOTSTRAP schema (§4 / B2)", () => {
  it("accepts a well-formed bootstrap", () => {
    expect(embedBootstrapSchema.safeParse(validBootstrap()).success).toBe(true);
  });

  it("B2: rejects an unknown top-level key (strict)", () => {
    expect(embedBootstrapSchema.safeParse(validBootstrap({ extra: 1 })).success).toBe(false);
  });

  it("B2: rejects an unknown nested key under auth (strict)", () => {
    const bad = validBootstrap({
      auth: { citToken: "cit_x", cwuToken: "cwu_y", leaked: "z" },
    });
    expect(embedBootstrapSchema.safeParse(bad).success).toBe(false);
  });

  it("B2: rejects a wrong protocolVersion", () => {
    expect(embedBootstrapSchema.safeParse(validBootstrap({ protocolVersion: 2 })).success).toBe(false);
  });

  it("B2: rejects a missing/ wrong-prefix cit_ token", () => {
    const bad = validBootstrap({ auth: { citToken: "nope_x", cwuToken: "cwu_y" } });
    expect(embedBootstrapSchema.safeParse(bad).success).toBe(false);
  });

  it("B2: rejects a wrong-prefix cwu_ token", () => {
    const bad = validBootstrap({ auth: { citToken: "cit_x", cwuToken: "nope_y" } });
    expect(embedBootstrapSchema.safeParse(bad).success).toBe(false);
  });

  it("B5: rejects an assistant outside the closed enum", () => {
    const bad = validBootstrap({ session: { threadId: "t", assistant: "shopify" } });
    expect(embedBootstrapSchema.safeParse(bad).success).toBe(false);
  });

  it("§6g: rejects a non-http(s) cms.href", () => {
    const bad = validBootstrap({ cms: { instanceId: "inst-1", href: "javascript:alert(1)" } });
    expect(embedBootstrapSchema.safeParse(bad).success).toBe(false);
  });

  it("§6g: accepts an https cms.href", () => {
    const ok = validBootstrap({ cms: { instanceId: "inst-1", href: "https://site.example/post/1" } });
    expect(embedBootstrapSchema.safeParse(ok).success).toBe(true);
  });
});

describe("bridge-protocol prototype-key guard (§6d)", () => {
  // JSON.parse produces an OWN `__proto__` data property that zod .strict()
  // silently strips; the proto guard must FAIL CLOSED on it, at any depth.
  it("B2: rejects a top-level own __proto__ key on bootstrap", () => {
    const raw = JSON.parse(`{"type":"${EMBED_MESSAGE_TYPES.bootstrap}","protocolVersion":1,"correlationId":"${CORR}","nonceEcho":"${NONCE}","seq":0,"auth":{"citToken":"cit_x","cwuToken":"cwu_y"},"session":{"threadId":"t","assistant":"wordpress"},"cms":{"instanceId":"inst-1"},"__proto__":{"polluted":true}}`);
    expect(embedBootstrapSchema.safeParse(raw).success).toBe(false);
    const d = evaluateBootstrap({
      raw,
      frameNonce: NONCE,
      expectedAssistant: "wordpress",
      expectedInstanceId: "inst-1",
    });
    expect(d).toEqual({ ok: false, reason: "schema" });
  });

  it("B2: rejects a NESTED own __proto__ key under auth", () => {
    const raw = JSON.parse(`{"type":"${EMBED_MESSAGE_TYPES.bootstrap}","protocolVersion":1,"correlationId":"${CORR}","nonceEcho":"${NONCE}","seq":0,"auth":{"citToken":"cit_x","cwuToken":"cwu_y","__proto__":{"x":1}},"session":{"threadId":"t","assistant":"wordpress"},"cms":{"instanceId":"inst-1"}}`);
    expect(embedBootstrapSchema.safeParse(raw).success).toBe(false);
  });

  it("B13: rejects a __proto__ key on READY and on an uplink", () => {
    const ready = JSON.parse(`{"type":"${EMBED_MESSAGE_TYPES.ready}","protocolVersion":1,"nonce":"${NONCE}","seq":0,"__proto__":{"x":1}}`);
    expect(embedReadySchema.safeParse(ready).success).toBe(false);
    const uplink = JSON.parse(`{"type":"${EMBED_MESSAGE_TYPES.resize}","protocolVersion":1,"correlationId":"${CORR}","seq":1,"height":100,"__proto__":{"x":1}}`);
    expect(embedUplinkSchema.safeParse(uplink).success).toBe(false);
  });
});

describe("bridge-protocol origin + source-window binding (§6a / §6a-2 / B1 / B10)", () => {
  it("B1: origin must strictly equal the expected parent origin", () => {
    expect(originMatchesExpected("https://parent.example", "https://parent.example")).toBe(true);
    expect(originMatchesExpected("https://evil.example", "https://parent.example")).toBe(false);
  });

  it("B1: empty / null origins never match", () => {
    expect(originMatchesExpected("", "https://parent.example")).toBe(false);
    expect(originMatchesExpected("https://parent.example", "")).toBe(false);
    expect(originMatchesExpected(null, null)).toBe(false);
  });

  it("B10: source must be the identity-equal expected window", () => {
    const parent = { name: "parent" };
    const sibling = { name: "sibling" };
    expect(sourceMatchesExpected(parent, parent)).toBe(true);
    expect(sourceMatchesExpected(sibling, parent)).toBe(false);
  });

  it("B10: nullish sources never match (undefined event.source)", () => {
    const parent = { name: "parent" };
    expect(sourceMatchesExpected(undefined, parent)).toBe(false);
    expect(sourceMatchesExpected(parent, null)).toBe(false);
  });
});

describe("bridge-protocol evaluateBootstrap (§4 ordered fail-closed / B3 / B5)", () => {
  const base = {
    frameNonce: NONCE,
    expectedAssistant: "wordpress" as const,
    expectedInstanceId: "inst-1",
  };

  it("accepts a fully-agreeing bootstrap", () => {
    const d = evaluateBootstrap({ raw: validBootstrap(), ...base });
    expect(d.ok).toBe(true);
  });

  it("B2: schema failure yields reason 'schema'", () => {
    const d = evaluateBootstrap({ raw: { type: "wrong" }, ...base });
    expect(d).toEqual({ ok: false, reason: "schema" });
  });

  it("B3: a nonceEcho that does not match the frame nonce is rejected", () => {
    const d = evaluateBootstrap({
      raw: validBootstrap({ nonceEcho: "ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ" }),
      ...base,
    });
    expect(d).toEqual({ ok: false, reason: "nonce_mismatch" });
  });

  it("B5: session.assistant != ?assistant is rejected", () => {
    const d = evaluateBootstrap({
      raw: validBootstrap({ session: { threadId: "t", assistant: "drupal" } }),
      ...base,
    });
    expect(d).toEqual({ ok: false, reason: "assistant_mismatch" });
  });

  it("B5: cms.instanceId != ?instanceId is rejected", () => {
    const d = evaluateBootstrap({
      raw: validBootstrap({ cms: { instanceId: "other-inst" } }),
      ...base,
    });
    expect(d).toEqual({ ok: false, reason: "instance_mismatch" });
  });
});

describe("bridge-protocol replay + sequence gates (§6c / B3)", () => {
  it("B3: a non-increasing seq for a direction is dropped", () => {
    const gate = createMonotonicSeqGate();
    expect(gate.accept(0)).toBe(true);
    expect(gate.accept(1)).toBe(true);
    expect(gate.accept(1)).toBe(false); // equal -> drop
    expect(gate.accept(0)).toBe(false); // decrease -> drop
    expect(gate.accept(2)).toBe(true);
  });

  it("B3: the two directions are INDEPENDENT gates", () => {
    const up = createMonotonicSeqGate();
    const down = createMonotonicSeqGate();
    expect(up.accept(5)).toBe(true);
    expect(down.accept(0)).toBe(true); // down is not constrained by up's 5
    expect(down.accept(1)).toBe(true);
  });

  it("B3: a second bootstrap on a burned nonce is ignored", () => {
    const gate = createSingleUseGate();
    expect(gate.consume()).toBe(true);
    expect(gate.consume()).toBe(false);
    expect(gate.used).toBe(true);
  });
});

describe("bridge-protocol uplinks (§5 / B9)", () => {
  const up = { protocolVersion: 1, correlationId: CORR, seq: 1 };

  it("B9: rejects a negative height", () => {
    const r = embedResizeSchema.safeParse({ type: EMBED_MESSAGE_TYPES.resize, ...up, height: -1 });
    expect(r.success).toBe(false);
  });

  it("B9: rejects a NaN height", () => {
    const r = embedResizeSchema.safeParse({ type: EMBED_MESSAGE_TYPES.resize, ...up, height: NaN });
    expect(r.success).toBe(false);
  });

  it("B9: rejects a height above the schema max", () => {
    const r = embedResizeSchema.safeParse({
      type: EMBED_MESSAGE_TYPES.resize,
      ...up,
      height: RESIZE_MAX_HEIGHT + 1,
    });
    expect(r.success).toBe(false);
  });

  it("B9: accepts a valid height (parent clamps to its panel max separately)", () => {
    const r = embedResizeSchema.safeParse({ type: EMBED_MESSAGE_TYPES.resize, ...up, height: 800 });
    expect(r.success).toBe(true);
  });

  it("B14: apply_intent requires exactly one of proposalId/changeSetId", () => {
    const both = embedApplyIntentSchema.safeParse({
      type: EMBED_MESSAGE_TYPES.applyIntent,
      ...up,
      proposalId: "p1",
      changeSetId: "c1",
      viewType: "content_change_proposal",
    });
    expect(both.success).toBe(false);
    const neither = embedApplyIntentSchema.safeParse({
      type: EMBED_MESSAGE_TYPES.applyIntent,
      ...up,
      viewType: "content_change_proposal",
    });
    expect(neither.success).toBe(false);
    const one = embedApplyIntentSchema.safeParse({
      type: EMBED_MESSAGE_TYPES.applyIntent,
      ...up,
      proposalId: "p1",
      viewType: "content_change_proposal",
    });
    expect(one.success).toBe(true);
  });

  it("B14: apply_intent rejects an arbitrary viewType (closed enum)", () => {
    const r = embedApplyIntentSchema.safeParse({
      type: EMBED_MESSAGE_TYPES.applyIntent,
      ...up,
      proposalId: "p1",
      viewType: "artifact_preview",
    });
    expect(r.success).toBe(false);
  });

  it("B6/B13: the uplink union rejects a bootstrap-shaped message (closed allowlist)", () => {
    const r = embedUplinkSchema.safeParse(validBootstrap());
    expect(r.success).toBe(false);
  });

  it("B13: the uplink union rejects an unknown type", () => {
    const r = embedUplinkSchema.safeParse({ type: "cinatra.embed.evil", ...up });
    expect(r.success).toBe(false);
  });
});
