// ---------------------------------------------------------------------------
// The parent CMS <-> Cinatra iframe embed bridge (S5 cinatra#1221 Lane B;
// PROTOCOL 2 by cinatra#2674, epic #2564 S8e).
//
// WHAT CHANGED AT PROTOCOL 2, AND WHY IT IS THE WHOLE POINT. Protocol 1's one
// inbound envelope was a BOOTSTRAP and it carried the credential pair: the
// parent page composed `auth.citToken` + `auth.cwuToken` and posted them into
// the frame. That made the embedding site a holder of the user's widget bearer
// by construction — the site's own JavaScript possessed a credential that
// belongs to the person and to Cinatra. Protocol 2 RETIRES that envelope. The
// inbound message is a CONTEXT message (`cinatra.embed.context`) and it carries
// only PUBLIC, UNTRUSTED SELECTORS: which site, which agent, which CMS resource
// is on screen. The frame acquires its own credential itself, on the Cinatra
// origin, and no credential crosses this boundary in either direction ever
// again.
//
// THREE STRUCTURAL CONSEQUENCES, all enforced here rather than by convention:
//   1. There is NO credential FIELD. The context schema has no `auth` and is
//      `.strict()`, so a v1 parent's credential-bearing message is REJECTED, not
//      stripped-and-accepted.
//   2. There is no credential-shaped VALUE either. Every envelope in BOTH
//      directions runs `containsCredentialShapedValue` before its strict parse,
//      so a bearer smuggled inside an allowed field (a `resourceId` that is
//      really a `cwu_…`) fails the parse as well. This is the control the
//      instrumented postMessage harness asserts with synthetic sentinels.
//   3. The version literal ADVANCED to 2. A protocol-1 parent and a protocol-2
//      frame cannot negotiate at all — the migration is a fresh sign-in owned by
//      the frame, never a silent fallback to parent credential delivery.
//
// TIER-NEUTRAL by construction: this module is PURE (no `server-only`, no DOM,
// no window) so BOTH the iframe client wiring (`embed-bridge.client.ts`) AND
// the unit tests exercise the SAME schemas + validators, and the two CMS lanes
// (wordpress-plugin, drupal-module) consume the exact byte-level field contract
// from a single source of truth. Every control here is unit-testable WITHOUT a
// server or a browser — the trust boundary is proven at the schema/validator
// layer.
//
// FAIL-CLOSED throughout: every envelope is a zod `.strict()` schema (unknown
// keys / wrong types are rejected, never ignored); the inbound CONTEXT message
// is accepted ONLY after origin + source-window + schema + protocolVersion +
// nonce-echo + assistant/instance agreement ALL hold, in that order. Nothing
// here is authority: the iframe NEVER treats `cms.*` or `site.*` as authority —
// the SERVER re-derives the site, org, origin, agent and canonical instance and
// denies on any mismatch (`widget-frame-auth.ts`). A parent-supplied selector
// can only ever DISAMBIGUATE among things the server already established.
// ---------------------------------------------------------------------------

import { z } from "zod";

/**
 * Bumped on any breaking bridge change; both sides pin the literal.
 *
 * 2 (cinatra#2674): the credential-bearing BOOTSTRAP is retired in favour of the
 * selector-only CONTEXT message. This is deliberately breaking — a protocol-1
 * parent cannot negotiate with a protocol-2 frame, which is what makes "the
 * parent can no longer deliver a credential" true rather than merely intended.
 */
export const EMBED_PROTOCOL_VERSION = 2 as const;

/**
 * The protocol version whose inbound envelope carried the credential pair. Kept
 * as a named constant for exactly one purpose: the regression that proves a v1
 * message is REJECTED. Nothing in this module ever accepts it.
 */
export const RETIRED_CREDENTIAL_PROTOCOL_VERSION = 1 as const;

/** The CLOSED message-type allowlist (§6e). There is no arbitrary-tool channel. */
export const EMBED_MESSAGE_TYPES = {
  /** iframe -> parent, PRE-context, the ONLY message without a correlationId. */
  ready: "cinatra.embed.ready",
  /** parent -> iframe, the ONE inbound envelope. Carries SELECTORS, never a
   *  credential — the type was renamed from `…bootstrap` so the retired
   *  credential carrier cannot be reached by name either. */
  context: "cinatra.embed.context",
  /** iframe -> parent uplinks (post-context). */
  resize: "cinatra.embed.resize",
  focus: "cinatra.embed.focus",
  a11y: "cinatra.embed.a11y",
  applyIntent: "cinatra.embed.apply_intent",
} as const;

/** The retired protocol-1 inbound type. Named ONLY so the regression can name
 *  it; it appears in no schema. */
export const RETIRED_BOOTSTRAP_MESSAGE_TYPE = "cinatra.embed.bootstrap" as const;

/** `?assistant` values; == the `cit_`-bound kind (§4). */
export const EMBED_ASSISTANTS = ["wordpress", "drupal"] as const;
export type EmbedAssistant = (typeof EMBED_ASSISTANTS)[number];

/**
 * Content-height uplink upper bound (§5 / §B9). A height within schema range but
 * above the parent's panel cap is CLAMPED by the parent, not schema-rejected;
 * NaN / negative / > this max is schema-rejected here.
 */
export const RESIZE_MAX_HEIGHT = 20000;

/**
 * The ONLY S4 view that carries an apply-able proposal/change-set (§5). The
 * other S4 views (artifact_preview, citation_group, change_history) are
 * display-only and NOT apply-eligible. Extended ONLY as a new apply-eligible S4
 * view lands — never an open string (an arbitrary value must never choose
 * behaviour).
 */
export const APPLY_INTENT_VIEW_TYPES = ["content_change_proposal"] as const;

// A CSPRNG base64url value carrying >=128 bits of entropy is >=22 chars; the
// charset+length are enforced so a merely-short/low-entropy id is rejected
// (§6b). Upper bound guards against unbounded-string abuse.
const ID_PATTERN = /^[A-Za-z0-9_-]{22,128}$/;
const idSchema = z.string().regex(ID_PATTERN);

const seqSchema = z.number().int().nonnegative();

// ---------------------------------------------------------------------------
// Prototype-pollution / dangerous-key guard.
//
// zod 4.x `.strict()` DELIBERATELY ignores an own-enumerable `__proto__` key
// (it strips it rather than raising `unrecognized_keys`), which would violate
// this module's "unknown keys are REJECTED, never ignored" contract at the
// trust boundary. A raw structured-clone/JSON message can carry such a key, so
// every boundary envelope is wrapped with a recursive raw-key guard that FAILS
// CLOSED before the strict parse runs. None of the closed schemas define a
// field named `__proto__` / `constructor` / `prototype`, so rejecting them can
// never drop a legitimate message — it is purely the strict-mode enforcement
// zod skips.
// ---------------------------------------------------------------------------
const DANGEROUS_OWN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function containsDangerousKey(value: unknown, depth = 0): boolean {
  if (depth > 8 || value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) {
    return value.some((v) => containsDangerousKey(v, depth + 1));
  }
  // getOwnPropertyNames catches an own `__proto__` data property (as produced by
  // JSON.parse('{"__proto__":…}')), which `Object.keys` + zod strict skip.
  for (const key of Object.getOwnPropertyNames(value)) {
    if (DANGEROUS_OWN_KEYS.has(key)) return true;
  }
  for (const key of Object.keys(value)) {
    if (containsDangerousKey((value as Record<string, unknown>)[key], depth + 1)) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// (cinatra#2674) CREDENTIAL-SHAPED VALUE GUARD — the second half of "no
// credential crosses this boundary".
//
// Removing the `auth` field removes the credential FIELD. It does not remove the
// possibility of a credential VALUE: every remaining field is a string a parent
// chooses, so a site could put a `cwu_…` in `cms.resourceId`, and a frame could
// put one in an `a11y` uplink. Both would be a credential on the bridge, which
// is the thing this slice exists to end.
//
// So every envelope in BOTH directions is scanned for a value carrying one of
// Cinatra's credential prefixes before its strict parse runs, and the message
// FAILS CLOSED when one is found. The prefixes are the real ones the platform
// mints (`cwu_` per-user widget token, `cit_` site transport token, `cnx_`
// connect-site credential); they are checked case-insensitively and after
// trimming, because a value that differs from a credential only by whitespace or
// case is a credential someone is trying to sneak past a check.
//
// This is a CONTAINMENT control, not a secret-detector: it cannot recognise a
// credential that carries no prefix, and it is not asked to. What it does
// guarantee — and what the instrumented postMessage harness asserts with
// synthetic sentinels — is that no message on this bridge can carry a value
// shaped like one of our bearers, in either direction, at any depth.
// ---------------------------------------------------------------------------

/** The bearer prefixes this platform mints. A value containing one of these at a
 *  token boundary is treated as a credential wherever it appears. */
export const CREDENTIAL_VALUE_PREFIXES = ["cwu_", "cit_", "cnx_"] as const;

/**
 * A bearer prefix ANYWHERE in the string, at a token boundary (codex round 0,
 * finding 2).
 *
 * A prefix-only test was too weak: `"Error: cwu_…"` and
 * `"https://x/?t=cwu_…"` are credentials on the wire, and an error string or a
 * URL is exactly how one would arrive there by accident. The boundary class
 * keeps it from firing on a word that merely ENDS in the letters (a fictional
 * `"abccwu_"`), while still catching every separator a real message would put in
 * front of a token. Case-insensitive, because a value that differs from a
 * credential only by case is a credential someone is trying to sneak past.
 */
const CREDENTIAL_TOKEN_RE = new RegExp(
  `(?:^|[^A-Za-z0-9])(?:${CREDENTIAL_VALUE_PREFIXES.map((p) => p.slice(0, -1)).join("|")})_`,
  "i",
);

/** True when `value` is a string carrying one of our bearer shapes. */
export function isCredentialShapedValue(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return CREDENTIAL_TOKEN_RE.test(value);
}

/** Recursively true when ANY string anywhere in `value` is credential-shaped —
 *  object values, array members and object KEYS alike (a key is as visible to a
 *  logger as a value). Depth-bounded like the dangerous-key guard. */
export function containsCredentialShapedValue(value: unknown, depth = 0): boolean {
  if (depth > 8) return false;
  if (isCredentialShapedValue(value)) return true;
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) {
    return value.some((v) => containsCredentialShapedValue(v, depth + 1));
  }
  for (const key of Object.keys(value)) {
    if (isCredentialShapedValue(key)) return true;
    if (containsCredentialShapedValue((value as Record<string, unknown>)[key], depth + 1)) {
      return true;
    }
  }
  return false;
}

/**
 * Wrap a strict schema so a raw message FAILS the parse when it carries an own
 * `__proto__` (or other dangerous own key) at any depth — zod strict would
 * silently strip it — or a credential-shaped value anywhere (cinatra#2674). The
 * superRefine sees the RAW value before the piped strict schema runs; the piped
 * output type is unchanged.
 */
function protoGuarded<T extends z.ZodTypeAny>(schema: T) {
  return z
    .unknown()
    .superRefine((val, ctx) => {
      if (containsDangerousKey(val)) {
        ctx.addIssue({ code: "custom", message: "forbidden object key" });
      }
      if (containsCredentialShapedValue(val)) {
        ctx.addIssue({ code: "custom", message: "credential-shaped value" });
      }
    })
    .pipe(schema);
}

// ---------------------------------------------------------------------------
// (§3a) READY — iframe -> parent, pre-bootstrap. Posted to the expected parent
// origin ONLY (never "*"). No correlationId (it does not exist yet).
// ---------------------------------------------------------------------------
const embedReadyObject = z
  .object({
    type: z.literal(EMBED_MESSAGE_TYPES.ready),
    protocolVersion: z.literal(EMBED_PROTOCOL_VERSION),
    nonce: idSchema,
    seq: seqSchema,
  })
  .strict();
export const embedReadySchema = protoGuarded(embedReadyObject);
export type EmbedReady = z.infer<typeof embedReadyObject>;

// ---------------------------------------------------------------------------
// (§4) CONTEXT — parent -> iframe. The ONLY inbound message the iframe accepts.
// It conveys PUBLIC, UNTRUSTED SELECTORS and nothing else (cinatra#2674). Field
// names are the byte-level contract the CMS lanes MUST emit.
//
// EVERY FIELD BELOW IS A SELECTOR, NOT AN ASSERTION. `site.siteId`,
// `cms.instanceId` and `session.assistant` name things the SERVER already knows
// about; the server re-derives the authoritative site, org, origin, agent and
// canonical instance from its own rows and DENIES on any mismatch. A parent that
// names another site's id gets a denial, not that site's data.
// ---------------------------------------------------------------------------
const httpsUrlString = z
  .string()
  .url()
  .max(2048)
  // §6g: HTTP(S) only — never navigated by the iframe, display context only.
  .refine((u) => {
    try {
      return /^https?:$/.test(new URL(u).protocol);
    } catch {
      return false;
    }
  }, "href must be http(s)");

const embedContextObject = z
  .object({
    type: z.literal(EMBED_MESSAGE_TYPES.context),
    protocolVersion: z.literal(EMBED_PROTOCOL_VERSION),
    correlationId: idSchema, // parent-minted CSPRNG (>=128-bit); §6b
    nonceEcho: idSchema, // MUST equal the frame's READY nonce; §6b
    seq: seqSchema, // parent->iframe counter (§6c)
    // The PUBLIC site selector. Optional, because the frame can already name the
    // site without the parent's help (its own `?assistant`+`?instanceId` and the
    // server-resolved framing origin), and a disambiguator that is not needed
    // must not become required. Never a credential: a connect-site id is a
    // public handle, and the `cnx_` credential it pairs with stays server-side.
    site: z
      .object({ siteId: z.string().min(1).max(200) })
      .strict()
      .optional(),
    session: z
      .object({
        threadId: z.string().min(1).max(200),
        assistant: z.enum(EMBED_ASSISTANTS), // == ?assistant
      })
      .strict(),
    cms: z
      .object({
        instanceId: z.string().min(1).max(200), // == ?instanceId (disambiguator)
        resourceId: z.string().max(200).optional(), // postId / nodeId
        resourceType: z.string().max(200).optional(), // postType / nodeBundle
        status: z.string().max(64).optional(),
        href: httpsUrlString.optional(),
      })
      .strict(),
  })
  .strict();
export const embedContextSchema = protoGuarded(embedContextObject);
export type EmbedContext = z.infer<typeof embedContextObject>;

// ---------------------------------------------------------------------------
// (§5) POST-BOOTSTRAP uplinks — iframe -> parent. A CLOSED discriminated union;
// each carries type + protocolVersion + correlationId (echoed) + monotonic seq.
// ---------------------------------------------------------------------------
const uplinkBase = {
  protocolVersion: z.literal(EMBED_PROTOCOL_VERSION),
  correlationId: idSchema,
  seq: seqSchema,
} as const;

export const embedResizeSchema = z
  .object({
    type: z.literal(EMBED_MESSAGE_TYPES.resize),
    ...uplinkBase,
    // content height only; NaN/negative/over-max are schema-rejected (§B9).
    height: z.number().int().min(0).max(RESIZE_MAX_HEIGHT),
  })
  .strict();

export const embedFocusSchema = z
  .object({
    type: z.literal(EMBED_MESSAGE_TYPES.focus),
    ...uplinkBase,
    focus: z.boolean(),
  })
  .strict();

export const embedA11ySchema = z
  .object({
    type: z.literal(EMBED_MESSAGE_TYPES.a11y),
    ...uplinkBase,
    // parent renders as textContent (never HTML).
    liveRegion: z.string().max(2000),
    politeness: z.enum(["polite", "assertive"]),
  })
  .strict();

export const embedApplyIntentSchema = z
  .object({
    type: z.literal(EMBED_MESSAGE_TYPES.applyIntent),
    ...uplinkBase,
    proposalId: z.string().max(200).optional(),
    changeSetId: z.string().max(200).optional(),
    viewType: z.enum(APPLY_INTENT_VIEW_TYPES),
  })
  .strict()
  // Exactly one of proposalId/changeSetId — the parent treats it as an UNTRUSTED
  // SELECTOR (§6f); carries NO content and NO tool call (§5).
  .refine(
    (m) => (m.proposalId != null) !== (m.changeSetId != null),
    "exactly one of proposalId / changeSetId is required",
  );

/** The CLOSED uplink union (READY is the separate pre-bootstrap envelope). */
const embedUplinkUnion = z.union([
  embedResizeSchema,
  embedFocusSchema,
  embedA11ySchema,
  embedApplyIntentSchema,
]);
export const embedUplinkSchema = protoGuarded(embedUplinkUnion);
export type EmbedUplink = z.infer<typeof embedUplinkUnion>;

// ---------------------------------------------------------------------------
// Pure validators — the trust-boundary controls (§6), each testable in isolation.
// ---------------------------------------------------------------------------

/**
 * (§6a) Strict target-origin. Inbound `event.origin` MUST equal the
 * server-resolved expected parent origin (NOT `document.referrer` / the first
 * message's origin — both spoofable seeds). Empty on either side never matches.
 */
export function originMatchesExpected(
  eventOrigin: string | null | undefined,
  expectedParentOrigin: string | null | undefined,
): boolean {
  if (!eventOrigin || !expectedParentOrigin) return false;
  return eventOrigin === expectedParentOrigin;
}

/**
 * (§6a-2) Source-window binding. Origin alone does not stop a
 * sibling/cross-instance frame on the SAME origin from cross-bootstrapping — the
 * message's `event.source` MUST be the identity-equal expected window
 * (`window.parent` on the iframe side; `iframe.contentWindow` on the parent
 * side). Nullish sources never match. Kept pure: the caller passes the two
 * opaque window handles.
 */
export function sourceMatchesExpected(
  eventSource: unknown,
  expectedWindow: unknown,
): boolean {
  return eventSource != null && expectedWindow != null && eventSource === expectedWindow;
}

export type ContextRejectReason =
  | "schema"
  | "nonce_mismatch"
  | "assistant_mismatch"
  | "instance_mismatch";

export type ContextDecision =
  | { ok: true; data: EmbedContext }
  | { ok: false; reason: ContextRejectReason };

/**
 * (§4 handling order, AFTER the caller has already gated origin (§6a) and
 * source-window (§6a-2)): schema -> protocolVersion (enforced by the literal) ->
 * nonceEcho === frame nonce (§6b) -> assistant === ?assistant -> cms.instanceId
 * === ?instanceId. Any mismatch fails closed with a typed reason; the caller
 * mounts NOTHING on a non-ok decision and renders a neutral error card (no
 * oracle to the parent). Pure: no window here — and, since cinatra#2674, no
 * token handling anywhere in this module because there is no token to handle.
 */
export function evaluateContext(input: {
  raw: unknown;
  frameNonce: string;
  expectedAssistant: EmbedAssistant | string;
  expectedInstanceId: string;
}): ContextDecision {
  // embedContextSchema is proto-guarded + strict: an own `__proto__`/dangerous
  // key, a credential-shaped value anywhere, a protocol-1 version literal, the
  // retired `…bootstrap` type, a retired `auth` block, or any other unknown key
  // all fail here as `schema` (§B2). protocolVersion is pinned by the literal, so
  // no separate reachable branch is needed.
  const parsed = embedContextSchema.safeParse(input.raw);
  if (!parsed.success) return { ok: false, reason: "schema" };
  const data = parsed.data;
  if (data.nonceEcho !== input.frameNonce) {
    return { ok: false, reason: "nonce_mismatch" };
  }
  if (data.session.assistant !== input.expectedAssistant) {
    return { ok: false, reason: "assistant_mismatch" };
  }
  if (data.cms.instanceId !== input.expectedInstanceId) {
    return { ok: false, reason: "instance_mismatch" };
  }
  return { ok: true, data };
}

/**
 * (§6c) A per-direction, per-correlation monotonic sequence gate. A message
 * whose seq does NOT strictly increase for its direction is dropped (replay /
 * reorder). Two INDEPENDENT gates are used — one per direction. The first
 * accepted seq may be any non-negative value (the parent mints seq=0 for
 * CONTEXT; the frame's READY seq is on the other direction).
 */
export function createMonotonicSeqGate(): {
  accept(seq: number): boolean;
  readonly last: number | null;
} {
  let last: number | null = null;
  return {
    accept(seq: number): boolean {
      if (!Number.isInteger(seq) || seq < 0) return false;
      if (last !== null && seq <= last) return false;
      last = seq;
      return true;
    },
    get last() {
      return last;
    },
  };
}

/**
 * (§6c-i) Single-use nonce burn. Once a valid CONTEXT message is accepted the
 * nonce is burned; a second one on a mounted session is ignored (single context
 * per frame; a new session = reload). Also backs the parent-side apply de-dup LRU
 * seed. Kept as a tiny pure helper so the client wiring holds no ad-hoc flag.
 */
export function createSingleUseGate(): { consume(): boolean; readonly used: boolean } {
  let used = false;
  return {
    consume(): boolean {
      if (used) return false;
      used = true;
      return true;
    },
    get used() {
      return used;
    },
  };
}

// ---------------------------------------------------------------------------
// (§12b) PORT-BOUND TRANSPORT — retained at protocol 2, for a NARROWER reason.
//
// AT PROTOCOL 1 this transport existed to protect a credential. `event.source`
// is a WindowProxy — a live handle to a browsing CONTEXT, not to a specific
// DOCUMENT — so a same-origin replacement of the iframe's document would still
// satisfy `event.source === expectedWindow`, and a parent posting the
// credential-bearing BOOTSTRAP at the WindowProxy would have delivered the
// tokens to the REPLACEMENT document (issue #1965).
//
// AT PROTOCOL 2 THERE IS NO CREDENTIAL TO MISDELIVER. The inbound message
// carries selectors only, so the worst a misdelivered one can do is tell a
// replacement document which CMS post is on screen. The transport is kept
// anyway, because the property it provides is still worth having and costs
// nothing: the retained endpoint belongs to the REALM that ran the handshake, so
// a replacement document is a fresh realm that never inherits it and therefore
// cannot silently take over an established session's uplink channel. Defense in
// depth, no longer the credential wall — the credential wall is now that no
// credential exists on this bridge at all.
//
// The two functions below are the PURE (DOM-free, tier-neutral) parent-side
// transport primitives — the SINGLE SOURCE OF TRUTH the two CMS widgets
// (wordpress-plugin, drupal-module) mirror for their parent bridge. The CONTEXT
// body is byte-identical across transports.
// ---------------------------------------------------------------------------

/**
 * Structural handle for a window/WindowProxy postMessage sink — it REQUIRES an
 * explicit target origin (never "*"). Kept structural so this module stays
 * tier-neutral (no DOM lib): the caller passes `iframe.contentWindow`.
 */
export interface WindowPostTarget {
  postMessage(message: unknown, targetOrigin: string): void;
}

/**
 * Structural handle for an entangled `MessageChannel` endpoint. A port needs NO
 * target origin — the origin-targeted READY transfer that delivered it is the
 * binding; the caller passes the port from the READY's `event.ports`.
 */
export interface PortPostTarget {
  postMessage(message: unknown): void;
}

/** The transport the PARENT uses for the ONE inbound CONTEXT message (§12b). */
export type ParentContextTransport =
  | { readonly mode: "port"; readonly port: PortPostTarget }
  | {
      readonly mode: "window";
      readonly window: WindowPostTarget;
      readonly targetOrigin: string;
    };

export type ParentTransportDecision =
  | { ok: true; transport: ParentContextTransport }
  | { ok: false; reason: "no_port_available" };

/**
 * (§12b) PARENT-side transport selection. Given the ports the iframe transferred
 * on the ALREADY-GATED READY (origin + source-window + schema, checked by the
 * caller with `originMatchesExpected`/`sourceMatchesExpected`/`embedReadySchema`)
 * and the window fallback, choose the transport for the CONTEXT message —
 * fail-closed and downgrade-resistant:
 *   - a transferred port is present    -> PORT MODE (the message rides ONLY the
 *     entangled port; a same-origin replacement of the iframe cannot receive it);
 *   - no port AND `requirePort`        -> FAIL CLOSED (`no_port_available`): the
 *     window transport can NOT be selected merely by omitting/stripping the
 *     transferred port, and the caller sends NOTHING;
 *   - no port AND window allowed       -> WINDOW MODE: the origin-pinned window
 *     transport, for a frame that transferred no port.
 *
 * Bind this to the frame's single-use nonce gate on the parent side
 * (`createSingleUseGate`): a second READY on a burned nonce is ignored, so a
 * replacement document cannot re-open the handshake to force a downgrade. PURE:
 * the caller passes the opaque transferred ports + the fallback window; no DOM
 * assumption, fully unit-testable.
 */
export function selectParentContextTransport(input: {
  transferredPorts: ReadonlyArray<PortPostTarget> | null | undefined;
  fallbackWindow: WindowPostTarget;
  fallbackTargetOrigin: string;
  requirePort: boolean;
}): ParentTransportDecision {
  const port = input.transferredPorts != null ? input.transferredPorts[0] : undefined;
  if (port != null) {
    return { ok: true, transport: { mode: "port", port } };
  }
  if (input.requirePort) {
    return { ok: false, reason: "no_port_available" };
  }
  return {
    ok: true,
    transport: {
      mode: "window",
      window: input.fallbackWindow,
      targetOrigin: input.fallbackTargetOrigin,
    },
  };
}

/**
 * (§12b) Send the CONTEXT message over the SELECTED transport. In PORT MODE it
 * rides ONLY the entangled port — this function NEVER calls a window
 * `postMessage` in port mode. In WINDOW MODE it posts to the origin-pinned
 * WindowProxy, never "*": a wildcard/empty target origin FAILS CLOSED (the
 * message is dropped, never broadcast cross-origin) so the "never '*'" invariant
 * is enforced HERE, in the reference the widgets mirror, not left to the caller.
 *
 * The message is re-validated against the CONTEXT schema before it is sent
 * (cinatra#2674). The parent side of the bridge is code the CMS lanes mirror, and
 * a mirror that composed a credential-bearing message would put a bearer on the
 * wire even though the frame would later refuse it — a message that never leaves
 * is strictly better than one that is rejected on arrival. Returns whether the
 * message was sent, so a caller can render its own neutral failure.
 */
export function sendContextOverTransport(
  transport: ParentContextTransport,
  context: EmbedContext,
): boolean {
  // Refuse to emit anything that is not a valid, credential-free CONTEXT message.
  if (!embedContextSchema.safeParse(context).success) return false;
  if (transport.mode === "port") {
    transport.port.postMessage(context);
    return true;
  }
  // §6a: a message is NEVER broadcast to a wildcard/empty origin.
  if (!transport.targetOrigin || transport.targetOrigin === "*") return false;
  transport.window.postMessage(context, transport.targetOrigin);
  return true;
}
