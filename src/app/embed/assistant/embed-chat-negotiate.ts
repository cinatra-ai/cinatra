// ---------------------------------------------------------------------------
// S5 (cinatra#1221) Lane B §8 — the embed's CLIENT-SIDE capability handshake.
//
// The merged capabilities route is explicit that a cross-origin embed negotiates
// CLIENT-SIDE, NOT via the session-gated POST: "Cross-origin surfaces (the S5
// embedded view) negotiate client-side with the same module — their graphs are
// not /chat's" (src/app/api/assistants/chat/capabilities/route.ts). So this
// lives in the EMBED's own module graph (NOT ag-ui-chat-client.ts, which /chat
// imports and whose graph is a locked dev-perf budget) and runs the PURE
// `negotiateStreamContract` from the shared handshake module in the browser.
//
// The embed GETs the static advertisement with `credentials: "omit"` + the
// broker headers (§9.1) and negotiates `authMode: "token-broker"`. It mounts the
// wire ONLY on `negotiation.ok === true`, FAIL-CLOSED on every failure —
// `auth_mode_unsupported` / `no_mutual_contract` / `not_resumable`, AND on
// malformed capability JSON / transport failure (§B18).
//
// LANE-A INTERLOCK (§8) — RESOLVED by cinatra#1998 (epic #1216 S6). The
// capabilities route now (a) advertises `token-broker` AND (b) serves that
// advertisement to a sessionless broker-auth embed presenting the SAME
// `cit_`/`cwu_` dual-token pair the turn endpoint brokers. Because this GET is
// SAME-ORIGIN to the Cinatra-served app, the browser sends no CMS `Origin`
// header (and JS cannot set the forbidden `Origin`), so the embed forwards the
// server-resolved parent (CMS) origin + its bound assistant handle here
// (`X-Cinatra-Widget-Origin` / `X-Cinatra-Widget-Assistant`); the route
// validates both against the token binding (a forged value fails closed — the
// tokens are the authority). Absent forwarded context (or an invalid token pair)
// → the route 401s → this fails closed and the embed does NOT mount. That
// remains the honest gated state, never a fail-open.
//
// `requiresResumable: false` UNTIL §9.3 lands a broker-auth resume path (codex
// R1): the server always advertises `resumable: true`, but whether a
// broker-audience token is ACCEPTED at the resume endpoint is the §9.3(A)
// decision; the embed degrades to a fresh mount on reconnect so it must not fail
// the handshake on a resumability it does not require. Flip to `true` once §9.3
// lands.
// ---------------------------------------------------------------------------

import {
  negotiateStreamContract,
  type AssistantStreamCapabilities,
  type StreamClientHello,
  type StreamNegotiation,
} from "@cinatra-ai/agent-ui-protocol/stream";
import { CLIENT_SUPPORTED_CONTRACTS } from "@cinatra-ai/chat/ag-ui-chat-client";

/** The embed's hello: token-broker auth; resume NOT required until §9.3 lands. */
export const EMBED_CLIENT_HELLO: StreamClientHello = {
  supportedContracts: CLIENT_SUPPORTED_CONTRACTS,
  authMode: "token-broker",
  requiresResumable: false,
};

const CAPABILITIES_ENDPOINT = "/api/assistants/chat/capabilities";

/** Cross-origin forwarding seams (cinatra#1998 Lane A). The embed's negotiate
 *  GET is SAME-ORIGIN to the Cinatra app, so the CMS origin cannot ride the
 *  browser `Origin` header; it is forwarded explicitly and validated against the
 *  token binding server-side (a lie fails the consume closed). */
const WIDGET_ORIGIN_HEADER = "X-Cinatra-Widget-Origin";
const WIDGET_ASSISTANT_HEADER = "X-Cinatra-Widget-Assistant";

/** The non-secret disambiguators the embed forwards so the sessionless,
 *  same-origin capabilities GET can be authenticated against the CMS-origin-
 *  bound `cit_`/`cwu_` tokens. Both are validated against the token binding —
 *  never trusted on their own. */
export type EmbedNegotiateContext = {
  /** The bound assistant handle ("wordpress" | "drupal"). */
  readonly assistant?: string;
  /** The server-resolved expected parent (CMS) origin the tokens are bound to. */
  readonly parentOrigin?: string;
};

/** Structural guard for the advertisement JSON — a malformed body is a
 *  fail-closed transport-integrity failure (§B18), not a parse crash. Validates
 *  EVERY field `negotiateStreamContract` reads (a non-iterable `renderableViews`
 *  or `auth`/`supportedContracts` would otherwise throw INSIDE the pure
 *  negotiator), so the guard is the sole trust boundary for the untrusted body. */
function isCapabilitiesShape(v: unknown): v is AssistantStreamCapabilities {
  if (typeof v !== "object" || v === null) return false;
  const c = v as Record<string, unknown>;
  const allStrings = (a: unknown): boolean =>
    Array.isArray(a) && a.every((x) => typeof x === "string");
  return (
    typeof c.contract === "string" &&
    allStrings(c.supportedContracts) &&
    typeof c.resumable === "boolean" &&
    // The embed speaks ONLY the SSE AG-UI wire; a non-SSE transport must NOT
    // negotiate ok and mount (negotiateStreamContract does not check transport),
    // so pin it here — fail closed on any other advertised transport (§8/§B18).
    c.transport === "sse" &&
    allStrings(c.auth) &&
    allStrings(c.renderableViews)
  );
}

/**
 * Negotiate the embed stream contract CLIENT-SIDE. Fetches the advertisement
 * with `credentials: "omit"` + broker headers, then runs the pure negotiator.
 * Returns a `StreamNegotiation` — `ok:true` only when the server advertises a
 * mutual contract AND `token-broker`; every failure (including a non-200 fetch,
 * malformed JSON, or a network error) resolves to a fail-closed `ok:false` so
 * the caller mounts NOTHING.
 */
export async function negotiateEmbedChatContract(
  authHeaders: () => Record<string, string>,
  context: EmbedNegotiateContext = {},
): Promise<StreamNegotiation> {
  try {
    const forwarded: Record<string, string> = {};
    if (context.assistant) forwarded[WIDGET_ASSISTANT_HEADER] = context.assistant;
    if (context.parentOrigin) forwarded[WIDGET_ORIGIN_HEADER] = context.parentOrigin;
    const res = await fetch(CAPABILITIES_ENDPOINT, {
      method: "GET",
      headers: { ...authHeaders(), ...forwarded },
      credentials: "omit", // §B11 — ambient Cinatra cookies must NOT auth this.
      cache: "no-store",
    });
    if (!res.ok) {
      // Session-gated today (Lane-A interlock) or a real error — fail closed as
      // an unsupported auth mode so the surface renders one precise reason.
      return {
        ok: false,
        reason: "auth_mode_unsupported",
        clientAuthMode: EMBED_CLIENT_HELLO.authMode,
        serverAuthModes: [],
      };
    }
    const body = (await res.json()) as unknown;
    if (!isCapabilitiesShape(body)) {
      return {
        ok: false,
        reason: "no_mutual_contract",
        clientSupported: [...EMBED_CLIENT_HELLO.supportedContracts],
        serverSupported: [],
      };
    }
    // Run the PURE negotiator INSIDE the try so any residual throw (an exotic
    // hostile payload that passes the shape guard) still fails closed (§B18).
    return negotiateStreamContract(EMBED_CLIENT_HELLO, body);
  } catch {
    // Malformed JSON / transport failure / negotiator throw → fail closed (§B18).
    return {
      ok: false,
      reason: "auth_mode_unsupported",
      clientAuthMode: EMBED_CLIENT_HELLO.authMode,
      serverAuthModes: [],
    };
  }
}
