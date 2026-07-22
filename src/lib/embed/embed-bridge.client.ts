// ---------------------------------------------------------------------------
// S5 (cinatra#1221) Lane B — the IFRAME-SIDE window wiring of the parent CMS <->
// Cinatra iframe embed bridge. This is the client half named by
// `bridge-protocol.ts` (§6 "`embed-bridge.client.ts` (window wiring)").
//
// It owns NO schema and NO validator of its own: every trust-boundary control
// comes from the PURE, tier-neutral `bridge-protocol.ts` (§6a origin, §6a-2
// source-window, §4 `evaluateBootstrap`, §6c dual `seq` gates, §6c-i single-use
// nonce burn). This module only wires those pure controls to the real `window`
// (mint the nonce, post READY, listen for BOOTSTRAP, post uplinks) so the same
// controls the unit tests exercise are the ones that run in the browser.
//
// PORT-BOUND TRANSPORT (§12b, issue #1965): the iframe creates a `MessageChannel`
// and transfers ONE endpoint in the token-free READY, RETAINING the other. The
// parent replies with the token-bearing BOOTSTRAP over that retained port, never
// via `window.postMessage` to the WindowProxy — so a same-origin replacement of
// this browsing context (a fresh realm that never inherits the retained endpoint)
// can never receive the tokens. Steady-state uplinks then ride the entangled
// port. A legacy WINDOW path is kept ONLY for the negotiated transition with an
// as-yet-unmigrated widget, and is refused entirely under `requirePort`.
//
// FAIL-CLOSED handling order for the ONE inbound BOOTSTRAP (§3/§4):
//   - PORT path (§12b): schema + protocolVersion + nonceEcho + assistant/instance
//     via `evaluateBootstrap` (§4) → single-use nonce burn (§6c-i). No origin/
//     source check is needed — the port was transferred ONLY to the expected
//     parent origin, so its provenance IS the origin guarantee (a NARROWING).
//   - legacy WINDOW path, each step BEFORE the next: (1) `event.origin ===
//     expectedParentOrigin` (§6a) → (2) `event.source === window.parent` (§6a-2)
//     → (3) `evaluateBootstrap` (§4) → (4) single-use nonce burn (§6c-i).
// The single-use burn is SHARED across both transports, so whichever the parent
// chooses, a second bootstrap on a mounted session is IGNORED. Any inbound
// message that is not the accepted BOOTSTRAP is dropped.
//
// TOKEN NON-DISCLOSURE (§6i): the `cit_`/`cwu_` tokens arrive ONLY on the
// bootstrap and are handed to `onBootstrap` in a closure. This module NEVER
// writes them to storage, the URL, an uplink, or any log/telemetry — it does not
// log the bootstrap at all.
// ---------------------------------------------------------------------------

import {
  EMBED_MESSAGE_TYPES,
  EMBED_PROTOCOL_VERSION,
  RESIZE_MAX_HEIGHT,
  createMonotonicSeqGate,
  createSingleUseGate,
  evaluateBootstrap,
  originMatchesExpected,
  sourceMatchesExpected,
  type BootstrapRejectReason,
  type EmbedAssistant,
  type EmbedBootstrap,
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
  /** The endpoint the iframe RETAINS — receives the BOOTSTRAP + posts uplinks. */
  readonly localPort: BridgePortEndpoint;
  /** The endpoint TRANSFERRED to the parent in the token-free READY. */
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
  /** `?assistant` — bootstrap `session.assistant` MUST equal this (§4). */
  expectedAssistant: EmbedAssistant | string;
  /** `?instanceId` — bootstrap `cms.instanceId` MUST equal this (§4). */
  expectedInstanceId: string;
  /** Invoked ONCE, after a valid bootstrap is accepted and the nonce burned.
   *  Receives the tokens+context in a closure; the caller drives the turn (§9)
   *  and MUST NOT persist/log the tokens. */
  onBootstrap: (bootstrap: EmbedBootstrap) => void;
  /** Invoked on a rejected inbound bootstrap so the caller renders a NEUTRAL
   *  error card (no oracle to the parent) and never mounts the wire (§4). */
  onReject?: (reason: BootstrapRejectReason) => void;
  /** The window the iframe expects as the message source + uplink target. Test
   *  seam; defaults to the real `window.parent`. */
  parentWindow?: Window;
  /** The window the iframe listens/posts on. Test seam; defaults to `window`. */
  selfWindow?: Window;
  /**
   * (§12b) Require the PORT transport: refuse a window-delivered (legacy)
   * bootstrap so a downgrade cannot be forced by stripping the transferred port.
   * The iframe still transfers the port in READY and accepts the BOOTSTRAP over
   * it. Defaults to FALSE during the negotiated transition (interoperate with an
   * as-yet-unmigrated widget that replies via `window.postMessage`); flip to TRUE
   * — and drop the legacy path — once both CMS widgets have migrated.
   */
  requirePort?: boolean;
  /** (§12b) Test seam: mint the handshake `MessageChannel`. Defaults to a real
   *  channel; the iframe RETAINS `localPort` and TRANSFERS `remotePort`. */
  createChannel?: CreateBridgeChannel;
};

export type EmbedBridge = {
  /** The minted per-frame nonce (§6b); exposed for diagnostics/tests only. */
  readonly nonce: string;
  /** True once a valid bootstrap has been accepted (the nonce is burned). */
  readonly bootstrapped: boolean;
  /** Post the READY pre-bootstrap envelope to the expected parent origin (§3a). */
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
 * posted so a bootstrap that races the transfer is never missed. Whichever
 * transport the parent chooses, the SAME single-use nonce burn + seq gates apply
 * and the second channel is mooted once bootstrapped.
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

  const nonceGate = createSingleUseGate(); // §6c-i single bootstrap per frame
  // §6c: two INDEPENDENT monotonic seq counters, one per direction.
  const outboundSeq = createMonotonicSeqGate(); // iframe -> parent
  const inboundSeq = createMonotonicSeqGate(); // parent -> iframe (post-bootstrap)

  let bootstrapped = false;
  let readyPosted = false;
  let correlationId: string | null = null;
  // The transport the accepted bootstrap arrived on — uplinks then ride the same
  // channel the parent proved it is listening on.
  let activeTransport: "port" | "legacy" | null = null;

  function nextOutboundSeq(): number {
    const next = (outboundSeq.last ?? -1) + 1;
    outboundSeq.accept(next);
    return next;
  }

  function postReady(): void {
    // Idempotent: the remote endpoint is transferred (neutered) exactly once —
    // a second pre-bootstrap call must NOT re-transfer an already-detached port
    // (which would throw DataCloneError).
    if (bootstrapped || readyPosted) return;
    readyPosted = true;
    // Transfer the remote endpoint to the expected parent origin ONLY, never "*"
    // (§6a outbound). The explicit target origin is the origin gate AT TRANSFER
    // TIME: only a document at `expectedParentOrigin` receives the port, so a
    // message later arriving on the retained `localPort` is inherently from that
    // origin. The READY body is byte-identical to the pre-migration envelope
    // (protocolVersion 1) so an unmigrated widget is unaffected; the transferred
    // port is out-of-band and simply ignored by a legacy parent.
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
  // port). Token non-disclosure is unchanged: the tokens are handed to
  // `onBootstrap` in a closure and never logged/persisted/uplinked.
  function acceptBootstrap(raw: unknown, transport: "port" | "legacy"): void {
    const decision = evaluateBootstrap({
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

    bootstrapped = true;
    activeTransport = transport;
    correlationId = decision.data.correlationId;
    options.onBootstrap(decision.data);
  }

  // §12b PORT path — the hardened transport. No origin/source check: the port was
  // transferred ONLY to `expectedParentOrigin`, so its provenance IS the origin
  // guarantee (and it is document-bound, immune to the WindowProxy residual).
  function onPortMessage(event: MessageEvent): void {
    if (bootstrapped) return;
    acceptBootstrap(event.data, "port");
  }

  // Legacy WINDOW path — the pre-migration transport, kept ONLY for the
  // negotiated transition and refused entirely under `requirePort`.
  function onWindowMessage(event: MessageEvent): void {
    if (bootstrapped) return;
    // (§6a) strict origin, BEFORE schema.
    if (!originMatchesExpected(event.origin, options.expectedParentOrigin)) return;
    // (§6a-2) source-window binding, BEFORE schema — a sibling frame on the same
    // origin must never cross-bootstrap.
    if (!sourceMatchesExpected(event.source, parent)) return;
    acceptBootstrap(event.data, "legacy");
  }

  localPort.addEventListener("message", onPortMessage);
  localPort.start();
  // Downgrade resistance (§12b): under `requirePort` the window path is NOT
  // attached at all, so a legacy/window-delivered bootstrap can never be accepted
  // — the transport cannot be silently downgraded by stripping the port.
  if (!requirePort) {
    self.addEventListener("message", onWindowMessage);
  }

  function postUplink(partial: Record<string, unknown>): boolean {
    // Uplinks are only valid after a bootstrap established the correlationId +
    // the transport the parent is listening on.
    if (!bootstrapped || correlationId === null || activeTransport === null) {
      return false;
    }
    const message = {
      ...partial,
      protocolVersion: EMBED_PROTOCOL_VERSION,
      correlationId,
      seq: nextOutboundSeq(),
    };
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
    get bootstrapped() {
      return bootstrapped;
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
