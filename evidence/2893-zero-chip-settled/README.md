# cinatra#2893 — the zero-chip settled reading, on a real path

A settled recommendation hold whose recorded set names no skill used to leave the
transcript entirely: `RunRecommendationChipRow` returned `null`, honestly, because
§V drew settled faces per chip only and there was no ratified face for a row with
no chips. §V now draws one, and this directory is the evidence that the shipped
renderer draws it — photographed on the running app, from a state produced by the
path that actually reaches it.

## The path these pictures were taken on

**The real one, and it is on main.** `#2794` landed
(`7d1de74d3`, in `origin/main@972f98495`), and with it the run-level skip record:
`run_recommendation_skips`, keyed by `run_id` alone, with `candidate_count`
recording how much was still on the row when the decision was taken. A skip taken
after the candidates have drifted away writes that marker with
`candidate_count = 0` and **no** per-skill row beside it — which is exactly the
state whose card had no reading. **No stand-in was needed and none was used.**

The drift was caused rather than simulated, in this order
(`drivers/drift-skip.mjs`):

1. A run is seeded `pending_input` with a person present and parked through the
   shipped hold seam, on three organization-assigned skills.
2. The run page is opened and the row is on screen, offering all three.
3. **The candidates are retired underneath it** — the agent's skill assignments
   are removed through the assignment table the shipped assignment surface owns.
4. **Skip is pressed on each chip, in the browser.** The row releases through the
   shipped `skipRunRecommendationAction`, which re-derives the candidate set at
   settle time, finds nothing, and writes the marker alone.

The evidence the driver read back straight afterwards, from the lane's own
database:

```
marker: { run_id: 31b85132-…, candidate_count: 0 }   rejected rows: 0   selected rows: 0
```

Nothing here writes a decision row directly, and no server action is invoked
outside the browser: the only write the driver makes is the drift in step 3.

**Runtime:** the dev server (`node scripts/dev-server.mjs`, Next.js 16.2.10,
Turbopack) against a lane-private Postgres and Redis on loopback, placeholder-only
environment, no real model credential on this host. Viewport 1228 wide, device
scale factor 2. The theme is set the way the app stores it (`localStorage.theme`,
next-themes over the named `cinatra` / `dark` classes) — a browser context asked
for `prefers-color-scheme: dark` renders the **light** ground in this app, and the
first attempt at a dark cell produced a picture byte-identical to the light one.
Every record carries the class the document actually resolved.

## The grading table

Graded by opening each PNG and reading it against the drawing at
`design@71398a49c1f8adfe6176ab0dda25486920fac958` §V.

| Capture | Requires | Shows | Verdict |
|---|---|---|---|
| `captures/C0__recommendation-card__run_card__held__per-chip-control.png` | The held row §V draws: one chip per skill, each carrying its own Confirm / Adjust / Skip; no heading plate above the row; no row-level submit beneath it | Three chips — Blog Writing Skill, Blog Idea Authoring Skill, Web Research Skill — each with its own Confirm, Adjust and Skip; nothing above the row and nothing below it | **PASS** — and this is the "before the drift" picture too: the drift run is held on the same three candidates and renders the same bytes, so one image is filed rather than the same picture under two cell names |
| `captures/C1__recommendation-card__run_card__settled__per-chip-control.png` | The PER-CHIP settled reading, unchanged: one settled chip per recorded skill, each on §V's skipped treatment — dashed edge, muted ground, the display name and the mark — and nothing left to press | Three settled chips, each dashed on the muted ground, each reading its skill name then SKIPPED; no button anywhere in the row | **PASS** — the control. The candidate set survived to settle time here, so the recorded set names skills and the chips are what draw. That these faces did not move is proven by normalized DOM equality in `packages/agents/src/__tests__/settled-chip-faces.test.tsx`, against a baseline recorded on `origin/main@972f98495`; this picture is what that equality looks like |
| `captures/C3__recommendation-card__run_card__settled__zero-chip.png` | THE READING UNDER TEST. In place of the row, one outcome panel: the 36px marked square over the semibold outcome word and the 11.5px muted sentence, on the skipped treatment of the chips above it — the dashed edge and the muted ground, and no status colour. The decider named only where a safely displayable name exists; the outcome word alone where none does. No identifier and no address anywhere | No chip, and no absent card. One dashed panel on the muted ground carrying the muted × square, **Skipped** in semibold, and beneath it "The recommendation is recorded as skipped, and the run went ahead with its default skill set." The panel's anchor is `recommendation-settled-outcome-only` — the drawing's fallback face — with no trailing "by", no placeholder and no id | **PASS**. Against `origin/main@972f98495` this same state renders nothing at all |
| `captures/C4__recommendation-card__run_card__settled__zero-chip__dark.png` | The same reading on the dark ground, with the tokens resolving to it and still no status colour | The identical panel, dashed on the dark ground, the muted square, **Skipped** and the same sentence. Document class `dark`, and a different image hash from the light cell | **PASS** |

Hashes, and the two anchors that separate the readings — measured inside the
card's own root, `absent` written down as an observation rather than left silent:

| Cell | sha256 | `[data-recommendation-chip]` | `[data-recommendation-outcome-panel]` |
|---|---|---|---|
| C0 | `3ca674d7b024…` | present, 3 | absent, 0 |
| C1 | `ca9d0b364450…` | present, 3 | absent, 0 |
| C3 | `ac8753253a15…` | **absent, 0** | **present, 1** |
| C4 | `c59bfba6fb27…` | **absent, 0** | **present, 1** |

That is the whole change in two columns: the settled reading that names skills
still draws chips, and the settled reading that names none now draws the panel
instead of nothing.

## The decider, stated plainly

Every picture here shows the **outcome-only** face, and that is the true reading
rather than a gap in the evidence. The run-level skip record does record who
decided — `skipped_by`, written from the deciding session's user id — but an
identifier is not a name, the settled resolver reads no decider at all, and the
drawing rules out pressing an id, an address or a truncated handle into service
as a name. "Skipped" is true; "Skipped by 4f3a…" would be an id read out to
whoever opens the transcript. The named face is exercised in
`packages/agents/src/__tests__/zero-chip-settled-reading.test.tsx`, which supplies
a name directly and asserts the panel takes the other anchor — so the second face
is proven to exist without any surface pretending to have one.

## What is here

```
README.md          this file — the path, the runtime, the grading table
PLAN-WALK.md       every cell against the verbatim governing text
captures/          the four graded pictures
drivers/           what produced them, end to end
  lane-setup.mjs     the lane's own account, organization and template ids
  walk.config.ts     the vitest config the walk runs under
  walk.test.ts       PROBE / ASSIGN / SEED / HOLD — the shipped hold seam
  drift-skip.mjs     the drift, the browser-driven skip, and the records
```

Every record is written by the ONE shared recorder
(`scripts/audit/lib/chat-hitl-capture-recorder.mjs`, `cinatra-lifecycle-capture-
recorder@1`): `drift-skip.mjs` supplies the scenario and a page port over
Playwright, and nothing else. The counting rules, the card-instance pin, the
stability re-measure that fails a capture whose screen moved between the numbers
and the shutter, and the record shape all come from the recorder — so
`recordedBy` names a fact rather than carrying a label.

`C2` is deliberately absent, and its absence is a finding rather than an omission:
the drift run's held row is byte-identical to the control's, and the evidence gate
refuses one image filed under two cell names — correctly, because one picture
cannot prove two screens.
