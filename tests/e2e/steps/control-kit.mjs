// What uploadFile, fillForm, switchTheme and decideGate share: how a name read
// from the page is written on a line, and how the one control a step means is
// picked out of every control of the page with the same name.
//
// Plain ESM with JSDoc types and Node's builtins only, like every file in this
// directory.
import { READING_BOUND_MS, within } from "./step-kit.mjs";

/** The most characters of a name read from the page that a line carries. */
export const NAME_LENGTH = 60;
/** The most names one line lists; the rest are counted. */
export const NAMES_LISTED = 8;

/**
 * A name read from the page, for a line: in double quotes, without an address,
 * without a double quote of its own, and at most NAME_LENGTH characters.
 * @param {string} name
 */
export function quoted(name) {
  const plain = String(name)
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b[a-z][a-z\d+.-]*:\/\/\S*/gi, "an address")
    .replace(/"/g, "'");
  return `"${plain.length > NAME_LENGTH ? `${plain.slice(0, NAME_LENGTH - 1).trimEnd()}…` : plain}"`;
}

/**
 * Names read from the page, for a line: each quoted, at most NAMES_LISTED of
 * them, and the rest counted. `none` is what the line says when there are none.
 * @param {string[]} names
 * @param {string} none
 */
export function listed(names, none) {
  if (names.length === 0) return none;
  const shown = names.slice(0, NAMES_LISTED).map((name) => (name ? quoted(name) : "one without a name"));
  const more = names.length - shown.length;
  return more > 0 ? `${shown.join(", ")} and ${more} more` : shown.join(", ");
}

/**
 * The first of `candidates` (a locator of every control with one name, such as
 * `page.getByRole("button", { name, exact: true })`) for which `holds` answers
 * true, or null. `holds` runs IN THE PAGE with the candidate's element and
 * `arg`, so it may use nothing of the caller's module. A candidate that cannot
 * be read within READING_BOUND_MS does not hold.
 * @param {import("@playwright/test").Locator} candidates
 * @param {(element: Element, arg: any) => boolean} holds
 * @param {unknown} arg
 */
export async function pickCandidate(candidates, holds, arg) {
  const count = (await within(candidates.count(), READING_BOUND_MS)) ?? 0;
  for (let index = 0; index < count; index += 1) {
    const candidate = candidates.nth(index);
    if (await within(candidate.evaluate(holds, arg, { timeout: READING_BOUND_MS }), READING_BOUND_MS)) return candidate;
  }
  return null;
}
