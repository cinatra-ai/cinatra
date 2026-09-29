// decideGate: a decision taken at a gate a run stops at, through the gate's
// own control, and the run seen to move on.
//
// WHY IT EXISTS. A decision written by hand for each run pressed the first
// Approve on the page, which on a page with two gates is the wrong gate's, and
// took its picture while the run still waited. This step finds the gate by its
// name, presses the gate's own control named by the decision, and waits until
// the run has left the gate.
//
// THE GATE. A gate is a lifecycle card (`data-lifecycle-card`): the review gate,
// an input screen, a proposal a run holds for. Its name is its accessible name
// (`aria-label`, or the text its `aria-labelledby` names), else its heading, else
// its title: the first text it shows, which is how the product's gate cards open
// ("Review requested"). The decision is a shown button of that gate, by its
// accessible name ("Approve", "Reject"). A gate is drawn once the app has
// resolved it, and its controls may come after its title, so the step waits for
// both within the find bound.
//
// LEAVING THE GATE. On a run page the run's own status (the pill the run surface
// draws with the dot) reads `needs-review` while the run waits at the gate; the
// run has left once it reads another status. On a page without that status (a
// conversation) the gate itself is read: the run has left once the gate reads a
// decided state (GATE_LEFT_STATES) or is no longer drawn.
import { listed, pickCandidate, quoted } from "./control-kit.mjs";
import { elapsedSince, errorClass, pathOf, pollUntilSettled, readBounds, refuse, requireRecord } from "./step-kit.mjs";
import { RUN_STATUS_SELECTOR, RUN_SURFACE_SELECTOR } from "./watch-run.mjs";

const STEP = "decideGate";

/** A gate a run stops at: every lifecycle card is one. */
export const GATE_SELECTOR = "[data-lifecycle-card]";
/** The attribute a gate writes its state to. */
export const GATE_STATE_ATTRIBUTE = "data-lifecycle-card-state";
/** The gate states a decision has settled. */
export const GATE_LEFT_STATES = Object.freeze(["settled", "decided"]);
/** The run's status while it waits at a gate for a person. */
export const GATE_WAITING_STATUS = "needs-review";
/** How long the gate and its control may take to be drawn. */
export const GATE_FIND_BOUND_MS = 30_000;
/** The press. */
export const GATE_ACTION_BOUND_MS = 30_000;
/** From the press to the run leaving the gate. The app records the decision and resumes the run. */
export const GATE_LEAVE_BOUND_MS = 60_000;
/** How often the page is read. */
export const GATE_POLL_MS = 250;

/** Every bound of the step, by the name `bounds` overrides it with. */
export const GATE_BOUNDS = Object.freeze({
  findMs: GATE_FIND_BOUND_MS,
  actionMs: GATE_ACTION_BOUND_MS,
  leaveMs: GATE_LEAVE_BOUND_MS,
  pollMs: GATE_POLL_MS,
});

// Runs IN THE PAGE: nothing of this module may be used inside it. One reading
// names every gate, so the gate the step finds and the gate a control is
// matched to are named by the same rule. Handed a control (as a locator's
// evaluation does), it answers whether the control sits in the gate named
// `gate`. Otherwise it reads every shown gate (name, state, the names of its
// shown controls) and, by `mode`: `find` says whether a gate named `gate` shows
// a control named `decision` (`ready`, `no-control`, `no-gate`); `leave` reads
// the run's status, or, without one, the named gate's state (`gate:gone` when it
// is no longer drawn).
function readGates(first, second) {
  const arg = second === undefined ? first : second;
  const control = second === undefined ? null : first;
  const text = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const shown = (element) => {
    if (!element.isConnected || getComputedStyle(element).visibility === "hidden") return false;
    for (let node = element; node; node = node.parentElement) {
      if (node.hasAttribute("hidden") || getComputedStyle(node).display === "none") return false;
    }
    return true;
  };
  const texts = (node) => {
    const found = [];
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    for (let at = walker.nextNode(); at; at = walker.nextNode()) {
      if (at.parentElement && at.parentElement.closest('[aria-hidden="true"]')) continue;
      const value = text(at.nodeValue);
      if (value) found.push(value);
    }
    return found;
  };
  const byIds = (element, attribute) =>
    text(element.getAttribute(attribute))
      .split(" ")
      .filter(Boolean)
      .map((id) => document.getElementById(id))
      .filter(Boolean);
  const nameOf = (element, title) => {
    const labelledBy = byIds(element, "aria-labelledby");
    if (labelledBy.length > 0) return text(labelledBy.map((node) => texts(node).join(" ")).join(" "));
    const label = text(element.getAttribute("aria-label"));
    if (label) return label;
    if (title) {
      const heading = element.querySelector("h1, h2, h3, h4, h5, h6, [role='heading']");
      return heading ? texts(heading).join(" ") : texts(element)[0] || "";
    }
    const own = element.localName === "input" ? text(element.value) : texts(element).join(" ");
    return own || text(element.getAttribute("title"));
  };
  if (control) {
    const holder = control.closest(arg.selector);
    return Boolean(holder) && shown(holder) && nameOf(holder, true) === arg.gate;
  }
  const gates = Array.from(document.querySelectorAll(arg.selector))
    .filter(shown)
    .map((gate) => ({
      name: nameOf(gate, true),
      state: gate.getAttribute(arg.stateAttribute) || "unmarked",
      controls: Array.from(gate.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"]'))
        .filter(shown)
        .map((element) => nameOf(element, false)),
    }));
  const named = gates.filter((gate) => gate.name === arg.gate);
  if (arg.mode === "leave") {
    const surface = document.querySelector(arg.surface);
    const pill = surface ? surface.querySelector(arg.status) : null;
    if (pill) return { state: `status:${pill.getAttribute("data-status") || "unmarked"}`, gates };
    return { state: named.length > 0 ? `gate:${named[0].state}` : "gate:gone", gates };
  }
  const state = named.some((gate) => gate.controls.includes(arg.decision)) ? "ready" : named.length > 0 ? "no-control" : "no-gate";
  return { state, gates };
}

/** Whether a reading says the run has left the gate. @param {string} state */
function hasLeft(state) {
  if (state.startsWith("status:")) {
    const status = state.slice("status:".length);
    return status !== GATE_WAITING_STATUS && status !== "unmarked";
  }
  if (state === "gate:gone") return true;
  return state.startsWith("gate:") && GATE_LEFT_STATES.includes(state.slice("gate:".length));
}

/** A reading, for a line. @param {string} state */
function described(state) {
  if (state === "gate:gone") return "the gate is no longer drawn";
  if (state.startsWith("status:")) return `status ${state.slice("status:".length)}`;
  if (state.startsWith("gate:")) return `the gate reads ${state.slice("gate:".length)}`;
  return state;
}

/** @param {string} value */
const normal = (value) => value.replace(/\s+/g, " ").trim();

/**
 * Take the decision `decision` at the gate named `gate` on the caller's page:
 * press the gate's own control with that name, and resolve
 * `{ gate, decision, state, elapsedMs, path }` once the run has left the gate
 * (`state` is the reading that says so, such as `status:running`). Refuses, as a
 * StepRefusal: `input` (nothing was pressed), `no-gate` (no gate with the name,
 * naming the gates the page shows), `no-control` (the gate shows no control
 * with the name, naming its controls), `driver-failure` (the press failed) and
 * `still-at-gate` (the run did not leave the gate within the bound, with the
 * last reading).
 *
 * @param {import("@playwright/test").Page} page
 * @param {{
 *   gate: string,
 *   decision: string,
 *   record: import("./step-kit.mjs").StepRecord,
 *   bounds?: Partial<Record<keyof typeof GATE_BOUNDS, number>>,
 * }} options
 * @returns {Promise<{ gate: string, decision: string, state: string, elapsedMs: number, path: string }>}
 */
export async function decideGate(page, { gate, decision, record, bounds } = /** @type {any} */ ({})) {
  requireRecord(STEP, record);
  const nothing = "nothing was pressed";
  if (typeof gate !== "string" || normal(gate) === "") {
    throw refuse(STEP, record, "input", `name the gate by its name, such as Review requested — ${nothing}`);
  }
  if (typeof decision !== "string" || normal(decision) === "") {
    throw refuse(STEP, record, "input", `name the decision by its control's accessible name, such as Approve — ${nothing}`);
  }
  const bound = readBounds(STEP, record, GATE_BOUNDS, bounds, nothing);
  const named = normal(gate);
  const choice = normal(decision);
  const at = pathOf(page.url());
  const arg = {
    selector: GATE_SELECTOR,
    stateAttribute: GATE_STATE_ATTRIBUTE,
    surface: RUN_SURFACE_SELECTOR,
    status: RUN_STATUS_SELECTOR,
    gate: named,
    decision: choice,
  };

  // The gate and its control, drawn: the app draws a gate once it has resolved it.
  const found = await pollUntilSettled(page, {
    read: readGates,
    arg: { ...arg, mode: "find" },
    isSettled: (state) => state === "ready",
    bound: bound.findMs,
    pollMs: bound.pollMs,
  });
  const gates = /** @type {{ gates?: { name: string, state: string, controls: string[] }[] }} */ (found.reading).gates;
  const noControl = (/** @type {string} */ why) => {
    const held = gates?.find((candidate) => candidate.name === named);
    return refuse(STEP, record, "no-control", `${why}; its controls: ${listed(held ? held.controls : [], "none")} — ${nothing}`);
  };
  if (!found.settled) {
    if (!gates) throw refuse(STEP, record, "no-gate", `the gates on ${at} could not be read within ${bound.findMs} ms — ${nothing}`);
    if (found.reading.state !== "no-control") {
      const names = gates.map((candidate) => candidate.name);
      throw refuse(STEP, record, "no-gate", `no gate named ${quoted(named)} on ${at} within ${bound.findMs} ms; its gates: ${listed(names, "none")} — ${nothing}`);
    }
    throw noControl(`the gate ${quoted(named)} on ${at} shows no control named ${quoted(choice)} within ${bound.findMs} ms`);
  }
  const control = await pickCandidate(page.getByRole("button", { name: choice, exact: true }), readGates, arg);
  if (!control) throw noControl(`no control named ${quoted(choice)} in the gate ${quoted(named)} on ${at} can be pressed by its name`);

  const start = performance.now();
  try {
    await control.click({ timeout: bound.actionMs });
  } catch (error) {
    throw refuse(STEP, record, "driver-failure", `the control ${quoted(choice)} in the gate ${quoted(named)} could not be pressed (${errorClass(error)})`);
  }
  const left = await pollUntilSettled(page, {
    read: readGates,
    arg: { ...arg, mode: "leave" },
    isSettled: hasLeft,
    bound: bound.leaveMs,
    pollMs: bound.pollMs,
  });
  const state = left.reading.state;
  if (!left.settled) {
    throw refuse(
      STEP,
      record,
      "still-at-gate",
      `the press on ${quoted(choice)} in the gate ${quoted(named)} on ${at} did not move the run on within ${bound.leaveMs} ms (${described(state)})`,
    );
  }
  const elapsedMs = elapsedSince(start);
  record(`${STEP}: pressed ${quoted(choice)} in the gate ${quoted(named)} on ${at}; the run left the gate after ${elapsedMs} ms (${described(state)})`);
  return { gate: named, decision: choice, state, elapsedMs, path: at };
}
