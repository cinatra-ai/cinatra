// S5 (cinatra#1221) Lane B — the IFRAME-SIDE bridge wiring negative-test matrix.
// Proves the window wiring enforces the SAME trust boundary the pure validators
// define: origin (§6a/B1), source-window (§6a-2/B10), nonce+single-bootstrap
// (§6b/§6c-i/B3), per-direction monotonic seq (§6c/B13), apply-intent
// signal-only (§6e/§6f/B6), and token non-disclosure (§6i/B4/B17).
import { describe, it, expect, vi } from "vitest";
import {
  installEmbedBridge,
  mintBridgeNonce,
  type EmbedBridgeOptions,
} from "@/lib/embed/embed-bridge.client";
import { EMBED_MESSAGE_TYPES, EMBED_PROTOCOL_VERSION } from "@/lib/embed/bridge-protocol";

const PARENT_ORIGIN = "https://cms.example.com";
const CIT = "cit_site_transport_token";
const CWU = "cwu_per_user_token";
const CORR = "CORRELATION-id_0123456789ABCDEFG";

/** A minimal window double capturing posts + a single message listener. */
function makeWindow() {
  const posts: Array<{ message: Record<string, unknown>; targetOrigin: string }> = [];
  let listener: ((e: MessageEvent) => void) | null = null;
  return {
    posts,
    postMessage(message: Record<string, unknown>, targetOrigin: string) {
      posts.push({ message, targetOrigin });
    },
    addEventListener(_type: string, l: (e: MessageEvent) => void) {
      listener = l;
    },
    removeEventListener() {
      listener = null;
    },
    deliver(e: Partial<MessageEvent>) {
      listener?.(e as MessageEvent);
    },
  };
}

function harness(overrides: Partial<EmbedBridgeOptions> = {}) {
  const self = makeWindow();
  const parent = makeWindow();
  const onBootstrap = vi.fn();
  const onReject = vi.fn();
  const bridge = installEmbedBridge({
    expectedParentOrigin: PARENT_ORIGIN,
    expectedAssistant: "wordpress",
    expectedInstanceId: "inst-1",
    onBootstrap,
    onReject,
    selfWindow: self as unknown as Window,
    parentWindow: parent as unknown as Window,
    ...overrides,
  });
  return { self, parent, onBootstrap, onReject, bridge };
}

function bootstrapMessage(nonce: string, overrides: Record<string, unknown> = {}) {
  return {
    type: EMBED_MESSAGE_TYPES.bootstrap,
    protocolVersion: EMBED_PROTOCOL_VERSION,
    correlationId: CORR,
    nonceEcho: nonce,
    seq: 0,
    auth: { citToken: CIT, cwuToken: CWU },
    session: { threadId: "thread-1", assistant: "wordpress" },
    cms: { instanceId: "inst-1" },
    ...overrides,
  };
}

describe("embed-bridge.client — READY (§3a)", () => {
  it("posts READY to the expected parent origin ONLY, never '*', with the minted nonce", () => {
    const { parent, bridge } = harness();
    bridge.postReady();
    expect(parent.posts).toHaveLength(1);
    const { message, targetOrigin } = parent.posts[0];
    expect(targetOrigin).toBe(PARENT_ORIGIN);
    expect(message.type).toBe(EMBED_MESSAGE_TYPES.ready);
    expect(message.nonce).toBe(bridge.nonce);
    expect(message).not.toHaveProperty("correlationId"); // §3a
  });
});

describe("embed-bridge.client — BOOTSTRAP gate order (§4/§6)", () => {
  it("B1: drops a foreign-origin bootstrap BEFORE schema — no mount, no reject oracle", () => {
    const { bridge, self, onBootstrap, onReject } = harness();
    self.deliver({
      origin: "https://evil.example.com",
      source: {} as Window,
      data: bootstrapMessage(bridge.nonce),
    });
    expect(onBootstrap).not.toHaveBeenCalled();
    expect(onReject).not.toHaveBeenCalled(); // dropped silently before schema
    expect(bridge.bootstrapped).toBe(false);
  });

  it("B10: drops a correct-origin bootstrap whose source is NOT window.parent", () => {
    const { bridge, self, onBootstrap } = harness();
    self.deliver({
      origin: PARENT_ORIGIN,
      source: { not: "parent" } as unknown as Window,
      data: bootstrapMessage(bridge.nonce),
    });
    expect(onBootstrap).not.toHaveBeenCalled();
    expect(bridge.bootstrapped).toBe(false);
  });

  it("B3: rejects a bootstrap whose nonceEcho != frame nonce (typed reject, no mount)", () => {
    const { bridge, self, parent, onBootstrap, onReject } = harness();
    self.deliver({
      origin: PARENT_ORIGIN,
      source: parent as unknown as Window,
      data: bootstrapMessage("wrong-nonce-000000000000000000000"),
    });
    expect(onBootstrap).not.toHaveBeenCalled();
    expect(onReject).toHaveBeenCalledWith("nonce_mismatch");
    expect(bridge.bootstrapped).toBe(false);
  });

  it("B5: rejects on assistant / instance disagreement", () => {
    const { bridge, self, parent, onReject } = harness();
    self.deliver({
      origin: PARENT_ORIGIN,
      source: parent as unknown as Window,
      data: bootstrapMessage(bridge.nonce, { session: { threadId: "t", assistant: "drupal" } }),
    });
    expect(onReject).toHaveBeenCalledWith("assistant_mismatch");
    expect(bridge.bootstrapped).toBe(false);
  });

  it("accepts a valid bootstrap (all gates pass) exactly once and hands tokens via closure", () => {
    const { bridge, self, parent, onBootstrap } = harness();
    self.deliver({ origin: PARENT_ORIGIN, source: parent as unknown as Window, data: bootstrapMessage(bridge.nonce) });
    expect(bridge.bootstrapped).toBe(true);
    expect(onBootstrap).toHaveBeenCalledTimes(1);
    expect(onBootstrap.mock.calls[0][0].auth.citToken).toBe(CIT);
  });

  it("B3: a SECOND bootstrap on a mounted session is IGNORED (single-use nonce burn)", () => {
    const { bridge, self, parent, onBootstrap } = harness();
    const deliver = () =>
      self.deliver({ origin: PARENT_ORIGIN, source: parent as unknown as Window, data: bootstrapMessage(bridge.nonce) });
    deliver();
    deliver();
    expect(onBootstrap).toHaveBeenCalledTimes(1);
  });
});

describe("embed-bridge.client — uplinks (§5/§6c)", () => {
  function mounted() {
    const h = harness();
    h.self.deliver({ origin: PARENT_ORIGIN, source: h.parent as unknown as Window, data: bootstrapMessage(h.bridge.nonce) });
    h.parent.posts.length = 0; // drop READY
    return h;
  }

  it("uplinks carry the echoed correlationId + a MONOTONIC per-direction seq, targeted to the parent origin", () => {
    const { parent, bridge } = mounted();
    expect(bridge.sendResize(100)).toBe(true);
    expect(bridge.sendFocus(true)).toBe(true);
    const seqs = parent.posts.map((p) => p.message.seq as number);
    expect(seqs[1]).toBeGreaterThan(seqs[0]); // strictly increasing
    for (const p of parent.posts) {
      expect(p.targetOrigin).toBe(PARENT_ORIGIN); // never "*"
      expect(p.message.correlationId).toBe(CORR);
    }
  });

  it("B9: refuses NaN / negative / over-max resize height at the client (schema parity)", () => {
    const { bridge } = mounted();
    expect(bridge.sendResize(-1)).toBe(false);
    expect(bridge.sendResize(Number.NaN)).toBe(false);
    expect(bridge.sendResize(20001)).toBe(false);
    expect(bridge.sendResize(500)).toBe(true);
  });

  it("no uplink is sent before a bootstrap (pre-bootstrap uplinks denied)", () => {
    const { bridge } = harness();
    expect(bridge.sendResize(100)).toBe(false);
    expect(bridge.sendApplyIntent({ proposalId: "p1", viewType: "content_change_proposal" })).toBe(false);
  });

  it("B6: apply_intent is a signal-only uplink carrying just the selector (no content, no fetch)", () => {
    const { parent, bridge } = mounted();
    expect(bridge.sendApplyIntent({ proposalId: "p1", viewType: "content_change_proposal" })).toBe(true);
    const msg = parent.posts.at(-1)!.message;
    expect(msg.type).toBe(EMBED_MESSAGE_TYPES.applyIntent);
    expect(msg.proposalId).toBe("p1");
    expect(msg).not.toHaveProperty("changeSetId");
  });
});

describe("embed-bridge.client — token non-disclosure (§6i/B4/B17)", () => {
  it("tokens never appear in READY, any uplink, or the minted nonce", () => {
    const { self, bridge, parent } = harness();
    bridge.postReady();
    self.deliver({ origin: PARENT_ORIGIN, source: parent as unknown as Window, data: bootstrapMessage(bridge.nonce) });
    bridge.sendResize(100);
    bridge.sendA11y("saved", "polite");
    bridge.sendApplyIntent({ changeSetId: "cs1", viewType: "content_change_proposal" });
    const serialized = JSON.stringify(parent.posts);
    expect(serialized).not.toContain(CIT);
    expect(serialized).not.toContain(CWU);
    expect(bridge.nonce).not.toContain(CIT);
  });
});

describe("embed-bridge.client — mintBridgeNonce", () => {
  it("mints a base64url id in the bridge-protocol id range (22..128), unique across calls", () => {
    const a = mintBridgeNonce();
    const b = mintBridgeNonce();
    expect(a).toMatch(/^[A-Za-z0-9_-]{22,128}$/);
    expect(a).not.toBe(b);
  });
});
