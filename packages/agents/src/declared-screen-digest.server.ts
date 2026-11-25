import "server-only";

import { createHash } from "node:crypto";

import { canonicalJson, type DeclaredHitlCard } from "./hitl-gate-submit";

/**
 * The digest stored with the card a step paused with (cinatra#3470): sha-256 of
 * the checked card's canonical JSON. Written by `withDeclaredScreenOfStep` and
 * checked by the server's answer road (`declaredCardOfStep`) with this one
 * function, so the two cannot disagree.
 */
export function declaredScreenDigest(card: DeclaredHitlCard): string {
  return `sha256:${createHash("sha256").update(canonicalJson(card)).digest("hex")}`;
}
