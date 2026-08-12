# #2683 / #2577 — the fix-set wave, photographed

Captured 2026-08-12 on host2 against a live stack: the **shipped WordPress plugin
in `wp-admin`** framing the real `/embed/assistant` surface, a dev server on
`lane/2683-s8f-parity` at `1acc61044` with the repo's own `wp-drupal-uat`
environment (`CINATRA_TEST_LLM_PROVIDER=scripted`), the real hosted widget login,
and rows written by the shipped stores.

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
| V2r | `V2r-widget-review-card-island-painting.png` | **DELIVERED** |
| V9r | — | **NOT DELIVERED** (see below) |
| V11 | `V11-PARTIAL-upload-accepted-no-chip-exists.png` | PARTIAL |
| V13 | `V13-PARTIAL-run-card-mounts-no-changeset.png` | PARTIAL |
| V14 | `V14-REFUSED-same-thread-empty-restore.png` | REFUSED, with the measurement |

### V2r — the card, and the island PAINTING

The shipped plugin's panel drawing the review card the closure pass could not
produce: "Review requested · Awaiting your decision", the review-target island
beneath it (`Launch banner — S8f parity proof · Image Artifact`, the artifact
coordinates, the `Image Artifact · build-time · detail` renderer strip) and **the
image itself, painted**. Measured inside the island's own frame:
`{ naturalWidth: 320, naturalHeight: 160, complete: true }` on
`/api/artifacts/…/versions/…`.

That answers the one question the closure pass left open. It named the widget
frame as the unclosed case; on this stack the island paints there too.

The card exists because the dispatch now completes: the server's own record for
this turn is `POST /api/mcp 200` (initialize), `202` (initialized), then **two**
`tools/call 200`s — the LIST and the RENDER. Before the fix there was no
`/api/mcp` line at all.

### V11 — the upload is accepted; there is no chip to photograph, on either surface

Picking a file in the widget's composer fires the change handler and
`POST /api/artifacts/upload` answers **201** with a real artifact ref, cookieless,
with the broker headers. The frame shows the turn that file rode.

It is PARTIAL for one reason, stated rather than worked around: **neither surface
draws a pending-attachment chip.** `/chat` does not (`chat-page.tsx` renders the
refusal notice and nothing else) and the shared column does not, so there is no
affordance to photograph and inventing one would be a design decision this wave
has no drawing for. The epic's item 8 is "attachments on the composer", and the
parity claim is satisfied — measured, not asserted.

### V13 — the mount site now exists; the chip's own gate answers no

The panel drawing an `agent_run` card for a run the person NAMED — the mount site
the undo chip needs, which a key-free stack never had. The chip does not appear,
and that is the honest answer here rather than a missing mount: the chip renders
only when the §VI eligibility gate finds a CLOSED restorable change-set from that
run inside its five-minute window, and this rebuilt stack has none. Seeding one
through the shipped writers is a data job this wave did not do; the mount site,
which was the fix, is in the frame.

### V14 — the same thread is asked for after a real reload, and the read answers 404

The plugin half WORKS and is measured: after a full page reload the widget asks
for the SAME thread id, resolved from its own storage —
`cinatra.widget.thread.v1|http://localhost:3000|6928763b…|wordpress|1 =>
{"id":"fLbGvBnbJmrqYbFFPrliGt6C","at":…}` — where before this wave it minted a new
id per bootstrap and could never ask twice.

The conversation is still empty, and the reason is a SECOND defect this wave found
rather than a failure of the first fix:
`GET /api/assistants/threads/fLbGvBnbJmrqYbFFPrliGt6C` answers **404** although the
row exists (`assistant_threads`, owner = the widget reader, org = the token's org)
and carries a turn. `reconstructThreadPayload` assembles only LEGACY-MIRROR turns
(`id LIKE 'legacy:%' AND run_id IS NULL`) — rows the `/chat` client writes through
`saveChatThreadViaFetch` (cookie-bound, `POST /api/assistants/threads`, no widget
branch). The widget's turns are the runtime's own rows, so there is nothing for
the reconstruct to assemble.

**It is not a widget-auth defect.** The same read was driven with a first-party
cookie session for the same thread id and answered **404** identically. The widget
can read a transcript it is structurally unable to write.

## RENDER-VERIFY

Every PNG here was opened and read before it was committed. Each caption states
what is actually visible in its own frame; no view was composed, cropped to imply
something else, or substituted for a view that could not be taken. The three files
that are not a delivered view carry `PARTIAL` / `REFUSED` in their names.
