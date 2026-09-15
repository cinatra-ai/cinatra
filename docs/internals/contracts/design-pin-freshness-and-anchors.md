# The design pin: freshness, anchors, and the record grammar

The drawings this application's screens are graded against live outside this
repository. This repository records which revision of them it grades against as
a **pin**, and until cinatra#3144 nothing checked that the pin was still the
current one. A drawing could be re-ratified, the pin stay where it was, no check
turn red, and a capture taken afterwards be graded against a picture that was
already replaced — and a fix answering that grade could move a screen *back
towards* the retired drawing.

Three gates close that, and one script does the adoption they make safe. None of
them moves a pin on its own, and none of them decides whether one should move.
They refuse silence.

| | what it compares | red when | warn-first |
| --- | --- | --- | --- |
| [`design-pin-freshness`](../../../scripts/ci/design-pin-freshness.mjs) | the pin against the design source's default branch | a governed drawing moved past the pinned revision | yes |
| [`design-anchor-resolution`](../../../scripts/ci/design-anchor-resolution.mjs) | the recorded anchors against the drawings the pin governs | a recorded anchor resolves in no governed drawing | yes |
| [`design-record-grammar`](../../../scripts/ci/design-record-grammar.mjs) | a pull request body against the pin on its branch | a graded section names no pin, or the wrong one | yes |

Everything the three share — the pin grammar, the reader, the trigger rule —
lives in [`scripts/ci/lib/design-pin.mjs`](../../../scripts/ci/lib/design-pin.mjs),
and the paths they trigger on are in
[`scripts/ci/design-pin-gates.paths.json`](../../../scripts/ci/design-pin-gates.paths.json).
Their unit suites ride the root Vitest include, so a failure in one reds a
required check even while the gate jobs themselves are warn-first.

This page does not replace
[the pin-drift check](./design-conformance-pin-drift.md), which compares the
pinned conformance manifests against the **published** ones. That gate answers a
different question — a hash mismatch proves *different*, not *behind* — and
publication lags ratification by design, so an unpublished ratification is
structurally invisible to it.

## The pin, as a grammar

```
design@<forty-character revision id> <drawing path> [<drawing path> ...]
```

One revision, and the **set** of drawing paths that revision governs. The set is
what cinatra#3144 adds. A pin naming one path while the kinds it governs are
drawn across more than one cannot tell an anchor drawn in a sibling drawing
apart from an anchor drawn nowhere, and that ambiguity is exactly what the
anchor check exists to remove. Existing single-path values parse unchanged: a
set of one is a set.

The pin is declared in `scripts/audit/chat-hitl-acceptance-manifest.json` and
mirrored, readable-only, in `scripts/audit/chat-hitl-anchor-contract.json`. The
two must agree; a gate that finds them disagreeing refuses to answer rather than
answering for whichever file it read first.

## The disclosure rule

**A public gate discloses nothing about the design source — not a revision, not
a drawing path, not a section, not a count, and not a date.** A public CI log is
public, and a count is a fact about a private source as much as a revision is.

So the freshness gate's message says only that a pin has un-adopted
ratifications against it, names the two files in *this* repository that carry
the pin, and states the rule for moving one. Its suite pins the bound
negatively — no bare forty-hex, no `commit`, no `upstream`, no `specs/`, no `@`,
and **no digit at all**, because holding every number out is the cheapest way to
hold a count and a date out. The same bound is asserted over everything the
command prints — red, warning, could-not-run **and the clean path**, which is
public output like every other and is pinned as such.

The detail exists, and a reader **with access** gets it by running the same
check locally with a credential and `--detail`. The command refuses that flag
inside a public log.

The anchor check prints kinds, origins, the selectors it was given, and which
governed drawing resolved each — **by its position in the pin's own set**, never
by path, and never a byte of drawing text.

## `design-pin-freshness` — is the pin still the current one?

For each commit-bearing pin, and for every drawing path the pin governs, the
checker asks the design source for the revisions touching that path on the
**default branch**, and for the revisions touching it that are reachable from
the **pinned** revision. A revision in the first list and not the second is one
the pin has not adopted. There is no attempt to classify a revision as a
"ratification": the default branch is the ratified line by definition.

The source is not publicly readable, so an unauthenticated read cannot answer
the question. The job runs with the installation credential this repository's
workflows already mint for cross-repository reads, handed to the checker through
`DESIGN_SOURCE_TOKEN`. **Where no credential is present, or the read fails or
cannot be parsed, the gate exits `2`** — the pin-drift check's own "the gate
could not run honestly" convention — rather than certifying a pin it never
inspected. A read longer than the checker paginates in one run is refused for
the same reason: a truncated list would make an un-adopted revision look
adopted, which is the fail-open direction.

## `design-anchor-resolution` — do the recorded anchors resolve?

The anchor contract's digest binds the pin, the recorded DOM expectations and
the live capture requirements. **It hashes nothing from the drawings**, so a
contract can record an anchor that no drawing under its pin draws, be
re-ratified by hand, and stay green for ever. This check reads the drawings —
from a checked-out copy named by `DESIGN_DRAWINGS_DIR`, or through the same
authenticated reader at the contract's own pinned revision — and says so.

- **Matching is exact, not substring.** A raw text search would let a selector
  quoted in prose or shown in a code sample "resolve". The checker parses each
  drawing's tags, ignoring comments and the contents of `pre`/`code`/`script`/
  `style`, and matches an attribute name and value exactly.
- **An anchor that resolves in a governed drawing other than the first is
  resolved**, and the report says which. One that resolves only in a drawing the
  pin does *not* govern is **unresolved**, with that distinction stated — that is
  the second defect, and it is not the same as an anchor drawn nowhere.
- **A selector form beyond one attribute predicate is refused by name**, and the
  run exits `2`. It is never approximated and never counted in either direction.
  The live recorded set carries such a form today (a class selector among the
  frame-wide capture requirements), and the suite pins that. `--print-unresolved`
  — the road the adoption script reads — **prints nothing and exits `2`** while
  any selector is refused: a set with a verdict missing from it would otherwise
  be recorded, and digest-bound, as though it were the whole finding.
- **An attribute NAME matches case-insensitively; a VALUE does not.** HTML folds
  attribute names, so a drawing written `DATA-LIFECYCLE-CARD=` draws the same
  anchor. A conformance id is case-sensitive and is compared as written.
- **A run that did not read the sibling drawings says so.** Over the
  authenticated road only the drawings the pin *names* are read, so "no governed
  drawing draws it" is all such a run knows — and the report words it as the
  unanswered question it is, rather than as a negative answer it did not reach.
  A checked-out copy carries the siblings, and there the distinction is stated
  outright.
- **Where `anchorsUnresolvedAtPin` is recorded, this check compares it with what
  it finds** and is red on a disagreement, naming both directions. The digest
  proves the array was not edited afterwards; it can never prove it was true
  when it was written, and this is the script that decides that.

It reports what is true today: the recorded owner anchors do not resolve at the
pin the contract names. That is the state the check exists to make visible
rather than digest-passable, and it stays until the anchor content itself moves.

## `design-record-grammar` — does a graded record name its pin?

A capture graded against an unnamed drawing cannot be re-checked by anyone and
cannot be invalidated by a later ratification. So every graded section of a pull
request body must carry a literal `design@<40-hex>` equal to the pin on that
branch. The body is read from the workflow event payload (`pull_request.body`),
so the gate needs no extra credential. A payload it cannot read or parse is
**not** a body it passed: an unreadable payload, a missing payload file and an
unreadable `--body-file` each exit `2`, while an event that genuinely carries no
pull request passes.

**The grammar is defined by the gate, not inferred.** A *graded section* opens at
a Markdown ATX heading (`#` through `######`, with up to three leading spaces —
four make it an indented code block) whose text, trimmed and read
case-insensitively, matches either `^fix leg\b` or
`^(.*\bcapture\b.*\bgraded\b|.*\bgraded\b.*\bcapture\b)`, and runs to the next
heading of the same or a higher level, or to the end of the body. A deeper
heading stays inside it. A bold or emphasised line is not a heading and opens
nothing; a heading inside a fenced block is not one either — a fence closes only
on a run of the same marker character at least as long as the one that opened it
— and a prose sentence that merely mentions a fix leg opens nothing. The opening
heading is part of its own section, so a pin written into the heading counts. The words are read exactly as the
grammar states them, so a plural-only heading ("Captures — graded") opens no
section — the ratified grammar implemented rather than widened, pinned in the
suite in both directions.

A section carrying the right value *and* a wrong one is red: a record that names
two pins names none. The message prints both values that disagree — both are
content this repository already tracks, or that the body itself published.

## `adopt-design-pin` — the adoption the three make safe

[`scripts/audit/adopt-design-pin.mjs`](../../../scripts/audit/adopt-design-pin.mjs)
moves the pin in the manifest and its mirror, records what the re-examination
found, and re-derives the digest — in one transaction, with a rollback:

```
node scripts/audit/adopt-design-pin.mjs --pin "design@<40-hex> specs/<drawing>.html" [--write]
```

- the digest is **read from the canonical script**
  (`chat-hitl-acceptance-gate.mjs --print-anchor-digest`) on the moved tree, never
  computed by the adoption script and never copied from anywhere else. If the
  script prints none, the tree is rolled back;
- `anchorsUnresolvedAtPin` is **read from the resolution check**
  (`design-anchor-resolution.mjs --print-unresolved`) at the new pin, sorted, and
  recorded as data. It is a **fourth digest input the moment it is present**, so
  it cannot be edited, emptied or deleted without re-deriving. A **non-empty
  array is a truthful passing state**, not a failure to fix;
- the edits are textual. Both files are hand-authored documents whose
  formatting, key order and long prose notes are part of the record. A field is
  located **on its own line and only once** — both documents open with a long
  prose note, and a note quoting a field in that shape sits above the record, so
  a first-match replace would edit the prose and leave the record. A document
  carrying the field twice is refused rather than guessed at, and the array
  replacement skips bracket characters inside JSON strings, because every value
  it writes is an attribute selector;
- **every write is inside the rollback guard**, including the second of the two
  opening writes — a failure between them would leave the manifest moved and the
  mirror behind, the exact disagreement this script refuses to adopt on top of.
  A rollback that itself fails is reported in those words rather than reported
  as a clean tree;
- the **re-ratification note is not written by the script**. That prose is a
  claim a person makes about what they re-examined, and the script has
  re-examined nothing. It prints where the note goes.

While `anchorsUnresolvedAtPin` is absent — as it is today — the digest is taken
over the original three inputs and stands exactly where it stood. That is what
lets these checks land before the adoption that writes it.

## Rollout

All three follow the pin-drift check's rollout: **warn-first**, with the
`.github/branch-protections.json` edit that makes a context required landing as
a **separate** pull request, per that file's own note.
