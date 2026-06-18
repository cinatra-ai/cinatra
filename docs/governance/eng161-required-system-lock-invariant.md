# The `required == system == lock == 8` invariant (current state, not law)

- Status: DOCUMENTED (cinatra-engineering#168 ruling (d), 2026-06-13)
- Source: eng#122 Tier-4 must-do #20 (cinatra-engineering#122); unblocked by the
  owner ruling on cinatra-engineering#168 (d)

## The fact

Today, three artifacts agree on the same set of **8 packages**:

| Artifact | What it declares | Where |
| --- | --- | --- |
| `cinatra.extensions` | the prod-boot **required** set (must be installed for prod boot to succeed; carries version ranges) | root `package.json` |
| `cinatra.systemExtensions` | the **system/locked** set (locked on install; destructive ops — archive/uninstall/force-delete/purge/registry-removal — are refused; update preserves the lock) | root `package.json` |
| `cinatra-required-extensions.lock.json` | the SHA-pinned **acquisition lock** for the prod bootable set (one entry per `extensions` package) | repo root |

All three are length **8** and name the same 8 packages
(`@cinatra-ai/nango-connector`, `code-reviewer-agent`, `planner-agent`,
`author-agent`, `lint-policy-agent`, `security-reviewer-agent`,
`assistant-skills`, `default-artifact`).

## The ruling: this equality is a CURRENT INVARIANT, not a permanent law

Per cinatra-engineering#168 (d): the three-way equality holding at **8** is a
**current-state invariant** — true today and worth asserting as a drift guard —
but it is **not a permanent law of the system.** The number 8, and the
coincidence that the required set and the system set are *identical* rather than
merely *related*, are facts of the present launch configuration, not design
constraints that must hold forever.

What is the law, and what is incidental:

- **LAW (must always hold):** `systemExtensions ⊆ extensions`. A system
  (locked) package that is not also required would leave the prod-boot verifier
  unable to guarantee it is installed. This subset relation is enforced
  fail-closed today by
  `packages/extensions/src/__tests__/system-extension-inventory.test.ts`
  ("system inventory is a SUBSET of cinatra.extensions") and is the
  permanent invariant.
- **LAW (must always hold):** the acquisition lock covers exactly the required
  set — one pinned entry per `extensions` package — so prod can acquire
  every required package from SHA-pinned source. The two locks are a disjoint
  partition (the dev lock must never carry a required package); see
  [extension-clone-pinning.md](./../extension-clone-pinning.md).
- **INCIDENTAL (true today, may change):** that `systemExtensions` happens to
  *equal* (not merely be a subset of) `extensions`, and that both equal
  **8**. The first required-but-not-system extension makes the sets diverge in
  size while the subset law still holds.

## `required-but-not-system`: the intended future behavior

A **required-but-not-system** extension is one that prod boot must find
installed (it is in `extensions`) but that is *not* in
`systemExtensions`. It is legal under the subset law and is the expected shape
of the first divergence. The conceptual split eng#122 #20 asked for: *required*
answers "must this be installed for prod?"; *system* answers "is this protected
from destructive operator actions?". They are different questions that happen to
have the same answer for all 8 of today's packages.

**Current code does not yet honor that split.** Today, in production, the
required set is auto-locked: `requiredInProd` is sourced from
`cinatra.extensions` (`packages/extensions/src/required-in-prod.ts`),
and a required-in-prod install is coerced to `status: "locked"` in non-dev mode
(`packages/extensions/src/index.ts` install seam;
`lifecycle-primitive.ts`/`system-extension-inventory.ts` boot-lock), after
which destructive ops refuse any locked row
(`packages/extensions/src/index.ts` destructive-op guard). So **a
required-but-not-system package would still be locked in production today** —
the `requiredInProd` prod-lock, not just `systemExtensions`, currently drives
locking for the required set.

The **intended future** behavior, which requires an owner-approved code change
to adopt, is to decouple the prod-lock from "required" so that:

- **Prod boot** still treats it like any required package (boot refuses if it is
  absent; the acquisition lock carries its SHA-pinned source) — unchanged.
- **Lifecycle does not lock it for being merely required:** archive / uninstall
  / force-delete / purge / registry-removal become **permitted** (subject to the
  normal required-set presence guard — you still cannot leave the required set
  unsatisfied at prod boot — but the *lock-based* destructive-op refusal no
  longer applies to a not-system package). Locking would then track
  `systemExtensions` membership alone, not `requiredInProd`.
- **Drift guards** assert the **subset** relation, not the equality: the
  `systemExtensions ⊆ extensions` test continues to hold; the
  size-equality and the literal `8` are *not* asserted as invariants.

Until that code change lands, the equality is not merely incidental in
configuration — it is also load-bearing in current prod behavior (required
⟹ locked-in-prod). This doc records the target semantics so the first
divergence is adopted deliberately, with the matching `requiredInProd`/lock
decoupling, rather than by accident.

## On collapsing the three declarations (deferred — doc-only here)

eng#122 #20 also asked whether the three declarations should physically
**collapse** to one declaration + the SHA lock. Per ruling (d) the collapse is
low-risk either way, and this change does **not** perform it: the physical
collapse would touch the host extension wiring and the generated-manifest
pipeline, which is out of scope for a documentation clarification and would
require its own owner-approved change. For now the three artifacts are correctly
understood as **three views of one fact** (the bootable, locked, pinned set),
kept in agreement by the drift tests above.

As noted above, adopting the `required-but-not-system` divergence case likewise
requires a future owner-approved code change: today locking is driven by
`systemExtensions` membership AND, in production, by `requiredInProd` (the
required set), so the two would have to be decoupled before a required package
could be left unlocked. The test suite asserts the subset relation, but the
running configuration still has the two sets equal. This doc records the
intended semantics so the first divergence lands deliberately, not as a
surprise.
