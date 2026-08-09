// The gate BLOCKED / LOADING states moved to
// `@cinatra-ai/agents/review-gate-states` (cinatra#2566, epic #2564 S2) so the
// ONE review renderer can draw §IV's "no longer open" and "loading" with the
// SHIPPED components rather than a second look-alike. Nothing about them
// changed; this file stays as the route-local name every existing import (and
// the design-conformance greps) already use.
export { ReviewGateBlocked, ReviewGateLoading } from "@cinatra-ai/agents/review-gate-states";
