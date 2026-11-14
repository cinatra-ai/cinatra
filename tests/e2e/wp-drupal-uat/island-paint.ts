/**
 * The review card's island paint, read as ONE predicate inside the frame
 * (cinatra#2713, cinatra#4129).
 *
 * A pending gate that pins several targets draws one island per target, so the
 * card has painted when there is AT LEAST ONE island and EVERY island reads
 * `data-island-load-state="loaded"`. Both halves are one reading, taken in one
 * synchronous call inside the frame. Split into two reads ("an island is
 * attached", then "no island reads anything but loaded"), the check passes on
 * an EMPTY card: the one island can detach between the two reads, and an empty
 * set holds no island that is not loaded.
 *
 * Nothing here imports Playwright: the predicate is serialized into the frame,
 * and the wait polls any reader that answers one such reading, so both run in
 * the node unit tier as well (tests/e2e/__tests__/island-paint.test.ts).
 */

/** The island the review card draws, once per pinned target. */
export const REVIEW_TARGET_ISLAND = '[data-conformance-id="review-target-island"]';

/** What the wait throws at its bound. */
export const ISLAND_PAINT_MESSAGE =
  "the review card's §III islands did not all reach " +
  'data-island-load-state="loaded" in time — a screenshot taken now would ' +
  "recreate the V5 blank-frame defect (cinatra#2713)";

/**
 * True only when `root` holds at least one island and every island it holds
 * reads `loaded`. It closes over nothing and imports nothing, because it is
 * serialized into the frame and evaluated there.
 */
export function allIslandsLoaded(root: ParentNode, selector: string): boolean {
  const nodes = Array.from(root.querySelectorAll(selector));
  return nodes.length > 0 && nodes.every((node) => node.getAttribute("data-island-load-state") === "loaded");
}

/** One reading of `allIslandsLoaded` over `selector`, bounded by `timeoutMs`. */
export type IslandPaintReader = (selector: string, timeoutMs: number) => Promise<boolean>;

/**
 * Poll `read` until one reading answers true, and resolve then. A reading that
 * throws (a frame not attached yet, or mid-navigation) counts as not painted.
 * Past `timeoutMs` it throws `ISLAND_PAINT_MESSAGE` with the last reading. Each
 * reading stands alone: nothing one reading saw is carried into the next.
 */
export async function pollIslandPaint(read: IslandPaintReader, timeoutMs: number, pollMs = 100): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "no reading";
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`${ISLAND_PAINT_MESSAGE} (last reading: ${last})`);
    try {
      if ((await read(REVIEW_TARGET_ISLAND, remaining)) === true) return;
      last = "no island, or one not loaded";
    } catch (error) {
      last = `unreadable: ${error instanceof Error ? error.message.replace(/\n[\s\S]*$/, "") : String(error)}`;
    }
    const left = deadline - Date.now();
    if (left > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, left)));
  }
}
