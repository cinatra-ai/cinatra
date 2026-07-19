// ---------------------------------------------------------------------------
// S5 (cinatra#1221) Lane B — the parent CMS <-> Cinatra iframe embed bridge.
//
// TIER-NEUTRAL by construction: this module is PURE (no `server-only`, no DOM,
// no window) so BOTH the iframe client wiring (`embed-bridge.client.ts`) AND
// the unit tests exercise the SAME schemas + validators, and the two CMS lanes
// (wordpress-plugin, drupal-module) consume the exact byte-level field contract
// from a single source of truth (the S5 embed-route design contract,
// §3-6 + §12). Every control here is unit-testable WITHOUT a server or a
// browser — the trust boundary is proven at the schema/validator layer.
//
// FAIL-CLOSED throughout: every envelope is a zod `.strict()` schema (unknown
// keys / wrong types are rejected, never ignored); the inbound BOOTSTRAP — the
// ONE message that conveys credentials/context — is accepted ONLY after origin
// + source-window + schema + protocolVersion + nonce-echo + assistant/instance
// agreement ALL hold, in that order (§4). Nothing here loosens the server auth
// invariant: the iframe NEVER treats `cms.*` as authority — the SERVER re-derives
// the write instance from the tokens (W1 §3/G2/G3); `cms.instanceId` only
// disambiguates and MUST agree with the query.
// ---------------------------------------------------------------------------

import { z } from "zod";

/** Bumped on any breaking bridge change; both sides pin the literal. */
export const EMBED_PROTOCOL_VERSION = 1 as const;

/** The CLOSED message-type allowlist (§6e). There is no arbitrary-tool channel. */
export const EMBED_MESSAGE_TYPES = {
  /** iframe -> parent, PRE-bootstrap, the ONLY message without a correlationId. */
  ready: "cinatra.embed.ready",
  /** parent -> iframe, the ONE inbound envelope; the ONLY credential carrier. */
  bootstrap: "cinatra.embed.bootstrap",
  /** iframe -> parent uplinks (post-bootstrap). */
  resize: "cinatra.embed.resize",
  focus: "cinatra.embed.focus",
  a11y: "cinatra.embed.a11y",
  applyIntent: "cinatra.embed.apply_intent",
} as const;

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

/**
 * Wrap a strict schema so a raw message carrying an own `__proto__` (or other
 * dangerous own key) at any depth FAILS the parse (zod strict would silently
 * strip it). The superRefine sees the RAW value before the piped strict schema
 * runs; the piped output type is unchanged.
 */
function protoGuarded<T extends z.ZodTypeAny>(schema: T) {
  return z
    .unknown()
    .superRefine((val, ctx) => {
      if (containsDangerousKey(val)) {
        ctx.addIssue({ code: "custom", message: "forbidden object key" });
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
// (§4) BOOTSTRAP — parent -> iframe. The ONLY inbound message the iframe accepts
// and the ONLY one that conveys credentials/context. Field names are the
// byte-level contract the CMS lanes MUST emit.
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

const embedBootstrapObject = z
  .object({
    type: z.literal(EMBED_MESSAGE_TYPES.bootstrap),
    protocolVersion: z.literal(EMBED_PROTOCOL_VERSION),
    correlationId: idSchema, // parent-minted CSPRNG (>=128-bit); §6b
    nonceEcho: idSchema, // MUST equal the frame's READY nonce; §6b
    seq: seqSchema, // parent->iframe counter (§6c)
    auth: z
      .object({
        citToken: z.string().startsWith("cit_").max(4096), // site transport token
        cwuToken: z.string().startsWith("cwu_").max(4096), // per-user token
      })
      .strict(),
    session: z
      .object({
        threadId: z.string().min(1).max(200),
        assistant: z.enum(EMBED_ASSISTANTS), // == ?assistant, == cit_ bound kind
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
export const embedBootstrapSchema = protoGuarded(embedBootstrapObject);
export type EmbedBootstrap = z.infer<typeof embedBootstrapObject>;

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

export type BootstrapRejectReason =
  | "schema"
  | "nonce_mismatch"
  | "assistant_mismatch"
  | "instance_mismatch";

export type BootstrapDecision =
  | { ok: true; data: EmbedBootstrap }
  | { ok: false; reason: BootstrapRejectReason };

/**
 * (§4 handling order, AFTER the caller has already gated origin (§6a) and
 * source-window (§6a-2)): schema -> protocolVersion (enforced by the literal) ->
 * nonceEcho === frame nonce (§6b) -> assistant === ?assistant -> cms.instanceId
 * === ?instanceId. Any mismatch fails closed with a typed reason; the caller
 * mounts NOTHING on a non-ok decision and renders a neutral error card (no
 * oracle to the parent). Pure: no window, no token handling here.
 */
export function evaluateBootstrap(input: {
  raw: unknown;
  frameNonce: string;
  expectedAssistant: EmbedAssistant | string;
  expectedInstanceId: string;
}): BootstrapDecision {
  // embedBootstrapSchema is proto-guarded + strict: an own `__proto__`/dangerous
  // key, a wrong protocolVersion literal, a bad token prefix, or any unknown key
  // all fail here as `schema` (§B2). protocolVersion is pinned by the literal, so
  // no separate reachable branch is needed.
  const parsed = embedBootstrapSchema.safeParse(input.raw);
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
 * BOOTSTRAP; the frame's READY seq is on the other direction).
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
 * (§6c-i) Single-use nonce burn. Once a valid bootstrap is accepted the nonce is
 * burned; a second bootstrap on a mounted session is ignored (single bootstrap
 * per frame; re-auth = reload). Also backs the parent-side apply de-dup LRU
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
