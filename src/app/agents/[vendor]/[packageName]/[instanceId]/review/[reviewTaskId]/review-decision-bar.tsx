// The host DECISION BAR moved to `@cinatra-ai/agents/review-decision-bar`
// (cinatra#2566, epic #2564 S2) so the ONE review renderer can mount the SHIPPED
// bar on all three first-party hosts — the chat thread and the run card are
// package-side and could not reach a component that lived under an app route.
// Nothing about the bar changed; this file stays as the route-local name every
// existing import (and the design-conformance greps) already use.
export {
  ReviewDecisionBar,
  type SubmitReviewDecisionAction,
} from "@cinatra-ai/agents/review-decision-bar";
