// ---------------------------------------------------------------------------
// The IFRAME-SIDE window wiring of the parent CMS <-> Cinatra iframe embed
// bridge (S5 cinatra#1221 Lane B; PROTOCOL 2 by cinatra#2674, epic #2564 S8e).
//
// It owns NO schema and NO validator of its own: every trust-boundary control
// comes from the PURE, tier-neutral `bridge-protocol.ts` (§6a origin, §6a-2
// source-window, §4 `evaluateContext`, §6c dual `seq` gates, §6c-i single-use
// nonce burn). This module only wires those pure controls to the real `window`
// (mint the nonce, post READY, listen for CONTEXT, post uplinks) so the same
// controls the unit tests exercise are the ones that run in the browser.
//
// IT HANDLES NO CREDENTIAL, BECAUSE THERE IS NONE TO HANDLE (cinatra#2674). At
// protocol 1 the inbound message carried `cit_`/`cwu_` and this module's central
// promise was that it never wrote them anywhere. At protocol 2 the inbound
// message carries selectors only and the credential is acquired by the frame
// itself, on the Cinatra origin, through `useFrameWidgetSession` — so this
// module has no token-handling surface at all. That is a stronger guarantee than
// the old one: not "we are careful with the credential" but "no credential is
// ever in this file's reach".
//
// PORT-BOUND TRANSPORT (§12b, issue #1965): the iframe creates a `MessageChannel`
// and transfers ONE endpoint in the READY, RETAINING the other. Kept at protocol
// 2 as defense in depth — it binds the channel to the realm that ran the
// handshake, so a same-origin replacement document cannot take over an
// established session's uplink channel.
//
// FAIL-CLOSED handling order for the ONE inbound CONTEXT message (§3/§4):
//   - PORT path (§12b): schema + protocolVersion + nonceEcho + assistant/instance
//     via `evaluateContext` (§4) → single-use nonce burn (§6c-i). No origin/
//     source check is needed — the port was transferred ONLY to the expected
//     parent origin, so its provenance IS the origin guarantee (a NARROWING).
//   - WINDOW path, each step BEFORE the next: (1) `event.origin ===
//     expectedParentOrigin` (§6a) → (2) `event.source === window.parent` (§6a-2)
//     → (3) `evaluateContext` (§4) → (4) single-use nonce burn (§6c-i).
// The single-use burn is SHARED across both transports, so whichever the parent
// chooses, a second context message on a mounted session is IGNORED. Any inbound
// message that is not the accepted CONTEXT message is dropped.
// ---------------------------------------------------------------------------

import {
  EMBED_MESSAGE_TYPES,
  EMBED_PROTOCOL_VERSION,
  RESIZE_MAX_HEIGHT,
  createMonotonicSeqGate,
  createSingleUseGate,
  embedUplinkSchema,
  evaluateContext,
  originMatchesExpected,
  sourceMatchesExpected,
  type ContextRejectReason,
  type EmbedAssistant,
  type EmbedContext,
} from "./bridge-protocol";

/** A CSPRNG base64url nonce carrying >=128 bits of entropy (24 base64url chars
 *  == 144 bits) — satisfies the `bridge-protocol` `ID_PATTERN` (22..128). */
export function mintBridgeNonce(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The apply-intent payload the embed emits on an explicit end-user gesture
 *  (§5/§6e). Exactly one selector; the parent treats it as UNTRUSTED (§6f). */
export type ApplyIntentSignal =
  | { proposalId: string; viewType: "content_change_proposal" }
  | { changeSetId: string; viewType: "content_change_proposal" };

// ---------------------------------------------------------------------------
// (§12b) The retained MessageChannel endpoint the iframe uses for the port-bound
// transport. Structural (a test seam can supply a synchronous double), matching
// the `MessagePort` surface this module actually touches.
// ---------------------------------------------------------------------------
export interface BridgePortEndpoint {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  start(): void;
  close(): void;
}

export type BridgeMessageChannel = {
  /** The endpoint the iframe RETAINS — receives the CONTEXT + posts uplinks. */
  readonly localPort: BridgePortEndpoint;
  /** The endpoint TRANSFERRED to the parent in the READY. */
  readonly remotePort: Transferable;
};

/** Mint the handshake channel. Defaults to a real `MessageChannel`; a test seam
 *  supplies a synchronous double so the wiring matrix stays deterministic. */
export type CreateBridgeChannel = () => BridgeMessageChannel;

function defaultCreateBridgeChannel(): BridgeMessageChannel {
  const channel = new MessageChannel();
  // The iframe keeps port1 (bound to THIS realm — a same-origin replacement of
  // the browsing context is a fresh realm that never inherits it) and transfers
  // port2 to the parent origin in READY.
  return {
    localPort: channel.port1 as unknown as BridgePortEndpoint,
    remotePort: channel.port2,
  };
}

export type EmbedBridgeOptions = {
  /** The server-resolved expected parent origin (§7 `frameAncestorOrigin`) — the
   *  ONLY origin READY/uplinks are posted to and the ONLY origin BOOTSTRAP is
   *  accepted from. NOT `document.referrer` / a message origin (both spoofable). */
  expectedParentOrigin: string;
  /** `?assistant` — context `session.assistant` MUST equal this (§4). */
  expectedAssistant: EmbedAssistant | string;
  /** `?instanceId` — context `cms.instanceId` MUST equal this (§4). */
  expectedInstanceId: string;
  /** Invoked ONCE, after a valid CONTEXT message is accepted and the nonce
   *  burned. Receives PUBLIC SELECTORS ONLY — the server re-derives every
   *  authoritative binding from them and denies on mismatch. */
  onContext: (context: EmbedContext) => void;
  /** Invoked on a rejected inbound CONTEXT message so the caller renders a
   *  NEUTRAL error card (no oracle to the parent) and never mounts the wire. */
  onReject?: (reason: ContextRejectReason) => void;
  /** The window the iframe expects as the message source + uplink target. Test
   *  seam; defaults to the real `window.parent`. */
  parentWindow?: Window;
  /** The window the iframe listens/posts on. Test seam; defaults to `window`. */
  selfWindow?: Window;
  /**
   * (§12b) Require the PORT transport: refuse a window-delivered CONTEXT
   * message so the channel cannot be re-opened by stripping the transferred
   * port. Defaults to FALSE (a parent that ignores the transferred port and
   * replies on the window still works). At protocol 2 this is a channel-binding
   * knob, not a credential control — the message carries no credential either
   * way.
   */
  requirePort?: boolean;
  /** (§12b) Test seam: mint the handshake `MessageChannel`. Defaults to a real
   *  channel; the iframe RETAINS `localPort` and TRANSFERS `remotePort`. */
  createChannel?: CreateBridgeChannel;
};

export type EmbedBridge = {
  /** The minted per-frame nonce (§6b); exposed for diagnostics/tests only. */
  readonly nonce: string;
  /** True once a valid CONTEXT message has been accepted (the nonce is burned). */
  readonly contextReceived: boolean;
  /** Post the READY pre-context envelope to the expected parent origin (§3a). */
  postReady(): void;
  /** Uplink: content height (§5); NaN/negative/>max are refused here (schema
   *  parity — the parent additionally clamps a valid height to its panel cap). */
  sendResize(height: number): boolean;
  /** Uplink: advisory focus request (§5). */
  sendFocus(focus: boolean): boolean;
  /** Uplink: mirror an assistant status into the parent aria-live region (§5). */
  sendA11y(liveRegion: string, politeness: "polite" | "assertive"): boolean;
  /** Uplink: apply-intent signal — ONLY from an explicit user gesture (§6e). */
  sendApplyIntent(signal: ApplyIntentSignal): boolean;
  /** Detach the message listener. */
  dispose(): void;
};

/**
 * Install the iframe-side bridge. Returns an `EmbedBridge` handle whose
 * `postReady()` starts the handshake by transferring one `MessageChannel`
 * endpoint to the expected parent origin (§12b). Both channels — the retained
 * port and (unless `requirePort`) the window — are listening BEFORE READY is
 * posted so a CONTEXT message that races the transfer is never missed. Whichever
 * transport the parent chooses, the SAME single-use nonce burn + seq gates apply
 * and the second channel is mooted once the context is in.
 */
export function installEmbedBridge(options: EmbedBridgeOptions): EmbedBridge {
  const self = options.selfWindow ?? window;
  const parent = options.parentWindow ?? self.parent;
  const requirePort = options.requirePort ?? false;
  const nonce = mintBridgeNonce();

  // §12b: the iframe creates the channel, RETAINS the local endpoint (bound to
  // this realm), and TRANSFERS the remote endpoint to the parent in READY.
  const channel = (options.createChannel ?? defaultCreateBridgeChannel)();
  const localPort = channel.localPort;

  const nonceGate = createSingleUseGate(); // §6c-i single context per frame
  // §6c: two INDEPENDENT monotonic seq counters, one per direction.
  const outboundSeq = createMonotonicSeqGate(); // iframe -> parent
  const inboundSeq = createMonotonicSeqGate(); // parent -> iframe (post-context)

  let contextReceived = false;
  let readyPosted = false;
  let correlationId: string | null = null;
  // The transport the accepted CONTEXT message arrived on — uplinks then ride
  // the same channel the parent proved it is listening on.
  let activeTransport: "port" | "window" | null = null;

  function nextOutboundSeq(): number {
    const next = (outboundSeq.last ?? -1) + 1;
    outboundSeq.accept(next);
    return next;
  }

  function postReady(): void {
    // Idempotent: the remote endpoint is transferred (neutered) exactly once —
    // a second pre-context call must NOT re-transfer an already-detached port
    // (which would throw DataCloneError).
    if (contextReceived || readyPosted) return;
    readyPosted = true;
    // Transfer the remote endpoint to the expected parent origin ONLY, never "*"
    // (§6a outbound). The explicit target origin is the origin gate AT TRANSFER
    // TIME: only a document at `expectedParentOrigin` receives the port, so a
    // message later arriving on the retained `localPort` is inherently from that
    // origin. The transferred port is out-of-band and simply ignored by a parent
    // that does not use it.
    parent.postMessage(
      {
        type: EMBED_MESSAGE_TYPES.ready,
        protocolVersion: EMBED_PROTOCOL_VERSION,
        nonce,
        seq: nextOutboundSeq(),
      },
      options.expectedParentOrigin,
      [channel.remotePort],
    );
  }

  // Shared acceptance: schema + protocolVersion + nonceEcho + assistant/instance
  // (§4) → single-use burn (§6c-i) → seed the inbound seq gate (§6c). Identical
  // across transports; the ONLY per-transport difference is the pre-schema gate
  // (the window path additionally proves origin + source-window; the port path
  // is origin-bound by the targeted transfer that delivered it — a NARROWING,
  // never a loosening — and source-window is meaningless for a document-bound
  // port). There is no credential to disclose at protocol 2: the accepted
  // message is selectors only.
  function acceptContext(raw: unknown, transport: "port" | "window"): void {
    const decision = evaluateContext({
      raw,
      frameNonce: nonce,
      expectedAssistant: options.expectedAssistant,
      expectedInstanceId: options.expectedInstanceId,
    });
    if (!decision.ok) {
      options.onReject?.(decision.reason);
      return;
    }
    if (!nonceGate.consume()) return; // §6c-i burn — single-use across transports
    if (!inboundSeq.accept(decision.data.seq)) return; // §6c

    contextReceived = true;
    activeTransport = transport;
    correlationId = decision.data.correlationId;
    options.onContext(decision.data);
  }

  // §12b PORT path — the hardened transport. No origin/source check: the port was
  // transferred ONLY to `expectedParentOrigin`, so its provenance IS the origin
  // guarantee (and it is document-bound, immune to the WindowProxy residual).
  function onPortMessage(event: MessageEvent): void {
    if (contextReceived) return;
    acceptContext(event.data, "port");
  }

  // Legacy WINDOW path — the pre-migration transport, kept ONLY for the
  // negotiated transition and refused entirely under `requirePort`.
  function onWindowMessage(event: MessageEvent): void {
    if (contextReceived) return;
    // (§6a) strict origin, BEFORE schema.
    if (!originMatchesExpected(event.origin, options.expectedParentOrigin)) return;
    // (§6a-2) source-window binding, BEFORE schema — a sibling frame on the same
    // origin must never cross-mount another frame's context.
    if (!sourceMatchesExpected(event.source, parent)) return;
    acceptContext(event.data, "window");
  }

  localPort.addEventListener("message", onPortMessage);
  localPort.start();
  // Downgrade resistance (§12b): under `requirePort` the window path is NOT
  // attached at all, so a window-delivered CONTEXT message can never be accepted
  // — the transport cannot be silently downgraded by stripping the port.
  if (!requirePort) {
    self.addEventListener("message", onWindowMessage);
  }

  function postUplink(partial: Record<string, unknown>): boolean {
    // Uplinks are only valid after a CONTEXT message established the
    // correlationId + the transport the parent is listening on.
    if (!contextReceived || correlationId === null || activeTransport === null) {
      return false;
    }
    const message = {
      ...partial,
      protocolVersion: EMBED_PROTOCOL_VERSION,
      correlationId,
      seq: nextOutboundSeq(),
    };
    // VALIDATE BEFORE SENDING (cinatra#2674; codex round 0, finding 2). The
    // uplink schema carries the credential-shaped-value guard, and until this
    // check existed it was never RUN on the outbound path — the frame composed
    // the object and posted it. So the guarantee "no credential-shaped value in
    // either direction" was true of the schema and false of the wire. A future
    // status string or error message that happened to carry a bearer would have
    // gone straight to the CMS parent. Now nothing leaves this frame that the
    // schema would refuse on arrival.
    if (!embedUplinkSchema.safeParse(message).success) return false;
    if (activeTransport === "port") {
      localPort.postMessage(message); // rides the entangled port
    } else {
      // ALWAYS an explicit origin, never "*" (§6a outbound).
      parent.postMessage(message, options.expectedParentOrigin);
    }
    return true;
  }

  return {
    nonce,
    get contextReceived() {
      return contextReceived;
    },
    postReady,
    sendResize(height: number): boolean {
      // Schema parity (§5/§B9): refuse NaN/negative/>max HERE so a bad height is
      // never posted; the parent clamps a valid in-range height to its panel cap.
      if (!Number.isInteger(height) || height < 0 || height > RESIZE_MAX_HEIGHT) {
        return false;
      }
      return postUplink({ type: EMBED_MESSAGE_TYPES.resize, height });
    },
    sendFocus(focus: boolean): boolean {
      return postUplink({ type: EMBED_MESSAGE_TYPES.focus, focus });
    },
    sendA11y(liveRegion: string, politeness: "polite" | "assertive"): boolean {
      if (liveRegion.length > 2000) return false;
      return postUplink({ type: EMBED_MESSAGE_TYPES.a11y, liveRegion, politeness });
    },
    sendApplyIntent(signal: ApplyIntentSignal): boolean {
      return postUplink({ type: EMBED_MESSAGE_TYPES.applyIntent, ...signal });
    },
    dispose(): void {
      self.removeEventListener("message", onWindowMessage);
      localPort.removeEventListener("message", onPortMessage);
      localPort.close();
    },
  };
}
