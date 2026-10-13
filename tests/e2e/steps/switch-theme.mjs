// switchTheme: the theme switched through the app's own control, and read back
// from the review island.
//
// WHY IT EXISTS. A theme switch written by hand for each run pressed the theme
// control and took its picture at once, or after a fixed sleep: the island the
// review card frames repaints only once the card has re-pointed it at the new
// palette and it has loaded again, so the picture showed an island still in the
// old palette. This step presses the app's own theme control when the page shows
// another theme, then reads the page's palette and the island's reported theme
// on a fixed cadence until both report the theme, within a short bound.
//
// THE READINGS. The app's theme provider writes the palette on the document
// root as a class: `cinatra` (light) or `dark`. The island document writes the
// theme it applied on its wrapper, `data-island-color-scheme` on the island's
// body (or on the empty island): `light` or `dark`. The island is every frame of
// the page whose document is on `frameSrcPath`. Other readings: `unmarked` (no
// palette or no attribute), `absent` (no island frame) and `unreadable` (the
// document could not be read at that moment, for example mid-load).
//
// THE CONTROL. The app's theme switch is a button named "Toggle theme"; it has
// no name until the app has mounted it, so the step waits for it. Each press
// toggles the palette: the step presses at most once. With `island: false` the
// page's palette alone is read, for a page that frames no island.
import { quoted } from "./control-kit.mjs";
import { READING_BOUND_MS, elapsedSince, errorClass, isPagePath, pathOf, pause, readBounds, refuse, refuseFrameScope, requireRecord, within } from "./step-kit.mjs";
import { ISLAND_FRAME_SRC_PATH } from "./wait-for-island.mjs";

const STEP = "switchTheme";

/** The app's theme control, by its accessible name. */
export const THEME_CONTROL_NAME = "Toggle theme";
/** The class the app writes on the document root for each theme. */
export const THEME_ROOT_CLASSES = Object.freeze({ light: "cinatra", dark: "dark" });
/** The island's wrapper: its body, or the empty island a refusal draws. */
export const ISLAND_THEME_SELECTOR =
  '[data-conformance-id="review-target-island-body"], [data-conformance-id="review-target-island-empty"]';
/** The attribute the island's wrapper writes the theme it applied to. */
export const ISLAND_THEME_ATTRIBUTE = "data-island-color-scheme";
/** How long the theme control may take to be shown with its name. */
export const THEME_CONTROL_BOUND_MS = 15_000;
/** The press. */
export const THEME_ACTION_BOUND_MS = 30_000;
/** From the press to the page and its island reporting the theme. The island reloads in the new palette at once. */
export const THEME_APPLIED_BOUND_MS = 10_000;
/** How often the page and its island are read. */
export const THEME_POLL_MS = 100;

/** Every bound of the step, by the name `bounds` overrides it with. */
export const THEME_BOUNDS = Object.freeze({
  controlMs: THEME_CONTROL_BOUND_MS,
  actionMs: THEME_ACTION_BOUND_MS,
  appliedMs: THEME_APPLIED_BOUND_MS,
  pollMs: THEME_POLL_MS,
});

// These run IN THE PAGE (the first in the page, the second in the island's
// document): nothing of this module may be used inside them.

function readRootTheme({ light, dark }) {
  const root = document.documentElement;
  if (root.classList.contains(dark)) return "dark";
  return root.classList.contains(light) ? "light" : "unmarked";
}

function readIslandTheme({ selector, attribute }) {
  const wrapper = document.querySelector(selector);
  if (!wrapper) return "absent";
  return wrapper.getAttribute(attribute) || "unmarked";
}

/**
 * The page's theme and each island's, as one reading.
 * @param {import("@playwright/test").Page} page
 * @param {string} frameSrcPath
 * @returns {Promise<{ root: string, islands: string[] }>}
 */
async function readThemes(page, frameSrcPath) {
  const root = (await within(page.evaluate(readRootTheme, THEME_ROOT_CLASSES), READING_BOUND_MS)) ?? "unreadable";
  let frames = [];
  try {
    frames = page.frames().filter((frame) => pathOf(frame.url()) === frameSrcPath);
  } catch {
    return { root, islands: ["unreadable"] };
  }
  const arg = { selector: ISLAND_THEME_SELECTOR, attribute: ISLAND_THEME_ATTRIBUTE };
  const islands = await Promise.all(frames.map(async (frame) => (await within(frame.evaluate(readIslandTheme, arg), READING_BOUND_MS)) ?? "unreadable"));
  return { root, islands };
}

/**
 * What the islands reported, for a refusal.
 * @param {string[]} islands
 * @param {string} to
 * @param {string} inTime
 */
const reportedLast = (islands, to, inTime) =>
  islands.length === 0
    ? `no island reported ${to} ${inTime} (the page frames none: absent)`
    : islands.length === 1
      ? `its island reported ${islands[0]} last, not ${to}, ${inTime}`
      : `its ${islands.length} islands reported ${islands.join(", ")} last, not ${to}, ${inTime}`;

/** The page and its islands, for a line. @param {number} count */
const theIslands = (count) => (count === 1 ? "its island" : `its ${count} islands`);

/**
 * Switch the caller's page to the theme `to` (`light` or `dark`) through the
 * app's own theme control, and resolve `{ to, pressed, islands, elapsedMs }`
 * once the page's palette and every island on `frameSrcPath` report it
 * (`islands` is how many were read). A page that already shows `to` is not
 * pressed. Refuses, as a StepRefusal: `input` (nothing was pressed),
 * `no-control` (the control was not shown with its name within the bound),
 * `driver-failure` (the press failed), `not-applied` (the page's palette did not
 * become `to`) and `island-unreported` (the page shows `to`, but an island did
 * not report it within the bound, naming what it reported last).
 *
 * @param {import("@playwright/test").Page} page
 * @param {{
 *   to: "light" | "dark",
 *   record: import("./step-kit.mjs").StepRecord,
 *   island?: boolean,
 *   frameSrcPath?: string,
 *   bounds?: Partial<Record<keyof typeof THEME_BOUNDS, number>>,
 * }} options
 * @returns {Promise<{ to: string, pressed: boolean, islands: number, elapsedMs: number }>}
 */
export async function switchTheme(page, { to, record, island = true, frameSrcPath = ISLAND_FRAME_SRC_PATH, bounds } = /** @type {any} */ ({})) {
  refuseFrameScope(STEP, record, page, "nothing was pressed");
  requireRecord(STEP, record);
  const nothing = "nothing was pressed";
  if (to !== "light" && to !== "dark") throw refuse(STEP, record, "input", `name the theme to switch to: light or dark — ${nothing}`);
  if (typeof island !== "boolean") throw refuse(STEP, record, "input", `island must be true or false — ${nothing}`);
  if (!isPagePath(frameSrcPath)) {
    throw refuse(STEP, record, "input", `name the island's frame by its path, such as ${ISLAND_FRAME_SRC_PATH} — ${nothing}`);
  }
  const bound = readBounds(STEP, record, THEME_BOUNDS, bounds, nothing);
  const at = pathOf(page.url());
  const applied = (/** @type {{ root: string, islands: string[] }} */ reading) =>
    reading.root === to && (!island || (reading.islands.length > 0 && reading.islands.every((theme) => theme === to)));

  const start = performance.now();
  let reading = await readThemes(page, frameSrcPath);
  const pressed = reading.root !== to;
  if (pressed) {
    // The control, shown with its name: the app names it only once it has mounted it.
    const controls = page.getByRole("button", { name: THEME_CONTROL_NAME, exact: true });
    for (;;) {
      if (((await within(controls.count(), READING_BOUND_MS)) ?? 0) > 0) break;
      const remaining = bound.controlMs - (performance.now() - start);
      if (remaining <= 0) {
        throw refuse(
          STEP,
          record,
          "no-control",
          `no shown control named ${quoted(THEME_CONTROL_NAME)} on ${at} within ${bound.controlMs} ms (the page shows ${reading.root}) — ${nothing}`,
        );
      }
      await pause(Math.min(bound.pollMs, remaining));
    }
    try {
      await controls.first().click({ timeout: bound.actionMs });
    } catch (error) {
      throw refuse(STEP, record, "driver-failure", `the control ${quoted(THEME_CONTROL_NAME)} could not be pressed (${errorClass(error)})`);
    }
  }

  // The readings, until both report the theme or the bound runs out.
  const since = performance.now();
  for (;;) {
    if (applied(reading)) break;
    const remaining = bound.appliedMs - (performance.now() - since);
    if (remaining <= 0) {
      const inTime = `within ${bound.appliedMs} ms`;
      const press = `the press on ${quoted(THEME_CONTROL_NAME)}`;
      if (reading.root !== to) {
        throw refuse(
          STEP,
          record,
          "not-applied",
          pressed
            ? `${press} did not switch the page on ${at} to ${to} ${inTime} (it shows ${reading.root})`
            : `the page on ${at} no longer shows ${to} ${inTime} (it shows ${reading.root}) — ${nothing}`,
        );
      }
      throw refuse(
        STEP,
        record,
        "island-unreported",
        pressed
          ? `${press} switched the page on ${at} to ${to}, but ${reportedLast(reading.islands, to, inTime)}`
          : `the page on ${at} shows ${to}, but ${reportedLast(reading.islands, to, inTime)} — ${nothing}`,
      );
    }
    await pause(Math.min(bound.pollMs, remaining));
    reading = await readThemes(page, frameSrcPath);
  }
  const elapsedMs = elapsedSince(start);
  const islands = island ? reading.islands.length : 0;
  record(
    pressed
      ? `${STEP}: pressed ${quoted(THEME_CONTROL_NAME)} on ${at}; ${island ? `the page and ${theIslands(islands)} report` : "the page reports"} ${to} after ${elapsedMs} ms${island ? "" : "; no island was read"}`
      : `${STEP}: the page on ${at} shows ${to} already — nothing pressed; ${island ? `${theIslands(islands)} ${islands === 1 ? "reports" : "report"} ${to}` : "no island was read"}`,
  );
  return { to, pressed, islands, elapsedMs };
}
