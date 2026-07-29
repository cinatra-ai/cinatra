# cinatra#2139 residuals — proof index

Both residuals recorded on the D-8 + OBS-1 change, closed together. Everything
here was produced against a real Postgres with the canonical DDL, real
constraints and real blob IO — no stubs on the DB or storage path.

| file | what it proves |
|---|---|
| `logs/integration-suites.txt` | the affected real-store suites, all green: the new `claimed-row-context-pinnability-2139` suite plus every suite that owns a contract this change touches (the #1430 snapshot/pin path, the #2047 claimed-production path, the dashboard-form exclusion, both CMS capture writers, the binding write path). |
| `logs/counterfactuals.txt` | the same new suite with parts of the change reverted to the default branch. Residual (a) is a **coordinated triple**: reverting the snapshot-candidate rule, the resolver, or the selection-finalizer **alone** already leaves the suite red, and no single site carries it. Residual (b) reverted turns the three witness rungs red. |
| `logs/codex-round1-verdict.txt` | convergence round 1 — NOT MERGE-SAFE, three findings, all adopted. |
| `logs/codex-round2-verdict.txt` | round 2 — the winner-identity blocker, adopted in full. |
| `logs/codex-round3-verdict.txt` | round 3 — closed; one test-hardening suggestion, also adopted. |

## What the new suite drives

**Residual (a)** — on an organization that HOLDS the pack's claim, an artifact
produced through the shipped writer is pinned at its **authored** representation
(no data snapshot is minted for it), resolves with the assertion triple intact,
finalizes into a real retention pin, and serves its real bytes. A claimed
typed-DATA row keeps the snapshot arm only. A claimed pack-typed row whose
representation no host writer authored is refused at **all three** sites, and the
real provenance row flips every one of them. Winner identity is enforced, not
assumed: a *retiring* claim is still the winner and still pins, while a claim
superseded by a narrower-scope one stops pinning immediately — before the
reconcile queue drains.

**Residual (b)** — both CMS capture writers emit the provenance witness inside
their own capture transaction, a degraded capture emits none (there is no
representation to vouch for), and the consequence the missing witness would have
cost is shown end to end: a claimed captured CMS snapshot still serves.

## Not covered here

No UI surface changed, so there is no render proof. Both lifecycle fences remain
at their default on the default branch; nothing in this change reads them.
