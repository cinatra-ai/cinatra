// signInThroughWindow: the one sign-in through the WINDOW a control opens, as
// an embedded product signs a person in: a press in the frame opens a window of
// the product, which either returns by itself or shows the product's sign-in
// form, and closes itself once the person is signed in.
//
// WHY IT EXISTS. signInThroughPage loads the sign-in page it signs in on, and
// waits for the app shell after it. An embedded product's frame takes no cookie
// of the product and signs in through a window of its own instead, which closes
// itself when it is done: there is no page to load and no shell to wait for.
//
// WHAT IT DOES, in order:
//   1. refuses, before anything is pressed, a call without the run's once-only
//      budget or with that budget spent, without credentials, or with a name, a
//      role or a bound it cannot use;
//   2. presses the one control of `role` named `name`, found as `press` finds
//      it, and waits for the window that press opens (the page's `popup`);
//   3. reads the window, by polling and never by assuming, until exactly one of
//      two roads shows: THE WINDOW RETURNS BY ITSELF (a person with a live
//      session in this browser context is returned at once, and the window
//      closes itself), and the budget is not touched; or THE WINDOW SHOWS THE
//      PRODUCT'S SIGN-IN FORM, carrying its hydration mark;
//   4. on the form, keeps every rule of signInThroughPage that applies to a form
//      it did not load itself: the two guards armed before the press, the email
//      and the password TYPED KEY BY KEY into the two fields (the window's
//      fields are controlled inputs, which a fill does not reach as a person's
//      typing does), the email read back by its value and the password by its
//      LENGTH only, one press, the app's own sign-in request read with its
//      answer (a press that sent none never spends the budget; a request that
//      left the window spends it, whatever the answer);
//   5. waits for the window to close itself, its return.
// No line carries the email, the password, a token, a cookie or an address: the
// window is named by its path.
import { randomUUID } from "node:crypto";

import { CONTROL_HYDRATION_BOUND_MS, CONTROL_MARK, CONTROL_NAMES_LISTED, describeMatches, describeNames, markedBy, newMark, plainName, quotedName, readPageControls, unmarkControls, unspacedNote, waitForPageHydration } from "./page-controls.mjs";
import { PRESS_ROLES, ROLE_WORDS } from "./press.mjs";
import {
  SIGN_IN_ACTION_BOUND_MS,
  SIGN_IN_ALLOWANCE,
  SIGN_IN_ANSWER_BOUND_MS,
  SIGN_IN_HYDRATION_MARK,
  SIGN_IN_HYDRATION_POLL_MS,
  SIGN_IN_REQUEST_BOUND_MS,
  SIGN_IN_REQUEST_PATHS,
  SIGN_IN_SELECTORS,
  armNativeSubmitGuard,
  describeReading,
  disarmNativeSubmitGuard,
  readNativeSubmitGuard,
  readSignInForm,
} from "./sign-in-through-page.mjs";
import { READING_BOUND_MS, elapsedSince, errorClass, pathOf, pause, readBounds, refuse, refuseStaleScope, requireRecord, within } from "./step-kit.mjs";

const STEP = "signInThroughWindow";

/** From the press to the window it opens. A browser opens it at once. */
export const WINDOW_OPEN_BOUND_MS = 30_000;
/**
 * From the window's opening to its return or its form, and from the app's
 * answer to the window closing itself. A development server compiles the
 * window's page on its first request.
 */
export const WINDOW_RETURN_BOUND_MS = 120_000;

/** Every bound of the step, by the name `bounds` overrides it with. */
export const SIGN_IN_WINDOW_BOUNDS = Object.freeze({
  actionMs: SIGN_IN_ACTION_BOUND_MS,
  openMs: WINDOW_OPEN_BOUND_MS,
  returnMs: WINDOW_RETURN_BOUND_MS,
  pollMs: SIGN_IN_HYDRATION_POLL_MS,
  requestMs: SIGN_IN_REQUEST_BOUND_MS,
  answerMs: SIGN_IN_ANSWER_BOUND_MS,
});

// Runs IN THE PAGE: nothing of this module may be used inside it. What the two
// fields hold once typed into: the email's value, and the password's LENGTH
// only, so its value never leaves the window.
function readTyped({ email, password }) {
  const id = document.querySelector(email);
  const secret = document.querySelector(password);
  return { email: id ? id.value : null, passwordLength: secret ? secret.value.length : null };
}

/**
 * Sign the run in once, through the window the control of `role` named `name`
 * opens on the caller's page or frame scope. `credentials` go into the window's
 * two fields and nowhere else; `budget` is the run's once-only count
 * (createSignInBudget), the same object for every sign-in of the run. Resolves
 * `{ window: "returned", spent: false, path, elapsedMs }` when the window
 * returned by itself (the budget untouched), and
 * `{ window: "signed-in", spent: true, path, windowPath, elapsedMs }` once the
 * form signed in and the window closed itself; `path` is the path the control
 * stood on, `windowPath` the path of the window's form, and `elapsedMs` the
 * time from the press. Otherwise throws a StepRefusal whose kind is
 * `input` or `spent` (nothing was pressed), `unreadable`, `no-control`,
 * `ambiguous` or `disabled` (nothing was pressed), `no-window` (pressed, and no
 * window opened within the bound), `blocker` (the window's form never became
 * pressable), `driver-failure`, `rejected` and `no-answer` (as
 * signInThroughPage's), or `not-returned` (the window neither closed nor
 * showed the form within the bound, or stayed open after the answer).
 *
 * @param {import("@playwright/test").Page} page
 * @param {{
 *   name: string,
 *   role?: "button" | "link" | "menuitem" | "tab" | "checkbox" | "radio" | "switch",
 *   credentials: { email: string, password: string },
 *   budget: import("./sign-in-through-page.mjs").SignInBudget,
 *   record: import("./step-kit.mjs").StepRecord,
 *   bounds?: Partial<Record<keyof typeof SIGN_IN_WINDOW_BOUNDS, number>>,
 * }} options
 * @returns {Promise<{ window: "returned" | "signed-in", spent: boolean, path: string, windowPath?: string, elapsedMs: number }>}
 */
export async function signInThroughWindow(page, { name, role = "button", credentials, budget, record, bounds } = /** @type {any} */ ({})) {
  requireRecord(STEP, record);
  const nothing = "nothing was pressed";
  if (!budget || typeof budget.spent !== "number") {
    throw refuse(STEP, record, "input", `hand the step the run's once-only budget (createSignInBudget) — ${nothing}`);
  }
  if (budget.spent >= SIGN_IN_ALLOWANCE) {
    throw refuse(STEP, record, "spent", "this run's one sign-in already reached the app — no second press");
  }
  const { email, password } = credentials ?? {};
  if (typeof email !== "string" || email === "" || typeof password !== "string" || password === "") {
    throw refuse(STEP, record, "input", `hand the step credentials with a non-empty email and password — ${nothing}`);
  }
  const wanted = plainName(name);
  if (typeof name !== "string" || wanted === "") throw refuse(STEP, record, "input", `name the control that opens the window by its accessible name, such as Sign in — ${nothing}`);
  if (!PRESS_ROLES.includes(role)) {
    throw refuse(STEP, record, "input", `role must be ${PRESS_ROLES.slice(0, -1).join(", ")} or ${PRESS_ROLES.at(-1)} — ${nothing}`);
  }
  const bound = readBounds(STEP, record, SIGN_IN_WINDOW_BOUNDS, bounds, nothing);
  refuseStaleScope(STEP, record, page, nothing);
  const notSpent = "the once-only sign-in is not spent";
  const [word, words] = ROLE_WORDS[role];
  const named = quotedName(wanted);

  // THE CONTROL, found as press finds it.
  const from = pathOf(page.url());
  if (!(await waitForPageHydration(page))) {
    throw refuse(STEP, record, "unreadable", `the page on ${from} did not hydrate within ${CONTROL_HYDRATION_BOUND_MS} ms — ${nothing}`);
  }
  const mark = newMark();
  const reading = await within(
    readPageControls(page, { mode: "press", role, name: wanted, within: "", attribute: CONTROL_MARK, mark, listed: CONTROL_NAMES_LISTED }),
    READING_BOUND_MS,
  );
  if (!reading) throw refuse(STEP, record, "unreadable", `the controls on ${from} could not be read — ${nothing}`);
  const at = ` on ${from}`;
  /** @type {import("@playwright/test").Page | null} */
  let popup = null;
  let pressedAt = performance.now();
  try {
    const { matches } = reading;
    if (matches.length === 0) {
      throw refuse(STEP, record, "no-control", `no shown ${word}${at} is named ${named} — the ${words} it shows: ${describeNames(reading.present)}; ${nothing}`);
    }
    if (matches.length > 1) {
      throw refuse(
        STEP,
        record,
        "ambiguous",
        `${matches.length} shown ${words}${at} are named ${named}${unspacedNote(reading.unspaced, reading.named)}: ${describeMatches(matches)} — ${nothing}, since a press never guesses`,
      );
    }
    if (matches[0].disabled) throw refuse(STEP, record, "disabled", `the ${word} ${named}${at} is disabled — ${nothing}`);

    // THE PRESS, and the window it opens: listened for from before the press.
    const opened = page.waitForEvent("popup", { timeout: bound.openMs });
    opened.catch(() => {});
    try {
      // `noWaitAfter`: the press returns once made; the window it opens is read below.
      await page.locator(markedBy(mark)).click({ timeout: bound.actionMs, noWaitAfter: true });
    } catch (error) {
      throw refuse(STEP, record, "driver-failure", `the ${word} ${named}${at} could not be pressed (${errorClass(error)}) — ${notSpent}`);
    }
    pressedAt = performance.now();
    popup = await within(opened, bound.openMs);
  } finally {
    await within(page.evaluate(unmarkControls, { attribute: CONTROL_MARK, mark }), READING_BOUND_MS);
  }
  if (!popup) {
    throw refuse(STEP, record, "no-window", `the press on the ${word} ${named}${at} opened no window within ${bound.openMs} ms — ${notSpent}`);
  }
  const opener = `the window the ${word} ${named}${at} opened`;

  // THE TWO ROADS, read by polling: the window closes itself, or it shows the sign-in form with its hydration mark.
  const arg = { password: SIGN_IN_SELECTORS.password, submit: SIGN_IN_SELECTORS.submit, mark: SIGN_IN_HYDRATION_MARK };
  /** @type {any} */
  let last = null;
  let lastPath = pathOf(popup.url());
  for (;;) {
    if (popup.isClosed()) {
      const elapsedMs = elapsedSince(pressedAt);
      record(`${STEP}: ${opener} returned by itself after ${elapsedMs} ms — a session of this browser context signed it in; ${notSpent}`);
      return { window: "returned", spent: false, path: from, elapsedMs };
    }
    lastPath = pathOf(popup.url());
    const read = await within(popup.evaluate(readSignInForm, arg), READING_BOUND_MS);
    if (read) last = read;
    if (read && read.form && read.mark) break;
    const remaining = bound.returnMs - (performance.now() - pressedAt);
    if (remaining <= 0) {
      if (last && last.form) {
        throw refuse(
          STEP,
          record,
          "blocker",
          `${opener} shows a sign-in form on ${lastPath} that did not hydrate within ${bound.returnMs} ms (reading: ${describeReading(last)}) — ${notSpent}`,
        );
      }
      throw refuse(STEP, record, "not-returned", `${opener} on ${lastPath} neither returned by itself nor showed the product's sign-in form within ${bound.returnMs} ms — ${notSpent}`);
    }
    await pause(Math.min(bound.pollMs, remaining));
  }
  const windowPath = pathOf(popup.url());
  record(`${STEP}: ${opener} shows the product's sign-in form on ${windowPath}, and it carries its hydration mark`);
  const blocker = (/** @type {string} */ why) => refuse(STEP, record, "blocker", `${why} — ${notSpent}`);

  // THE TWO GUARDS, armed before anything is pressed in the window. The network
  // guard aborts a navigation to the window's own address that is not the page
  // itself: the form submitting natively. The page guard cancels a native
  // submission nobody else cancelled.
  const at2 = new URL(popup.url());
  let aborted = 0;
  const isWindowPage = (/** @type {URL} */ u) => u.origin === at2.origin && u.pathname === at2.pathname;
  const networkGuard = async (/** @type {any} */ route, /** @type {any} */ request) => {
    if (request.isNavigationRequest() && (request.method() !== "GET" || new URL(request.url()).search !== at2.search)) {
      aborted += 1;
      await route.abort("blockedbyclient");
      return;
    }
    await route.fallback();
  };
  const guardKey = `__signInGuard${randomUUID().replace(/-/g, "")}`;
  const signedWindow = popup;
  await signedWindow.route(isWindowPage, networkGuard);
  try {
    try {
      await signedWindow.evaluate(armNativeSubmitGuard, guardKey);
    } catch (error) {
      throw blocker(`the page guard of the window on ${windowPath} could not be armed (${errorClass(error)})`);
    }

    // TYPED KEY BY KEY, never filled: each field pressed into, then typed through the keyboard.
    for (const [field, selector, value] of [
      ["email", SIGN_IN_SELECTORS.email, email],
      ["password", SIGN_IN_SELECTORS.password, password],
    ]) {
      try {
        await signedWindow.locator(selector).click({ timeout: bound.actionMs });
        await signedWindow.keyboard.type(value);
      } catch (error) {
        // The driver's own message can repeat what it was given to type: only the error's class is kept.
        throw refuse(STEP, record, "driver-failure", `the ${field} field of the window on ${windowPath} could not be typed into (${errorClass(error)}) — nothing was pressed; ${notSpent}`);
      }
    }
    // Read back: the email by its value, the password by its length only.
    const typed = await within(signedWindow.evaluate(readTyped, { email: SIGN_IN_SELECTORS.email, password: SIGN_IN_SELECTORS.password }), READING_BOUND_MS);
    if (!typed || typed.email !== email || typed.passwordLength !== password.length) {
      throw refuse(
        STEP,
        record,
        "driver-failure",
        `the fields of the window on ${windowPath} do not read back what was typed into them (the email read by its value, the password by its length) — nothing was pressed; ${notSpent}`,
      );
    }
    record(`${STEP}: typed the email and the password key by key into the window on ${windowPath}; the email reads back as typed, and the password reads back at its length`);

    // THE PRESS, and the app's own request: listened for from before the press.
    const isSignInRequest = (/** @type {any} */ request) => {
      const u = new URL(request.url());
      return request.method() === "POST" && u.origin === at2.origin && SIGN_IN_REQUEST_PATHS.includes(u.pathname);
    };
    /** @type {(request: unknown) => void} */
    let noteRequest = () => {};
    const requestSent = new Promise((done) => {
      noteRequest = done;
    });
    const onRequest = (/** @type {any} */ request) => {
      if (isSignInRequest(request)) noteRequest(request);
    };
    let pressError = null;
    /** @type {any} */
    let request = null;
    signedWindow.on("request", onRequest);
    try {
      try {
        await signedWindow.locator(SIGN_IN_SELECTORS.submit).click({ timeout: bound.actionMs, noWaitAfter: true });
      } catch (error) {
        pressError = error;
      }
      request = await within(requestSent, bound.requestMs);
    } finally {
      signedWindow.off("request", onRequest);
    }
    if (!request) {
      const cancelled = signedWindow.isClosed() ? null : await within(signedWindow.evaluate(readNativeSubmitGuard, guardKey), bound.actionMs);
      const why = pressError
        ? `the sign-in button of the window on ${windowPath} could not be pressed (${errorClass(pressError)})`
        : `the press in the window on ${windowPath} sent no sign-in request within ${bound.requestMs} ms`;
      throw refuse(STEP, record, "driver-failure", `${why} (native submissions cancelled: ${cancelled ?? "unread"}, form navigations aborted: ${aborted}) — ${notSpent}`);
    }

    // The app's own request left the window: the run's one sign-in is spent, whatever the answer.
    budget.spent += 1;
    record(`${STEP}: the press sent the app's own sign-in request (${new URL(request.url()).pathname}) — the once-only sign-in is spent`);
    const response = await within(request.response(), bound.answerMs);
    if (!response) {
      throw refuse(STEP, record, "no-answer", `the app gave no answer to its sign-in request within ${bound.answerMs} ms — the once-only sign-in is spent`);
    }
    const status = response.status();
    if (status !== 200) {
      const why =
        status === 401
          ? "the app answered 401 (it rejected the credentials, or the boot has no such account)"
          : status === 403
            ? "the app answered 403 (it refused the request itself at its trusted-origin check, not the account)"
            : `the app answered ${status}, neither 200 nor a rejection`;
      throw refuse(STEP, record, "rejected", `${why} — the once-only sign-in is spent`);
    }
    record(`${STEP}: signed in — the app answered 200 to its own sign-in request`);

    // THE RETURN: the window closes itself once the person is signed in.
    const answeredAt = performance.now();
    for (;;) {
      if (signedWindow.isClosed()) break;
      const remaining = bound.returnMs - (performance.now() - answeredAt);
      if (remaining <= 0) {
        throw refuse(STEP, record, "not-returned", `the window on ${pathOf(signedWindow.url())} stayed open ${bound.returnMs} ms after the app's answer — the once-only sign-in is spent`);
      }
      await pause(Math.min(bound.pollMs, remaining));
    }
    const elapsedMs = elapsedSince(pressedAt);
    record(`${STEP}: the window closed itself after the app's answer; the run is signed in, ${elapsedMs} ms after the press`);
    return { window: "signed-in", spent: true, path: from, windowPath, elapsedMs };
  } finally {
    // The window is the app's again, where it still stands.
    if (!signedWindow.isClosed()) {
      await within(signedWindow.evaluate(disarmNativeSubmitGuard, guardKey), bound.actionMs);
      await signedWindow.unroute(isWindowPage, networkGuard).catch(() => {});
    }
  }
}
