// fillForm: named fields filled by their labels, and the form sent, driven
// against a form whose required fields show their errors the two ways the
// product's forms draw them.
//
// The defect these cases stand for: a form filled by selectors that drifted
// from the page, and a required field left empty that surfaced only as a run
// that went on with a gap. Every value below is built at run time; each case
// checks that no value reaches a line the step wrote.
import { afterAll, describe, expect, it } from "vitest";

import { BACKENDS, closeBrowser, labelOf, refusal, scene, theSteps } from "./backends.mjs";
import { FORM_SAVE_ROUTE } from "./fixture-app-controls.mjs";

afterAll(closeBrowser);

// Short bounds, so a refusal costs a second, not minutes.
const BOUNDS = Object.freeze({ fieldsMs: 1500, actionMs: 2000, errorMs: 1000, pollMs: 25 });
const TITLE = ["fixture", "title", "one"].join("-");
const SUMMARY = ["fixture", "summary", "two"].join("-");
const NOTES = ["fixture", "notes", "three"].join("-");
const SECRETS = [TITLE, SUMMARY, NOTES];
const LABELS = '"Title", "Summary *", "Notes (optional)", "Reference"';

for (const backend of BACKENDS) {
  describe.skipIf(Boolean(backend.skip))(`fillForm [${labelOf(backend)}]`, () => {
    const open = async (page, app, path) => {
      await page.goto(`${app.origin}${path}`);
      return theSteps("fillForm").fillForm;
    };
    const saved = (app) => app.requests.filter((r) => r.method === "POST" && r.path === FORM_SAVE_ROUTE);
    const valueOf = (page, selector) => page.evaluate((field) => document.querySelector(field).value, selector);

    it("fills each field by its label and sends the form with its own control", async () => {
      await scene(backend, { secrets: SECRETS }, async ({ app, page, record, lines }) => {
        const fillForm = await open(page, app, "/form/profile");
        const fields = { Title: TITLE, "Summary *": SUMMARY, "Notes (optional)": NOTES };
        const result = await fillForm(page, { fields, submit: "Save", record, bounds: BOUNDS });
        expect(result).toEqual({ filled: ["Title", "Summary *", "Notes (optional)"], submitted: true, path: "/form/profile" });
        for (let i = 0; i < 40 && saved(app).length === 0; i += 1) await new Promise((done) => setTimeout(done, 25));
        expect(saved(app), "the form was sent exactly once").toHaveLength(1);
        expect(JSON.parse(saved(app)[0].body)).toEqual({ title: TITLE, summary: SUMMARY, notes: NOTES, reference: "" });
        expect(lines).toEqual(['fillForm: filled "Title", "Summary *", "Notes (optional)" in the form on /form/profile and pressed "Save"']);
      });
    });

    it("fills without sending when no control is named", async () => {
      await scene(backend, { secrets: SECRETS }, async ({ app, page, record, lines }) => {
        const fillForm = await open(page, app, "/form/profile");
        const result = await fillForm(page, { fields: { "  Title ": TITLE }, record, bounds: BOUNDS });
        expect(result).toEqual({ filled: ["Title"], submitted: false, path: "/form/profile" });
        expect(await valueOf(page, "#title")).toBe(TITLE);
        expect(saved(app)).toEqual([]);
        expect(lines).toEqual(['fillForm: filled "Title" in the form on /form/profile']);
      });
    });

    it("waits for a form the app draws after the page", async () => {
      await scene(backend, { secrets: SECRETS }, async ({ app, page, record }) => {
        const fillForm = await open(page, app, "/form/late");
        const result = await fillForm(page, { fields: { Title: TITLE, "Summary *": SUMMARY }, submit: "Save", record, bounds: BOUNDS });
        expect(result.submitted).toBe(true);
        expect(await valueOf(page, "#summary")).toBe(SUMMARY);
      });
    });

    it("refuses by name a label the form does not have, naming the labels it has", async () => {
      await scene(backend, { secrets: SECRETS }, async ({ app, page, record, lines }) => {
        const fillForm = await open(page, app, "/form/profile");
        const error = await refusal(fillForm(page, { fields: { Title: TITLE, Titel: TITLE }, submit: "Save", record, bounds: { ...BOUNDS, fieldsMs: 600 } }));
        expect(error.name).toBe("StepRefusal");
        expect(error.step).toBe("fillForm");
        expect(error.kind).toBe("unknown-label");
        expect(error.message).toBe(
          `fillForm refused (unknown-label): no field in the form on /form/profile is labelled "Titel" within 600 ms; its labels: ${LABELS} — nothing was filled`,
        );
        expect(lines).toEqual([error.message]);
        expect(await valueOf(page, "#title"), "a field was filled before the refusal").toBe("");
        expect(saved(app)).toEqual([]);
      });
    });

    it("quotes the page's own error for a required field left empty", async () => {
      await scene(backend, { secrets: SECRETS }, async ({ app, page, record, lines }) => {
        const fillForm = await open(page, app, "/form/profile");
        const error = await refusal(fillForm(page, { fields: { Title: TITLE }, submit: "Save", record, bounds: BOUNDS }));
        expect(error.kind).toBe("required-empty");
        expect(error.message).toBe(
          'fillForm refused (required-empty): the press on "Save" in the form on /form/profile left a required field empty: ' +
            '"Summary *" (the page says "Summary is required.")',
        );
        expect(lines).toEqual([error.message]);
        expect(saved(app), "the page sent a form with a required field empty").toEqual([]);
      });
    });

    it("names every required field left empty, each with the error the page shows for it", async () => {
      await scene(backend, { secrets: SECRETS }, async ({ app, page, record }) => {
        const fillForm = await open(page, app, "/form/profile");
        const error = await refusal(fillForm(page, { fields: { "Notes (optional)": NOTES }, submit: "Save", record, bounds: BOUNDS }));
        expect(error.kind).toBe("required-empty");
        expect(error.message).toBe(
          'fillForm refused (required-empty): the press on "Save" in the form on /form/profile left required fields empty: ' +
            '"Title" (the page says "Title is required."), "Summary *" (the page says "Summary is required.")',
        );
      });
    });

    it("refuses by name a control the form does not have, naming its controls", async () => {
      await scene(backend, { secrets: SECRETS }, async ({ app, page, record, lines }) => {
        const fillForm = await open(page, app, "/form/profile");
        const error = await refusal(fillForm(page, { fields: { Title: TITLE }, submit: "Send", record, bounds: BOUNDS }));
        expect(error.kind).toBe("no-submit");
        expect(error.message).toBe(
          'fillForm refused (no-submit): no shown control named "Send" in the form on /form/profile; its controls: "Save" — ' +
            'the fields were filled ("Title"), and nothing was pressed',
        );
        expect(lines).toEqual([error.message]);
        expect(saved(app)).toEqual([]);
      });
    });

    it("refuses by name a field that cannot be filled, and keeps the value out of the refusal", async () => {
      await scene(backend, { secrets: SECRETS }, async ({ app, page, record, lines }) => {
        const fillForm = await open(page, app, "/form/profile");
        const error = await refusal(fillForm(page, { fields: { Title: TITLE, Reference: SUMMARY }, record, bounds: { ...BOUNDS, actionMs: 300 } }));
        expect(error.kind).toBe("driver-failure");
        expect(error.message).toBe('fillForm refused (driver-failure): the field "Reference" could not be filled (TimeoutError) — filled before it: "Title"');
        expect(lines).toEqual([error.message]);
      });
    });

    it("fills nothing when it refuses its arguments", async () => {
      const { fillForm } = theSteps("fillForm");
      await scene(backend, { secrets: SECRETS }, async ({ app, page, record, lines }) => {
        await page.goto(`${app.origin}/form/profile`);
        const FIELDS = "hand the step the fields to fill, each a label with a text value — nothing was filled";
        const cases = [
          [{ record }, FIELDS],
          [{ record, fields: {} }, FIELDS],
          [{ record, fields: [TITLE] }, FIELDS],
          [{ record, fields: { Title: 7 } }, FIELDS],
          [{ record, fields: { " ": TITLE } }, FIELDS],
          [{ record, fields: { Title: TITLE }, form: "" }, "name the form by a selector, such as form — nothing was filled"],
          [{ record, fields: { Title: TITLE }, submit: " " }, "name the control that sends the form by its accessible name, such as Save — nothing was filled"],
          [{ record, fields: { Title: TITLE }, bounds: { errorMs: -1 } }, "errorMs must be a positive number of milliseconds — nothing was filled"],
          [{ record, fields: { Title: TITLE }, bounds: { typeMs: 5 } }, "there is no bound named typeMs — nothing was filled"],
        ];
        for (const [options, reason] of cases) {
          const error = await refusal(fillForm(page, options));
          expect(error.kind).toBe("input");
          expect(error.message).toBe(`fillForm refused (input): ${reason}`);
          expect(lines.at(-1)).toBe(error.message);
        }
        const unrecorded = await refusal(fillForm(page, { fields: { Title: TITLE } }));
        expect(unrecorded.message).toBe("fillForm refused (input): hand the step a record callback — nothing was done");
        expect(await valueOf(page, "#title"), "a refused call filled a field").toBe("");
      });
    });
  });
}
