// decideGate: a decision taken at a named gate through the gate's own control,
// and the run seen to move on, driven against a run page with two gates, a
// conversation, and a gate whose decision goes nowhere.
//
// The defect these cases stand for: a decision pressed the first Approve on the
// page, which belonged to another gate, and the picture was taken while the run
// still waited at the gate.
import { afterAll, describe, expect, it } from "vitest";

import { BACKENDS, closeBrowser, labelOf, refusal, scene, theSteps } from "./backends.mjs";

afterAll(closeBrowser);

// Short bounds, so a refusal costs a second, not minutes.
const BOUNDS = Object.freeze({ findMs: 1500, actionMs: 2000, leaveMs: 3000, pollMs: 25 });

for (const backend of BACKENDS) {
  describe.skipIf(Boolean(backend.skip))(`decideGate [${labelOf(backend)}]`, () => {
    const open = async (page, app, path) => {
      await page.goto(`${app.origin}${path}`);
      return theSteps("decideGate").decideGate;
    };
    const gateState = (page, id) =>
      page.evaluate((gate) => {
        const element = document.getElementById(gate);
        return { state: element.getAttribute("data-lifecycle-card-state"), controls: element.querySelectorAll("button").length };
      }, id);

    it("presses the named gate's own control, not the first of its name, and waits for the run to move on", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const decideGate = await open(page, app, "/gate/run");
        const result = await decideGate(page, { gate: "Review requested", decision: "Approve", record, bounds: BOUNDS });
        expect(result).toMatchObject({ gate: "Review requested", decision: "Approve", state: "status:running", path: "/gate/run" });
        // The run moves on 300 ms after the press: the step waited for it.
        expect(result.elapsedMs).toBeGreaterThanOrEqual(250);
        expect(await gateState(page, "gate-review")).toEqual({ state: "settled", controls: 0 });
        expect(await gateState(page, "gate-budget"), "the other gate's Approve was pressed").toEqual({ state: "pending", controls: 2 });
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatch(
          /^decideGate: pressed "Approve" in the gate "Review requested" on \/gate\/run; the run left the gate after \d+ ms \(status running\)$/,
        );
      });
    });

    it("names a gate by its heading", async () => {
      await scene(backend, {}, async ({ app, page, record }) => {
        const decideGate = await open(page, app, "/gate/run");
        const result = await decideGate(page, { gate: "Budget review", decision: "Approve", record, bounds: BOUNDS });
        expect(result.state).toBe("status:approved");
        expect(await gateState(page, "gate-review")).toEqual({ state: "pending", controls: 3 });
      });
    });

    it("reads the gate itself on a page that draws no run status", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const decideGate = await open(page, app, "/gate/thread");
        const result = await decideGate(page, { gate: "Review requested", decision: "Approve", record, bounds: BOUNDS });
        expect(result.state).toBe("gate:settled");
        expect(lines[0]).toMatch(/\(the gate reads settled\)$/);
      });
    });

    it("waits for a gate the app draws after the page", async () => {
      await scene(backend, {}, async ({ app, page, record }) => {
        const decideGate = await open(page, app, "/gate/late");
        const result = await decideGate(page, { gate: "Review requested", decision: "Approve", record, bounds: BOUNDS });
        expect(result.state).toBe("status:running");
      });
    });

    it("refuses by name a gate the page does not show, naming the gates it shows", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const decideGate = await open(page, app, "/gate/run");
        const error = await refusal(decideGate(page, { gate: "Review wanted", decision: "Approve", record, bounds: { ...BOUNDS, findMs: 500 } }));
        expect(error.name).toBe("StepRefusal");
        expect(error.step).toBe("decideGate");
        expect(error.kind).toBe("no-gate");
        expect(error.message).toBe(
          'decideGate refused (no-gate): no gate named "Review wanted" on /gate/run within 500 ms; its gates: "Budget review", "Review requested" — nothing was pressed',
        );
        expect(lines).toEqual([error.message]);
        expect(await gateState(page, "gate-review")).toEqual({ state: "pending", controls: 3 });
        expect(await gateState(page, "gate-budget")).toEqual({ state: "pending", controls: 2 });
      });
    });

    it("refuses by name a control the gate does not show, naming the gate's controls", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const decideGate = await open(page, app, "/gate/run");
        const error = await refusal(decideGate(page, { gate: "Review requested", decision: "Accept", record, bounds: { ...BOUNDS, findMs: 500 } }));
        expect(error.kind).toBe("no-control");
        expect(error.message).toBe(
          'decideGate refused (no-control): the gate "Review requested" on /gate/run shows no control named "Accept" within 500 ms; ' +
            'its controls: "Comment", "Reject", "Approve" — nothing was pressed',
        );
        expect(lines).toEqual([error.message]);
        expect(await gateState(page, "gate-review")).toEqual({ state: "pending", controls: 3 });
      });
    });

    it("refuses by name a run that never leaves the gate, with its last reading", async () => {
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        const decideGate = await open(page, app, "/gate/stuck");
        const error = await refusal(decideGate(page, { gate: "Review requested", decision: "Approve", record, bounds: { ...BOUNDS, leaveMs: 800 } }));
        expect(error.kind).toBe("still-at-gate");
        expect(error.message).toBe(
          'decideGate refused (still-at-gate): the press on "Approve" in the gate "Review requested" on /gate/stuck did not move the run on within 800 ms (status needs-review)',
        );
        expect(lines).toEqual([error.message]);
      });
    });

    it("presses nothing when it refuses its arguments", async () => {
      const { decideGate } = theSteps("decideGate");
      await scene(backend, {}, async ({ app, page, record, lines }) => {
        await page.goto(`${app.origin}/gate/run`);
        const GATE = "name the gate by its name, such as Review requested — nothing was pressed";
        const cases = [
          [{ record, decision: "Approve" }, GATE],
          [{ record, gate: " ", decision: "Approve" }, GATE],
          [{ record, gate: "Review requested" }, "name the decision by its control's accessible name, such as Approve — nothing was pressed"],
          [{ record, gate: "Review requested", decision: "Approve", bounds: { leaveMs: 0 } }, "leaveMs must be a positive number of milliseconds — nothing was pressed"],
          [{ record, gate: "Review requested", decision: "Approve", bounds: { pressMs: 5 } }, "there is no bound named pressMs — nothing was pressed"],
        ];
        for (const [options, reason] of cases) {
          const error = await refusal(decideGate(page, options));
          expect(error.kind).toBe("input");
          expect(error.message).toBe(`decideGate refused (input): ${reason}`);
          expect(lines.at(-1)).toBe(error.message);
        }
        const unrecorded = await refusal(decideGate(page, { gate: "Review requested", decision: "Approve" }));
        expect(unrecorded.message).toBe("decideGate refused (input): hand the step a record callback — nothing was done");
        expect(await gateState(page, "gate-review"), "a refused call pressed a control").toEqual({ state: "pending", controls: 3 });
      });
    });
  });
}
