import { describe, it, expect, vi } from "vitest";
import {
  EMBED_PROTOCOL_VERSION,
  EMBED_MESSAGE_TYPES,
  RESIZE_MAX_HEIGHT,
  embedReadySchema,
  embedContextSchema,
  embedResizeSchema,
  embedApplyIntentSchema,
  embedUplinkSchema,
  originMatchesExpected,
  sourceMatchesExpected,
  evaluateContext,
  createMonotonicSeqGate,
  createSingleUseGate,
  selectParentContextTransport,
  sendContextOverTransport,
  containsCredentialShapedValue,
  isCredentialShapedValue,
  RETIRED_BOOTSTRAP_MESSAGE_TYPE,
  RETIRED_CREDENTIAL_PROTOCOL_VERSION,
  type EmbedContext,
} from "@/lib/embed/bridge-protocol";

// A well-formed CSPRNG-shaped base64url id (>=22 chars) for the id fields.
const NONCE = "abcdefghijklmnopqrstuvwxyz012345";
const CORR = "CORRELATION-id_0123456789ABCDEFG";

function validContext(overrides: Record<string, unknown> = {}) {
  return {
    type: EMBED_MESSAGE_TYPES.context,
    protocolVersion: EMBED_PROTOCOL_VERSION,
    correlationId: CORR,
    nonceEcho: NONCE,
    seq: 0,
    session: { threadId: "thread-1", assistant: "wordpress" },
    cms: { instanceId: "inst-1" },
    ...overrides,
  };
}

describe("bridge-protocol READY (§3a)", () => {
  it("accepts a well-formed READY with no correlationId", () => {
    const r = embedReadySchema.safeParse({
      type: EMBED_MESSAGE_TYPES.ready,
      protocolVersion: EMBED_PROTOCOL_VERSION,
      nonce: NONCE,
      seq: 0,
    });
    expect(r.success).toBe(true);
  });

  it("B13: rejects a READY carrying a correlationId (unknown key, strict)", () => {
    const r = embedReadySchema.safeParse({
      type: EMBED_MESSAGE_TYPES.ready,
      protocolVersion: EMBED_PROTOCOL_VERSION,
      nonce: NONCE,
      seq: 0,
      correlationId: CORR,
    });
    expect(r.success).toBe(false);
  });

  it("rejects a too-short (low-entropy) nonce", () => {
    const r = embedReadySchema.safeParse({
      type: EMBED_MESSAGE_TYPES.ready,
      protocolVersion: EMBED_PROTOCOL_VERSION,
      nonce: "short",
      seq: 0,
    });
    expect(r.success).toBe(false);
  });
});

describe("bridge-protocol CONTEXT schema (§4 / B2)", () => {
  it("accepts a well-formed context message", () => {
    expect(embedContextSchema.safeParse(validContext()).success).toBe(true);
  });

  it("accepts the optional public site selector", () => {
    const ok = validContext({ site: { siteId: "site-public-handle" } });
    expect(embedContextSchema.safeParse(ok).success).toBe(true);
  });

  it("B2: rejects an unknown top-level key (strict)", () => {
    expect(embedContextSchema.safeParse(validContext({ extra: 1 })).success).toBe(false);
  });

  it("B2: rejects a wrong protocolVersion", () => {
    expect(embedContextSchema.safeParse(validContext({ protocolVersion: 99 })).success).toBe(false);
  });

  it("B5: rejects an assistant outside the closed enum", () => {
    const bad = validContext({ session: { threadId: "t", assistant: "shopify" } });
    expect(embedContextSchema.safeParse(bad).success).toBe(false);
  });

  it("§6g: rejects a non-http(s) cms.href", () => {
    const bad = validContext({ cms: { instanceId: "inst-1", href: "javascript:alert(1)" } });
    expect(embedContextSchema.safeParse(bad).success).toBe(false);
  });

  it("§6g: accepts an https cms.href", () => {
    const ok = validContext({ cms: { instanceId: "inst-1", href: "https://site.example/post/1" } });
    expect(embedContextSchema.safeParse(ok).success).toBe(true);
  });
});

describe("bridge-protocol prototype-key guard (§6d)", () => {
  // JSON.parse produces an OWN `__proto__` data property that zod .strict()
  // silently strips; the proto guard must FAIL CLOSED on it, at any depth.
  it("B2: rejects a top-level own __proto__ key on the context message", () => {
    const raw = JSON.parse(`{"type":"${EMBED_MESSAGE_TYPES.context}","protocolVersion":${EMBED_PROTOCOL_VERSION},"correlationId":"${CORR}","nonceEcho":"${NONCE}","seq":0,"session":{"threadId":"t","assistant":"wordpress"},"cms":{"instanceId":"inst-1"},"__proto__":{"polluted":true}}`);
    expect(embedContextSchema.safeParse(raw).success).toBe(false);
    const d = evaluateContext({
      raw,
      frameNonce: NONCE,
      expectedAssistant: "wordpress",
      expectedInstanceId: "inst-1",
    });
    expect(d).toEqual({ ok: false, reason: "schema" });
  });

  it("B2: rejects a NESTED own __proto__ key under cms", () => {
    const raw = JSON.parse(`{"type":"${EMBED_MESSAGE_TYPES.context}","protocolVersion":${EMBED_PROTOCOL_VERSION},"correlationId":"${CORR}","nonceEcho":"${NONCE}","seq":0,"session":{"threadId":"t","assistant":"wordpress"},"cms":{"instanceId":"inst-1","__proto__":{"x":1}}}`);
    expect(embedContextSchema.safeParse(raw).success).toBe(false);
  });

  it("B13: rejects a __proto__ key on READY and on an uplink", () => {
    const ready = JSON.parse(`{"type":"${EMBED_MESSAGE_TYPES.ready}","protocolVersion":${EMBED_PROTOCOL_VERSION},"nonce":"${NONCE}","seq":0,"__proto__":{"x":1}}`);
    expect(embedReadySchema.safeParse(ready).success).toBe(false);
    const uplink = JSON.parse(`{"type":"${EMBED_MESSAGE_TYPES.resize}","protocolVersion":${EMBED_PROTOCOL_VERSION},"correlationId":"${CORR}","seq":1,"height":100,"__proto__":{"x":1}}`);
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

describe("bridge-protocol evaluateContext (§4 ordered fail-closed / B3 / B5)", () => {
  const base = {
    frameNonce: NONCE,
    expectedAssistant: "wordpress" as const,
    expectedInstanceId: "inst-1",
  };

  it("accepts a fully-agreeing context message", () => {
    const d = evaluateContext({ raw: validContext(), ...base });
    expect(d.ok).toBe(true);
  });

  it("B2: schema failure yields reason 'schema'", () => {
    const d = evaluateContext({ raw: { type: "wrong" }, ...base });
    expect(d).toEqual({ ok: false, reason: "schema" });
  });

  it("B3: a nonceEcho that does not match the frame nonce is rejected", () => {
    const d = evaluateContext({
      raw: validContext({ nonceEcho: "ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ" }),
      ...base,
    });
    expect(d).toEqual({ ok: false, reason: "nonce_mismatch" });
  });

  it("B5: session.assistant != ?assistant is rejected", () => {
    const d = evaluateContext({
      raw: validContext({ session: { threadId: "t", assistant: "drupal" } }),
      ...base,
    });
    expect(d).toEqual({ ok: false, reason: "assistant_mismatch" });
  });

  it("B5: cms.instanceId != ?instanceId is rejected", () => {
    const d = evaluateContext({
      raw: validContext({ cms: { instanceId: "other-inst" } }),
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

  it("B3: a second context message on a burned nonce is ignored", () => {
    const gate = createSingleUseGate();
    expect(gate.consume()).toBe(true);
    expect(gate.consume()).toBe(false);
    expect(gate.used).toBe(true);
  });
});

describe("bridge-protocol uplinks (§5 / B9)", () => {
  const up = { protocolVersion: EMBED_PROTOCOL_VERSION, correlationId: CORR, seq: 1 };

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

  it("B6/B13: the uplink union rejects a context-shaped message (closed allowlist)", () => {
    const r = embedUplinkSchema.safeParse(validContext());
    expect(r.success).toBe(false);
  });

  it("B13: the uplink union rejects an unknown type", () => {
    const r = embedUplinkSchema.safeParse({ type: "cinatra.embed.evil", ...up });
    expect(r.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §12b — PORT-BOUND TRANSPORT (issue #1965). The PARENT-side transport primitives
// the two CMS widgets mirror. At protocol 2 (cinatra#2674) NO message on this
// bridge carries a credential in either direction, so these cases assert the
// channel binding itself: in PORT mode the message rides ONLY the entangled port
// the pre-navigation realm established, and the whole handshake is credential-free.
// ---------------------------------------------------------------------------
describe("bridge-protocol §12b READY handshake is credential-free", () => {
  it("a well-formed READY parses and carries NO cit_/cwu_ token", () => {
    const ready = { type: EMBED_MESSAGE_TYPES.ready, protocolVersion: EMBED_PROTOCOL_VERSION, nonce: NONCE, seq: 0 };
    expect(embedReadySchema.safeParse(ready).success).toBe(true);
    const serialized = JSON.stringify(ready);
    expect(serialized).not.toContain("cit_");
    expect(serialized).not.toContain("cwu_");
  });

  it("a token-bearing field on READY is rejected (strict) — READY can never carry auth", () => {
    const bad = {
      type: EMBED_MESSAGE_TYPES.ready,
      protocolVersion: EMBED_PROTOCOL_VERSION,
      nonce: NONCE,
      seq: 0,
      auth: { citToken: "cit_x", cwuToken: "cwu_y" },
    };
    expect(embedReadySchema.safeParse(bad).success).toBe(false);
  });
});

describe("bridge-protocol §12b selectParentContextTransport (downgrade-resistant)", () => {
  const PARENT = "https://cms.example.com";
  const fallbackWindow = { postMessage: vi.fn() };

  it("selects PORT mode when the iframe transferred a port", () => {
    const port = { postMessage: vi.fn() };
    const d = selectParentContextTransport({
      transferredPorts: [port],
      fallbackWindow,
      fallbackTargetOrigin: PARENT,
      requirePort: false,
    });
    expect(d.ok).toBe(true);
    expect(d.ok && d.transport.mode).toBe("port");
  });

  it("FAILS CLOSED (no_port_available) with no port under requirePort — no downgrade by stripping the port", () => {
    const d = selectParentContextTransport({
      transferredPorts: [],
      fallbackWindow,
      fallbackTargetOrigin: PARENT,
      requirePort: true,
    });
    expect(d).toEqual({ ok: false, reason: "no_port_available" });
  });

  it("null/undefined ports also fail closed under requirePort", () => {
    for (const ports of [null, undefined]) {
      const d = selectParentContextTransport({
        transferredPorts: ports,
        fallbackWindow,
        fallbackTargetOrigin: PARENT,
        requirePort: true,
      });
      expect(d).toEqual({ ok: false, reason: "no_port_available" });
    }
  });

  it("falls back to WINDOW mode with no port only when the window path is allowed", () => {
    const d = selectParentContextTransport({
      transferredPorts: [],
      fallbackWindow,
      fallbackTargetOrigin: PARENT,
      requirePort: false,
    });
    expect(d.ok).toBe(true);
    expect(d.ok && d.transport.mode).toBe("window");
  });
});

describe("bridge-protocol §12b sendContextOverTransport — no token-bearing postMessage in port mode", () => {
  const PARENT = "https://cms.example.com";
  const context = validContext() as unknown as EmbedContext;

  it("REGRESSION: in PORT mode the context message rides ONLY the port — window.postMessage is never called", () => {
    const port = { postMessage: vi.fn() };
    const fallbackWindow = { postMessage: vi.fn() };
    const decision = selectParentContextTransport({
      transferredPorts: [port],
      fallbackWindow,
      fallbackTargetOrigin: PARENT,
      requirePort: true, // strictest: both peers require the port
    });
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    sendContextOverTransport(decision.transport, context);
    // the message went over the port …
    expect(port.postMessage).toHaveBeenCalledTimes(1);
    expect(port.postMessage).toHaveBeenCalledWith(context);
    // … and NEVER via a window-targeted postMessage.
    expect(fallbackWindow.postMessage).not.toHaveBeenCalled();
    const windowSerialized = JSON.stringify(fallbackWindow.postMessage.mock.calls);
    expect(windowSerialized).not.toContain("cit_");
    expect(windowSerialized).not.toContain("cwu_");
  });

  it("in WINDOW mode posts to the origin-pinned window, never '*'", () => {
    const fallbackWindow = { postMessage: vi.fn() };
    const decision = selectParentContextTransport({
      transferredPorts: [],
      fallbackWindow,
      fallbackTargetOrigin: PARENT,
      requirePort: false,
    });
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    sendContextOverTransport(decision.transport, context);
    expect(fallbackWindow.postMessage).toHaveBeenCalledWith(context, PARENT);
  });

  it("WINDOW mode FAILS CLOSED on a wildcard/empty target origin — nothing is broadcast", () => {
    for (const fallbackTargetOrigin of ["*", ""]) {
      const fallbackWindow = { postMessage: vi.fn() };
      const sent = sendContextOverTransport(
        { mode: "window", window: fallbackWindow, targetOrigin: fallbackTargetOrigin },
        context,
      );
      expect(sent).toBe(false);
      expect(fallbackWindow.postMessage).not.toHaveBeenCalled();
    }
  });

  it("a no-port READY under requirePort sends NOTHING (fail closed)", () => {
    const fallbackWindow = { postMessage: vi.fn() };
    const decision = selectParentContextTransport({
      transferredPorts: [],
      fallbackWindow,
      fallbackTargetOrigin: PARENT,
      requirePort: true,
    });
    // The caller sends only on ok; a fail-closed decision emits no traffic.
    if (decision.ok) sendContextOverTransport(decision.transport, context);
    expect(fallbackWindow.postMessage).not.toHaveBeenCalled();
  });

  it("single-use binding: a REPLACEMENT no-port READY on a burned nonce cannot re-open the window channel", () => {
    // Parent binds the transport to the frame's single-use nonce gate: the first
    // (port) READY consumes it; a later replacement's no-port READY is ignored,
    // so it can never coax the parent onto the window channel.
    const nonceGate = createSingleUseGate();
    const port = { postMessage: vi.fn() };
    const fallbackWindow = { postMessage: vi.fn() };

    // READY #1 — the genuine iframe transferred a port; parent commits.
    if (nonceGate.consume()) {
      const d1 = selectParentContextTransport({
        transferredPorts: [port],
        fallbackWindow,
        fallbackTargetOrigin: PARENT,
        requirePort: false,
      });
      if (d1.ok) sendContextOverTransport(d1.transport, context);
    }
    // READY #2 — a same-origin replacement, no port; the burned nonce drops it.
    if (nonceGate.consume()) {
      const d2 = selectParentContextTransport({
        transferredPorts: [],
        fallbackWindow,
        fallbackTargetOrigin: PARENT,
        requirePort: false,
      });
      if (d2.ok) sendContextOverTransport(d2.transport, context);
    }

    expect(port.postMessage).toHaveBeenCalledTimes(1); // only the genuine send
    expect(fallbackWindow.postMessage).not.toHaveBeenCalled(); // no window send
  });
});

// ---------------------------------------------------------------------------
// cinatra#2674 (epic #2564 S8e) — THE CREDENTIAL IS GONE FROM THE BRIDGE.
//
// AC-1 of the issue: "Protocol unit tests prove the new parent↔iframe schemas
// contain no credential field and reject credential-bearing or unknown fields.
// The breaking protocol version is advanced."
//
// Each case below is NEGATIVE-CONTROLLED: the credential-free twin of every
// rejected message is asserted to PARSE, so a test that passes because the
// fixture is malformed for some other reason cannot hide here.
// ---------------------------------------------------------------------------
describe("cinatra#2674 — the context schema has no credential field", () => {
  it("the breaking protocol version is advanced past the credential-bearing one", () => {
    expect(EMBED_PROTOCOL_VERSION).toBeGreaterThan(RETIRED_CREDENTIAL_PROTOCOL_VERSION);
  });

  it("REJECTS a protocol-1 credential-bearing bootstrap in full; ACCEPTS the v2 twin", () => {
    const v1 = {
      type: RETIRED_BOOTSTRAP_MESSAGE_TYPE,
      protocolVersion: RETIRED_CREDENTIAL_PROTOCOL_VERSION,
      correlationId: CORR,
      nonceEcho: NONCE,
      seq: 0,
      auth: { citToken: "cit_site_transport", cwuToken: "cwu_per_user" },
      session: { threadId: "thread-1", assistant: "wordpress" },
      cms: { instanceId: "inst-1" },
    };
    expect(embedContextSchema.safeParse(v1).success).toBe(false);
    expect(
      evaluateContext({
        raw: v1,
        frameNonce: NONCE,
        expectedAssistant: "wordpress",
        expectedInstanceId: "inst-1",
      }),
    ).toEqual({ ok: false, reason: "schema" });
    // NEGATIVE CONTROL: the same message minus the credential, at v2, parses.
    expect(embedContextSchema.safeParse(validContext()).success).toBe(true);
  });

  it("REJECTS an `auth` block even at the new version and type (no credential field exists)", () => {
    const bad = validContext({
      auth: { citToken: "cit_site_transport", cwuToken: "cwu_per_user" },
    });
    expect(embedContextSchema.safeParse(bad).success).toBe(false);
  });

  it("REJECTS the retired message TYPE at the new version", () => {
    const bad = validContext({ type: RETIRED_BOOTSTRAP_MESSAGE_TYPE });
    expect(embedContextSchema.safeParse(bad).success).toBe(false);
  });

  it("REJECTS any unknown field, credential-named or not (strict)", () => {
    for (const extra of [
      { token: "anything" },
      { citToken: "cit_x" },
      { cwuToken: "cwu_y" },
      { bearer: "x" },
      { harmlessTypo: 1 },
    ]) {
      expect(embedContextSchema.safeParse(validContext(extra)).success).toBe(false);
    }
    // NEGATIVE CONTROL: with none of them, the same fixture parses.
    expect(embedContextSchema.safeParse(validContext()).success).toBe(true);
  });
});

describe("cinatra#2674 — no credential-shaped VALUE, in either direction", () => {
  it("recognises each minted bearer prefix, trimmed and case-insensitively", () => {
    for (const value of ["cwu_abc", "cit_abc", "cnx_abc", "  CWU_ABC  ", "Cit_x"]) {
      expect(isCredentialShapedValue(value)).toBe(true);
    }
    for (const value of ["citation", "cwuppercase-no-underscore", "", 42, null, {}]) {
      expect(isCredentialShapedValue(value)).toBe(false);
    }
  });

  it("finds one at any depth — object value, array member, or KEY", () => {
    expect(containsCredentialShapedValue({ a: { b: ["x", "cwu_leak"] } })).toBe(true);
    expect(containsCredentialShapedValue({ a: { cit_leak: 1 } })).toBe(true);
    expect(containsCredentialShapedValue({ a: { b: ["x", "y"] } })).toBe(false);
  });

  it("REJECTS a bearer smuggled inside an allowed context field; ACCEPTS the clean twin", () => {
    const smuggled = validContext({
      cms: { instanceId: "inst-1", resourceId: "cwu_smuggled_user_token" },
    });
    expect(embedContextSchema.safeParse(smuggled).success).toBe(false);
    // NEGATIVE CONTROL — identical message, ordinary resourceId.
    const clean = validContext({ cms: { instanceId: "inst-1", resourceId: "42" } });
    expect(embedContextSchema.safeParse(clean).success).toBe(true);
  });

  it("REJECTS a bearer smuggled into an UPLINK (iframe -> parent) too", () => {
    const up = { protocolVersion: EMBED_PROTOCOL_VERSION, correlationId: CORR, seq: 1 };
    const smuggled = {
      type: EMBED_MESSAGE_TYPES.a11y,
      ...up,
      liveRegion: "cit_site_transport_token",
      politeness: "polite" as const,
    };
    expect(embedUplinkSchema.safeParse(smuggled).success).toBe(false);
    // NEGATIVE CONTROL — the same uplink with ordinary text.
    expect(
      embedUplinkSchema.safeParse({ ...smuggled, liveRegion: "Assistant is thinking" })
        .success,
    ).toBe(true);
  });

  it("the SENDER refuses to emit a credential-bearing message at all", () => {
    const port = { postMessage: vi.fn() };
    const smuggled = validContext({
      cms: { instanceId: "inst-1", resourceId: "cwu_smuggled" },
    }) as unknown as EmbedContext;
    expect(sendContextOverTransport({ mode: "port", port }, smuggled)).toBe(false);
    expect(port.postMessage).not.toHaveBeenCalled();
    // NEGATIVE CONTROL — the clean message IS sent over the same transport.
    expect(
      sendContextOverTransport({ mode: "port", port }, validContext() as unknown as EmbedContext),
    ).toBe(true);
    expect(port.postMessage).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// cinatra#2674, codex round 0 finding 2 — the credential guard matches a bearer
// ANYWHERE at a token boundary, not only at character zero. An error string or a
// URL carrying a token is a credential on the wire.
// ---------------------------------------------------------------------------
describe("cinatra#2674 — a bearer inside a longer string is still a bearer", () => {
  it("matches after a separator: an error message, a URL, a bracketed value", () => {
    for (const value of [
      "Error: cwu_the_user_bearer expired",
      "https://cinatra.test/x?token=cit_site_transport",
      "[cnx_site_credential]",
      "auth=cwu_abc",
      "  CWU_ABC  ",
    ]) {
      expect(isCredentialShapedValue(value)).toBe(true);
    }
  });

  it("does NOT fire on a word that merely ends in the letters", () => {
    for (const value of ["abccwu_x", "specit_x", "", "citation", 42, null]) {
      expect(isCredentialShapedValue(value)).toBe(false);
    }
  });

  it("REJECTS an uplink whose a11y text embeds a bearer mid-string", () => {
    const up = { protocolVersion: EMBED_PROTOCOL_VERSION, correlationId: CORR, seq: 1 };
    const leaky = {
      type: EMBED_MESSAGE_TYPES.a11y,
      ...up,
      liveRegion: "Sign-in failed for cwu_abcdef — please retry",
      politeness: "polite" as const,
    };
    expect(embedUplinkSchema.safeParse(leaky).success).toBe(false);
    // NEGATIVE CONTROL — the same sentence without the token.
    expect(
      embedUplinkSchema.safeParse({ ...leaky, liveRegion: "Sign-in failed — please retry" })
        .success,
    ).toBe(true);
  });
});
