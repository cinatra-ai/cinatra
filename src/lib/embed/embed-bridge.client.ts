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
// FAIL-CLOSED handling order for the ONE inbound message (§3/§4), each step
// BEFORE the next: (1) `event.origin === expectedParentOrigin` (§6a) → (2)
// `event.source === window.parent` (§6a-2) → (3) schema + protocolVersion +
// nonceEcho + assistant/instance agreement via `evaluateBootstrap` (§4) → (4)
// single-use nonce burn (§6c-i). A second bootstrap on a mounted session is
// IGNORED. Any inbound message that is not the accepted BOOTSTRAP is dropped.
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
 * `postReady()` starts the handshake. The listener is attached immediately so a
 * bootstrap posted right after READY is never missed.
 */
export function installEmbedBridge(options: EmbedBridgeOptions): EmbedBridge {
  const self = options.selfWindow ?? window;
  const parent = options.parentWindow ?? self.parent;
  const nonce = mintBridgeNonce();

  const nonceGate = createSingleUseGate(); // §6c-i single bootstrap per frame
  // §6c: two INDEPENDENT monotonic seq counters, one per direction.
  const outboundSeq = createMonotonicSeqGate(); // iframe -> parent
  const inboundSeq = createMonotonicSeqGate(); // parent -> iframe (post-bootstrap)

  let bootstrapped = false;
  let correlationId: string | null = null;

  function nextOutboundSeq(): number {
    const next = (outboundSeq.last ?? -1) + 1;
    outboundSeq.accept(next);
    return next;
  }

  function postToParent(message: Record<string, unknown>): void {
    // ALWAYS an explicit origin, never "*" (§6a outbound).
    parent.postMessage(message, options.expectedParentOrigin);
  }

  function postReady(): void {
    if (bootstrapped) return;
    postToParent({
      type: EMBED_MESSAGE_TYPES.ready,
      protocolVersion: EMBED_PROTOCOL_VERSION,
      nonce,
      seq: nextOutboundSeq(),
    });
  }

  function onMessage(event: MessageEvent): void {
    // A second bootstrap on a mounted session is IGNORED (§4). Do NOT even
    // inspect further inbound messages once bootstrapped — the wire is the
    // renderer's, not the bridge's.
    if (bootstrapped) return;
    // (§6a) strict origin, BEFORE schema.
    if (!originMatchesExpected(event.origin, options.expectedParentOrigin)) return;
    // (§6a-2) source-window binding, BEFORE schema — a sibling frame on the same
    // origin must never cross-bootstrap.
    if (!sourceMatchesExpected(event.source, parent)) return;

    const decision = evaluateBootstrap({
      raw: event.data,
      frameNonce: nonce,
      expectedAssistant: options.expectedAssistant,
      expectedInstanceId: options.expectedInstanceId,
    });
    if (!decision.ok) {
      options.onReject?.(decision.reason);
      return;
    }
    // (§6c-i) burn the nonce — the bootstrap is single-use.
    if (!nonceGate.consume()) return;
    // (§6c) seed the inbound seq gate with the bootstrap seq.
    if (!inboundSeq.accept(decision.data.seq)) return;

    bootstrapped = true;
    correlationId = decision.data.correlationId;
    options.onBootstrap(decision.data);
  }

  self.addEventListener("message", onMessage);

  function postUplink(partial: Record<string, unknown>): boolean {
    // Uplinks are only valid after a bootstrap established the correlationId.
    if (!bootstrapped || correlationId === null) return false;
    postToParent({
      ...partial,
      protocolVersion: EMBED_PROTOCOL_VERSION,
      correlationId,
      seq: nextOutboundSeq(),
    });
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
      self.removeEventListener("message", onMessage);
    },
  };
}
