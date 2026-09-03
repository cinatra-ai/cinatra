// ---------------------------------------------------------------------------
// THE MARK BETWEEN TWO RAIL ENTRIES, DECLARED ONCE (cinatra#3225).
//
// The ratified drawing, agent run and review surface, fixes the mark's own
// geometry in its rail rule:
//
//   ".rail .sep { width: 2px; height: 8px; margin: 4px 0 4px 11px;
//      border-radius: 1px; background: var(--line); }"
//
// — 11px being the centre of the 24px circle the entries carry, so the marks
// and the circles read as one line down the rail; and "so the rail is the run's
// whole lifecycle at a glance, not just its live tip." One rail read at a
// glance is one rhythm.
//
// Two components compose this rail on the run surface — the run-surface rail
// frame and the run page's own panel rail (through the vendored `Stepper`) —
// and they used to compose the mark from two classes: one at the drawing's
// measurements, one that set neither width nor radius and left both to the
// primitive. Measured on a real completed run, the two rails read at two
// rhythms. So the mark is ONE declaration, in a leaf that imports nothing,
// which both rails read: a later change to one cannot reintroduce two.
//
// `!h-2`: the vendored `StepperSeparator` sets its vertical height through a
// variant-scoped token that is emitted after the plain utilities, so the
// drawing's 8px has to win by importance there; on the frame's plain mark the
// importance is inert. `my-1` overrides the primitive's `m-0.5` above and
// below; `ml-[11px]` is the drawing's own indent.
// ---------------------------------------------------------------------------

export const RUN_RAIL_MARK_CLASS = "my-1 ml-[11px] !h-2 w-0.5 shrink-0 rounded-[1px] bg-line";
