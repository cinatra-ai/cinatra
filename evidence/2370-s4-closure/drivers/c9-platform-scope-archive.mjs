// C9 — cinatra#2370 S4 CLOSURE item 1e, second attempt: the Archive control on
// google-calendar is disabled by the SCOPE guard ("Installed for the whole
// platform — an organization-scoped session can't act on it"), which pre-empts
// the dependency guard. Try a platform-scoped session (no active organization)
// so the dependency refusal is the one that has to fire.
import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { authenticate, ensureDir, shot, BASE } from "./lib-auth.mjs";

const OUT = ensureDir(process.env.S4_OUT ?? "<lane-out>/2370c-out/c9");
const GCAL_SETTINGS = "/configuration/extensions/settings/connector/%40cinatra-ai/google-calendar-connector";
const DEP = "@cinatra-ai/google-appointment-schedules-connector";

const steps = [];
const assertions = [];
function A(id, pass, detail) {
  assertions.push({ id, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${id} :: ${detail}`);
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
const page = await context.newPage();

try {
  await authenticate(context, steps);
  // Drop the active organization → platform-scoped session.
  const clear = await context.request.post(`${BASE}/api/auth/organization/set-active`, {
    data: { organizationId: null },
    headers: { Origin: BASE },
    failOnStatusCode: false,
  });
  steps.push(`clear-active-org status=${clear.status()} body=${(await clear.text()).slice(0, 200)}`);

  const res = await page.goto(`${BASE}${GCAL_SETTINGS}`, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(2500);
  steps.push(`status=${res?.status()} url=${page.url()}`);
  await shot(page, OUT, "01-gcal-settings-platform-scope");
  const bodyText = (await page.locator("body").innerText()).replace(/\s+/g, " ");
  steps.push(`page text=${JSON.stringify(bodyText.slice(0, 2500))}`);

  const controls = await page.locator("button").evaluateAll((els) =>
    els
      .map((e) => ({
        text: (e.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60),
        disabled: e.hasAttribute("disabled") || e.getAttribute("aria-disabled") === "true",
        title: e.getAttribute("title"),
      }))
      .filter((b) => /archive|uninstall|reinstall|force-delete|activate/i.test(b.text)),
  );
  steps.push(`lifecycle controls=${JSON.stringify(controls)}`);

  const archive = page.getByRole("button", { name: "Archive", exact: true });
  const count = await archive.count();
  const disabled = count ? await archive.first().isDisabled() : null;
  steps.push(`archive count=${count} disabled=${disabled}`);

  if (count && disabled === false) {
    await archive.first().scrollIntoViewIfNeeded().catch(() => {});
    await shot(page, OUT, "02-archive-enabled");
    await archive.first().click({ timeout: 15000 });
    await page.waitForTimeout(6000);
    await shot(page, OUT, "03-after-archive-click");
    const err = page.locator('[data-slot="archive-error"]');
    const errText = (await err.count()) ? (await err.first().innerText()).replace(/\s+/g, " ") : "";
    const after = (await page.locator("body").innerText()).replace(/\s+/g, " ");
    const toasts = await page.locator("[data-sonner-toast]").allInnerTexts().catch(() => []);
    steps.push(`archive-error=${JSON.stringify(errText)}`);
    steps.push(`toasts=${JSON.stringify(toasts)}`);
    steps.push(`after text=${JSON.stringify(after.slice(0, 1500))}`);
    A(
      "C9.1-archive-refused-naming-dependent",
      errText.includes(DEP) || toasts.some((t) => t.includes(DEP)) || after.includes(`Required by ${DEP}`),
      `errText=${JSON.stringify(errText)} toasts=${JSON.stringify(toasts)}`,
    );
  } else {
    A(
      "C9.1-archive-refused-naming-dependent",
      false,
      `Archive still not actionable in a platform-scoped session: count=${count} disabled=${disabled}; controls=${JSON.stringify(controls)}`,
    );
  }
} catch (err) {
  assertions.push({ id: "C9.FATAL", pass: false, detail: String(err && err.stack ? err.stack : err) });
  console.error(err);
} finally {
  writeFileSync(`${OUT}/assertions.json`, JSON.stringify({ base: BASE, steps, assertions }, null, 2));
  await browser.close();
}
console.log("DRIVER-DONE");
