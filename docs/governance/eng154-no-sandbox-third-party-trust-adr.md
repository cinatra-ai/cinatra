# ADR — In-process, no-sandbox extension trust (first-party launch posture)

- Status: ACCEPTED (cinatra-engineering#168 ruling (a), 2026-06-13)
- Scope: the trust posture for executing extension code, NOT a runtime change
- Supersedes nothing; records the posture eng#122 surfaced and eng#168 (a) ruled
- Source: eng#122 Tier-1 must-do #5 (cinatra-engineering#122); unblocked by the
  owner ruling on cinatra-engineering#168 (a)

## Context

A Cinatra extension is signed code that the host imports **in-process**. There
is no sandbox between the extension and the host runtime. The trust boundary is
the **Ed25519 signature + human review** of the published package — not a
runtime isolation boundary (`packages/sdk-extensions/README.md:167-169`:
"the host does not sandbox it — the trust boundary is the signature + review").

This ADR records, for the public **v0.1.x first-party launch**, that this
posture is **deliberately accepted**, and fixes the exact condition that will
make runtime isolation **mandatory** before that acceptance can continue.

## Decision

1. **No-sandbox in-process execution is ACCEPTED for the first-party launch.**
   For v0.1.x, every published extension is authored, signed, and reviewed by
   `cinatra-ai`. The signature + review boundary is sufficient *because the set
   of code authors is exactly the set of people who already operate the host.*
   Isolation would add cost and surface without changing who is trusted.

2. **Isolation becomes MANDATORY at a single, named trigger** — see
   [Isolation trigger](#isolation-trigger). It is a third-party-RELEASE-posture
   blocker, not a first-party-runtime blocker: nothing in this ADR gates the
   first-party launch.

## Threat model (what "no sandbox" actually grants)

Signed extension code runs with the **host process's full ambient authority**.
Concretely, an installed-and-activated extension can:

- **Act with full process authority the instant it is imported** — read/write
  the filesystem, open the network, read environment variables (secrets),
  spawn `child_process` — and it does so **at module-import (top-of-file)
  time**, which is **after** the signature/trust gate authorizes the import but
  **before** `register(ctx)` runs and before any host-port / capability grant
  is checked. Grant checks therefore govern which **host ports** an extension is
  handed, *not* its ambient OS authority; a top-level side effect never reaches
  a grant check at all.
- **Run arbitrary unsandboxed SQL on the shared multi-tenant schema** through a
  declared migration (`packages/sdk-extensions/README.md:167-169`). Migrations
  run only for `trusted-signed` packages, but once trusted they are not
  schema-scoped by any runtime mechanism — the `ext_<scope>_<pkg>_…` table
  prefix and per-row `org_id` filter are **authoring conventions enforced by
  review, not by an isolation boundary**.

Least privilege today governs **ports** (which host capabilities an extension
is granted), **not** ambient authority. That is the precise gap a sandbox would
close, and the precise reason it is safe to defer while every author is
first-party.

## Why isolation is deferred (vs the Shopify / browser-extension precedent)

Shopify apps and browser extensions sandbox third-party code because they
**admit arbitrary third-party publishers from day one** — their threat model
includes a hostile-but-signed publisher, so a signature is necessary but never
sufficient, and isolation is load-bearing on launch day.

Cinatra's launch threat model is different: the only publisher is `cinatra-ai`.
A hostile-publisher scenario does not exist yet, so the runtime isolation those
platforms need on day one is **work without a corresponding launch risk**.
Building it now would delay the launch to defend against a publisher set of
size one that we already fully control. The decision is to defer the build and
**bind its mandatory delivery to the exact moment the threat model changes**,
rather than ship isolation speculatively or ship third-party admission
unguarded.

## Isolation trigger

Isolation MUST land **before the first non-cinatra-ai publisher is admitted.**

**"Admitted" is defined operationally:** the marketplace lists, for install by
any instance, a package whose **source repository is not owned by the
`cinatra-ai` GitHub organization.** The trigger fires on the *first such
listing* — not on the first install, and not on a private/experimental
preview. A fork or mirror that still serves first-party-authored, first-party-
signed bytes is **not** an admission (it changes the remote, not the author of
record).

When the trigger fires, the following become **mandatory**, gating that first
third-party listing:

- **A real OS-level execution boundary per extension** — a subprocess or
  container with a separate OS process boundary, a **scrubbed environment**
  (no host secrets in `env`), and **constrained filesystem, network, and
  child-process** authority. Node `worker_threads` is explicitly **NOT**
  sufficient: a worker shares the process and its ambient authority, so it is
  not a security boundary for env/fs/net/child_process.
- **A dedicated database role per extension**, scoped to that extension's own
  tables, so a migration cannot reach another tenant's or another extension's
  schema even if its SQL tries to. This replaces the review-enforced
  `ext_<scope>_<pkg>_…` / `org_id` convention with an enforced boundary.

Designing and landing those mechanisms is itself an owner-approved,
high-risk change (it touches the extension loader and the migration path); this
ADR sets the trigger, not the implementation.

## Consequences

- The launch proceeds first-party with no isolation work blocking it.
- The acceptance is **conditional and self-expiring**: the moment a non-
  cinatra-ai-owned repository is listed, this ADR's acceptance no longer holds
  and the isolation work above is a release blocker for that listing.
- Reviewers and operators have one unambiguous question to answer before any
  third-party listing: *is the isolation boundary above in place?* If not, the
  listing is refused.
