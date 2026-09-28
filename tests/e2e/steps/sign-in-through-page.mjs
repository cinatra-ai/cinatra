// signInThroughPage: the one sign-in press, through the product's own sign-in
// page.
//
// WHY IT EXISTS. A run that proves a change on a booted app signs in once. A
// press made before the sign-in page has hydrated reaches a form nothing of the
// app owns yet: the browser submits it natively, the app never hears its own
// sign-in request, the fields leave the page in a request of their own, and the
// run's one sign-in is spent on nothing. This step makes that impossible.
//
// WHAT IT DOES, in order:
//   1. refuses, before anything is sent, a call without the run's once-only
//      budget, without credentials, or with a bound it does not know;
//   2. loads the sign-in page with a full load and checks it landed there;
//   3. arms two guards before anything is pressed: one in the page, one on the
//      network;
//   4. waits for the form's hydration mark, never a fixed sleep; a page still
//      without it after the bound is reloaded once, and a second stall is
//      refused with a reading of the page;
//   5. fills the two fields and presses once;
//   6. waits for the app's own sign-in request and reads its answer. A press that
//      sent no such request is a driver failure and does not spend the budget; a
//      request that left the page spends it, whatever the answer.
import { randomUUID } from "node:crypto";

import { errorClass, pathOf, readBounds, refuse, requireRecord, within } from "./step-kit.mjs";

const STEP = "signInThroughPage";

/** The product's sign-in page. A caller outside a configured base address passes an absolute one. */
export const SIGN_IN_PAGE_PATH = "/sign-in";

/**
 * The app's own sign-in requests: the auth client's email route, and the
 * username route the same form takes for an identifier that is not an email
 * address. A press signs in only when one of these leaves the page.
 */
export const SIGN_IN_REQUEST_PATHS = Object.freeze(["/api/auth/sign-in/email", "/api/auth/sign-in/username"]);

/**
 * The hydration mark. The sign-in form comes from the product's auth form
 * library, which renders `<form method="POST" noValidate={isHydrated}>`:
 * `isHydrated` is false in the markup the server sends and true from the first
 * render after hydration has committed. So `novalidate` is absent until the
 * app's own submit handler owns the form, and present from then on. The load
 * event alone says only that the scripts arrived, not that they took the form over.
 */
export const SIGN_IN_HYDRATION_MARK = "novalidate";

/** The sign-in form's parts. The form is the one that holds the password field. */
export const SIGN_IN_SELECTORS = Object.freeze({
  password: 'input[type="password"]',
  email: 'form:has(input[type="password"]) input[name="email"]',
  submit: 'form:has(input[type="password"]) button[type="submit"]',
});

/** A page load, the first and the one reload alike. A cold development boot compiles the page on its first request. */
export const SIGN_IN_NAVIGATION_BOUND_MS = 300_000;
/** From the load event to the hydration mark. The mark normally follows within a second or two; past this bound the page has stalled. */
export const SIGN_IN_HYDRATION_BOUND_MS = 60_000;
/** How often the hydration mark is read while the step waits for it. */
export const SIGN_IN_HYDRATION_POLL_MS = 100;
/** One fill or the press: how long its field or button may take to be ready. */
export const SIGN_IN_ACTION_BOUND_MS = 30_000;
/** From the press to the app's own sign-in request. The app's handler sends it at once. */
export const SIGN_IN_REQUEST_BOUND_MS = 10_000;
/** From that request to the app's answer. A development boot may compile the route on its first request. */
export const SIGN_IN_ANSWER_BOUND_MS = 120_000;
/** The once-only rule: how many presses of one run may send the app's sign-in request. */
export const SIGN_IN_ALLOWANCE = 1;

/** Every bound of the step, by the name `bounds` overrides it with. */
export const SIGN_IN_BOUNDS = Object.freeze({
  navigationMs: SIGN_IN_NAVIGATION_BOUND_MS,
  hydrationMs: SIGN_IN_HYDRATION_BOUND_MS,
  pollMs: SIGN_IN_HYDRATION_POLL_MS,
  actionMs: SIGN_IN_ACTION_BOUND_MS,
  requestMs: SIGN_IN_REQUEST_BOUND_MS,
  answerMs: SIGN_IN_ANSWER_BOUND_MS,
});

/**
 * @typedef {{ spent: number }} SignInBudget
 *   The once-only rule, counted for one run.
 */

/**
 * The once-only rule, counted: create one per run and hand the same object to
 * every sign-in the run makes. `spent` grows only when a press sent the app's
 * own sign-in request; a driver failure leaves it where it was.
 * @returns {SignInBudget}
 */
export function createSignInBudget() {
  return Object.seal({ spent: 0 });
}

// These run IN THE PAGE. Playwright sends each one's source text, so none of
// them may use anything of this module.

/** True once the form that holds the password field carries the hydration mark. */
function signInFormHydrated({ password, mark }) {
  const field = document.querySelector(password);
  return Boolean(field && field.form && field.form.hasAttribute(mark));
}

/** What the sign-in page shows, for a stall's reading. Never a field's value. */
function readSignInForm({ password, submit, mark }) {
  const field = document.querySelector(password);
  const form = field && field.form ? field.form : null;
  const button = document.querySelector(submit);
  return {
    path: location.pathname,
    readyState: document.readyState,
    form: Boolean(form),
    mark: Boolean(form && form.hasAttribute(mark)),
    button: Boolean(button),
    enabled: Boolean(button && !button.disabled),
  };
}

/**
 * THE PAGE GUARD: one listener on the window, in the bubble phase, so it runs
 * after the app's own handler (the framework listens below the window). A
 * submission the app's handler owns arrives cancelled and is left alone; a
 * submission nobody cancelled, the native one a press before hydration makes, is
 * cancelled here and counted. The step removes it when the sign-in ends.
 */
function armNativeSubmitGuard(key) {
  if (window[key]) return true;
  const guard = { cancelled: 0 };
  guard.listener = function cancelNativeSubmit(event) {
    if (event.defaultPrevented) return;
    event.preventDefault();
    guard.cancelled += 1;
  };
  window.addEventListener("submit", guard.listener);
  window[key] = guard;
  return true;
}

/** How many native submissions the page guard cancelled; null when this document carries no guard. */
function readNativeSubmitGuard(key) {
  const guard = window[key];
  return guard ? guard.cancelled : null;
}

/** Remove the page guard; its count, or null when this document carries none. */
function disarmNativeSubmitGuard(key) {
  const guard = window[key];
  if (!guard) return null;
  window.removeEventListener("submit", guard.listener);
  delete window[key];
  return guard.cancelled;
}

function describeReading(reading) {
  if (!reading || reading.unreadable) return `the page could not be read (${reading?.unreadable ?? "no reading"})`;
  return [
    `path ${reading.path}`,
    `document ${reading.readyState}`,
    `form ${reading.form ? "present" : "absent"}`,
    `hydration mark ${reading.mark ? "present" : "absent"}`,
    `button ${reading.button ? (reading.enabled ? "enabled" : "disabled") : "absent"}`,
  ].join(", ");
}

/** Wait for the hydration mark; null when it came, else the page's reading. */
async function waitForHydrationMark(page, bound) {
  const arg = { password: SIGN_IN_SELECTORS.password, submit: SIGN_IN_SELECTORS.submit, mark: SIGN_IN_HYDRATION_MARK };
  try {
    await page.waitForFunction(signInFormHydrated, arg, { timeout: bound.hydrationMs, polling: bound.pollMs });
    return null;
  } catch {
    try {
      return await page.evaluate(readSignInForm, arg);
    } catch (readError) {
      return { unreadable: errorClass(readError) };
    }
  }
}

/**
 * Sign the run in once, through the product's own sign-in page, on the caller's
 * page. `credentials` go into the two fields and nowhere else; `budget` is the
 * run's once-only count (createSignInBudget), the same object for every sign-in
 * of the run; `record` receives one line per event. Resolves
 * `{ status: 200, reloads, spent }` signed in; otherwise throws a StepRefusal
 * whose kind is `input` or `spent` (nothing was sent), `blocker` (the page never
 * became pressable), `driver-failure` (the press sent no sign-in request),
 * `rejected` or `no-answer` (the request left the page; the budget is spent).
 *
 * @param {import("@playwright/test").Page} page
 * @param {{
 *   credentials: { email: string, password: string },
 *   budget: SignInBudget,
 *   record: import("./step-kit.mjs").StepRecord,
 *   url?: string,
 *   bounds?: Partial<Record<keyof typeof SIGN_IN_BOUNDS, number>>,
 * }} options
 * @returns {Promise<{ status: number, reloads: number, spent: number }>}
 */
export async function signInThroughPage(page, { credentials, budget, record, url = SIGN_IN_PAGE_PATH, bounds } = /** @type {any} */ ({})) {
  requireRecord(STEP, record);
  const nothingSent = "nothing was sent";
  // Without the run's own count the rule could only be kept per call, which is no rule at all.
  if (!budget || typeof budget.spent !== "number") {
    throw refuse(STEP, record, "input", `hand the step the run's once-only budget (createSignInBudget) — ${nothingSent}`);
  }
  if (budget.spent >= SIGN_IN_ALLOWANCE) {
    throw refuse(STEP, record, "spent", "this run's one sign-in already reached the app — no second press");
  }
  const { email, password } = credentials ?? {};
  if (typeof email !== "string" || email === "" || typeof password !== "string" || password === "") {
    throw refuse(STEP, record, "input", `hand the step credentials with a non-empty email and password — ${nothingSent}`);
  }
  const bound = readBounds(STEP, record, SIGN_IN_BOUNDS, bounds, nothingSent);
  const notSpent = "the once-only sign-in is not spent";
  const blocker = (why, reading = null) =>
    refuse(STEP, record, "blocker", `${why}${reading ? ` (reading: ${describeReading(reading)})` : ""} — ${notSpent}`);

  // A full load, and it must land on the page it named: a boot that sends the
  // visitor elsewhere (a setup form, a signed-in landing) holds no sign-in form.
  const load = async (how) => {
    try {
      await how();
    } catch (error) {
      throw blocker(`the sign-in page did not load within ${bound.navigationMs} ms (${errorClass(error)})`);
    }
    const landed = new URL(page.url());
    const wanted = new URL(url, landed);
    if (landed.origin !== wanted.origin || landed.pathname !== wanted.pathname) {
      throw blocker(`the sign-in page answered with another page, ${pathOf(landed.href)}, and nothing was pressed`);
    }
    return landed;
  };
  const at = await load(() => page.goto(url, { waitUntil: "load", timeout: bound.navigationMs }));

  // THE NETWORK GUARD. A navigation to the sign-in page's own address that is
  // not the page itself (a POST, or a GET with another query) is the form
  // submitting natively, and it is aborted before it leaves the browser. It also
  // stops what the page guard cannot see: a script's `form.submit()` fires no
  // submit event.
  let aborted = 0;
  const isSignInPage = (/** @type {URL} */ u) => u.origin === at.origin && u.pathname === at.pathname;
  const networkGuard = async (route, request) => {
    if (request.isNavigationRequest() && (request.method() !== "GET" || new URL(request.url()).search !== at.search)) {
      aborted += 1;
      await route.abort("blockedbyclient");
      return;
    }
    await route.fallback();
  };
  const guardKey = `__signInGuard${randomUUID().replace(/-/g, "")}`;
  const armPage = async () => {
    try {
      await page.evaluate(armNativeSubmitGuard, guardKey);
    } catch (error) {
      throw blocker(`the page guard could not be armed (${errorClass(error)})`);
    }
  };
  await page.route(isSignInPage, networkGuard);
  try {
    await armPage();
    let reloads = 0;
    const stall = await waitForHydrationMark(page, bound);
    if (stall) {
      record(`${STEP}: no hydration mark within ${bound.hydrationMs} ms (reading: ${describeReading(stall)}) — one full reload`);
      await load(() => page.reload({ waitUntil: "load", timeout: bound.navigationMs }));
      reloads = 1;
      await armPage();
      const again = await waitForHydrationMark(page, bound);
      if (again) {
        throw blocker(`the sign-in page did not hydrate within ${bound.hydrationMs} ms after its load, nor after one full reload`, again);
      }
    }
    record(`${STEP}: the form carries its hydration mark ${reloads ? "after one full reload" : "on the first load"}`);

    for (const [name, selector, value] of [
      ["email", SIGN_IN_SELECTORS.email, email],
      ["password", SIGN_IN_SELECTORS.password, password],
    ]) {
      try {
        await page.locator(selector).fill(value, { timeout: bound.actionMs });
      } catch (error) {
        // Playwright's own message can repeat the value it was given to fill: only the class is kept.
        throw refuse(STEP, record, "driver-failure", `the ${name} field could not be filled (${errorClass(error)}) — nothing was pressed; ${notSpent}`);
      }
    }

    // THE PRESS, and the app's own request: listened for from before the press,
    // so a request sent while the press is still being made is not missed, and
    // bounded from the moment the press was made.
    const isSignInRequest = (request) => {
      const u = new URL(request.url());
      return request.method() === "POST" && u.origin === at.origin && SIGN_IN_REQUEST_PATHS.includes(u.pathname);
    };
    /** @type {(request: unknown) => void} */
    let noteRequest = () => {};
    const requestSent = new Promise((done) => {
      noteRequest = done;
    });
    const onRequest = (request) => {
      if (isSignInRequest(request)) noteRequest(request);
    };
    let pressError = null;
    let request = null;
    page.on("request", onRequest);
    try {
      try {
        // `noWaitAfter`: the press returns once made; what it sent is read below.
        await page.locator(SIGN_IN_SELECTORS.submit).click({ timeout: bound.actionMs, noWaitAfter: true });
      } catch (error) {
        pressError = error;
      }
      request = await within(requestSent, bound.requestMs);
    } finally {
      page.off("request", onRequest);
    }
    if (!request) {
      const cancelled = await within(page.evaluate(readNativeSubmitGuard, guardKey), bound.actionMs);
      const why = pressError
        ? `the sign-in button could not be pressed (${errorClass(pressError)})`
        : `the press sent no sign-in request within ${bound.requestMs} ms`;
      throw refuse(
        STEP,
        record,
        "driver-failure",
        `${why} (native submissions cancelled: ${cancelled ?? "unread"}, form navigations aborted: ${aborted}) — ${notSpent}`,
      );
    }

    // The app's own request left the page: the run's one sign-in is spent, whatever the answer.
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
    return { status, reloads, spent: budget.spent };
  } finally {
    // The page is the app's again. A page that has navigated since carries no guard to remove.
    await within(page.evaluate(disarmNativeSubmitGuard, guardKey), bound.actionMs);
    await page.unroute(isSignInPage, networkGuard).catch(() => {});
  }
}
