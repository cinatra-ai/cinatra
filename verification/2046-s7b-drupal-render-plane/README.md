# #2046 S7b — Drupal parity (render plane): live verification

Live proofs that the merged S6 capture pipeline drives a **real Drupal** running
the lane's `drupal-module` build (server-emitted region anchors + the
authenticated preview route), on a lane-scoped stack: own Postgres + Redis, own
Drupal + MariaDB (the repo's `docker/drupal` image and entrypoint), app port
3096, review fence **on**, real signup, a real connect-registered Drupal site
with a real provisioned webhook binding under the **Drupal** connector's tuple.

Every step drove production code: the real `bindCmsReviewHostSeamRuntime` seam
factory inside a real `ActorContext` frame (the same AsyncLocalStorage frame
every worker / LLM-orchestration run enters) and a real MCP run frame, the real
`drupal-mcp-connector` trigger leaf (`evaluateStagedNodeWrite`), the real
capture pair / post-apply capture, the real gate store, the real running app for
every render and decision, and `drush` for the site-side apply the connector's
node writer performs.

The Drupal fixture's `article` bundle carries `title`, `body` and a declared
`field_subtitle`, so the walk exercises the **open** Drupal field set — not a
fixed four-field WordPress shape.

| # | What it proves | Evidence |
|---|---|---|
| R1 | A staged Drupal write is HELD and the gate pins **both** roles from ONE signed fetch of the module's preview: `before` (as fetched) and `current` (the proposal composed into the module's own anchored regions). | store output below |
| R2 | The pair renders on the **run-embedded** review surface with the adapter's region outlines and honest captions, and the page load makes **zero** requests to the captured site. | `screenshots/R2-a-review-surface-visual-pair.png`, `screenshots/R2-b-pair-detail-region-outlines.png` |
| R3 | Approve → apply → an `applied` capture is pinned and the post-apply read-back records `verified`, with reviewed-vs-applied shown side by side. | `screenshots/R3-a-verification-verified-surface.png`, `screenshots/R3-b-verification-reviewed-vs-applied.png` |
| R4 | A site-side rewrite outside the reviewed scope → `drifted`, the field diff marks the row OUT OF SCOPE, and the drifted region is outlined **amber on the applied picture**. | `screenshots/R4-a-drifted-surface.png`, `screenshots/R4-b-drift-amber-on-applied.png` |
| R5 | The site unreachable at gate creation → the gate is still created and decidable, and **both** halves state the named reason in place. | `screenshots/R5-degraded-pair-named-reason.png` |

R1/R2 were **re-driven end to end after the convergence round** rewrote the
module's replay consume and its per-element render-cache handling, and the core
addressing policy's origin and id bounds:
`screenshots/R2-c-pair-after-convergence-fixes.png` (2 pictures, 6 adapter-marked
region outlines, unchanged).

## The module half, proven directly against the real Drupal

Signed with an **independent** Standard-Webhooks implementation (an `openssl`
HMAC over `<id>.<ts>.preview.<nid>`), never the host's signer — so the module's
verification is proven wire-compatible rather than self-consistent.

```
GET /cinatra/preview/4   unsigned                                  -> 401 (bare body)
GET /cinatra/preview/4   forged signature                          -> 401
GET /cinatra/preview/4   correctly signed for t-400s (stale)       -> 401
GET /cinatra/preview/4   signature minted for node 1               -> 401
GET /cinatra/preview/4   correctly signed                          -> 200
GET /cinatra/preview/4   the SAME webhook-id replayed              -> 401
GET /node/4              (the draft, anonymously)                  -> 403   <- drafts never public
```

The 200 carries `Cache-Control: no-store, private`, `X-Robots-Tag: noindex,
nofollow`, `Content-Type: text/html`, `data-cinatra-preview-status="unpublished"`,
the draft's actual body, and exactly three server-emitted anchors:

```
data-cinatra-region="title"            (the page title, inside the theme's <h1>)
data-cinatra-region="body"
data-cinatra-region="field_subtitle"
```

`links`, `uid` and `created` are rendered on the same page and are deliberately
**not** anchored — they are chrome, not reviewable content.

Inertness, on the same site: `GET /node/1` (a published node's public page) and
the front page contain **0** occurrences of `data-cinatra-region`.

Replay state does not accumulate. Measured on the same MariaDB after the
convergence rework: `semaphore` held 3 rows left over from the rejected
never-released-lock implementation and stayed at exactly **3** across three
further successful previews, while the durable one-shot records live in
`key_value_expire` (collection `cinatra.preview_seen`), which core's cron
garbage-collects. A replayed `webhook-id` still answers 401.

## Store verification (real Postgres)

`cinatra.objects`, type `@cinatra-ai/objects:cms-preview-capture` — one row per
(pinned target, role); `regions` is the adapter-marked geometry the renderer read
from the site's own markers:

```
 nid |  role   |  status  |        reason         |            substituted              |  unplaced  | regions
-----+---------+----------+-----------------------+-------------------------------------+------------+--------
 5   | before  | captured | -                     | -                                   | -          |    3
 5   | current | captured | -                     | ["title", "field_subtitle", "body"] | ["status"] |    3
 5   | applied | captured | -                     | -                                   | -          |    3
 6   | before  | captured | -                     | -                                   | -          |    3
 6   | current | captured | -                     | ["title", "field_subtitle", "body"] | ["status"] |    3
 6   | applied | captured | -                     | -                                   | -          |    3
 7   | before  | degraded | preview-unreachable   | -                                   | -          |    0
 7   | current | degraded | preview-unreachable   | -                                   | -          |    0
```

`status` is a publish effect the rendered page marks no region for — **stated**
as unplaced on the caption, never guessed into some other part of the theme.
This is the same honest-gap semantics the WordPress adapter produces for its own
unrenderable field.

R2, measured on the real page load:

```
pairKind               : "review"     sides: left:before, right:current
imgs                   : 2  (1280x1271, 1280x1294; both from the host's
                             version-pinned /api/artifacts/.../preview route)
regionHighlights       : 6  (3 per side, every one adapter-marked)
requestsToCapturedSite : []           <-- the no-live-fetch contract, live
caption (proposed)     : "composed · the proposed title, field_subtitle and body
                          placed into the page's own regions · 3 owned regions
                          outlined (title, field_subtitle, body) · static capture ·
                          no live page is loaded · status could not be placed in
                          this page's own regions · 7 active elements removed"
```

R3 — `cinatra.artifact_verification_records`:

```
outcome = verified   scope_manifest = {"paths":["body","title"]}   field_diff = []
captures: before | current | applied
```

R4 — the same table, for the drifted node:

```
outcome    = drifted    scope_manifest = {"paths":["title"]}
field_diff = [{field:"field_subtitle",
               before:"The honest subtitle",
               after: "The honest subtitle [Sponsored: try AcmeSaaS free for 30 days!]"}]
surface    : rail entry "Core analysis · Out-of-scope drift";
             the field row is marked OUT OF SCOPE;
             the applied picture outlines field_subtitle in amber
             (border-amber-500/80) while title and body stay in the neutral
             region colour; applied caption = "1 region changed outside the
             reviewed scope"
```

R5 — both capture rows `status=degraded, degradedReason=preview-unreachable`,
**no** representation row, the gate `pending` with a live decision bar, and both
halves reading *"The page could not be captured when this review was opened
(preview-unreachable). The content above is still the complete, reviewable
change — only the visual context is missing."*

## What the convergence round changed

A read-only Codex round on the preview-auth boundary and the composition
semantics returned NOT-MERGE-SAFE with four findings; all four are fixed in this
work, and a second round found one further defect in the first fix, also fixed.
The final round is MERGE-SAFE.

1. **HIGH — the replay consume was not atomic.** Core's expirable key-value
   `setWithExpireIfNotExists()` is a `has()` followed by a `set()`, so two
   simultaneous replays could both be served. First fix: hold a never-released
   persistent lock as the nonce (atomic). Round two rejected that: core has no
   lock garbage collection, so it would leak one `semaphore` row per preview
   forever. Final: the lock is a short critical section released in a `finally`,
   and the durable one-shot record is the expirable key-value entry core's cron
   collects. Measured above.
2. **HIGH — anchors could enter shared CHILD render caches.** `max-age` bubbles
   UP, so clearing it on the parent build did not protect a field element with
   its own `#cache[keys]` (a contrib formatter, a layout-builder component):
   it could be cached WITH the anchor and later served to an ordinary visitor,
   and symmetrically a cache HIT could silently return anchor-less markup.
   Every element the hook touches now loses its cache keys and gets `max-age 0`.
3. **HIGH — a same-origin multi-client registration resolved by first match.**
   The connect-site uniqueness index is `(org, client, origin)`, so one address
   can carry both a `wordpress` and a `drupal` row; the policy picked the first,
   which could fetch a WordPress route with a WordPress credential for a Drupal
   pointer. It now fails closed with a named `ambiguous-origin-registration`
   denial rather than guessing.
4. **MEDIUM — Drupal node ids were capped at signed 32-bit.** Drupal's `nid` is
   an unsigned integer on its MySQL/MariaDB schema, so a live site can carry a
   nid above 2^31-1 that would never have been capturable. The bound is now per
   adapter; WordPress's existing bound is untouched.

## Two honest notes

**The core-side change this needed.** The S6 addressing policy accepted only
WordPress: `PREVIEW_CAPABLE_CLIENTS` was `{"wordpress"}` and the preview path was
the single WordPress route constant, so a `drupal` connect site resolved
`client-has-no-preview-adapter` and no Drupal gate could ever carry a picture.
The policy now holds a per-client adapter map (each entry contributing ONE
compile-time path prefix), and the credential lookup resolves the site's own
connector webhook binding — a Drupal site's secret lives under the Drupal
connector's tuple, so looking it up under the WordPress one would have degraded
every Drupal gate as `no-preview-credential`. The site-scoped external-id grammar
(`<instanceId>:<nid>`) that #2109 added for WordPress needed **no** change: the
Drupal connector composes its pointer id the same way, and the walk proves it end
to end on a real pointer.

**Not this lane's gap.** The snapshot target renders through the generic
read-only view (*"no-semantic-renderer"*) because the
`@cinatra-ai/cms-snapshot-artifact` pack is not installed in this walk's
organization — that binding is #2107's activation-coupled renderer, unrelated to
the render plane. The visual pair, the region outlines and every decision path
are unaffected, as the screenshots show.
