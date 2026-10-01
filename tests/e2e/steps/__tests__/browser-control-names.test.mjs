// These regressions need the browser's accessibility tree. A DOM emulator is
// not evidence of the name its platform exposes (notably for a labelled label).
import { afterAll, describe, expect, it } from "vitest";

import { BACKENDS, closeBrowser, labelOf, refusal, theSteps } from "./backends.mjs";

afterAll(closeBrowser);
const browser = BACKENDS.find((backend) => backend.name === "browser");
const control = (role, name, from) => ({ role, name, from, description: "" });

describe.skipIf(Boolean(browser.skip))(`platform control names [${labelOf(browser)}]`, () => {
  const read = async (html, body) => {
    const page = await browser.open();
    try {
      await page.setContent(html);
      await body(page, theSteps("readControlNames", "press"));
    } finally {
      await browser.close(page);
    }
  };

  it("follows aria-labelledby including hidden referenced text, ahead of aria-label", async () => {
    await read('<span id="name" hidden>Save draft</span><button aria-labelledby="name" aria-label="Wrong">Other text</button>', async (page, steps) => {
      const result = await steps.readControlNames(page, { record() {} });
      expect(result.controls).toEqual([control("button", "Save draft", "aria-labelledby")]);
    });
  });

  it("preserves direct aria-label and text names, and reads an aria-label on a button's child", async () => {
    await read('<button aria-label="Delete draft">Other text</button><button>Save draft</button><button><span aria-label="Copy draft"></span></button>', async (page, steps) => {
      const result = await steps.readControlNames(page, { record() {} });
      expect(result.controls).toEqual([
        control("button", "Delete draft", "aria-label"),
        control("button", "Save draft", "text"),
        control("button", "Copy draft", "text"),
      ]);
    });
  });

  it("reads and presses a button named by a labelled SVG image", async () => {
    await read('<button onclick="this.dataset.pressed = \'yes\'"><svg role="img" aria-label="Copy"><path d="M0 0"></path></svg></button>', async (page, steps) => {
      const result = await steps.readControlNames(page, { record() {} });
      expect(result.controls).toEqual([control("button", "Copy", "text")]);
      await steps.press(page, { name: "Copy", record() {}, bounds: { startMs: 20, pollMs: 5 } });
      expect(await page.locator("button").getAttribute("data-pressed")).toBe("yes");
      expect(await page.locator("[data-step-control]").count()).toBe(0);
    });
  });

  it("uses the platform name of an HTML label and the winning source on its input", async () => {
    await read('<span id="section">Agent section</span><label for="skills" aria-labelledby="section">Which skills?</label><input id="skills" role="combobox">', async (page, steps) => {
      expect((await steps.readControlNames(page, { record() {} })).controls).toEqual([control("combobox", "Agent section", "label")]);
      await page.locator("input").evaluate((element) => element.setAttribute("aria-labelledby", "section"));
      expect((await steps.readControlNames(page, { record() {} })).controls).toEqual([control("combobox", "Agent section", "aria-labelledby")]);
    });
  });

  it("scopes controls by a section's computed name, including hidden label references", async () => {
    await read('<span id="section-name" hidden>Draft tools</span><section aria-labelledby="section-name"><button>Save</button></section><button>Save</button>', async (page, steps) => {
      expect((await steps.readControlNames(page, { record() {}, within: "Draft tools" })).controls).toEqual([control("button", "Save", "text")]);
    });
  });

  it("keeps two controls with the same computed name distinct and refuses to guess", async () => {
    await read('<button><svg role="img" aria-label="Copy"></svg></button><button><span aria-label="Copy"></span></button>', async (page, steps) => {
      expect((await steps.readControlNames(page, { record() {} })).controls).toEqual([control("button", "Copy", "text"), control("button", "Copy", "text")]);
      expect(await refusal(steps.press(page, { name: "Copy", record() {} }))).toMatchObject({ kind: "ambiguous" });
      expect(await page.locator("[data-step-control]").count()).toBe(0);
    });
  });
});
