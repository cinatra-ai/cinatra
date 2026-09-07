import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { StatusPill } from "@/components/ui/status-pill";
import { cn } from "@/lib/utils";
import {
  RUN_MADE_STATE_PILL_LABEL,
  RUN_MADE_STEP_LABEL,
  type RunMadeArtifactRow,
} from "./run-made-reading";

// ---------------------------------------------------------------------------
// THE RUN'S LAST STEP, DRAWN (cinatra#3029, acceptance item 5; fix leg 2).
//
// The ratified drawing's artifact review, section I.2, sentence by sentence:
//
//   "one row per artifact the run wrote, and — where the run consumed an
//    artifact to make them — that artifact too, marked used"
//   "Every row carries the artifact's title, the type that owns it, the
//    revision the run filed or read, and the control that opens it on its own
//    page."
//   "A run that wrote nothing and used nothing draws the empty reading and says
//    exactly that, rather than an empty panel."
//
// WHAT THE FIRST PROOF ROUND MEASURED, and what changed here. The step drew a
// bare link per artifact inside a generic card: no type, no revision, no Open
// control, no row box, no used mark, and no pill on the heading — 5 of the
// drawing's 12 readings, in both palettes. Every one of those is drawn below at
// the drawing's own measurements, which are transcribed beside the class that
// carries them so the next round grades the class against the drawing rather
// than against a recollection of it:
//
//   the row       border:1px solid var(--line); border-radius:8px;
//                 background:var(--surface-strong); padding:9px 12px
//   the used row  border:1px dashed var(--line-strong); background:var(--surface)
//
// TWO OF THOSE MEASUREMENTS WERE TRANSCRIBED BUT NOT DRAWN, and the first proof
// round measured both on the live boot:
//
//   THE RADIUS. `rounded-lg` computes to 10px under this app's radius scale, so
//   every row contradicted the 8px this file's own comment claimed. The class
//   now states the drawing's number literally.
//
//   THE USED MARK IN THE DARK PALETTE. `--line-strong` is declared for the
//   light palette only, and the dark palette must NOT re-declare it — the
//   etched-rule conformance gate binds to it, and the host suite pins it
//   undeclared there. So the dashed mark measured 1.20:1 in the dark palette:
//   the drawing's own mark, invisible. The app already carries a strengthened
//   line for exactly this, `--line-control`, which resolves to
//   `var(--line-strong)` in the light palette and to a findable white in the
//   dark — the drawing's value where the drawing was written, and the same mark
//   where it was not. Pinned in
//   src/app/__tests__/run-made-used-row-dark-affordance.test.ts.
//   the tag       .tag.ext — the blue-tinted type tag
//   the Used mark .tag — the plain one, beside the type
//   the control   .btn.link — the blue underlined "Open" with its arrow
//   the pill      .pill.approved, on the heading LINE, in BOTH specimens
//
// THE PILL IS THE APP'S OWN. The drawing's `.pill.approved` is a green-tinted
// pill with a dot; the design system's `StatusPill` is the component the run
// detail already draws that state with, and it carries a check where the
// drawing carries a dot BY THE DESIGN SYSTEM'S OWN RULE ("Icon on the left —
// never a bare dot"). The WORD is the drawing's: "Finished".
//
// THE DARK PALETTE CARRIES THE SAME AFFORDANCE. The first round found the rows'
// only link reading as near-white body text in the dark palette. The row now has
// ONE control and the drawing says which: a `text-primary`, underlined "Open"
// with its arrow. That pair is the app's OWN link vocabulary — shadcn's
// `button variant="link"` is `text-primary underline-offset-4 hover:underline`,
// and every link in this app draws it — so the underline and the arrow are
// identical in both palettes and the colour is whatever the palette in force
// calls a link. SAID PLAINLY: the app's `--primary` is a blue in the light
// palette and a near-white in the dark one, by the dark palette's own
// declaration; drawing a bespoke blue here would make this one row the only
// link in the app that ignores the palette. What is fixed here is the
// affordance the round actually found missing — a bare title with nothing to
// say it opens anything.
//
// NO "use client": the setup run page's screen is a server component and mounts
// this surface directly. Every row is a plain link to the artifact's own page,
// so the step needs no client state at all.
// ---------------------------------------------------------------------------

/** border:1px solid var(--line); border-radius:8px; background:var(--surface-strong); padding:9px 12px */
const ROW_CLASS =
  "flex flex-wrap items-center gap-2.5 rounded-[8px] border border-line bg-surface-strong px-3 py-[9px]";
/** border:1px dashed var(--line-strong); background:var(--surface) — drawn from
 *  `--line-control`, which IS `var(--line-strong)` in the light palette. */
const USED_ROW_CLASS =
  "flex flex-wrap items-center gap-2.5 rounded-[8px] border border-dashed border-line-control bg-surface px-3 py-[9px]";
/** .tag.ext — background rgba(54,78,129,0.10); color var(--blue); border rgba(54,78,129,0.30) */
const TYPE_TAG_CLASS =
  "inline-flex items-center gap-[5px] rounded-full border border-primary/30 bg-primary/10 px-[9px] py-[2px] text-[11px] font-semibold text-primary";
/** .tag — background var(--surface-muted); color var(--ink); border var(--line) */
const USED_TAG_CLASS =
  "inline-flex items-center gap-[5px] rounded-full border border-line bg-surface-muted px-[9px] py-[2px] text-[11px] font-semibold text-foreground";
/** .btn.link — color var(--blue); underline; text-underline-offset 3px */
const OPEN_CONTROL_CLASS =
  "inline-flex items-center gap-1 px-0.5 py-1 text-xs text-primary underline underline-offset-[3px]";

/**
 * The mono line under a row's title: the type the run recorded, the revision it
 * filed or read, the representation's mime, and — on a row the run READ — that
 * it read it. Composed from what the run actually pinned: a part the run never
 * recorded is left out rather than drawn as "unknown".
 */
export function runMadeRowFacts(row: RunMadeArtifactRow): string {
  const parts: string[] = [row.extension];
  if (row.revision !== null) parts.push(`revision ${row.revision}`);
  if (row.mime) parts.push(row.mime);
  if (row.used) parts.push("read by this run");
  return parts.join(" · ");
}

export function RunMadeStepSurface({
  rows,
  reading,
}: {
  rows: readonly RunMadeArtifactRow[];
  reading: string;
}) {
  const empty = rows.length === 0;
  return (
    <div data-run-made={empty ? "empty" : "listed"}>
      {/* The heading LINE — the step's word and the run's state pill, side by
          side, exactly as the drawing composes them in both specimens. */}
      <div
        data-run-made-heading=""
        className="mb-1 flex flex-wrap items-center gap-2.5"
      >
        <span className="text-sm font-bold text-foreground">{RUN_MADE_STEP_LABEL}</span>
        <StatusPill status="approved" data-run-made-state-pill="">
          {RUN_MADE_STATE_PILL_LABEL}
        </StatusPill>
      </div>
      {/* THE EMPTY READING IS ANNOUNCED (role="status"), as the drawing marks
          it — it is the whole answer for that run, not a caption over rows. */}
      {empty ? (
        <p
          role="status"
          data-run-made-reading=""
          className="m-0 text-[12.5px] leading-[1.55] text-foreground"
        >
          {reading}
        </p>
      ) : (
        <p
          data-run-made-reading=""
          className="mb-[11px] text-xs leading-[1.5] text-muted-foreground"
        >
          {reading}
        </p>
      )}
      {empty ? null : (
        <ul className="grid gap-[7px]" data-run-made-rows="">
          {rows.map((row) => (
            <li
              key={row.artifactId}
              data-run-made-row={row.artifactId}
              data-run-made-rung={row.rung ?? ""}
              data-run-made-used={row.used ? "used" : "written"}
              className={cn(row.used ? USED_ROW_CLASS : ROW_CLASS)}
            >
              <span className="min-w-[180px] flex-1">
                <span className="flex flex-wrap items-center gap-[7px]">
                  <span
                    data-run-made-row-title=""
                    className="text-[13px] font-bold text-foreground"
                  >
                    {row.title}
                  </span>
                  <span data-run-made-row-type="" className={TYPE_TAG_CLASS}>
                    {row.typeLabel}
                  </span>
                  {row.used ? (
                    <span data-run-made-used-tag="" className={USED_TAG_CLASS}>
                      Used
                    </span>
                  ) : null}
                </span>
                <span
                  data-run-made-row-revision=""
                  className="mt-[3px] block font-mono text-[10px] tracking-[0.04em] text-muted-foreground"
                >
                  {runMadeRowFacts(row)}
                </span>
              </span>
              <Link
                href={row.href}
                data-run-made-open=""
                className={OPEN_CONTROL_CLASS}
              >
                Open
                <ArrowRight aria-hidden="true" className="h-3 w-3" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
