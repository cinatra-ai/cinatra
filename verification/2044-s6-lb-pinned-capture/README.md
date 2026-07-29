# #2044 S6 L-B — pinned fetched-render capture: live verification

Live proofs for the pinned CMS preview-capture pipeline, taken against a real
WordPress running the merged `wordpress-plugin#94` build (region anchors + the
authenticated preview endpoint) and a real review gate on a local stack.

| # | What it proves | Screenshot |
|---|---|---|
| B1 | The capture pipeline produces a real page image: the staged DRAFT rendered with the site's own theme chrome, captured server-side from the plugin's authenticated preview and stored as an immutable artifact. Three adapter region anchors (title / content / excerpt) were read from the render. | `screenshots/B1-captured-page.png` |
| B2 | The review surface shows the PINNED capture with the owned regions outlined and the context labelled non-decisional — and performs **no** network request to the captured site while doing it. | `screenshots/B2-review-surface-pinned-capture.png` |
| B3 | Capture failure never blocks the gate: an unreachable site still opens the review, and the surface states the gap with its named reason. | `screenshots/B3-review-surface-degraded.png` |

B1 is the stored capture itself (the bytes served to the reviewer). B2 and B3
are the real run-embedded review route, driven in a browser against a real
pending gate.
