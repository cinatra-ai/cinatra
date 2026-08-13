# #2683 / #2577 — the final wave, photographed

Captured 2026-08-12/13 on host2 against a live stack: the **shipped WordPress
plugin in `wp-admin`** framing the real `/embed/assistant` surface, a dev server
on `lane/2683-s8f-parity` at **`108e10ec2`** (this branch REBASED onto the
post-#2689 `main`, with the widget thread-WRITE half) under the repo's own
`wp-drupal-uat` environment (`CINATRA_TEST_LLM_PROVIDER=scripted`), the real
hosted widget login, and rows written by the shipped stores.

**PLUGIN BUILD UNDER TEST.** `cinatra` **v0.1.7** (the shipped plugin, as
installed in the container) **plus the thread-continuity change from this wave**,
applied to that build's `assets/cinatra-widget.js`. It is applied rather than
checked out because `wordpress-plugin#108`'s own head is **embed protocol 2**
while this cinatra branch's frame is **protocol 1** — the two are a coordinated
pair that meets at merge, and a protocol-2 plugin against a protocol-1 frame
negotiates nothing at all (by design: there is no downgrade path). The applied
diff is the same block the plugin commit ships, minus the two things that file
does not have at protocol 1 (the CMS union and the credential-guard call, which
guards the bridge, not this write).

## Views

| View | File | State |
|---|---|---|
| V2r | `V2r-widget-review-card-island-painting.png` | **DELIVERED** (earlier wave, unchanged) |
| V9r | — | **NOT DELIVERED** (see below) |
| V11 | `V11-upload-201-with-picked-file.png` | **DELIVERED** in its truthful form |
| V13 | `V13-PARTIAL-run-card-mounts-no-changeset.png` | PARTIAL (see below) |
| V14 | `V14-REAL-history-restored-after-reload.png` | **DELIVERED — REAL** |

---

### V14 — REAL. The conversation comes back after a full page reload

**This is the view the whole slice was for, and it is now a delivered one.** The
previous wave photographed it as REFUSED: the plugin asked for the SAME thread id
after the reload and the read answered 404, because the widget could show a
transcript it was structurally unable to WRITE. The write half closes that.

The image is the real WordPress page editor, the shipped plugin's panel, and —
after a **full document reload** — the reader's own message and the assistant's
answer, restored. Under it is the server's own record for that run, in order:

1. `GET /api/assistants/threads/qmzVg97hhLwpqXw8iEvGjVCl` → **404** — the first
   mount, before there was anything to restore. This is the state EVERY widget
   thread was stuck in before this wave.
2. `[widget-auth-audit] widget_conversation_write_authorized` — the new grant,
   consumed at THIS route's audience, with the token's real granted scopes
   (`conversation.read conversation.write lifecycle.decide lifecycle.read
   tools.confirm`).
3. `POST /api/assistants/threads` → **200** — the widget KEPT the turn,
   cookieless, with the broker headers.
4. `GET /api/assistants/threads/qmzVg97hhLwpqXw8iEvGjVCl` → **200** — after the
   reload, the same id, and this time the read answers.

Driver measurement: `restoredCarriesMarker: true`; the plugin's own storage shows
the thread id survived the reload
(`cinatra.widget.thread.v1|http://localhost:3000|6928763b-…|wordpress|1`).

`V14-server-record.txt` is the raw log excerpt the caption is built from.

### V11 — the upload is ACCEPTED, and that is the whole truthful view

Picking a file in the widget's composer fires `POST /api/artifacts/upload`, which
answers **201** with a real artifact ref
(`objectId b8d703a5-…`, `resourceId 9bf0d305-…`, a representation revision) —
cookieless, with the broker headers. The panel shows the turn that file rode.

**There is no pending-attachment chip to photograph, on EITHER surface.** `/chat`
does not draw one and the shared column does not, so parity holds; a chip would
be net-new UI with no ratified drawing behind it, and this wave does not invent
one. The image therefore carries the panel and the network record together,
which is the honest form of this view rather than a smaller claim.

### V13 — PARTIAL, unchanged, and now with the exact reason

The panel drawing an `agent_run` card for a run the person NAMED — the mount site
the undo chip needs. The chip still does not appear: it renders only when the §VI
eligibility gate finds a **CLOSED restorable change-set** from that run inside its
five-minute window, and this stack has none.

**Seeding one was attempted this wave and refused rather than faked.** The chip's
gate is satisfied by a `change_set` row with no member events (`bool_and` over
zero rows is not `false`), so the row alone would have made the chip render — and
that would have been a screenshot of a chip deep-linking to the restore of
nothing. The honest seed goes through the shipped writers
(`openChangeSet` → `historyAwareUpsert` → `closeChangeSet`), and those cannot be
driven from outside the Next process on this host: `canonical-writer` reaches
`server-only`, and past that `src/lib/auth.ts` has a top-level `await` that tsx's
CJS output rejects. The product path that drives them is an `agent_run`, which
needs an LLM key this stack does not have.

### V9r — NOT DELIVERED, same class

`artifact_verification_records` is empty on this stack. The record is written by
`submitRepairResponse`'s own trigger at the end of the repair pipeline
(`createSemanticArtifact` → `emitArtifactReviewGate` → `recordChangesRequested` →
`createSemanticArtifact` → `submitRepairResponse`), and none of those five is an
MCP primitive, so the pipeline is reachable only from inside the app process —
the same blocker as V13. The card's own code path is unchanged by this branch and
was photographed on an earlier wave.

## RENDER-VERIFY

Every PNG here was opened and read before it was committed. Each caption states
what is actually visible in its own frame; no view was composed to imply
something it does not show. The two composed images (V11, V14) put a real panel
screenshot and a real server-log excerpt in one frame, both labelled as what they
are — nothing in either was redrawn. The one file that is not a delivered view
carries `PARTIAL` in its name.

---

# The seed wave — V9r and V13 are REAL, and the blocker is gone

Captured 2026-08-13 on host2, on the SAME stack, at `lane/2683-s8f-parity`
**head `e8aca4acf`** with the in-process seed path. The two views the previous
section listed as NOT DELIVERED and PARTIAL are now delivered, and the reason
they could not be is closed rather than worked around.

| View | File | State |
|---|---|---|
| V9r | `V9r-REAL-verification-card-advisory.png` | **DELIVERED — REAL** |
| V13 | `V13-REAL-undo-chip-on-seeded-changeset.png` | **DELIVERED — REAL** |

`V13-PARTIAL-run-card-mounts-no-changeset.png` is kept: it is the honest record
of the state before this wave (the run card mounted, no chip), and the two read
side by side.

## What changed

The previous section named ONE cause for both gaps: the writers that produce an
`artifact_verification_records` row and a CLOSED, restorable `change_set` with
member events are `server-only` behind a top-level `await` in `src/lib/auth.ts`
that tsx's CJS output rejects, so no out-of-process runner can load them.

This wave adds the smallest thing that puts a caller INSIDE the Next process — a
development-only, capability-gated, loopback POST that names a SUBJECT (an org, a
reader, an existing run) and calls the shipped writers. It holds no SQL. The
fence and its reasoning live in `src/lib/test-support/lifecycle-seed-fence.ts`.

## V9r — a VERIFICATION card in the shipped plugin's panel

The pipeline ran end to end: `createSemanticArtifact` -> `emitArtifactReviewGate`
-> `recordChangesRequested` -> `createSemanticArtifact` -> `submitRepairResponse`,
whose own trigger minted the record. The seed's answer, read back through the
shipped read port:

```
successorGateId            b7613839-f997-4b1d-96dc-0fde7ce2f3f0
successorTaskId            lifecycle-review:repair:9e8e8b2c-24c1-41fa-a7c7-7b96448b7a7a:1
verificationRecordPresent  true
verificationOutcome        drifted
```

An earlier run of the same fixture, on the same stack one commit back, answered
identically apart from its ids (`verify:f790a65f-…`, outcome `drifted`, gate
`pending`, on `run-ff2087fd-…`) — so the pipeline is repeatable, not a one-off.

**The verdict is `drifted`, not `verified`, and that is reported rather than
tuned.** The seed does not choose it: `computeVerificationVerdict` projects the
reviewed and repaired revisions and answers. `drifted` is a real product state —
the reading exists and is advisory, which is exactly what the card draws.

On screen: the real WordPress page editor, the shipped plugin's panel, the
reader's own message, the assistant's reply, and the **Verification /
"Advisory reading."** card. The DOM probe on that frame:
`lifecycleCards: 1`, `states: ["advisory"]`.

The turn NAMED the card ref. It has to: `artifact_review_gates_list` answers with
the oldest five gates a caller may read, this org's backlog has nine, and a
verification reading only exists for a target that has been repaired — so the
head of that list is never the item with a reading. Naming grants nothing; the
ref is opaque and the real primitive decodes it and re-runs the whole access
ladder. This is the same stand-in the run card already makes for a named run.

## V13 — the undo chip, on a change-set that really exists

`openChangeSet` -> `historyAwareUpsert` -> `closeChangeSet`, seeded immediately
before the capture opened — well inside the chip's five-minute window. The seed's answer:

```
changeSetId       cs_15f8b014-9de0-4ca9-80ef-1ae1f414bd5e
objectType        @cinatra-ai/text-artifact:artifact
memberEventCount  1
effectRollup      reversible-internal
restorable        true
closedAt          2026-08-13T00:30:07.250Z
```

**`memberEventCount: 1` is the whole point.** The previous wave refused to
photograph this chip because a `change_set` row with NO member events also
satisfies its gate — `bool_and(restore_eligible)` over zero rows is not `false` —
so the chip would have drawn over the restore of nothing. The set here closes
over a REAL object write, and the event is restore-eligible.

The panel's own network record for the captured turn:

```
GET /api/chat/undo-candidate?runId=run-671960a9-35e0-4fc1-80e2-2333fc23e28c
  -> 200 {"changeSetId":"cs_15f8b014-9de0-4ca9-80ef-1ae1f414bd5e"}
```

byte-identical to the id the seed returned. On screen: the inline run card
RESOLVED ("Agentic Run Progress", `queued`, "Waiting to start...") and the
**"Undo last action"** chip beside it. The chip drew because the §VI eligibility
gate found that closed, restorable set inside its five-minute window and then
authorized THIS reader against its events — not because a row existed.

## The fence, exercised on the live stack

Every refusal below was measured against this running server, which listens on
`0.0.0.0` — so the LAN case is a real request from a real address, not a mock.

```
no capability                                 -> 403 capability-not-presented
wrong capability                              -> 403 capability-not-presented
LAN address + "Host: localhost", no capability -> 403 capability-not-presented
right capability, content-type: text/plain    -> 403 non-json-content-type
right capability, x-forwarded-for: 203.0.113.7 -> 403 forwarded-from-off-host
right capability, correct shape                -> 200
```

The Host-spoof line is the one worth reading twice. `new URL(request.url).hostname`
reflects the HOST HEADER, not the socket peer, so every host-shaped check passes
for a remote caller who simply sets it. The capability is what refuses.

## RENDER-VERIFY

Both PNGs were opened and read before they were committed. Each caption states
what is visible in its own frame. Neither is composed; nothing was redrawn.
