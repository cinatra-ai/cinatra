// What every step test shares: the steps module as the tests load it, the two
// backends a case runs on, and the scene one case plays in.
//
// Every case runs on the PAGE DOUBLE, which needs no browser and runs wherever
// the unit tier runs. With E2E_STEPS_UNIT_BROWSER=1 the same cases also drive a
// real browser over the same fixture pages, which is what keeps the double
// honest; without it, or where no browser can be launched, that leg is skipped
// and its name says why.
import { expect } from "vitest";

import { startFixtureApp } from "./fixture-app.mjs";
import { ContextDouble } from "./page-double.mjs";

// The module is loaded here and not imported at the top of each file, so a
// module that does not load fails each case on a named assertion instead of
// failing every file at its import.
let steps = null;
let loadError = null;
try {
  steps = await import("../index.mjs");
} catch (error) {
  loadError = error;
}

/** The steps module, after asserting it offers each of `names`. */
export function theSteps(...names) {
  const why = loadError ? ` (the module does not load: ${loadError.code ?? loadError.name})` : "";
  for (const name of names) {
    expect(typeof steps?.[name], `tests/e2e/steps offers no ${name}${why}`).toBe("function");
  }
  return steps;
}

let browser = null;
let browserSkip = "set E2E_STEPS_UNIT_BROWSER=1 to drive a real browser as well";
if (process.env.E2E_STEPS_UNIT_BROWSER === "1") {
  try {
    const { chromium } = await import("@playwright/test");
    browser = await chromium.launch();
    browserSkip = false;
  } catch (error) {
    browserSkip = `no browser could be launched here (${error?.name ?? "Error"})`;
  }
}

export async function closeBrowser() {
  if (browser) await browser.close();
}

// Each case opens its page in a browser context of its own, and closes the context after it.
export const BACKENDS = [
  {
    name: "page double",
    skip: false,
    open: async (origin) => new ContextDouble(origin).newPage(),
    close: (page) => page.context().close(),
  },
  {
    name: "browser",
    skip: browserSkip,
    // The HTTP/2 origin's certificate is made at run time and signed by its own key.
    open: async () => (await browser.newContext({ ignoreHTTPSErrors: true })).newPage(),
    close: (page) => page.context().close(),
  },
];

/** The describe label for a backend: its name, and why it is skipped when it is. */
export const labelOf = (backend) => (backend.skip ? `${backend.name}, skipped: ${backend.skip}` : backend.name);

/**
 * One case on one backend: a fixture app (serving HTTP/2 as well with `secure`),
 * a page, and a record that keeps every line the step wrote. After the case, no
 * line may carry one of `secrets` or an origin of the app: a step writes paths,
 * never addresses or values.
 */
export async function scene(backend, { answer, secure, secrets = [] } = {}, body) {
  const app = await startFixtureApp({ answer, secure });
  const page = await backend.open(app.origin);
  const lines = [];
  const record = (line) => lines.push(String(line));
  try {
    await body({ app, page, record, lines });
    for (const line of lines) {
      for (const secret of [...secrets, app.origin, ...(app.secureOrigin ? [app.secureOrigin] : [])]) {
        expect(line.includes(secret), `a line the step wrote carries a value or the origin: ${line.slice(0, 48)}`).toBe(false);
      }
    }
  } finally {
    await backend.close(page);
    await app.stop();
  }
}

/** The refusal a step threw; a step that returned instead fails the case. */
export async function refusal(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("the step returned where it had to refuse");
}

/** A shutter that takes no picture: it keeps each request and names a frame path. */
export function shutterDouble() {
  const shots = [];
  const shutter = async (info) => {
    shots.push(info);
    return `frames/${info.step}-${shots.length}.png`;
  };
  return { shots, shutter };
}

export const pause = (ms) => new Promise((done) => setTimeout(done, ms));
