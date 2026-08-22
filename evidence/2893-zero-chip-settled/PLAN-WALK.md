# PLAN WALK — cinatra#2893, the zero-chip settled reading

Every capture on this branch, against the text that governs it. Two documents
govern, and they are quoted separately because they answer different questions:

- **The plan** — the engineering wiki page `PLAN: Agents Lifecycle`, section 6
  ("The skills-recommendation card"). It says what a reader is owed when a
  recommendation hold settles.
- **The drawing** — `specs/app-lifecycle-cards.html` §V at
  `design@71398a49c1f8adfe6176ab0dda25486920fac958`, the commit this branch's
  acceptance manifest pins. It says what the settled reading looks like.

Each `PLAN>` line below is copied verbatim from one of those two documents. No
line is paraphrased, and none is stitched together from two places.

---

## CELL: C0__recommendation-card__run_card__held__per-chip-control

The held row this whole walk starts from: three assigned skills, one chip each,
every chip carrying its own three affordances.

PLAN> **The row is the whole card** — there is no separate heading plate and no second gate-level submit.
PLAN> Per skill: **Confirm** takes it as offered; **Adjust** changes it; **Skip** leaves it out.

Shows: three chips — Blog Writing Skill, Blog Idea Authoring Skill, Web Research
Skill — each with Confirm / Adjust / Skip, no heading plate above the row and no
row-level submit beneath it.

Verdict: **PASS**. This is also the "before the drift" picture for the drift run
below, which is held on the same three candidates and renders the same bytes;
one picture is filed rather than the same image under two cell names.

---

## CELL: C1__recommendation-card__run_card__settled__per-chip-control

The control. The same row, settled by pressing Skip on each chip, with the
candidate set still standing at settle time — so the recorded set names skills
and the per-chip settled faces are what draw.

PLAN> The card settles in place and shows what you chose. The run card underneath advances.
PLAN> Once you have decided each one, the run starts with your selection, the card settles in place showing what you chose, and the run card underneath advances.

Shows: three settled chips, each on §V's skipped treatment — the dashed edge,
the muted ground, the skill's display name and the SKIPPED mark — and nothing
left to press.

Verdict: **PASS**, and this cell is the reason the addition can be read as an
addition: the per-chip faces here are the faces §V already drew. The claim that
they did not move is proven by normalized DOM equality in
`packages/agents/src/__tests__/settled-chip-faces.test.tsx`, not by this picture.

---

## CELL: C3__recommendation-card__run_card__settled__zero-chip

**The reading under test.** The same hold, settled after its candidates were
retired underneath it — the run-level skip marker on record with
`candidate_count = 0`, no per-skill row on either side of the evidence.

PLAN> the recommendation is recorded as skipped, nothing is selected, and the run proceeds with its default skill set
DESIGN> treatment of the chips above it: the dashed edge and the muted ground, never a status colour the outcome does not carry.
DESIGN> There is no third face: an identifier, an address or a truncated handle is
DESIGN> pressed into service as a name, and the outcome word alone is a true reading, not a degraded one.

Shows: no chip at all, and no absent card either. One outcome panel on the dashed
edge over the muted ground, with the muted marked square, the outcome word
**Skipped** in semibold beneath it, and the outcome's one sentence under that:
"The recommendation is recorded as skipped, and the run went ahead with its
default skill set." The panel carries `data-conformance-id="recommendation-
settled-outcome-only"` — the drawing's fallback face — because the settled state
this build resolves carries no decider it can name safely.

Verdict: **PASS**. Against `origin/main@972f98495` this same state renders
nothing at all.

---

## CELL: C4__recommendation-card__run_card__settled__zero-chip__dark

The same settled state, in the dark theme.

DESIGN> treatment of the chips above it: the dashed edge and the muted ground, never a status colour the outcome does not carry.

Shows: the identical reading on the dark ground — the dashed edge, the muted
square, the outcome word and its sentence, and no status colour anywhere.

Verdict: **PASS**. The theme is set the way the app itself stores it
(`localStorage.theme`, next-themes over the named `cinatra` / `dark` classes);
the record carries the class the document actually resolved, so the cell name is
not the only thing claiming this is dark.

---

## What is NOT walked here, and why

The plan's §6 also describes the card **in the chat** and **in the widget**. This
branch photographs neither, and does not claim them: the zero-chip settled
reading is a face of the ONE shipped renderer, so it draws on every host that
mounts that renderer, but a capture is evidence only of the host it was taken on.
The run page is the host this issue's renderer change is proven on.
