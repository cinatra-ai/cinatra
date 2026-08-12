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
