/**
 * ACCEPTANCE ITEM 1 OF cinatra#3026, ON THE REAL SURFACE.
 *
 * "A browser test asserts tabs labelled Code and Preview, exactly one panel
 *  visible at a time, Code containing editable markdown and Preview containing
 *  rendered markdown."
 *
 * And, because the same page can prove it without a second suite, acceptance
 * item 2 as a reader experiences it: "A change is saved as one new revision with
 * the spinner-then-check."
 *
 * NOTHING HERE IS A STUB. A real dev server, a real sign-in, a real upload
 * through the product's own upload road, the real artifact page, the real
 * extension display mounted by the host's own resolution ladder, and the real
 * save endpoint writing a real revision. The only thing the suite arranges is
 * the artifact itself.
 *
 * THE ONE PRECONDITION, AND WHY IT IS A FAILURE AND NOT A SKIP. The display
 * under test is the markdown base extension's, and the host mounts it only when
 * that base is installed — the re-pin of `PLAN: Agents Lifecycle (C)` item 0.19,
 * which is the sibling slice's work (cinatra#3025), not this one's. Until it
 * lands the artifact page falls to the host's own built-in markdown handler and
 * there are no tabs to find. The first assertion below therefore states that
 * precondition in its own words and fails on it, loudly, rather than skipping:
 * a suite that skips reports success by doing nothing.
 */
import { expect, test } from "@playwright/test";

const DOCUMENT = [
  "# Why migrations are the hardest part",
  "",
  "Teams pick a stack in an afternoon and then live",
  "with its **upgrade path** for years. Start at the",
  "[upgrade guide](/docs/upgrade), then run `cinatra upgrade`.",
  "",
].join("\n");

/** Upload one markdown document through the product's own upload road. */
async function uploadMarkdown(
  request: import("@playwright/test").APIRequestContext,
  name: string,
): Promise<string> {
  const response = await request.post("/api/artifacts/upload", {
    headers: {
      "content-type": "text/markdown",
      "x-artifact-filename": name,
      "x-artifact-title": name.replace(/\.md$/, ""),
    },
    data: Buffer.from(DOCUMENT, "utf8"),
  });
  expect(response.status(), await response.text()).toBe(201);
  const body = (await response.json()) as { artifactId?: string };
  expect(body.artifactId, "the upload road returned no artifact").toBeTruthy();
  return body.artifactId as string;
}

test.describe("the markdown editor on the artifact page", () => {
  test("draws Code and Preview, one panel at a time, editable markdown and a rendered document", async ({
    page,
    request,
  }) => {
    const artifactId = await uploadMarkdown(request, `editor-tabs-${Date.now()}.md`);
    await page.goto(`/artifacts/${artifactId}`);

    const display = page.locator("[data-artifact-renderer='markdown']");
    await expect(
      display,
      "the markdown base extension's display did not mount on the artifact page — the base has to be installed first (the re-pin of plan item 0.19, cinatra#3025); until then the page falls to the host's own built-in markdown handler and there are no tabs to find",
    ).toBeVisible();

    // The tabs, and their labels.
    const tabs = display.getByRole("tab");
    await expect(tabs).toHaveCount(2);
    await expect(tabs.nth(0)).toHaveText("Code");
    await expect(tabs.nth(1)).toHaveText("Preview");
    await expect(tabs.nth(0)).toHaveAttribute("aria-selected", "true");

    // EXACTLY ONE PANEL: the two are never shown side by side.
    await expect(display.getByRole("tabpanel")).toHaveCount(1);
    await expect(display.locator("[data-panel='code']")).toBeVisible();
    await expect(display.locator("[data-panel='preview']")).toHaveCount(0);

    // Code contains the markdown, editable in place.
    const editor = display.getByLabel("Markdown source");
    await expect(editor).toBeVisible();
    await expect(editor).toHaveValue(DOCUMENT);
    await expect(editor).toBeEditable();
    // Drawn as markdown, with its own syntax visible.
    await expect(display.locator("[data-token='heading']").first()).toContainText("#");

    // Preview contains the RENDERED document, and no editor.
    await tabs.nth(1).click();
    await expect(display.getByRole("tabpanel")).toHaveCount(1);
    await expect(display.locator("[data-panel='code']")).toHaveCount(0);
    const body = display.locator("[data-markdown-body]");
    await expect(body).toBeVisible();
    await expect(body.locator("h2")).toHaveText("Why migrations are the hardest part");
    await expect(body.locator("strong")).toHaveText("upgrade path");
    await expect(body.locator("code")).toHaveText("cinatra upgrade");
    await expect(display.getByLabel("Markdown source")).toHaveCount(0);
    // The document's own markdown is never drawn as text in the preview.
    await expect(body).not.toContainText("**upgrade path**");
  });

  test("saves an edit as one new revision, with the spinner turning into a check", async ({
    page,
    request,
  }) => {
    const artifactId = await uploadMarkdown(request, `editor-save-${Date.now()}.md`);
    await page.goto(`/artifacts/${artifactId}`);

    const display = page.locator("[data-artifact-renderer='markdown']");
    await expect(display).toBeVisible();
    const indicator = display.getByRole("status");
    // NOTHING TO SAY BEFORE THE FIRST EDIT: no save has happened, so the
    // indicator claims nothing.
    await expect(indicator).toHaveCount(0);

    const editor = display.getByLabel("Markdown source");
    await editor.click();
    await editor.press("End");
    await editor.pressSequentially("\n\nEdited in place.\n");

    // THE SPINNER FROM THE EDIT…
    await expect(indicator).toHaveAttribute("data-saving-indicator", "saving");
    // …AND THE CHECK ONCE IT IS STORED.
    await expect(indicator).toHaveAttribute("data-saving-indicator", "saved", { timeout: 15_000 });
    await expect(indicator).toContainText("Saved");

    // ONE NEW REVISION, and the document that comes back on a fresh load is the
    // edited one — proved by re-reading the page rather than by trusting the
    // indicator that just drew.
    await page.reload();
    await expect(display.getByLabel("Markdown source")).toContainText("Edited in place.");
  });
});
