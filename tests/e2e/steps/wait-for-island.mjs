// waitForIsland: the wait for a review card's island, the framed document that
// shows the work under review.
//
// WHY IT EXISTS. The island paints after the card around it: the card draws a
// skeleton while the frame loads, and a picture taken then shows a blank box. A
// wait that simply runs out keeps no picture at all of what the island showed.
// This step reads the island's own load state on a fixed cadence, takes the
// frame the moment the island has loaded OR when its bound runs out, and writes
// one line either way.
//
// THE STATE IT READS. The card marks its island on the element the design's
// conformance anchor names: `data-conformance-id="review-target-island"` carries
// `data-island-load-state`, which reads `loading` while the skeleton shows,
// `loaded` once the frame's own load event has landed, and `timed-out` past the
// card's own bound. `timed-out` is not the end: the frame stays mounted and a late
// load heals the card, so the step keeps reading until `loaded` or its own bound.
// Its own readings are `absent` (no island framing that path on the page),
// `unmarked` (an island without the attribute) and `unreadable` (the page could
// not be read at that moment, for example mid-navigation).
import { isPagePath, pollUntilSettled, refuse, refuseFrameScope, requireMs, requireRecord, takeFrame } from "./step-kit.mjs";

const STEP = "waitForIsland";

/** The path of the island's frame: the document the card frames for the work under review. */
export const ISLAND_FRAME_SRC_PATH = "/lifecycle/review-island";
/** The island's element. */
export const ISLAND_SELECTOR = '[data-conformance-id="review-target-island"]';
/** The attribute the card writes the island's load state to. */
export const ISLAND_STATE_ATTRIBUTE = "data-island-load-state";
/** The one state the wait settles on. */
export const ISLAND_SETTLED_STATE = "loaded";
/**
 * How long the step waits for the island. The card's own bound is twelve
 * seconds; a development boot compiling the island's route on its first request
 * takes far longer, and a late load still heals the card, so the step's bound is
 * the longer one.
 */
export const ISLAND_WAIT_BOUND_MS = 120_000;
/** How often the island's state is read. */
export const ISLAND_POLL_MS = 250;

// Runs IN THE PAGE: nothing of this module may be used inside it.
function readIsland({ selector, attribute, framePath }) {
  const islands = Array.from(document.querySelectorAll(selector)).filter(function framesThePath(island) {
    const frame = island.querySelector("iframe");
    if (!frame) return false;
    try {
      return new URL(frame.getAttribute("src") || "", location.href).pathname === framePath;
    } catch {
      return false;
    }
  });
  if (islands.length === 0) return { state: "absent", islands: 0 };
  return { state: islands[0].getAttribute(attribute) || "unmarked", islands: islands.length };
}

/**
 * Wait for the review island on the caller's page, and take the frame when the
 * island has loaded or when the bound runs out. The island is the first one on
 * the page whose frame shows `frameSrcPath`. Writes exactly one line (settled or
 * ran out, with the elapsed time and the state) and resolves
 * `{ state, settled, elapsedMs, path }`, where `path` is the frame the shutter
 * answered. Refuses, as a StepRefusal, arguments it cannot use and a shutter that
 * takes no frame.
 *
 * @param {import("@playwright/test").Page} page
 * @param {{
 *   record: import("./step-kit.mjs").StepRecord,
 *   shutter: import("./step-kit.mjs").StepShutter,
 *   frameSrcPath?: string,
 *   bound?: number,
 *   pollMs?: number,
 * }} options
 * @returns {Promise<{ state: string, settled: boolean, elapsedMs: number, path: string }>}
 */
export async function waitForIsland(
  page,
  { record, shutter, frameSrcPath = ISLAND_FRAME_SRC_PATH, bound = ISLAND_WAIT_BOUND_MS, pollMs = ISLAND_POLL_MS } = /** @type {any} */ ({}),
) {
  refuseFrameScope(STEP, record, page, "nothing was read");
  requireRecord(STEP, record);
  const nothing = "nothing was read";
  if (typeof shutter !== "function") throw refuse(STEP, record, "input", `hand the step a shutter that takes the frame — ${nothing}`);
  if (!isPagePath(frameSrcPath)) {
    throw refuse(STEP, record, "input", `name the island's frame by its path, such as ${ISLAND_FRAME_SRC_PATH} — ${nothing}`);
  }
  requireMs(STEP, record, "bound", bound, nothing);
  requireMs(STEP, record, "pollMs", pollMs, nothing);

  const { reading, settled, elapsedMs } = await pollUntilSettled(page, {
    read: readIsland,
    arg: { selector: ISLAND_SELECTOR, attribute: ISLAND_STATE_ATTRIBUTE, framePath: frameSrcPath },
    isSettled: (state) => state === ISLAND_SETTLED_STATE,
    bound,
    pollMs,
  });
  const state = reading.state;
  const path = await takeFrame(STEP, record, shutter, { step: STEP, state, settled, elapsedMs });
  const count = /** @type {{ islands?: number }} */ (reading).islands ?? 0;
  const which = count > 1 ? ` (the first of ${count} islands)` : "";
  record(`${STEP}: ${settled ? "settled" : "ran out"} after ${elapsedMs} ms (state ${state})${which}; frame ${path}`);
  return { state, settled, elapsedMs, path };
}
