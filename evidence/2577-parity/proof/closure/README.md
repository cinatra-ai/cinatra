# #2683 (S8f) — closure pass: the five reachability entries, photographed and measured

Captured 2026-08-12 on host2, on a stack rebuilt from scratch at this branch head
(`dc577bd7d` + this commit): the **shipped WordPress plugin** (`cinatra` v0.1.7,
mounted from `dev/wordpress-plugin`, active in `wp-admin`), a real cinatra dev
server booted **by the repo's own `wp-drupal-uat` harness**
(`pnpm test:e2e:wp-drupal`, which also runs the harness's `global-setup`: the
`cnx_` connect-site wiring assertion, the dev UAT actor, and the saved Cinatra
session the hosted widget login inherits), and lifecycle rows written by the
shipped stores.

The earlier `proof/complete/` wave photographed the lifecycle views. This wave is
about the **five routes that were unreachable** and about the **one thing that
proof got wrong**: the review-target island's image area was blank, and nobody had
measured why.

## What is real here

- Every widget request below was made by the SHIPPED plugin's embed frame with
  `credentials: "omit"` and the `cwu_` proof header. The status codes are the
  browser's own, recorded off `page.on("response")` — not a claim.
- The `cwu_` in every capture carried the five granted scopes the hosted login
  records: `conversation.read conversation.write lifecycle.decide lifecycle.read
  tools.confirm` (server audit line, `widget-auth-audit` `code_issued`).
- The seeded rows were written through the shipped writers — `createSemanticArtifact`
  (the artifact write choke point, real PNG bytes), `emitArtifactReviewGate`,
  `parkPendingCall` (the one transactional park writer), `upsertChatThreadInDatabase`
  (the single persistence chokepoint). Nothing wrote a table directly.

## The routes are REACHED, cookieless — measured

Before this commit each of these was a 307 to `/sign-in` that `fetch` followed
silently. Recorded in the browser during the captures below:

| Route | Method | Status observed from the embed frame |
|---|---|---|
| `/api/assistants/threads/<threadId>` | GET | **404** — the handler answered (a thread that does not exist), not a redirect |
| `/api/assistants/autosave` | GET | **200** |
| `/api/chat/pending-tool-calls` | GET | **200** |
| `/api/assistants/list` | GET | **200** (the entry that shipped in `997be24ec`) |

A 307 would have shown as a 200 carrying `/sign-in` HTML. None did.

## Views

| View | File | State |
|---|---|---|
| V12 | `V12-pending-tool-confirmation-card.png` | **delivered** — the shipped plugin's panel in `wp-admin` drawing a parked destructive call: "Destructive action needs your confirmation", `wp_delete_post · wordpress-mcp · cinatra-uat`, its expiry, and the park-time REDACTED args preview. Served by `GET /api/chat/pending-tool-calls` → 200 with the widget credential. This card could not exist on the widget before this commit. |
| V11 | `V11-PARTIAL-composer-upload-row.png`, `V11-PARTIAL-after-pick-no-upload.png` | **partial** — the flyout and its Upload-files row are real; the pick produced no upload request (see below) |
| V14 | `V14-REFUSED-after-full-reload.png` | **refused, with the measurement** — see below |
| V13 | — | **cannot be demonstrated on this stack** — see below |
| V2r / V9r | — | not re-shot; see "the island image" below |
| diagnosis | `DIAG-island-image-first-party.png` + `island-image-probe.json` | the island's image, measured |

## The island image — what it is NOT

The completion lane reported the review-target island drawing frame + metadata
with a BLANK image area, and named three suspects: the representation
`preview`/`content` href and its auth (a sixth guard entry), the blob fetch path,
or the fixture. **All three are excluded**, on this stack, with the same renderer
and the same seeded artifact:

`DIAG-island-image-first-party.png` is `/lifecycle/review-island?ref=…` rendered
first-party, and the image **paints**. Measured in the browser:

```
islandImg = { src: "/api/artifacts/<id>/versions/<rev>/preview",
              complete: true, naturalWidth: 320, naturalHeight: 160 }
artifactResponses = [ { ".../preview", status: 200 } ]
```

And every rung of the byte route, probed server-side (`island-image-probe.json`):

```
resolved        = { mime: "image/png", sizeBytes: 799, storageKey: "orgs/…/blobs/sha256/…" }
inlineEligible  = true
blobOpen        = { ok: true, sizeBytes: 799, bytesRead: 799 }
directPreview   = { status: 200, contentType: "image/png", bytes: 799 }
directContent   = { status: 200, contentType: "image/png", bytes: 799 }
representationRow = [{ kind: "blob", mime: "image/png", object_type: "@cinatra-ai/image-artifact:image", deleted_at: null }]
```

So: the fixture carries real bytes, the blob is on disk and readable, the
representation resolves, the MIME is inline-transport eligible, the byte route
answers 200 `image/png`, and the shipped `@cinatra-ai/image-artifact` `detail`
renderer draws it. **No sixth route-guard entry is owed** — the byte route is not
307'd for the reader who renders the island (the island itself requires that
reader's session).

**What is still open, stated honestly.** This does NOT close the widget-frame
case. Reproducing it needs the review card inside the panel, and on this
rebuilt stack the widget's lifecycle pull did not mint one: the turn answered
with its text and no card (`widgetCardVisible = false`), while the same gate is
readable — the harness probe resolved the S8a widget actor and
`enforceReviewRunAccess(runId, actor, "read")` returned `ok: true` for every
seeded gate. The refusal is therefore minted upstream of the row check, inside
the pull's own caller resolution, and one MCP dispatch was recorded for the turn
(`[mcp-run-ctx] … count=1`) — a LIST with no RENDER. That is a separate defect
from the one this commit fixes and it is named here rather than folded in.

## V11 — the attachment: PARTIAL, and the gap is named

`V11-PARTIAL-composer-upload-row.png` is real and is worth having on its own: the
shipped plugin's panel with the composer's plus flyout OPEN, showing the two rows
the widget draws — **Upload files** and **Remote chat**. That flyout is drawn from
data this commit made reachable (`GET /api/assistants/autosave` → 200 and
`GET /api/assistants/list` → 200, both cookieless, both recorded in the same run).
The Skill-autosave row is absent because this reader is not a platform admin and
`userCanConfigure` is off — the handler's own answer, not a missing wire.

`V11-PARTIAL-after-pick-no-upload.png` is the composer immediately after a file
was picked through that row, and it is why V11 is PARTIAL rather than delivered:

```
promptOptionsOpened = true     # the flyout opened
filePicked          = true     # the native chooser opened and accepted /tmp/s8f/banner.png
uploadPosts         = []       # NO POST /api/artifacts/upload was made
```

No attachment chip, no refusal notice, no request. Measured twice, by two
different mechanisms — `setInputFiles` on the composer's hidden picker in one run,
and the real `filechooser` through the shipped "Upload files" row in another — with
the same result. The guard entry this commit adds is what makes that POST
REACHABLE; something between the pick and the POST is not firing on the widget,
and that is a defect this evidence names rather than a screenshot it stages.

## V13 — the undo chip

**Cannot be demonstrated on this stack, and the reason is structural, not a
harness gap.** The chip mounts in exactly one place: under a transcript part with
`kind === "tool_call" && name === "agent_run"`
(`packages/chat/src/chat-messages-view.tsx`). The deterministic UAT provider —
the only model layer a key-free host has — emits `wordpress_content_editor_run`
and the three lifecycle pull primitives, never `agent_run`. So the widget
transcript on this stack has no mount site for the chip. Nothing was staged to
suggest otherwise.

## V14 — the transcript restore, and why it cannot happen

**Refused, and measured.** The shipped plugin mints a FRESH thread id on every
frame bootstrap:

```js
// dev/wordpress-plugin/assets/cinatra-widget.js
correlationId = mintCorrelationId();          // CSPRNG, per bootstrap
session: { threadId: correlationId, … }       // "one thread per bootstrapped frame"
```

Observed across a real full page reload in `V14-REFUSED-after-full-reload.png`:

```
firstThreadId  = "6-q8nNdQ-6AzlRTbiPdH0WUm"   GET /api/assistants/threads/6-q8nNdQ… → 404
secondThreadId = "gi-KCUTuwETPpPvCfgywruGE"   GET /api/assistants/threads/gi-KCUT… → 404
threadIdStableAcrossReload = false
```

Between the two loads the transcript was persisted under the FIRST id through the
shipped chokepoint, and the second load asked for a DIFFERENT id. So the restore
this slice made reachable is correct and reachable — and the shipped plugin can
never exercise it, because it never asks twice for the same thread. The 404s are
themselves the reachability proof: the handler answered.

The panel in the screenshot shows what a reader actually gets after a reload —
the parked-call card (which is `(org, user)`-scoped, not thread-scoped) and an
empty conversation.
