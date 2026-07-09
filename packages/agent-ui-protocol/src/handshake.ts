// ---------------------------------------------------------------------------
// AG-UI capability handshake (cinatra#1217, epic #1216 S1).
//
// The single capability + version negotiation for every assistant surface,
// replacing the bespoke `GET /api/agents/{slug}/capabilities` v1/v2
// negotiation. The retired shape advertised a `contractVersion` string plus a
// FROZEN SSE frame list (`["text","changes","error","done"]`) and per-behavior
// boolean flags (`supportsChangesFrame`, `supportsMarkdown`); this handshake
// carries NONE of those names. Instead the server advertises the AG-UI contract
// version range it speaks, that the wire is durable/resumable, the auth modes
// the surface accepts, and the renderable-view `viewType`s it MAY emit — and
// the client negotiates the highest mutually-supported contract.
//
// Tier-neutral: types + pure functions only (the server builds the
// advertisement; the client negotiates against it). No server-only constraint.
// ---------------------------------------------------------------------------

import {
  ASSISTANT_STREAM_CONTRACT_VERSION,
  type AssistantStreamContractVersion,
} from "./contract";

/**
 * How a surface authenticates its stream. The endpoint shape is identical
 * across surfaces; only this differs.
 *
 *  - `session`      — first-party `/chat`: the caller's cookie session.
 *  - `token-broker` — every embedded surface: a short-lived same-origin
 *                     `cit_`/`cwu_` token minted by the token broker. The
 *                     browser never holds a long-lived key (there is no
 *                     legacy long-lived-key path in this contract).
 */
export const ASSISTANT_STREAM_AUTH_MODES = ["session", "token-broker"] as const;

export type AssistantStreamAuthMode =
  (typeof ASSISTANT_STREAM_AUTH_MODES)[number];

/**
 * The server-advertised capabilities of an assistant-stream surface. Static,
 * instance-independent contract metadata — it leaks nothing instance-specific
 * (no auth config, no package names, no extension internals), mirroring the
 * security posture of the endpoint it replaces.
 */
export type AssistantStreamCapabilities = {
  /** Highest contract version this surface prefers to speak. */
  readonly contract: string;
  /**
   * Every contract version this surface can speak, newest-preferred order not
   * required — negotiation picks the numerically-highest mutual entry.
   */
  readonly supportedContracts: readonly string[];
  /**
   * The durable log + `Last-Event-ID` resume is intrinsic to this contract;
   * advertised explicitly so a client can assert it before relying on resume.
   * Always `true` for a conforming surface.
   */
  readonly resumable: boolean;
  /** Transport kind. Server-Sent Events today; the field leaves room to grow. */
  readonly transport: "sse";
  /** The auth modes this surface accepts; the client picks one it can satisfy. */
  readonly auth: readonly AssistantStreamAuthMode[];
  /**
   * The renderable-view `viewType` discriminators (see `./renderable-views`)
   * this surface MAY emit as typed `DATA_PART` payloads. ADVISORY: a client
   * renders the ones it knows and falls back safely for the rest — an absent
   * entry never gates rendering, it only informs the client which views to
   * expect. This is the extensible successor to the frozen SSE frame list.
   */
  readonly renderableViews: readonly string[];
};

/**
 * Build a conforming capability advertisement for a surface. `contract` and
 * `supportedContracts` default to the current contract version; callers supply
 * the surface's `auth` modes and the `renderableViews` it can emit.
 */
export function buildAssistantStreamCapabilities(params: {
  auth: readonly AssistantStreamAuthMode[];
  renderableViews?: readonly string[];
  contract?: AssistantStreamContractVersion;
  supportedContracts?: readonly string[];
}): AssistantStreamCapabilities {
  const contract = params.contract ?? ASSISTANT_STREAM_CONTRACT_VERSION;
  return {
    contract,
    supportedContracts: params.supportedContracts ?? [contract],
    resumable: true,
    transport: "sse",
    auth: params.auth,
    renderableViews: params.renderableViews ?? [],
  };
}

// ---------------------------------------------------------------------------
// Version negotiation
// ---------------------------------------------------------------------------

/**
 * Compare two semver-shaped contract versions numerically by dot-separated
 * segments (missing trailing segments treated as 0). Non-numeric segments sort
 * as 0. Returns <0 / 0 / >0 like `Array#sort`'s comparator.
 */
export function compareContractVersions(a: string, b: string): number {
  const pa = a.split(".");
  const pb = b.split(".");
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = Number.parseInt(pa[i] ?? "0", 10);
    const nb = Number.parseInt(pb[i] ?? "0", 10);
    const va = Number.isFinite(na) ? na : 0;
    const vb = Number.isFinite(nb) ? nb : 0;
    if (va !== vb) return va - vb;
  }
  return 0;
}

/**
 * The outcome of negotiating a contract version between a client and a server.
 * On success, `contract` is the numerically-highest version both sides support.
 * On failure the two support lists are echoed so the surface can render an
 * actionable "incompatible — update one side" message (the same fail-closed
 * posture the retired negotiation enforced: no mutual version => the surface
 * does not mount).
 */
export type ContractNegotiation =
  | { readonly ok: true; readonly contract: string }
  | {
      readonly ok: false;
      readonly reason: "no_mutual_contract";
      readonly clientSupported: readonly string[];
      readonly serverSupported: readonly string[];
    };

/**
 * Negotiate the contract version. Picks the highest version present in BOTH the
 * client's supported list and the server's advertised `supportedContracts`. No
 * mutual version is a hard incompatibility (`ok: false`) — there is no
 * optimistic default and no legacy fallback.
 */
export function negotiateContract(
  clientSupported: readonly string[],
  server: Pick<AssistantStreamCapabilities, "supportedContracts">,
): ContractNegotiation {
  const serverSet = new Set(server.supportedContracts);
  const mutual = clientSupported.filter((v) => serverSet.has(v));
  if (mutual.length === 0) {
    return {
      ok: false,
      reason: "no_mutual_contract",
      clientSupported: [...clientSupported],
      serverSupported: [...server.supportedContracts],
    };
  }
  const highest = mutual.reduce((best, v) =>
    compareContractVersions(v, best) > 0 ? v : best,
  );
  return { ok: true, contract: highest };
}

// ---------------------------------------------------------------------------
// Full handshake — version + auth mode + required renderable views.
//
// `negotiateContract` above negotiates only the VERSION. A surface's handshake
// also has to (a) confirm the server accepts the auth mode the client will
// present, and (b) confirm every renderable view the client REQUIRES is one the
// server can emit — both FAIL-CLOSED, so an incompatibility surfaces at the
// handshake, never as a silent downgrade that fails deep in a later render.
//
// Two deliberate non-behaviours (see CONTRACT.md §5):
//   - Auth is DECLARATIVE, not negotiated. The client states the single mode it
//     will present; the server route still enforces it for real. The handshake
//     asserts the server ACCEPTS that mode and never selects a WEAKER one.
//   - The server never filters the shared durable log by client capability.
//     `requiredViews` is a fail-closed pre-check only; views the client merely
//     supports are NOT listed here — the client renders the views it knows and
//     falls back safely on any unknown view (`isRenderableViewOfType` === false).
// ---------------------------------------------------------------------------

/** What a client presents to open a stream on a surface. */
export type StreamClientHello = {
  /** Contract versions the client speaks; negotiation picks the highest mutual. */
  readonly supportedContracts: readonly string[];
  /**
   * The single auth mode the client will present on this surface. Declarative —
   * the handshake asserts the server accepts it, never downgrades to a weaker
   * mode.
   */
  readonly authMode: AssistantStreamAuthMode;
  /**
   * Renderable-view `viewType`s the client REQUIRES the server be able to emit.
   * Any unmet entry fails the handshake closed. Optional — omit when the client
   * requires no specific view (it still renders any it knows, falls back on the
   * rest).
   */
  readonly requiredViews?: readonly string[];
  /** When true, the client requires the durable resume of §4; unmet fails closed. */
  readonly requiresResumable?: boolean;
};

/** The outcome of a full stream handshake. */
export type StreamNegotiation =
  | {
      readonly ok: true;
      /** The negotiated (highest mutual) contract version. */
      readonly contract: string;
      /** Echoed auth mode the server accepted — the same one the client presents. */
      readonly authMode: AssistantStreamAuthMode;
      /** The satisfied `requiredViews` (advisory echo; the log is never filtered). */
      readonly requiredViews: readonly string[];
    }
  | {
      readonly ok: false;
      readonly reason: "no_mutual_contract";
      readonly clientSupported: readonly string[];
      readonly serverSupported: readonly string[];
    }
  | {
      readonly ok: false;
      readonly reason: "auth_mode_unsupported";
      readonly clientAuthMode: AssistantStreamAuthMode;
      readonly serverAuthModes: readonly AssistantStreamAuthMode[];
    }
  | {
      readonly ok: false;
      readonly reason: "required_view_unsupported";
      readonly missingViews: readonly string[];
    }
  | { readonly ok: false; readonly reason: "not_resumable" };

/**
 * Negotiate a full stream handshake between a client hello and a server
 * advertisement. Checks fail-closed in order of fundamentality — version, then
 * auth mode, then resumability, then required views — and returns the FIRST
 * failure so the surface can render one precise, actionable reason. On success
 * the negotiated contract, the accepted auth mode, and the satisfied required
 * views are returned.
 */
export function negotiateStreamContract(
  client: StreamClientHello,
  server: AssistantStreamCapabilities,
): StreamNegotiation {
  // 1. Version — reuse the single-leg negotiator (highest mutual, fail-closed).
  const version = negotiateContract(client.supportedContracts, server);
  if (!version.ok) return version;

  // 2. Auth — declarative assertion; never downgrade to a weaker mode.
  if (!server.auth.includes(client.authMode)) {
    return {
      ok: false,
      reason: "auth_mode_unsupported",
      clientAuthMode: client.authMode,
      serverAuthModes: [...server.auth],
    };
  }

  // 3. Resumability — a client that requires resume on a non-resumable surface
  //    fails closed rather than silently losing events on a reconnect.
  if (client.requiresResumable && !server.resumable) {
    return { ok: false, reason: "not_resumable" };
  }

  // 4. Required views — every required view must be server-emittable.
  const required = client.requiredViews ?? [];
  const serverViews = new Set(server.renderableViews);
  const missingViews = required.filter((v) => !serverViews.has(v));
  if (missingViews.length > 0) {
    return { ok: false, reason: "required_view_unsupported", missingViews };
  }

  return {
    ok: true,
    contract: version.contract,
    authMode: client.authMode,
    requiredViews: [...required],
  };
}
