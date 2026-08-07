# Attribution record correction — squash 20245dc8c9c55677e15d3a325135df7d5fbfc940 (PR #2476)

The post-merge truthful-attribution gate reported `reviewed-by-fabricated` on this squash because the
reviewer's LATEST review state at evaluation time was COMMENTED. The underlying approval was real and
commit-bound: the maintainer approved PR #2476 at its exact merged head `31456e315fd558f1d9e2354323c6759e267d82c2`
at 2026-08-07T16:37:01Z, and that approval was never dismissed and never followed by a blocking review.
The later COMMENTED review (2026-08-07T16:50:41Z, same head) was created mechanically by the coordination
tooling replying to a review thread through the shared account after the approval — a reply artifact, not a
review decision. The `Reviewed-by` trailer on the squash records the genuine approval; this note corrects the
gate's latest-state reading for the audit trail.

Process correction adopted: review-thread replies on an approved head are never posted through the reviewer's
own account after approval — they ride the bot identity or land before approval — so a reply can no longer
displace the approval as the latest review.
