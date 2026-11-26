/**
 * THE ARTIFACT PAGE'S MONO META LINE, DRAWN FROM THE HEADER MODEL (cinatra#3092).
 *
 * The cells are joined by " · " exactly as before. The one cell the drawing
 * highlights is the pinned marker of a review target (artifact-review §XI.5,
 * §XI.7, §XI.8: `revision rev_c410… <span style="color:var(--mustard-ink)">·
 * pinned</span> · WordPress …`), drawn as the review card's identity line draws
 * it: its separator and its word together, in the mustard ink, on an otherwise
 * muted line. A model with no pinned cell draws the plain line.
 */
import { Fragment, type ReactElement } from "react";

export function ArtifactMetaLine({
  cells,
  pinnedCellIndex,
}: {
  cells: readonly string[];
  pinnedCellIndex: number | null;
}): ReactElement {
  return (
    <>
      {cells.map((cell, index) =>
        index === pinnedCellIndex ? (
          <span key={index} className="text-mustard-ink" data-artifact-meta-pinned="">
            {index > 0 ? ` · ${cell}` : cell}
          </span>
        ) : (
          <Fragment key={index}>{index > 0 ? ` · ${cell}` : cell}</Fragment>
        ),
      )}
    </>
  );
}
