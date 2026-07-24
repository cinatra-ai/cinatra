/**
 * The lifecycle-interceptions PURE contract barrel (cinatra#2038, epic #2037 S0).
 *
 * Re-exports every pure core + contract this foundation slice lands (no DB, no
 * server-only) so downstream slices import from one place. The DB-bound stores
 * live in `packages/agents/src/lifecycle-*-store.ts` and are imported directly.
 */

export * from "./lifecycle-policy";
export * from "./lifecycle-produced-event";
export * from "./lifecycle-continuation";
export * from "./lifecycle-repair";
export * from "./lifecycle-batch";
export * from "./lifecycle-advisory-seam";
export * from "./lifecycle-separation-of-duties";
export * from "./lifecycle-schemas";
// Lifecycle-interceptions S1 pure cores (cinatra#2039, epic #2037): the review-
// orchestration plan + effects-gating verdict, the fenced local-write emit
// builder, and the single global activation fence. No DB / server-only.
export * from "./lifecycle-orchestration";
export * from "./lifecycle-emit";
export * from "./lifecycle-activation";
