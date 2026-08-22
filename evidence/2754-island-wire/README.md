# cinatra#2754 — the review island, painted on a genuinely cross-site page

Head under proof: `2c66dd10b` (PR #2870), plus this evidence commit.

## The claim, in one line

On a page served by **another site**, the review card's target island **paints**
— authenticated by the server-minted credential in its own address, with no
cookie anywhere on the wire. Before this branch that frame was authenticated by
nothing on that surface and drew the empty document.

## The runtime, said first

`node scripts/dev-server.mjs` (Next.js dev, Turbopack), `CINATRA_RUNTIME_MODE=development`,
`NODE_ENV != production`, `CINATRA_TEST_LLM_PROVIDER=scripted`, on a dedicated
lane database on the verify Postgres (port 5634) and the verify Redis (port
6579), loopback-only, with the branch's own extension tree (114 packages).
**No model credential exists on this host**, and none is used — the turn that
pulls the card runs on the deterministic provider, whose self-MCP dispatch is
the real one (see below).

It is **not** a production-equivalent build, for the reason
`evidence/2573-s7-conformance/README.md` measured and this round does not
re-derive: `next start` bakes `NODE_ENV=production` into the server bundle,
which the shipped `assertScriptedProviderNotProduction` fence reads, so a
production build and a scripted dispatch are mutually exclusive.

## The origin pair — the one thing that makes this round mean anything

| Surface | Origin |
|---|---|
| the Cinatra app | `http://localhost:3251` |
| the page the widget is embedded in | `http://127.0.0.1:5591` |

Those are different origins **and different sites**. That distinction is the
whole round, so it is spelled out: a host page on `localhost:<another port>`
would be a different ORIGIN but the SAME SITE, the app's `SameSite=Lax` session
cookie would ride the island frame load, the island would paint, and the picture
would look **exactly like C1 while proving nothing**. `localhost` and
`127.0.0.1` are not the same registrable domain, so the cookie cannot travel.

**And it is measured, not asserted.** The hosted PKCE popup is a top-level
window on the app origin, so a real session cookie **exists in the browser** at
the moment every picture here was taken:

```
[{"name":"better-auth.session_token","domain":"localhost","sameSite":"Lax","httpOnly":true}]
```

and the island DOCUMENT request still went out with **no cookie**:

```
{"label":"island-document","method":"GET","path":"/lifecycle/review-island",
 "resourceType":"document","cookie":"absent","widgetUserToken":"absent"}
```

The two lifecycle resolves that produced the card are in the same log, each
carrying `cookie: absent` and `x-cinatra-widget-user-token: present (cwu_)`,
with `x-cinatra-widget-origin: http://127.0.0.1:5591`. Full log:
`logs/wire.json` and `logs/capture.txt`.

## What is real, and what is stood in for

**Real.** The gate: `materializeBlogPostBodyArtifact` → `createSemanticArtifact`
→ the `artifact_produced_outbox` row → `sweepReviewOrchestration()`, which minted
the `artifact_review_gates` row (`gatesCreated: 1`). The widget: the instance row
and its connect-site were written by the two SHIPPED writers the CMS OAuth
exchange itself calls (`writeConnectorConfigToDatabase`,
`upsertConnectSiteAndMintCredential`), and `deriveFrameBinding` was asserted to
close before anything was driven. The session: the frame ran its own hosted PKCE
popup sign-in and holds `cit_`/`cwu_`; nothing was injected into the context.
The card: the turn was typed into the widget's own composer, the deterministic
provider named the primitive, and the **real** self-MCP dispatch called it — so
the envelope was minted by the producer, which is the only thing that can mint
one. The island address, the credential, and the island's answer are all shipped
code end to end.

**Stood in for — one thing, named exactly.** The **model layer**: which
primitive to call for "Is there a review gate waiting for my approval?" is
decided by `packages/llm/src/scripted-test-provider.ts` instead of by a live
model. Everything after that decision — the OBO token, the transport, the
closed kind-keyed widget tool policy, `enforceReviewRunAccess`, the S1
authorization ladder, `buildLifecycleViewEnvelope` — is the shipped path. The
provider **cannot** put a card on screen: a string it composes carries no
dispatch provenance and `recognizeLifecycleViewEnvelope` refuses it.

## The island's tier, said plainly

The island resolves §III's ladder to its **floor**, and the screen says so
(`Floor · structured data`, `review target unavailable — slot "detail", reason
"no-semantic-renderer"`). That is the shipped answer, not a shortfall of this
round: `@cinatra-ai/blog-post-artifact` declares **no renderer** in its package
manifest, so there is no higher tier to resolve. What the round needs from the
picture is met either way — the floor is **drawn from the real target** (its
title `Connector rollout note`, its type, its mime, its pinned revision, its
Preview/Download hrefs) and is unmistakably different from the empty island C3
photographs.

## Cells DELIVERED

Framed on the card root (`[data-conformance-id="review-gate-card"]`) **inside the
embed frame**, viewport width 1228 at `deviceScaleFactor: 2`.

| Cell | Pixels | What is VISIBLY on screen |
|---|---|---|
| `C1__review-card__site_widget__pending` | 1056×1208 | The review card in the embedded conversation column on the third-party page, **with the island painted**: the target header `Connector rollout note` + the `Blog Post Artifact` chip, the pinned line `@cinatra-ai/blog-post-artifact:post · revision ec6d0269-a39… · pinned · organization · text/markdown`, the provenance chip `Floor · structured data`, and the metadata floor (`type` / `mime` / `revision` + `Preview` `Download`). Below the frame: `Expand`, then the card's own decision floor — `DECISION RATIONALE`, `Comment` `Reject` `Approve`. |
| `C2__review-card__site_widget__pending` | 1056×1968 | The SAME card with the island's `Expand` pressed: the identical painted target at the top of a taller frame, `Collapse` in the frame footer, the decision floor unchanged. Its evidentiary payload is the record's `islandAddress` — see the section below. |
| `C3__review-card__site_widget__pending` | 1056×1208 | **The negative control**, framed at the SAME clamped height as C1: the island region is **blank** — the single empty-island element every denial draws — and everything else is identical to C1: `Review requested`, `Awaiting your decision`, `Expand`, `DECISION RATIONALE`, `Comment` `Reject` `Approve`. The card is **unmoved**: no error, no crash, no sign-in form inside third-party chrome. |

Measured beside the pixels, in every record's `islandObserved`:
C1 and C2 → `body=1, empty=0, targets=1`; C3 → `body=0, empty=1`.

## C2's payload — the address, described and never disclosed

The island frame's `src` attribute, read off the DOM inside the embed frame:

| | |
|---|---|
| attribute | `iframe[src]` on the element inside `[data-conformance-id="review-target-island"]` |
| path | `/lifecycle/review-island` |
| form | root-relative — this origin, never an absolute URL |
| parameters | `ref`, **`ic`**, `assistant`, `instanceId` |
| `ref` | 214 chars, url-safe, `sha256[0:8] = e813f738` |
| `ic` | **559 chars, url-safe**, `sha256[0:8] = 630e60b9` |
| total | 856 chars, inside `LIFECYCLE_ISLAND_SRC_MAX_LENGTH` (2048) |

`ic` is the credential this branch adds, and it is present on the address exactly
as the slice describes. **The values are not written down anywhere in this
directory** — both are sealed bearer strings; a length, a shape and a truncated
digest are what a reader needs to see the address carries them, and are not
themselves usable. The `ref` digest differs between two mints of the same gate
because `encodeLifecycleGateRef` is authenticated encryption over a fresh nonce;
that is the codec working, not a second gate.

## C3 — why a flipped character is a control and not a re-run

One character of `ic` was flipped in the DOM (`icLength: 559`,
`flippedLength: 559`, `changedChars: 1`) and the frame re-addressed. The path,
the `ref`, the frame disambiguators, the reader, the gate and the surface are all
byte-identical; the credential is the only difference. The island answered with
its refusal within ~2s and the card did not move. That is
`resolveIslandCredentialReader` returning `null` and the page rendering
`EMPTY_ISLAND` — the same object every other denial renders, which is what keeps
"you may not read this" indistinguishable from "there is nothing here".

## Cells NOT delivered

| Cell | Why |
|---|---|
| the island painting through a **higher** ladder tier (a build-time or runtime renderer) | **Not available on this stack.** The seeded target's type is `@cinatra-ai/blog-post-artifact:post` and that extension declares no renderer, so the ladder's floor is the shipped answer. Producing a higher tier would have meant seeding a different artifact type purely to make a nicer picture, which would prove less about #2754, not more. Recorded here rather than implied by C1. |
| an **expired** credential (as opposed to a tampered one) | **Not attempted.** It needs the mint's TTL to elapse against a card that does not re-resolve, and the card's own retry re-resolves first (that is the branch's `onRetryResolve`), so the honest way to photograph it is to freeze a clock — which this lane cannot do against a live server. The refusal path it would exercise is the same `resolveIslandCredentialReader` → `EMPTY_ISLAND` path C3 photographs. |
| a same-site widget deployment receiving **no** credential | **Not photographed.** The branch's `mintIslandSrcForWidget` gates on the widget arm and the assertion is a code-path claim about the cookie hosts, which the branch's own route tests cover (`route.island-credential.test.ts`, `route.widget-branch.test.ts`). No picture is claimed for it. |

## Records and index

`capture-records.json` carries the three cells in the shape
`scripts/ci/lib/capture-record-contract.mjs` validates; each was run through that
validator before it was written and each came back
`record/ok`. The same three are registered in
`scripts/ci/chat-hitl-capture-index.json`, which was **empty on this branch** and
whose own comment says it is waiting for exactly this: records from one run of a
recorder against a live app.

**A concurrent branch also populates that index** — cinatra#2852 (PR #2863) adds
two `chat_thread` records. The two sets are disjoint and both are real; whoever
merges second must **keep both**, not take a side.

The cell names `C1`/`C2`/`C3` are this round's labels. They do not collide with
the `C1__review-card__chat_thread__*` cells the acceptance manifest cites: cells
bind by full name and the host token differs.

## Layout

- `captures/` — the three PNGs, full resolution, uncropped.
- `capture-records.json` / `capture-results.json` — the records and the machine record.
- `logs/` — `capture.log` (the run, verbatim), `wire.json` (every lifecycle and
  island request, present/absent only), `walk-state.json` (the seeded ids, with
  the sealed gate ref replaced by its length).
- `drivers/` — the harness exactly as run: `01-signup.mjs`, `02-seed-widget-site.mts`,
  `walk.test.ts` + `walk.config.ts` (produce → gate → ref), `host-page.html`
  (the third-party page), `03-capture-island.mjs` (the recorder, whose counting
  rules are written at the top of the file).

No credential, token, password or host identity appears in any file here. The
sealed gate ref and the island credential are addressing/bearer handles and are
not committed.

Assisted-by: Claude Code (claude-opus-5)
