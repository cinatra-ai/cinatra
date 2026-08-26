// ---------------------------------------------------------------------------
// THE RUN SURFACE RAIL'S LABELS — a plain module, deliberately NOT "use client".
//
// The labels are transcribed from the ratified drawing's own rail rather than
// chosen here: the drawing's rows read "Recommendation" and "Review", and plan
// (A) §7.2 step 5 names the schedule's row "the schedule … a dedicated step in
// the step rail". One source, so the setup rail and the schedule step cannot
// drift into two vocabularies for the same row.
//
// WHY THEY LIVE HERE RATHER THAN IN `run-surface-rail.tsx` (cinatra#2970).
// They were declared in that module, which is `"use client"`, and the setup run
// page's screen — `instance-screens.tsx`, a SERVER component — read them from
// there. Under React Server Components that does not work. Turbopack compiles a
// `"use client"` module, for the server graph, into one
// `registerClientReference(stub, id, exportName)` per export, and React only
// hangs `$typeof` / `$id` / `$async` on the stub function it is handed. What
// the server holds is therefore a TAGGED STUB FUNCTION with no `.schedule` on
// it — not a `Proxy` that would object. Rendering that reference as a JSX tag is
// precisely what it is for, and passing one through as a prop round-trips to the
// client; but reading a member of it on the server is an ordinary property
// lookup that misses, and yields `undefined` with no error. So
// `RUN_SURFACE_RAIL_LABELS.schedule` was `undefined` in the server render and
// every rail row shipped its numeral above an EMPTY title, while the drawing
// says the rail NAMES the run's ordered steps.
//
// A module with no directive has no boundary to cross: the server screen reads
// the real object, and so does the client schedule step that draws its own row
// from the same words. Nothing else moved with it — the rail's components stay
// in the client module that draws them, because a component is exactly the thing
// the boundary is designed to carry.
//
// `instance-screens-client-boundary.test.ts` is the guard that keeps it this
// way: it reds if any module in the run page's server graph dots into an import
// from a `"use client"` module again.
// ---------------------------------------------------------------------------

export const RUN_SURFACE_RAIL_LABELS = {
  schedule: "Schedule",
  recommendation: "Recommendation",
  review: "Review",
} as const;
