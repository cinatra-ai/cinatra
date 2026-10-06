// uploadFile: a file upload through the page's own Upload control, driven
// against library pages whose Upload button opens a hidden file input.
//
// The defect these cases stand for: an upload set the file on the hidden input
// directly, past the control a person presses, and read the list before the app
// had filed the upload. The file below is written at run time; each case checks
// that neither its content nor the place it was written reaches a line.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BACKENDS, closeBrowser, labelOf, refusal, scene, theSteps } from "./backends.mjs";
import { UPLOAD_ACCEPT_ROUTE, UPLOAD_REFUSE_ROUTE } from "./fixture-app-controls.mjs";

afterAll(closeBrowser);

// Short bounds, so a refusal costs a second, not minutes.
const BOUNDS = Object.freeze({ controlMs: 1000, actionMs: 2000, chooserMs: 600, rowMs: 3000, pollMs: 25 });
const CONTENT = ["fixture", "upload", "content"].join("-");
const ROWS = '[data-conformance-id="artifacts-library-list"] > li';

let folder = "";
let file = "";
beforeAll(() => {
  folder = mkdtempSync(join(tmpdir(), "steps-upload-"));
  file = join(folder, "notes.txt");
  writeFileSync(file, CONTENT);
  mkdirSync(join(folder, "not-a-file"));
});
afterAll(() => rmSync(folder, { recursive: true, force: true }));

const rowNames = (page, selector) => page.evaluate((rows) => Array.from(document.querySelectorAll(rows), (row) => row.textContent.trim()), selector);

for (const backend of BACKENDS) {
  describe.skipIf(Boolean(backend.skip))(`uploadFile [${labelOf(backend)}]`, () => {
    const open = async (page, app, path) => {
      await page.goto(`${app.origin}${path}`);
      return theSteps("uploadFile").uploadFile;
    };
    const posted = (app, route) => app.requests.filter((r) => r.method === "POST" && r.path === route);
    const secrets = () => [folder, CONTENT];

    it("presses the Upload control, answers its file chooser and waits for the file's row", async () => {
      await scene(backend, { secrets: secrets() }, async ({ app, page, record, lines }) => {
        const uploadFile = await open(page, app, "/upload/library");
        const result = await uploadFile(page, { control: "Upload", path: file, record, bounds: BOUNDS });
        expect(result).toMatchObject({ control: "Upload", file: "notes.txt", path: "/upload/library" });
        // The row comes 200 ms after the app's answer: the step waited for it.
        expect(result.elapsedMs).toBeGreaterThanOrEqual(150);
        expect(await rowNames(page, ROWS)).toContain("notes.txt");
        const sent = posted(app, UPLOAD_ACCEPT_ROUTE);
        expect(sent, "the file reached the app exactly once").toHaveLength(1);
        expect(sent[0].body).toBe(CONTENT);
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatch(/^uploadFile: pressed "Upload" on \/upload\/library and handed "notes\.txt" to its file chooser; its row appeared after \d+ ms$/);
      });
    });

    it("presses a shown file input named by its own label", async () => {
      await scene(backend, { secrets: secrets() }, async ({ app, page, record }) => {
        const uploadFile = await open(page, app, "/upload/attach");
        const result = await uploadFile(page, { control: "Attach a file", path: file, record, bounds: BOUNDS });
        expect(result).toMatchObject({ control: "Attach a file", file: "notes.txt" });
        expect(posted(app, UPLOAD_ACCEPT_ROUTE)).toHaveLength(1);
      });
    });

    it("waits for a row of its own when the list already names the file", async () => {
      await scene(backend, { secrets: secrets() }, async ({ app, page, record, lines }) => {
        const uploadFile = await open(page, app, "/upload/library");
        await uploadFile(page, { control: "Upload", path: file, record, bounds: BOUNDS });
        const again = await uploadFile(page, { control: "Upload", path: file, record, bounds: BOUNDS });
        // Returned only once the second row was there, not on the first upload's row.
        expect(again.elapsedMs).toBeGreaterThanOrEqual(150);
        expect((await rowNames(page, ROWS)).filter((name) => name === "notes.txt")).toHaveLength(2);
        expect(posted(app, UPLOAD_ACCEPT_ROUTE)).toHaveLength(2);
        expect(lines).toHaveLength(2);
      });
    });

    it("refuses by name a control the page does not have, naming its file inputs", async () => {
      await scene(backend, { secrets: secrets() }, async ({ app, page, record, lines }) => {
        const uploadFile = await open(page, app, "/upload/library");
        const error = await refusal(uploadFile(page, { control: "Upload files", path: file, record, bounds: BOUNDS }));
        expect(error.name).toBe("StepRefusal");
        expect(error.step).toBe("uploadFile");
        expect(error.kind).toBe("no-control");
        expect(error.message).toBe(
          'uploadFile refused (no-control): no shown control named "Upload files" on /upload/library within 1000 ms; ' +
            'its file inputs: one without a label, hidden (test id "artifacts-upload-input") — nothing was pressed',
        );
        expect(lines).toEqual([error.message]);
        expect(app.requests.filter((r) => r.method === "POST")).toEqual([]);
      });
    });

    it("refuses at once a press that opens no file chooser", async () => {
      await scene(backend, { secrets: secrets() }, async ({ app, page, record, lines }) => {
        const uploadFile = await open(page, app, "/upload/inert");
        const before = performance.now();
        const error = await refusal(uploadFile(page, { control: "Upload", path: file, record, bounds: { ...BOUNDS, rowMs: 30_000 } }));
        expect(error.kind).toBe("no-chooser");
        expect(error.message).toBe(
          'uploadFile refused (no-chooser): the press on "Upload" opened no file chooser within 600 ms, and the page stayed on /upload/inert — no file was handed over',
        );
        expect(lines).toEqual([error.message]);
        expect(performance.now() - before, "the step waited for a row that could not come").toBeLessThan(10_000);
        expect(app.requests.filter((r) => r.method === "POST")).toEqual([]);
      });
    });

    it("refuses by name an upload whose row never appears, naming the rows the list shows", async () => {
      await scene(backend, { secrets: secrets() }, async ({ app, page, record, lines }) => {
        const uploadFile = await open(page, app, "/upload/refused");
        const error = await refusal(uploadFile(page, { control: "Upload", path: file, record, bounds: { ...BOUNDS, rowMs: 800 } }));
        expect(error.kind).toBe("no-row");
        expect(error.message).toBe(
          'uploadFile refused (no-row): no new row naming "notes.txt" appeared in the list on /upload/refused within 800 ms; its rows: "Quarterly plan.md", "Launch notes.txt"',
        );
        expect(lines).toEqual([error.message]);
        // The file did reach the app, which refused it.
        expect(posted(app, UPLOAD_REFUSE_ROUTE)).toHaveLength(1);
      });
    });

    it("presses nothing when it refuses its arguments, and never repeats a path", async () => {
      const { uploadFile } = theSteps("uploadFile");
      await scene(backend, { secrets: secrets() }, async ({ app, page, record, lines }) => {
        await page.goto(`${app.origin}/upload/library`);
        const NO_FILE = "hand the step the path of a file that exists — nothing was pressed";
        const cases = [
          [{ record, path: file }, "name the upload control by its accessible name, such as Upload — nothing was pressed"],
          [{ record, control: " ", path: file }, "name the upload control by its accessible name, such as Upload — nothing was pressed"],
          [{ record, control: "Upload" }, NO_FILE],
          [{ record, control: "Upload", path: join(folder, "missing.txt") }, NO_FILE],
          [{ record, control: "Upload", path: join(folder, "not-a-file") }, NO_FILE],
          [{ record, control: "Upload", path: file, bounds: { rowMs: 0 } }, "rowMs must be a positive number of milliseconds — nothing was pressed"],
          [{ record, control: "Upload", path: file, bounds: { waitMs: 5 } }, "there is no bound named waitMs — nothing was pressed"],
        ];
        for (const [options, reason] of cases) {
          const error = await refusal(uploadFile(page, options));
          expect(error.kind).toBe("input");
          expect(error.message).toBe(`uploadFile refused (input): ${reason}`);
          expect(lines.at(-1)).toBe(error.message);
        }
        const unrecorded = await refusal(uploadFile(page, { control: "Upload", path: file }));
        expect(unrecorded.message).toBe("uploadFile refused (input): hand the step a record callback — nothing was done");
        expect(app.requests.filter((r) => r.method === "POST"), "a refused call uploaded something").toEqual([]);
      });
    });
  });
}
