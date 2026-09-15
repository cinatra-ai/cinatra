"use client";

// ---------------------------------------------------------------------------
// HOW A RUN IS READ, AND WHICH CREDENTIAL THAT READ TRAVELS ON (cinatra#2902;
// lifted to its own module by cinatra#3044).
// ---------------------------------------------------------------------------
//
// TWO readers now ask the same route the same question. The inline run panel
// seeds itself from a run, and the conversation's own run container reads that
// same run to learn which lifecycle moment it stands at. Two copies of "how a
// run is read" is exactly how two readers drift into two credentials — and the
// one that drifts wrong asks with an ambient cookie from a frame that must
// never send one. So the request is built HERE, once.
//
// The three answers are the column's own three (see `./conversation-credential`
// for what decides between them):
//
//   · COOKIE — a first-party host. The request is UNCHANGED, to the byte: the
//     same URL, the same `Accept`, the same `cache: "no-store"`, and no
//     `credentials` field, so the ambient session rides it exactly as it always
//     has. A preservation control pins this.
//   · BROKER — the third-party application's frame. The broker headers travel
//     on the request and `credentials` is `"omit"`, both supplied by the one
//     shared builder, so a caller cannot forget the mode and send a cookie it
//     must not send.
//   · REFUSED — a host that cannot say who is asking. It asks NOTHING. A run is
//     somebody's work, and an unclear surface must not learn about one by
//     issuing the request that would answer as whoever else is signed in.
// ---------------------------------------------------------------------------

import {
  brokerRequestInit,
  type ConversationCredential,
} from "./conversation-credential";

/** The run's own seed route. One definition, so the two readers cannot drift. */
export const RUN_SEED_ROUTE = "/api/agents/runs";

export function runSeedRequest(
  credential: ConversationCredential,
  runId: string,
): { url: string; init: RequestInit } | null {
  if (credential.kind === "refused") return null;
  const url = `${RUN_SEED_ROUTE}/${encodeURIComponent(runId)}`;
  const base: RequestInit = {
    method: "GET",
    headers: { Accept: "application/json" },
    cache: "no-store",
  };
  if (credential.kind === "cookie") return { url, init: base };
  return { url, init: brokerRequestInit(credential.auth, base) };
}
