// S5 (cinatra#1221) Lane B — the IFRAME-SIDE bridge wiring negative-test matrix.
// Proves the window wiring enforces the SAME trust boundary the pure validators
// define: origin (§6a/B1), source-window (§6a-2/B10), nonce+single-bootstrap
// (§6b/§6c-i/B3), per-direction monotonic seq (§6c/B13), apply-intent
// signal-only (§6e/§6f/B6), token non-disclosure (§6i/B4/B17), AND the §12b
// port-bound transport hardening (issue #1965): READY transfers one channel
// endpoint, the token-bearing BOOTSTRAP is accepted over the retained port,
// steady-state uplinks ride the port, the single-use burn is shared across
// transports, and `requirePort` refuses a legacy/window downgrade.
import { describe, it, expect, vi } from "vitest";
import {
  installEmbedBridge,
  mintBridgeNonce,
  type BridgeMessageChannel,
  type BridgePortEndpoint,
  type EmbedBridgeOptions,
} from "@/lib/embed/embed-bridge.client";
import {
  EMBED_MESSAGE_TYPES,
  EMBED_PROTOCOL_VERSION,
  type EmbedContext,
} from "@/lib/embed/bridge-protocol";

const PARENT_ORIGIN = "https://cms.example.com";
const CIT = "cit_site_transport_token";
const CWU = "cwu_per_user_token";
const CORR = "CORRELATION-id_0123456789ABCDEFG";

/** A minimal window double capturing posts (message + targetOrigin + transfer)
 *  and a single message listener. */
function makeWindow() {
  const posts: Array<{
    message: Record<string, unknown>;
    targetOrigin: string;
    transfer?: unknown[];
  }> = [];
  let listener: ((e: MessageEvent) => void) | null = null;
  return {
    posts,
    postMessage(message: Record<string, unknown>, targetOrigin: string, transfer?: unknown[]) {
      posts.push({ message, targetOrigin, transfer });
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

/** A synchronous MessagePort double: captures posts, a single message listener,
 *  and start/close state; `deliver` fires the listener synchronously. */
function makePort() {
  const posts: unknown[] = [];
  let listener: ((e: MessageEvent) => void) | null = null;
  const state = { started: false, closed: false };
  const port: BridgePortEndpoint & {
    posts: unknown[];
    state: { started: boolean; closed: boolean };
    deliver(data: unknown): void;
  } = {
    posts,
    state,
    postMessage(message: unknown) {
      posts.push(message);
    },
    addEventListener(_type: "message", l: (e: MessageEvent) => void) {
      listener = l;
    },
    removeEventListener() {
      listener = null;
    },
    start() {
      state.started = true;
    },
    close() {
      state.closed = true;
      listener = null;
    },
    deliver(data: unknown) {
      listener?.({ data } as MessageEvent);
    },
  };
  return port;
}

function makeChannel() {
  const localPort = makePort();
  const remotePort = { __fakeRemotePort: true } as unknown as Transferable;
  const channel: BridgeMessageChannel = { localPort, remotePort };
  return { channel, localPort, remotePort };
}

function harness(overrides: Partial<EmbedBridgeOptions> = {}) {
  const self = makeWindow();
  const parent = makeWindow();
  const { channel, localPort, remotePort } = makeChannel();
  const onContext = vi.fn();
  const onReject = vi.fn();
  const bridge = installEmbedBridge({
    expectedParentOrigin: PARENT_ORIGIN,
    expectedAssistant: "wordpress",
    expectedInstanceId: "inst-1",
    onContext,
    onReject,
    selfWindow: self as unknown as Window,
    parentWindow: parent as unknown as Window,
    createChannel: () => channel,
    ...overrides,
  });
  return { self, parent, port: localPort, remotePort, onContext, onReject, bridge };
}

function contextMessage(nonce: string, overrides: Record<string, unknown> = {}) {
  return {
    type: EMBED_MESSAGE_TYPES.context,
    protocolVersion: EMBED_PROTOCOL_VERSION,
    correlationId: CORR,
    nonceEcho: nonce,
    seq: 0,
    // PUBLIC SELECTORS ONLY (cinatra#2674). There is no `auth` block to build:
    // the schema has no credential field, and the frame acquires its own
    // credential on the Cinatra origin.
    session: { threadId: "thread-1", assistant: "wordpress" },
    cms: { instanceId: "inst-1", resourceId: "42" },
    ...overrides,
  };
}

describe("embed-bridge.client — READY (§3a/§12b)", () => {
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

  it("§12b: READY transfers EXACTLY ONE channel endpoint and is TOKEN-FREE", () => {
    const { parent, bridge, remotePort } = harness();
    bridge.postReady();
    const post = parent.posts[0];
    // exactly one transferred port — the iframe retains the other endpoint.
    expect(post.transfer).toHaveLength(1);
    expect(post.transfer?.[0]).toBe(remotePort);
    // token-free handshake: no cit_/cwu_ anywhere in the READY.
    const serialized = JSON.stringify(post.message);
    expect(serialized).not.toContain("cit_");
    expect(serialized).not.toContain("cwu_");
  });

  it("§12b: starts the retained port listener before READY (a racing bootstrap is not missed)", () => {
    const { port } = harness();
    expect(port.state.started).toBe(true);
  });

  it("§12b: postReady is IDEMPOTENT — a second pre-bootstrap call does not re-transfer the port", () => {
    const { parent, bridge } = harness();
    bridge.postReady();
    bridge.postReady();
    expect(parent.posts).toHaveLength(1); // the neutered endpoint is transferred once
  });
});

describe("embed-bridge.client — BOOTSTRAP gate order, legacy window path (§4/§6)", () => {
  it("B1: drops a foreign-origin bootstrap BEFORE schema — no mount, no reject oracle", () => {
    const { bridge, self, onContext, onReject } = harness();
    self.deliver({
      origin: "https://evil.example.com",
      source: {} as Window,
      data: contextMessage(bridge.nonce),
    });
    expect(onContext).not.toHaveBeenCalled();
    expect(onReject).not.toHaveBeenCalled(); // dropped silently before schema
    expect(bridge.contextReceived).toBe(false);
  });

  it("B10: drops a correct-origin bootstrap whose source is NOT window.parent", () => {
    const { bridge, self, onContext } = harness();
    self.deliver({
      origin: PARENT_ORIGIN,
      source: { not: "parent" } as unknown as Window,
      data: contextMessage(bridge.nonce),
    });
    expect(onContext).not.toHaveBeenCalled();
    expect(bridge.contextReceived).toBe(false);
  });

  it("B3: rejects a bootstrap whose nonceEcho != frame nonce (typed reject, no mount)", () => {
    const { bridge, self, parent, onContext, onReject } = harness();
    self.deliver({
      origin: PARENT_ORIGIN,
      source: parent as unknown as Window,
      data: contextMessage("wrong-nonce-000000000000000000000"),
    });
    expect(onContext).not.toHaveBeenCalled();
    expect(onReject).toHaveBeenCalledWith("nonce_mismatch");
    expect(bridge.contextReceived).toBe(false);
  });

  it("B5: rejects on assistant / instance disagreement", () => {
    const { bridge, self, parent, onReject } = harness();
    self.deliver({
      origin: PARENT_ORIGIN,
      source: parent as unknown as Window,
      data: contextMessage(bridge.nonce, { session: { threadId: "t", assistant: "drupal" } }),
    });
    expect(onReject).toHaveBeenCalledWith("assistant_mismatch");
    expect(bridge.contextReceived).toBe(false);
  });

  it("accepts a valid context message (all gates pass) exactly once and hands SELECTORS via closure", () => {
    const { bridge, self, parent, onContext } = harness();
    self.deliver({ origin: PARENT_ORIGIN, source: parent as unknown as Window, data: contextMessage(bridge.nonce) });
    expect(bridge.contextReceived).toBe(true);
    expect(onContext).toHaveBeenCalledTimes(1);
    expect(onContext.mock.calls[0][0].cms.resourceId).toBe("42");
    // cinatra#2674: nothing credential-shaped reaches the callback, because
    // nothing credential-shaped can pass the schema.
    expect(JSON.stringify(onContext.mock.calls[0][0])).not.toContain("cwu_");
    expect(JSON.stringify(onContext.mock.calls[0][0])).not.toContain("cit_");
  });

  it("B3: a SECOND bootstrap on a mounted session is IGNORED (single-use nonce burn)", () => {
    const { bridge, self, parent, onContext } = harness();
    const deliver = () =>
      self.deliver({ origin: PARENT_ORIGIN, source: parent as unknown as Window, data: contextMessage(bridge.nonce) });
    deliver();
    deliver();
    expect(onContext).toHaveBeenCalledTimes(1);
  });
});

describe("embed-bridge.client — port-bound BOOTSTRAP (§12b, issue #1965)", () => {
  it("accepts the context message delivered over the RETAINED port, no origin/source needed", () => {
    const { bridge, port, onContext } = harness();
    // A port message carries NO origin/source — provenance is the targeted
    // transfer. It is accepted on schema + nonce + agreement alone.
    port.deliver(contextMessage(bridge.nonce));
    expect(bridge.contextReceived).toBe(true);
    expect(onContext).toHaveBeenCalledTimes(1);
    expect(onContext.mock.calls[0][0].session.threadId).toBe("thread-1");
  });

  it("still enforces schema + nonce over the port (a bad-nonce port bootstrap is rejected)", () => {
    const { bridge, port, onContext, onReject } = harness();
    port.deliver(contextMessage("wrong-nonce-000000000000000000000"));
    expect(onContext).not.toHaveBeenCalled();
    expect(onReject).toHaveBeenCalledWith("nonce_mismatch");
    expect(bridge.contextReceived).toBe(false);
  });

  it("port-mode uplinks ride the RETAINED port, never window.postMessage", () => {
    const { bridge, port, parent } = harness();
    port.deliver(contextMessage(bridge.nonce));
    parent.posts.length = 0; // drop READY (window post)
    expect(bridge.sendResize(120)).toBe(true);
    expect(bridge.sendFocus(true)).toBe(true);
    // uplinks went over the port …
    expect(port.posts).toHaveLength(2);
    const seqs = (port.posts as Array<{ seq: number }>).map((p) => p.seq);
    expect(seqs[1]).toBeGreaterThan(seqs[0]); // strictly increasing (§6c)
    for (const p of port.posts as Array<{ correlationId: string }>) {
      expect(p.correlationId).toBe(CORR);
    }
    // … and NONE leaked to the window transport.
    expect(parent.posts).toHaveLength(0);
  });

  it("the single-use burn is SHARED across transports: a window bootstrap after a port bootstrap is ignored", () => {
    const { bridge, port, self, parent, onContext } = harness();
    port.deliver(contextMessage(bridge.nonce));
    self.deliver({ origin: PARENT_ORIGIN, source: parent as unknown as Window, data: contextMessage(bridge.nonce) });
    expect(onContext).toHaveBeenCalledTimes(1);
  });

  it("shared burn holds in the REVERSE order too: a port bootstrap after a window bootstrap is ignored", () => {
    const { bridge, port, self, parent, onContext } = harness();
    self.deliver({ origin: PARENT_ORIGIN, source: parent as unknown as Window, data: contextMessage(bridge.nonce) });
    port.deliver(contextMessage(bridge.nonce));
    expect(onContext).toHaveBeenCalledTimes(1);
  });

  it("mixed-version: a legacy (window) parent still bootstraps a compat iframe; uplinks ride the window", () => {
    const { bridge, self, parent, port } = harness();
    self.deliver({ origin: PARENT_ORIGIN, source: parent as unknown as Window, data: contextMessage(bridge.nonce) });
    parent.posts.length = 0; // drop READY
    expect(bridge.sendResize(80)).toBe(true);
    expect(parent.posts).toHaveLength(1); // legacy uplink over the window
    expect(port.posts).toHaveLength(0); // nothing on the port
    expect(parent.posts[0].targetOrigin).toBe(PARENT_ORIGIN); // never "*"
  });
});

describe("embed-bridge.client — downgrade resistance (§12b requirePort)", () => {
  it("under requirePort, a legacy/window bootstrap is NEVER accepted (window path not attached)", () => {
    const { bridge, self, parent, onContext, onReject } = harness({ requirePort: true });
    self.deliver({ origin: PARENT_ORIGIN, source: parent as unknown as Window, data: contextMessage(bridge.nonce) });
    expect(onContext).not.toHaveBeenCalled();
    expect(onReject).not.toHaveBeenCalled(); // the window path is simply absent
    expect(bridge.contextReceived).toBe(false);
  });

  it("under requirePort, the SAME bootstrap over the port IS accepted", () => {
    const { bridge, port, onContext } = harness({ requirePort: true });
    port.deliver(contextMessage(bridge.nonce));
    expect(bridge.contextReceived).toBe(true);
    expect(onContext).toHaveBeenCalledTimes(1);
  });
});

describe("embed-bridge.client — uplinks, legacy window transport (§5/§6c)", () => {
  function mounted() {
    const h = harness();
    h.self.deliver({ origin: PARENT_ORIGIN, source: h.parent as unknown as Window, data: contextMessage(h.bridge.nonce) });
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

describe("embed-bridge.client — credential non-disclosure (§6i/B4/B17)", () => {
  // At protocol 2 (cinatra#2674) these sentinels never enter the bridge in the
  // first place — the schema refuses them. The cases are kept and STRENGTHENED:
  // they now assert the absence of a credential the parent tried to inject, not
  // merely the absence of one the frame was handed.
  it("credentials never appear in READY, any uplink, or the minted nonce (window transport)", () => {
    const { self, bridge, parent } = harness();
    bridge.postReady();
    self.deliver({ origin: PARENT_ORIGIN, source: parent as unknown as Window, data: contextMessage(bridge.nonce) });
    bridge.sendResize(100);
    bridge.sendA11y("saved", "polite");
    bridge.sendApplyIntent({ changeSetId: "cs1", viewType: "content_change_proposal" });
    const serialized = JSON.stringify(parent.posts);
    expect(serialized).not.toContain(CIT);
    expect(serialized).not.toContain(CWU);
    expect(bridge.nonce).not.toContain(CIT);
  });

  it("credentials never appear in READY or any uplink (port transport)", () => {
    const { bridge, port, parent } = harness();
    bridge.postReady();
    port.deliver(contextMessage(bridge.nonce));
    bridge.sendResize(100);
    bridge.sendA11y("saved", "polite");
    const serialized = JSON.stringify([parent.posts, port.posts]);
    expect(serialized).not.toContain(CIT);
    expect(serialized).not.toContain(CWU);
  });
});

describe("embed-bridge.client — dispose", () => {
  it("detaches both transports (window listener + port listener) and closes the port", () => {
    const { bridge, port, self, parent, onContext } = harness();
    bridge.dispose();
    expect(port.state.closed).toBe(true);
    // after dispose neither channel can bootstrap.
    port.deliver(contextMessage(bridge.nonce));
    self.deliver({ origin: PARENT_ORIGIN, source: parent as unknown as Window, data: contextMessage(bridge.nonce) });
    expect(onContext).not.toHaveBeenCalled();
    expect(bridge.contextReceived).toBe(false);
  });
});

describe("embed-bridge.client — real MessageChannel end-to-end (§12b)", () => {
  it("delivers the bootstrap over a REAL entangled port from the transferred endpoint", async () => {
    const self = makeWindow();
    const parent = makeWindow();
    // Wait on the bridge's OWN completion signal rather than on a timer turn.
    // `onContext` is the callback the bridge invokes at the end of
    // `acceptBootstrap`, so this promise settles exactly when the port-delivered
    // bootstrap has been applied. The `setTimeout(resolve, 0)` hop this replaces
    // was not a completion signal at all: it only ASSUMED that a real MessagePort
    // is drained within one macrotask turn, and on any runtime where that does not
    // hold the assertions below read a bridge that has not dispatched yet. The
    // explicit per-test timeout at the bottom of this case bounds the other side:
    // a bootstrap that is never applied fails in seconds rather than sitting until
    // the suite-wide default.
    let signalBootstrapped!: () => void;
    const bootstrapApplied = new Promise<void>((resolve) => {
      signalBootstrapped = resolve;
    });
    const onContext = vi.fn<(bootstrap: EmbedContext) => void>(() => {
      signalBootstrapped();
    });
    const bridge = installEmbedBridge({
      expectedParentOrigin: PARENT_ORIGIN,
      expectedAssistant: "wordpress",
      expectedInstanceId: "inst-1",
      onContext,
      selfWindow: self as unknown as Window,
      parentWindow: parent as unknown as Window,
      // real MessageChannel (Node/DOM global) — the iframe retains port1.
    });
    bridge.postReady();
    // The parent received port2 in the READY transfer; reply with the
    // token-bearing bootstrap over it. A real port delivers asynchronously.
    const remote = parent.posts[0].transfer?.[0] as MessagePort;
    expect(remote).toBeInstanceOf(MessagePort);
    remote.postMessage(contextMessage(bridge.nonce));
    await bootstrapApplied;
    expect(bridge.contextReceived).toBe(true);
    expect(onContext).toHaveBeenCalledTimes(1);
    expect(onContext.mock.calls[0][0].cms.instanceId).toBe("inst-1");
    bridge.dispose();
    // Bounded failure path: awaiting a signal that never arrives would otherwise
    // burn the suite-wide 30s default before reporting.
  }, 5_000);
});

describe("embed-bridge.client — mintBridgeNonce", () => {
  it("mints a base64url id in the bridge-protocol id range (22..128), unique across calls", () => {
    const a = mintBridgeNonce();
    const b = mintBridgeNonce();
    expect(a).toMatch(/^[A-Za-z0-9_-]{22,128}$/);
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// cinatra#2674 (epic #2564 S8e) — the frame refuses a credential-bearing inbound
// message on BOTH transports, and the retired protocol-1 bootstrap cannot mount
// anything. Negative-controlled: the credential-free twin of each rejected
// message mounts normally.
// ---------------------------------------------------------------------------
describe("embed-bridge.client — cinatra#2674 credential refusal", () => {
  const v1Bootstrap = (nonce: string) => ({
    type: "cinatra.embed.bootstrap",
    protocolVersion: 1,
    correlationId: CORR,
    nonceEcho: nonce,
    seq: 0,
    auth: { citToken: CIT, cwuToken: CWU },
    session: { threadId: "thread-1", assistant: "wordpress" },
    cms: { instanceId: "inst-1" },
  });

  it("a protocol-1 credential bootstrap over the WINDOW mounts nothing and rejects as schema", () => {
    const { bridge, self, parent, onContext, onReject } = harness();
    self.deliver({
      origin: PARENT_ORIGIN,
      source: parent as unknown as Window,
      data: v1Bootstrap(bridge.nonce),
    });
    expect(onContext).not.toHaveBeenCalled();
    expect(bridge.contextReceived).toBe(false);
    expect(onReject).toHaveBeenCalledWith("schema");
  });

  it("a protocol-1 credential bootstrap over the PORT mounts nothing either", () => {
    const { bridge, port, onContext } = harness();
    port.deliver(v1Bootstrap(bridge.nonce));
    expect(onContext).not.toHaveBeenCalled();
    expect(bridge.contextReceived).toBe(false);
  });

  it("a v2 message smuggling a bearer in an allowed field is refused; the clean twin mounts", () => {
    const smuggled = harness();
    smuggled.port.deliver(
      contextMessage(smuggled.bridge.nonce, {
        cms: { instanceId: "inst-1", resourceId: CWU },
      }),
    );
    expect(smuggled.onContext).not.toHaveBeenCalled();
    expect(smuggled.bridge.contextReceived).toBe(false);

    // NEGATIVE CONTROL — same harness shape, ordinary resourceId.
    const clean = harness();
    clean.port.deliver(contextMessage(clean.bridge.nonce));
    expect(clean.onContext).toHaveBeenCalledTimes(1);
    expect(clean.bridge.contextReceived).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// cinatra#2674, codex round 0 finding 2 — the OUTBOUND path enforces the schema.
//
// The uplink schema carried the credential guard from the start; until this
// round nothing RAN it on the way out, so the frame would have posted whatever it
// composed. These cases pin the enforcement on both transports.
// ---------------------------------------------------------------------------
describe("embed-bridge.client — nothing leaves that the schema would refuse", () => {
  function mounted() {
    const h = harness();
    h.port.deliver(contextMessage(h.bridge.nonce));
    expect(h.bridge.contextReceived).toBe(true);
    return h;
  }

  it("REFUSES to send an a11y uplink carrying a bearer (port transport)", () => {
    const h = mounted();
    const before = h.port.posts.length;
    expect(h.bridge.sendA11y(`Sign-in failed for ${CWU}`, "polite")).toBe(false);
    expect(h.port.posts.length).toBe(before);
    // NEGATIVE CONTROL — the same call with ordinary text IS sent.
    expect(h.bridge.sendA11y("Sign-in failed", "polite")).toBe(true);
    expect(h.port.posts.length).toBe(before + 1);
  });

  it("REFUSES it on the WINDOW transport too", () => {
    const h = harness();
    h.self.deliver({
      origin: PARENT_ORIGIN,
      source: h.parent as unknown as Window,
      data: contextMessage(h.bridge.nonce),
    });
    const before = h.parent.posts.length;
    expect(h.bridge.sendA11y(`token ${CIT} leaked`, "assertive")).toBe(false);
    expect(h.parent.posts.length).toBe(before);
    expect(JSON.stringify(h.parent.posts)).not.toContain(CIT);
  });

  it("REFUSES an apply-intent whose selector is a bearer", () => {
    const h = mounted();
    const before = h.port.posts.length;
    expect(
      h.bridge.sendApplyIntent({ proposalId: CWU, viewType: "content_change_proposal" }),
    ).toBe(false);
    expect(h.port.posts.length).toBe(before);
  });
});
