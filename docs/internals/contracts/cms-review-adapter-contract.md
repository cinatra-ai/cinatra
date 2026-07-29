# The CMS review adapter contract

Normative contract for a **CMS adapter** — a connector that stages content
writes to a remote content management system — participating in
review-before-publish. It fixes what the host provides (snapshot capture, an
apply binding, effect disposition, read-back verification, pinned renders) and
what the adapter must supply (a scope manifest, a durable operation identity,
server-emitted region anchors, an authenticated preview route).

A CMS content artifact is a **pointer, not content**: the body lives on the
remote site and is read on demand, so it cannot be pinned as a review target.
This contract exists to give the review a target that *can* be pinned — a local,
immutable snapshot of the staged content — and to bind that snapshot to the exact
remote operation it authorises.

## 1. The capability

The host publishes `@cinatra-ai/host:cms-review`, a host-local capability id (not
an SDK ABI entry), registered in `src/lib/register-host-connector-services.ts`.
An adapter resolves it **optionally and lazily**, and is inert when it is absent.

| Member | Contract |
|---|---|
| `isReviewActive()` | Reports the review-orchestration activation state truthfully — **active by default**, false only where the host deployment sets `CINATRA_LIFECYCLE_REVIEW_ORCHESTRATION=off`. An adapter calls this first; when it is false the adapter passes the staged write through unchanged. |
| `captureStagedWrite(input)` | Captures the staged content as an immutable local snapshot + its apply binding, in one transaction. Returns the snapshot identity. |
| `resolveDisposition({artifactId, snapshotRevisionId})` | The five-state disposition of the captured write's external effect: `held`, `approved`, `rejected`, `ungated`, `unknown`, plus the gate reference when there is one. |
| `recordApplyVerification(input)` | Records the post-apply read-back verification against the stored scope manifest. |

Publication is unconditional; the activation state is reported through
`isReviewActive`, not by withholding the capability. The three write-driving members delegate to a seam
bound during boot; if that binding is absent they **fail closed** with an
explicit error rather than silently dropping a capture.

**Tenancy is never adapter input.** The organization, the run and the acting
subject stamped on a capture are derived from the trusted request frame inside
the host binding (`src/lib/cms-review-host-seam.ts`), never from the capture
input. A capture with no resolvable organization is refused; a verification with
no resolvable organization returns `no-org`. The gate and run **coordinates** on
a read-back do come from the adapter — and are validated against the stored
binding before anything is recorded (§6).

## 2. Snapshot capture

`captureStagedWrite` runs one atomic transaction
(`src/lib/artifacts/cms-content-snapshot-capture.ts`) containing:

1. the snapshot's `objects` row, typed
   `@cinatra-ai/objects:cms-content-snapshot` — correlation and display metadata
   only, never the body;
2. the content write — a `resource` + `artifact_blobs` + an append-only
   `representation`, the same substrate an uploaded file uses, so serving,
   retention and garbage collection need no special case;
3. the `artifact_produced_outbox` event, emitter `object_cms_snapshot_capture`
   (spliced only when review orchestration is active); and
4. the `cms_snapshot_targets` apply binding.

The four commit or roll back together: there is never a snapshot without its
binding, nor a produced event without its snapshot.

Facts the adapter should design around:

- **The representation's declared mime is the adapter's resolved mime**, written
  through unchanged. It is the representation's identity, and every mime-keyed
  consumer downstream reads it. The snapshot object type declares exactly one
  accepted representation form — the canonical CMS-fields serialization
  `application/vnd.cinatra.cms-fields+json` — so that is the mime an adapter
  resolves to for the snapshot to serve and render. The blob store's sniffed
  mime is recorded separately as provenance only.
- **Produced-event axes.** A captured snapshot's physical origin is
  `external_link` (mapping to the `user_provided` lattice axis) and its
  destination class is `external_publish` — the external-effect class that makes
  the review checkpoint fire, and that makes the verification checkpoint fire on
  read-back.
- **Size.** Resolved content above 4 MiB is refused
  (`CmsSnapshotTooLargeError`).
- **Immutability.** The snapshot is the decided target. Its object type declares
  no mutating source; the review decision binds to the pinned revision.

## 3. Operation identity — the staging saga

Every staged write carries an adapter-minted `operationId`, persisted on
`cms_snapshot_targets` under a `UNIQUE` constraint. It is the idempotency key for
the whole round-trip:

- **Re-drive.** A repeated capture for the same `operationId` short-circuits on a
  pre-read and returns the existing binding — no second artifact, no second
  produced event.
- **Race.** A concurrent caller that slips past the pre-read hits the unique
  violation, which rolls back the **entire** capture set rather than committing a
  fresh artifact with no binding; the loser re-reads the winner.
- **Read-back.** Verification is addressed by `operationId`, so an adapter that
  lost an acknowledgement can still resolve which snapshot a remote state
  corresponds to.

The binding row records the connector instance, the resource type and id, the
base remote revision reference, the scope manifest and the operation id — enough
to re-address the remote resource without trusting anything the caller passes at
apply time.

## 4. The scope manifest

The scope manifest is the closed set of field paths the review authorises an
apply to change:

```json
{ "paths": ["title", "content"] }
```

Rules:

- The adapter supplies it **at capture time**; it is stored on
  `cms_snapshot_targets.scope_manifest` and is fixed from that moment.
- The read-back reads the manifest **from the stored row**, never from the
  caller, so an apply can never widen what it was authorised to touch.
- An unreadable or malformed stored manifest coerces to `{ "paths": [] }` — an
  empty manifest authorises **no** change, so every observed change reads as
  out-of-scope drift. Fail-closed by construction.
- The manifest states the content-vs-chrome boundary. Only paths the adapter
  owns belong in it; theme chrome is context, never a decidable path.

## 5. Effects gating and the apply

An artifact under a pending review gate has its external effect **held**. Before
applying anything remotely the adapter asks `resolveDisposition`:

| Disposition | Meaning for the adapter |
|---|---|
| `held` | A gate is pending. Do not apply. |
| `approved` | The gate resolved in favour; the apply may proceed. |
| `rejected` | The gate resolved against; the staged content is not applied. |
| `ungated` | Policy left the write ungated; the effect flows. |
| `unknown` | No determination available. Treat as not-approved. |

The host-side hold is deliberate and fail-closed: an external-effect event that
has not yet been orchestrated is held, so an effect can never race ahead of a
decision that has not been made. A gate resolved as `changes_requested` has
**not** released its effect — the hold persists until the successor gate
approves.

The remote-side discipline of the apply — staging drafts rather than mutating
published content, comparing against the base remote revision before writing,
recognising an already-applied desired state instead of re-staging it, and
re-capturing onto a moved base — is the adapter's, and is what the `base remote
revision reference` on the binding exists to support. The host contributes the
authorisation boundary (the manifest), the identity (`operationId`), the hold,
and the verdict.

## 6. Read-back verification

After an approved apply lands, the adapter calls `recordApplyVerification` with
the `operationId`, the gate and run it belongs to, and the **post-apply field
map** it re-read from the site. It never re-sends the approved proposal.

Two authorisation anchors, both from stored state:

1. The **reviewed base** is derived from the stored binding — the captured
   snapshot *is* the approved proposal, read back through the same reader the
   verification uses. An unreadable proposal returns `proposal-unreadable`
   rather than substituting an empty base.
2. The stored snapshot **must be a pinned target of the named gate on the named
   run**, else the call returns `gate-target-mismatch`. An operation's manifest
   can never be paired with an unrelated gate.

The verdict is the shared verification core, with one CMS-specific
strengthening: over every stored scope path, the value must be **present on both
sides and strictly equal**. A missing key is not treated as an approved empty
string, and a key absent from both sides is not treated as a match — so an
in-scope deletion or an in-scope rewrite by the site cannot read as faithful.

| Outcome | Condition |
|---|---|
| `verified` | Every authorised path carries the approved value; nothing changed outside the manifest. |
| `drifted` | A changed field outside the scope manifest — for example a site plugin rewriting content on save. Takes precedence over `unmet`. |
| `unmet` | An authorised path does not carry the approved value — an in-scope rewrite or deletion — with nothing changed outside the manifest. |

`outOfScope` returns the offending paths.

## 7. Region anchors

Anchors come **exclusively from the adapter**. The site emits them server-side in
its own preview render as whole attributes:

| Attribute | Meaning |
|---|---|
| `data-cinatra-region="<field>"` | This element is the owned region for the named field. |
| `data-cinatra-post="<id>"` | Correlation id for the rendered resource. |

The host matches the region attribute as a whole attribute inside a real tag —
never as a substring, never inside a comment or a `<style>` body — and joins a
proposed field to the region of the **same name**. Core knows no concrete field
identity: there is no `title`/`content` literal in the composition leaf, so an
adapter that marks different regions composes just as well.

Reviewer-side CSS guessing is forbidden. An adapter that marks nothing gets
content-only review with the gap stated, not a heuristic.

Gaps are reported, never papered over: every proposed field whose value did not
reach the picture is listed — whether because no region was marked, because an
element's boundary could not be determined, or because the region was nested
inside another substituted region.

## 8. Pinned renders

Inside the same `captureStagedWrite` call that persists the snapshot, the host
fetches the adapter's authenticated preview, renders it in isolation, and pins
the result against the snapshot's `(artifact, revision)` pair
(`src/lib/artifacts/cms-preview-capture.ts`) — the same pair a gate pins, which
is how a capture is later found for the gate. Taking the pictures then, rather
than at view time, is what makes them replay-stable: a capture is written once
and never again, so re-viewing an old gate shows the original picture even after
the site's theme changes. The capture's artifact id is derived from
`sha256(boundArtifactId ␀ boundSnapshotRevisionId ␀ role)` (formatted
uuid-shaped, so it is indistinguishable from any other artifact id downstream),
so exactly one capture exists per (pinned target, role) and a re-drive collides
on the primary key instead of writing a second record.

| Role | What it shows |
|---|---|
| `before` | The live page as it stood at capture time. The effect is held, so this is the real "now". |
| `current` | The proposal, composed into that same captured page's owned regions. The proposal is deliberately not on the site, so it cannot be fetched — it is composed, and the surface says so. |
| `applied` | The page as it stood after an approved apply, fetched fresh at read-back time. |

**Addressing is a closed policy**
(`src/lib/artifacts/cms-preview-capture-policy.ts`):

- The origin is one of the organization's connect-registered site origins.
  Adapter input can only *select* among registered origins; it can never
  introduce one.
- The adapter's `sourceUrl` is a **selector only** — its origin must match a
  registered origin exactly (scheme + host + port). It contributes no path, no
  query, no fragment, no userinfo to the fetched URL.
- The path is a compile-time constant per platform with a single interpolated
  segment, the resource id, validated as a positive decimal integer within the
  platform's bound: `/wp-json/cinatra/v1/preview/<id>` (id ≤ 2147483647) and
  `/cinatra/preview/<id>` (id ≤ 4294967295, because that id space is unsigned).
  The adapter's external id may be bare (`<id>`) or site-scoped
  (`<instanceId>:<id>`); only the segment after the last colon is read, and the
  instance segment contributes nothing to the fetched URL.
- A site whose client kind has no preview adapter is refused by name, not probed.

**Credential and transport.** The request is signed with the site's
connect-provisioned shared secret over the canonical content `preview.<id>`,
using the host's existing outbound signer, with a freshly minted request id per
attempt — the adapter's receiver is expected to recompute the signature, compare
it in constant time, and consume the request id single-use, so a legitimate retry
is never a replay. The secret never enters the renderer subprocess, the stored
capture, or a log. The URL passes the shared egress guard (scheme, credentials,
internal aliases, IP ranges, rebind pinning) before a byte is sent, and redirects
are not followed, so an open redirect on the site cannot walk the signed request
elsewhere; the one carve-out is a loopback HTTP origin on a non-production
instance, which is pinned directly to the loopback address — the same origin
class the connect handshake accepts there. Only an authentication refusal is
retried under a second candidate secret (a rotation window).

**Inertness and isolation.** The fetched page is sanitized and re-checked before
anything is stored or rendered; a page still carrying an executable construct is
refused, not stored. Rendering happens in a separate process with JavaScript
disabled and a same-origin-only subresource policy, pinned to the addresses the
egress guard validated — an empty pinned-address set makes the renderer refuse to
run.

## 9. The degradation contract

Nothing in the render path may fail the staged write or the gate — the capture
step is awaited so its results are pinned with the snapshot, but its outcome
never propagates as an error. The failure modes the pipeline models each resolve
to a **named** reason instead of an exception, and the reason set is closed: a
new modelled failure has to be named to ship.

| Class | Reasons |
|---|---|
| Addressing | `no-registered-site`, `unusable-source-url`, `origin-not-registered`, `invalid-post-id`, `ambiguous-origin-registration`, `client-has-no-preview-adapter` |
| Credential / transport | `no-preview-credential`, `egress-blocked`, `preview-unauthorized`, `preview-unreachable`, `preview-bad-response`, `preview-too-large` |
| Render | `sanitization-failed`, `renderer-unavailable`, `render-failed`, `capture-timeout` |
| Composition | `no-proposed-fields`, `no-owned-regions`, `regions-unplaceable`, `composition-not-inert` |

Each reason carries reviewer-facing copy (`captureDegradeCopy`). What the review
surface reads is the **stored** degraded record: `status: "degraded"`, the named
reason, and no representation — the record exists precisely so the gap can be
stated rather than silently vanishing.

Two honest limits on that record. A capture is bounded by a hard wall-clock
ceiling, and the ceiling resolves the *result* (`capture-timeout`) without
cancelling the work behind it, so a timed-out capture may still have written, or
may still write, its own record. And an outcome whose record could not be
written, or a failure raised outside the modelled classes, is logged rather than
surfaced. An adapter should treat a present degraded record as authoritative and
its absence as "no picture", not as "no attempt".

**Decidability is preserved in every degraded case.** The decision binds to the
snapshot revision, not to the picture: captures are context. An adapter with no
preview route, no credential, or no anchors still gets a complete content review
of the snapshot, with the missing visual named on the gate. Chrome shown in a
capture is context and explicitly non-decisional.

## 10. Adapter checklist

1. Resolve the capability optionally and lazily; no-op when `isReviewActive()` is
   false.
2. Mint a durable `operationId` before the remote call and reuse it for the
   capture and the read-back.
3. Stage remotely first; capture the resolved content with the scope manifest,
   the connector instance, the resource type/id and the base remote revision
   reference.
4. Ask `resolveDisposition` before applying; apply only on `approved`.
5. Re-read the resource after the apply and call `recordApplyVerification` with
   the post-apply field map only.
6. Emit `data-cinatra-region` markers server-side for exactly the fields named in
   the scope manifest, and serve an authenticated preview at the platform's
   constant path.
7. Expect every gap to be named: supply what you can, and let the degradation
   contract state the rest.

## See also

- [Authoring guide — lifecycle producers](../workflows/authoring-lifecycle-producers.md)
  — the produced event, the declaration block, and the repair round-trip.
- [Lifecycle review policy](../governance/lifecycle-review-policy.md)
  — why a captured snapshot's checkpoint fires, and what holds its effect.
