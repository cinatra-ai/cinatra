import "server-only";

import { createHash, randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// Run-token spine — the dispatch-minted per-run credential (#1193).
//
// PROBLEM. Run identity currently reaches the app through several parallel,
// re-derived channels — a `cinatra_run_id` flow input (forgeable via a
// DataFlowEdge), an A2A context-id header, a dispatcher-signed binding, and an
// in-process registry. Each surface answers "which run is calling?" its own
// way. The run-identity-spine epic (#1192) collapses them onto ONE credential.
//
// SOLUTION (this module, the identity carrier + verifier). At dispatch the
// worker mints a random 256-bit per-run token and persists ONLY its sha256
// hash in the unique-indexed `agent_runs.run_token_hash` column, BEFORE the
// blocking sendTask (the same race-free ordering the context-id pre-bind
// uses). The raw token rides the WayFlow initial message under a reserved key
// and — in a later wave — is attached to first-party callbacks host-anchored
// to the configured base URL. A single server verifier hashes a presented
// token and looks the run up by the unique index:
//   - absent token          ⇒ { ok: false, reason: "absent" }      (caller ⇒ 403)
//   - present-but-no-match   ⇒ { ok: false, reason: "unresolvable" }(caller ⇒ 403)
//   - unique-index hit       ⇒ { ok: true, run }
// There is NO body-id fallback and NO newest-wins tie-break: the lookup is a
// single unique-index probe, so it resolves at most one run or none.
//
// Only the HASH is ever stored, so a database read cannot recover a live
// token. The token is a bearer credential whose authority is the run it
// resolves to; body-supplied ids can never promote a run into OBO/actor
// minting because that path consults this verifier, not a raw body id.
// ---------------------------------------------------------------------------

/**
 * The reserved key under which the dispatcher embeds the RAW per-run token in
 * the WayFlow A2A initial message payload (spread-then-overwrite, so agent
 * inputs can never smuggle it). The double-underscore sentinel guarantees no
 * agent's Flow input schema declares it: until the loader is taught to POP it
 * before schema-filtering (a later wave), `agent_loader.py`'s
 * `_filter_inputs_to_flow_schema` already DROPS every undeclared key before
 * `start_conversation`, so the token never reaches WayFlow. Any Python
 * consumer MUST use this exact literal.
 */
export const CINATRA_RUN_TOKEN_MESSAGE_KEY = "__cinatra_run_token__";

/** Random credential size — 256 bits of entropy. */
export const RUN_TOKEN_BYTES = 32;

export type MintedRunToken = {
  /** The raw bearer token. Carried to the container; NEVER persisted or logged. */
  token: string;
  /** sha256-hex of `token`. The ONLY value persisted (`agent_runs.run_token_hash`). */
  tokenHash: string;
};

/**
 * sha256-hex of a raw run token — the value stored in
 * `agent_runs.run_token_hash` and the key the verifier looks a run up by.
 */
export function hashRunToken(rawToken: string): string {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

/**
 * Mint a fresh random per-run credential and its hash. Called by the worker at
 * dispatch time (the run-identity owner), NEVER by anything under OAS control.
 */
export function mintRunToken(): MintedRunToken {
  const token = randomBytes(RUN_TOKEN_BYTES).toString("base64url");
  return { token, tokenHash: hashRunToken(token) };
}

/** The run identity a verified token resolves to (never carries the hash). */
export type RunTokenResolution = {
  id: string;
  orgId: string;
  runBy: string | null;
};

export type VerifyRunTokenResult =
  | { ok: true; run: RunTokenResolution }
  | { ok: false; reason: "absent" | "unresolvable" };

/**
 * THE run-token verifier. Hashes a presented token and resolves the run via
 * the injected unique-index lookup (`readAgentRunByTokenHash` in production;
 * a fake in hermetic tests). Fail-closed and side-effect-free: it performs no
 * body-id fallback and does not log — the calling route logs the 403 with the
 * returned `reason` and the run/context ids (never the token or the hash).
 *
 * A constant-time compare is unnecessary: resolution is a database unique-index
 * probe on sha256(token), not a byte comparison of a secret, and forging a hit
 * requires guessing a 256-bit token.
 */
export async function verifyRunToken(
  rawToken: string | null | undefined,
  lookupByHash: (hash: string) => Promise<RunTokenResolution | null>,
): Promise<VerifyRunTokenResult> {
  if (typeof rawToken !== "string" || rawToken.length === 0) {
    return { ok: false, reason: "absent" };
  }
  const run = await lookupByHash(hashRunToken(rawToken));
  if (!run) {
    return { ok: false, reason: "unresolvable" };
  }
  return { ok: true, run };
}
